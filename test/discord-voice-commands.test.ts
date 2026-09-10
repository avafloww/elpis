import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChannelType, Events } from 'discord.js';
import { createDiscord } from '../src/discord/discord.js';
import { buildTestAgent, makeConfig } from './helpers.js';
import type { DiscordVoiceController } from '../src/voice/discord-voice.js';

for (const scenario of [
  'allowed',
  'non-operator',
  'social',
  'disabled',
  'not-in-voice',
  'stage',
  'permissions',
  'leave',
] as const) {
  test(`/join gateway dispatch: ${scenario}`, async () => {
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
            {
              id: '3002',
              slug: 'social',
              slashCommands: true,
              quietHours: null,
              timezone: null,
              channels: {},
            },
          ],
          voice: {
            enabled: scenario !== 'disabled',
            apiKey: 'synthetic-voice-key',
            model: 'gpt-realtime-2.1',
            voice: 'marin',
            transcriptionModel: 'gpt-4o-mini-transcribe',
            maxSessionMinutes: 60,
          },
        },
      },
    });
    let joined = 0;
    let left = 0;
    const voice: DiscordVoiceController = {
      channelId: null,
      join: async () => {
        joined++;
      },
      leave: () => {
        left++;
      },
      speak: async () => ({ status: 'played', transcript: '', playedMs: 0 }),
      captureSpeech: () => null,
    };
    const { client } = createDiscord(fixture.config, fixture.agent, { voice });
    const replies: string[] = [];
    const channel =
      scenario === 'not-in-voice'
        ? null
        : {
            type:
              scenario === 'stage'
                ? ChannelType.GuildStageVoice
                : ChannelType.GuildVoice,
            permissionsFor: () => ({ has: () => scenario !== 'permissions' }),
          };
    const interaction = {
      isChatInputCommand: () => true,
      guildId: scenario === 'social' ? '3002' : '3001',
      commandName: scenario === 'leave' ? 'leave' : 'join',
      user: { id: scenario === 'non-operator' ? '2002' : '2001' },
      guild: { members: { fetch: async () => ({ voice: { channel } }) } },
      deferReply: async () => {},
      reply: async ({ content }: { content: string }) => {
        replies.push(content);
      },
      editReply: async ({ content }: { content: string }) => {
        replies.push(content);
      },
    };
    try {
      const handler = client.listeners(Events.InteractionCreate)[0] as (
        input: unknown,
      ) => Promise<void>;
      await handler(interaction);
      assert.equal(joined, scenario === 'allowed' ? 1 : 0);
      assert.equal(left, scenario === 'leave' ? 1 : 0);
      assert.equal(replies.length, 1);
      if (scenario === 'non-operator')
        assert.match(replies[0], /not authorized/);
      if (scenario === 'social') assert.match(replies[0], /home server/);
      if (scenario === 'disabled') assert.match(replies[0], /disabled/);
    } finally {
      fixture.agent.stop();
      client.destroy();
      fixture.cleanup();
    }
  });
}

test('voice send preserves readable delivery and returns truthful failed audio receipt', async () => {
  const fixture = buildTestAgent({
    config: {
      discord: {
        ...makeConfig().discord,
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
      },
    },
  });
  let textSends = 0;
  const voice: DiscordVoiceController = {
    channelId: '1001',
    join: async () => {},
    leave: () => {},
    speak: async () => {
      throw new Error('synthetic playback failure');
    },
    captureSpeech: () => async () => {
      throw new Error('synthetic playback failure');
    },
  };
  const { client } = createDiscord(fixture.config, fixture.agent, { voice });
  Object.defineProperty(client.channels, 'fetch', {
    value: async () => ({
      name: 'general',
      guildId: fixture.config.discord.guilds[0].id,
      isTextBased: () => true,
      isThread: () => false,
      send: async () => {
        textSends++;
      },
    }),
  });
  try {
    const receipt = await fixture.agent.send('1001', 'Hello.');
    assert.equal(textSends, 1);
    assert.deepEqual(receipt, {
      voice: { status: 'failed', transcript: '', playedMs: 0 },
    });
  } finally {
    fixture.agent.stop();
    client.destroy();
    fixture.cleanup();
  }
});

test('a voice call joined during readable delivery does not receive older speech', async () => {
  const fixture = buildTestAgent({
    config: {
      discord: {
        ...makeConfig().discord,
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
      },
    },
  });
  let joined = false;
  let speechCalls = 0;
  const voice: DiscordVoiceController = {
    get channelId() {
      return joined ? '1001' : null;
    },
    join: async () => {
      joined = true;
    },
    leave: () => {
      joined = false;
    },
    speak: async () => {
      speechCalls++;
      return { status: 'played', transcript: 'old text', playedMs: 10 };
    },
    captureSpeech: (channelId) =>
      joined && channelId === '1001'
        ? async () => {
            speechCalls++;
            return { status: 'played', transcript: 'old text', playedMs: 10 };
          }
        : null,
  };
  const { client } = createDiscord(fixture.config, fixture.agent, { voice });
  Object.defineProperty(client.channels, 'fetch', {
    value: async () => {
      joined = true;
      return {
        name: 'general',
        guildId: fixture.config.discord.guilds[0].id,
        isTextBased: () => true,
        isThread: () => false,
        send: async () => {},
      };
    },
  });
  try {
    const receipt = await fixture.agent.send('1001', 'Before the call.');
    assert.equal(receipt, undefined);
    assert.equal(speechCalls, 0);
  } finally {
    fixture.agent.stop();
    client.destroy();
    fixture.cleanup();
  }
});
