import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { VoiceChannel } from 'discord.js';
import { createDiscord } from '../src/discord/discord.js';
import { createDiscordVoice } from '../src/voice/discord-voice.js';
import type { RealtimeVoiceEvent } from '../src/voice/realtime.js';
import { loadMostRecentMain } from '../src/store/sessions.js';
import { buildTestAgent, makeConfig, makeStubLLM } from './helpers.js';

for (const speech of ['header', 'programmatic'] as const) {
  test(
    `final voice ingress reaches the resident loop and durable ${speech} playback receipt`,
    { timeout: 10_000 },
    async () => {
      const idle = Promise.withResolvers<void>();
      let completions = 0;
      const base = makeConfig();
      const fixture = buildTestAgent({
        config: {
          operator: { ...base.operator, discordId: '2001' },
          discord: {
            ...base.discord,
            guilds: [
              {
                id: '3001',
                slug: 'home',
                slashCommands: true,
                quietHours: null,
                timezone: null,
                channels: { '1001': 'direct' },
              },
            ],
            voice: {
              enabled: true,
              apiKey: 'synthetic-voice-key',
              model: 'gpt-realtime-2.1',
              voice: 'marin',
              transcriptionModel: 'gpt-4o-mini-transcribe',
              maxSessionMinutes: 1,
            },
          },
        },
        llm: makeStubLLM({
          complete: async (messages) => {
            completions++;
            assert.equal(
              completions,
              1,
              'voice must not fork a second resident turn',
            );
            assert.match(
              messages[0].content ?? '',
              /Aster speaks thoughtfully/,
            );
            assert.ok(
              messages.some(
                (m) =>
                  /source="voice"/.test(m.content ?? '') &&
                  /Please say hello/.test(m.content ?? ''),
              ),
            );
            return {
              message: {
                role: 'assistant',
                content:
                  speech === 'header'
                    ? '[send to=home/lounge]\nHello, Bramble.'
                    : '',
                tool_calls: [
                  {
                    id: 'voice-reply',
                    type: 'function',
                    function: {
                      name: 'run',
                      arguments: JSON.stringify({
                        code:
                          speech === 'programmatic'
                            ? "await elpis.channel('home/lounge').send('Hello, Bramble.')"
                            : '',
                        detail: 'Reply in the voice call',
                        wake: { after: '1h' },
                      }),
                    },
                  },
                ],
              },
              usage: {
                prompt_tokens: 10,
                completion_tokens: 10,
                total_tokens: 20,
              },
              stripped: false,
              completionStatus: 'complete',
            };
          },
        }),
        agentDeps: {
          onIdle: () => {
            if (completions) idle.resolve();
          },
        },
      });
      fs.writeFileSync(
        fixture.config.paths.soulPath,
        '---\nname: Aster\n---\nAster speaks thoughtfully.\n',
      );
      let emit: (event: RealtimeVoiceEvent) => void = () => {};
      const authoredSpeech: string[] = [];
      let playedBytes = 0;
      const voice = createDiscordVoice(fixture.config, fixture.agent, {
        createTransport: (options) => {
          emit = options.onEvent!;
          return {
            connect: async () => {},
            appendAudio: () => {},
            cancelResponse: () => {},
            deleteInput: () => {},
            close: () => {},
            speakText: (text, requestToken) => {
              authoredSpeech.push(text);
              emit({ type: 'responseCreated', responseId: 'r1', requestToken });
              emit({
                type: 'audio',
                responseId: 'r1',
                itemId: 'a1',
                pcm: Buffer.alloc(4800),
              });
              emit({
                type: 'outputTranscript',
                responseId: 'r1',
                itemId: 'a1',
                transcript: text,
                final: true,
              });
              emit({
                type: 'responseDone',
                responseId: 'r1',
                status: 'completed',
              });
            },
          };
        },
        createAudio: () => ({
          connection: null,
          connect: async () => ({}) as never,
          playPcm16: (pcm) => {
            playedBytes += pcm.length;
            return true;
          },
          finishPlayback: async () => 100,
          interruptPlayback: () => 0,
          close: () => {},
        }),
      });
      const wiring = createDiscord(fixture.config, fixture.agent, { voice });
      const channel = {
        id: '1001',
        name: 'lounge',
        guild: { id: '3001' },
        members: new Map([['2001', { displayName: 'Bramble' }]]),
      } as unknown as VoiceChannel;
      const readable: string[] = [];
      Object.defineProperty(wiring.client.channels, 'fetch', {
        value: async () => ({
          name: 'lounge',
          guildId: '3001',
          isTextBased: () => true,
          isThread: () => false,
          send: async ({ content }: { content: string }) => {
            readable.push(content);
          },
        }),
      });
      let running: Promise<void> | undefined;
      try {
        await voice.join(channel);
        emit({ type: 'inputCommitted', itemId: 'u1' });
        emit({
          type: 'inputTranscript',
          itemId: 'u1',
          transcript: 'Please say hello.',
        });
        running = fixture.agent.loop();
        await idle.promise;
        assert.deepEqual(readable, ['Hello, Bramble.']);
        assert.deepEqual(authoredSpeech, readable);
        assert.equal(playedBytes, 4800);
        const sends = fixture.agent.messagesForTest.flatMap(
          (m) => m.sends ?? [],
        );
        assert.equal(sends.length, 1);
        assert.deepEqual(sends[0].voice, {
          status: 'played',
          transcript: 'Hello, Bramble.',
          playedMs: 100,
        });
        fixture.agent.flushTranscripts();
        const restored = await loadMostRecentMain(
          path.join(fixture.tmpDir, 'sessions'),
        );
        assert.ok(
          restored?.messages.some((m) =>
            /source="voice"/.test(m.content ?? ''),
          ),
        );
        assert.deepEqual(
          restored?.messages.flatMap((m) => m.sends ?? [])[0].voice,
          sends[0].voice,
        );
      } finally {
        fixture.agent.stop();
        await running;
        wiring.client.destroy();
        fixture.cleanup();
      }
    },
  );
}
