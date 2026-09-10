import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { VoiceChannel } from 'discord.js';
import type { InboundMessage } from '../src/agent.js';
import type { Config } from '../src/config.js';
import {
  createDiscordVoice,
  voiceChannelAllowed,
} from '../src/voice/discord-voice.js';
import type {
  DiscordAudioSession,
  DiscordAudioSessionOptions,
} from '../src/voice/discord-audio.js';
import type {
  RealtimeVoiceEvent,
  RealtimeVoiceTransportOptions,
} from '../src/voice/realtime.js';
import type { MuteRow, MuteStore } from '../src/store/mutes.js';
import { makeConfig } from './helpers.js';

const GUILD_ID = 'guild-1';
const CHANNEL_ID = 'voice-1';
const OPERATOR_ID = 'operator-1';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function voiceConfig(overrides: Partial<Config> = {}): Config {
  const base = makeConfig();
  const guild = {
    ...base.discord.guilds[0],
    id: GUILD_ID,
    slug: 'home',
    channels: { [CHANNEL_ID]: 'direct' as const },
    channelAllowSend: { [CHANNEL_ID]: true },
    allowSend: true,
  };
  return makeConfig({
    ...overrides,
    operator: {
      ...base.operator,
      discordId: OPERATOR_ID,
      ...overrides.operator,
    },
    discord: {
      ...base.discord,
      guilds: [guild],
      voice: {
        enabled: true,
        apiKey: 'synthetic-voice-key',
        model: 'gpt-realtime-2.1',
        voice: 'marin',
        transcriptionModel: 'gpt-4o-mini-transcribe',
        maxSessionMinutes: 1,
      },
      ...overrides.discord,
    },
  });
}

function fakeChannel(operatorPresent = true): VoiceChannel {
  const members = new Map<string, { displayName: string }>();
  if (operatorPresent) members.set(OPERATOR_ID, { displayName: 'Bramble' });
  return {
    id: CHANNEL_ID,
    name: 'voice-room',
    guild: { id: GUILD_ID },
    members,
  } as unknown as VoiceChannel;
}

class FakeTransport {
  appended: Buffer[] = [];
  cancelled: Array<string | undefined> = [];
  deleted: string[] = [];
  spoken: string[] = [];
  requestTokens: string[] = [];
  closes = 0;
  connectResult: Promise<void> = Promise.resolve();
  onEvent: (event: RealtimeVoiceEvent) => void = () => undefined;

  connect(): Promise<void> {
    return this.connectResult;
  }
  appendAudio(pcm: Uint8Array): void {
    this.appended.push(Buffer.from(pcm));
  }
  speakText(text: string, requestToken: string): void {
    this.spoken.push(text);
    this.requestTokens.push(requestToken);
  }
  cancelResponse(responseId?: string): void {
    this.cancelled.push(responseId);
  }
  deleteInput(itemId: string): void {
    this.deleted.push(itemId);
  }
  close(): void {
    this.closes++;
  }
  emit(event: RealtimeVoiceEvent): void {
    this.onEvent(event);
  }
}

class FakeAudio implements DiscordAudioSession {
  connection = null;
  connects = 0;
  closes = 0;
  interrupts = 0;
  played: Buffer[] = [];
  finishResult: Promise<number> = Promise.resolve(0);
  connectResult: Promise<never> | Promise<unknown> = Promise.resolve({});
  options!: DiscordAudioSessionOptions;

  async connect(_channel: VoiceChannel): Promise<never> {
    this.connects++;
    return this.connectResult as Promise<never>;
  }
  playPcm16(pcm: Uint8Array): boolean {
    this.played.push(Buffer.from(pcm));
    return true;
  }
  finishPlayback(): Promise<number> {
    return this.finishResult;
  }
  interruptPlayback(): number {
    this.interrupts++;
    return 125;
  }
  close(): void {
    this.closes++;
  }
}

function muteStore() {
  let row: MuteRow | null = null;
  const store: MuteStore = {
    get: () => row,
    set: (channelId, type, setBy, reason = null) => {
      row = {
        channelId,
        type,
        setBy,
        reason,
        createdAt: '2026-09-10T00:00:00.000Z',
      };
    },
    clear: () => {
      const existed = row !== null;
      row = null;
      return existed;
    },
    all: () => (row ? [row] : []),
  };
  return { store, set: (next: MuteRow | null) => (row = next) };
}

function harness(
  options: {
    config?: Config;
    transports?: FakeTransport[];
    audios?: FakeAudio[];
    mutes?: MuteStore;
  } = {},
) {
  const config = options.config ?? voiceConfig();
  const transports = options.transports ?? [new FakeTransport()];
  const audios = options.audios ?? [new FakeAudio()];
  const enqueued: InboundMessage[] = [];
  let transportIndex = 0;
  let audioIndex = 0;
  const controller = createDiscordVoice(
    config,
    { enqueue: (message) => enqueued.push(message) },
    {
      mutes: options.mutes,
      createTransport: (transportOptions: RealtimeVoiceTransportOptions) => {
        const transport = transports[transportIndex++];
        assert.ok(transport, 'unexpected transport construction');
        transport.onEvent = transportOptions.onEvent ?? (() => undefined);
        return transport;
      },
      createAudio: ((audioOptions: DiscordAudioSessionOptions) => {
        const audio = audios[audioIndex++];
        assert.ok(audio, 'unexpected audio construction');
        audio.options = audioOptions;
        return audio;
      }) as NonNullable<
        Parameters<typeof createDiscordVoice>[2]
      >['createAudio'],
    },
  );
  return { config, controller, transports, audios, enqueued };
}

describe('Discord voice authorization and lifecycle', () => {
  it('allows only explicit send-enabled home channels', () => {
    const config = voiceConfig();
    assert.equal(voiceChannelAllowed(config, CHANNEL_ID, GUILD_ID), true);
    assert.equal(voiceChannelAllowed(config, 'unknown', GUILD_ID), false);
    assert.equal(voiceChannelAllowed(config, CHANNEL_ID, 'other-guild'), false);

    const guild = config.discord.guilds[0];
    const denied = voiceConfig({
      discord: {
        ...config.discord,
        guilds: [{ ...guild, channelAllowSend: { [CHANNEL_ID]: false } }],
      },
    });
    assert.equal(voiceChannelAllowed(denied, CHANNEL_ID, GUILD_ID), false);
  });

  it('checks configuration, operator presence, ignore, and mute gates before effects', async () => {
    const disabled = voiceConfig();
    disabled.discord.voice = { ...disabled.discord.voice!, enabled: false };
    await assert.rejects(
      harness({ config: disabled }).controller.join(fakeChannel()),
      /Voice is not configured/,
    );

    const absent = harness();
    await assert.rejects(
      absent.controller.join(fakeChannel(false)),
      /Join the voice channel/,
    );
    assert.equal(absent.transports[0].closes, 0);

    const ignoredConfig = voiceConfig();
    ignoredConfig.discord.ignoredUserIds = [OPERATOR_ID];
    await assert.rejects(
      harness({ config: ignoredConfig }).controller.join(fakeChannel()),
      /operator is excluded/,
    );

    const muted = muteStore();
    muted.store.set(CHANNEL_ID, 'deafen', 'operator');
    await assert.rejects(
      harness({ mutes: muted.store }).controller.join(fakeChannel()),
      /deafened/,
    );
  });

  it('queues finalized operator ASR with voice provenance and ordered item identity', async () => {
    const h = harness();
    await h.controller.join(fakeChannel());
    assert.equal(h.controller.channelId, CHANNEL_ID);

    h.transports[0].emit({
      type: 'inputCommitted',
      itemId: 'item-1',
      previousItemId: 'item-0',
    });
    h.transports[0].emit({
      type: 'inputTranscript',
      itemId: 'item-1',
      transcript: '  hello from voice  ',
    });

    const message = h.enqueued.find((item) => item.source === 'voice');
    assert.ok(message);
    assert.equal(message.id.startsWith('voice-'), true);
    assert.equal(message.id.endsWith('-item-1'), true);
    assert.deepEqual(
      {
        source: message.source,
        kind: message.kind,
        channelId: message.channelId,
        policyChannelId: message.policyChannelId,
        guildId: message.guildId,
        guildSlug: message.guildSlug,
        authorId: message.authorId,
        author: message.author,
        content: message.content,
        wakeClass: message.wakeClass,
      },
      {
        source: 'voice',
        kind: 'discord',
        channelId: CHANNEL_ID,
        policyChannelId: CHANNEL_ID,
        guildId: GUILD_ID,
        guildSlug: 'home',
        authorId: OPERATOR_ID,
        author: 'Bramble',
        content: 'hello from voice',
        wakeClass: 'wake',
      },
    );
    assert.deepEqual(h.transports[0].deleted, ['item-1']);
    h.controller.leave();
    assert.equal(h.controller.channelId, null);
    assert.equal(h.transports[0].closes >= 1, true);
    assert.equal(h.audios[0].closes >= 1, true);
  });

  it('keeps mute listen-only, blocks sends, and makes deafen stop ingress', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000 });
    const mute = muteStore();
    mute.store.set(CHANNEL_ID, 'mute', 'operator');
    const h = harness({ mutes: mute.store });
    await h.controller.join(fakeChannel());

    await h.audios[0].options.onSpeechStart?.();
    t.mock.timers.tick(60);
    assert.equal(
      h.transports[0].appended.some((chunk) => chunk.length === 960),
      true,
      'Discord speech-start begins paced silence before remote VAD responds',
    );
    h.transports[0].appended.length = 0;
    h.audios[0].options.onAudio?.(Buffer.from([1, 2]));
    assert.deepEqual(h.transports[0].appended, [Buffer.from([1, 2])]);
    await assert.rejects(
      h.controller.speak('hello'),
      /voice sending is disabled/,
    );

    mute.store.set(CHANNEL_ID, 'deafen', 'operator');
    h.audios[0].options.onAudio?.(Buffer.from([3, 4]));
    assert.equal(h.transports[0].appended.length, 1);
    h.transports[0].emit({ type: 'inputCommitted', itemId: 'item-deaf' });
    h.transports[0].emit({
      type: 'inputTranscript',
      itemId: 'item-deaf',
      transcript: 'must not enter history',
    });
    assert.equal(
      h.enqueued.some((item) => item.source === 'voice'),
      false,
    );
    assert.deepEqual(h.transports[0].deleted, ['item-deaf']);
    h.controller.leave();
  });

  it('ends a call when local speech never reaches a provider VAD commit', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_000 });
    const h = harness();
    await h.controller.join(fakeChannel());

    await h.audios[0].options.onSpeechStart?.();
    await h.audios[0].options.onUtteranceEnd?.();
    t.mock.timers.tick(9_999);
    assert.equal(h.controller.channelId, CHANNEL_ID);

    // Resumed local audio proves the old end marker stale. A later end starts
    // a fresh bound rather than allowing the first timeout to close the call.
    await h.audios[0].options.onAudio?.(Buffer.from([1, 2]));
    t.mock.timers.tick(1);
    assert.equal(h.controller.channelId, CHANNEL_ID);
    await h.audios[0].options.onUtteranceEnd?.();
    t.mock.timers.tick(10_000);

    assert.equal(h.controller.channelId, null);
    assert.equal(
      h.enqueued.some((item) =>
        item.content.includes('did not reach an utterance boundary'),
      ),
      true,
    );
  });

  it('a delayed old commit preserves the next utterance silence tail and deadline', async (t) => {
    t.mock.timers.enable({
      apis: ['Date', 'setTimeout', 'setInterval'],
      now: 1_000,
    });
    const h = harness();
    await h.controller.join(fakeChannel());
    h.audios[0].options.onSpeechStart?.();
    h.audios[0].options.onAudio?.(Buffer.alloc(960));
    h.audios[0].options.onUtteranceEnd?.();
    h.transports[0].emit({
      type: 'speechStopped',
      itemId: 'old',
      audioEndMs: 20,
    });
    h.audios[0].options.onSpeechStart?.();
    h.audios[0].options.onAudio?.(Buffer.alloc(960));
    h.audios[0].options.onUtteranceEnd?.();
    h.transports[0].emit({ type: 'inputCommitted', itemId: 'old' });
    const before = h.transports[0].appended.length;
    t.mock.timers.tick(60);
    assert.ok(h.transports[0].appended.length > before);
    t.mock.timers.tick(9_940);
    assert.equal(h.controller.channelId, null);
    assert.ok(
      h.enqueued.some((item) =>
        item.content.includes('did not reach an utterance boundary'),
      ),
    );
  });

  it('a matching current VAD commit stops silence pacing and its deadline', async (t) => {
    t.mock.timers.enable({
      apis: ['Date', 'setTimeout', 'setInterval'],
      now: 1_000,
    });
    const h = harness();
    await h.controller.join(fakeChannel());
    h.audios[0].options.onSpeechStart?.();
    h.audios[0].options.onAudio?.(Buffer.alloc(960));
    h.audios[0].options.onUtteranceEnd?.();
    h.transports[0].emit({
      type: 'speechStopped',
      itemId: 'current',
      audioEndMs: 20,
    });
    h.transports[0].emit({ type: 'inputCommitted', itemId: 'current' });
    const before = h.transports[0].appended.length;
    t.mock.timers.tick(10_000);
    assert.equal(h.transports[0].appended.length, before);
    assert.equal(h.controller.channelId, CHANNEL_ID);
    h.controller.leave();
  });

  it('retains a current provider commit until Discord reports local utterance end', async (t) => {
    t.mock.timers.enable({
      apis: ['Date', 'setTimeout', 'setInterval'],
      now: 1_000,
    });
    const h = harness();
    await h.controller.join(fakeChannel());
    h.audios[0].options.onSpeechStart?.();
    h.audios[0].options.onAudio?.(Buffer.alloc(960));
    h.transports[0].emit({
      type: 'speechStopped',
      itemId: 'current',
      audioEndMs: 20,
    });
    h.transports[0].emit({ type: 'inputCommitted', itemId: 'current' });
    h.audios[0].options.onUtteranceEnd?.();
    t.mock.timers.tick(10_000);
    assert.equal(h.controller.channelId, CHANNEL_ID);
    assert.equal(h.transports[0].appended.length, 1);
    h.controller.leave();
  });

  it('setup error releases a join whose audio connection never settles', async () => {
    const firstAudio = new FakeAudio();
    firstAudio.connectResult = new Promise(() => {});
    const h = harness({
      audios: [firstAudio, new FakeAudio()],
      transports: [new FakeTransport(), new FakeTransport()],
    });
    const joining = h.controller.join(fakeChannel());
    const rejected = assert.rejects(joining, /Voice join was cancelled/);
    await Promise.resolve();
    await Promise.resolve();
    firstAudio.options.onError?.(new Error('connection failed'));
    await rejected;
    await h.controller.join(fakeChannel());
    assert.equal(h.controller.channelId, CHANNEL_ID);
    h.controller.leave();
  });

  it('delivers explicit speech with correlated audio and playback receipt', async () => {
    const h = harness();
    h.audios[0].finishResult = Promise.resolve(875);
    await h.controller.join(fakeChannel());

    const delivery = h.controller.speak('Resident-authored reply.');
    assert.deepEqual(h.transports[0].spoken, ['Resident-authored reply.']);
    h.transports[0].emit({
      type: 'responseCreated',
      responseId: 'response-1',
      requestToken: h.transports[0].requestTokens[0],
    });
    h.transports[0].emit({
      type: 'audio',
      responseId: 'response-1',
      itemId: 'assistant-1',
      pcm: Buffer.from([5, 6]),
    });
    h.transports[0].emit({
      type: 'outputTranscript',
      responseId: 'response-1',
      itemId: 'assistant-1',
      transcript: 'Resident-authored reply.',
      final: true,
    });
    h.transports[0].emit({
      type: 'responseDone',
      responseId: 'response-1',
      status: 'completed',
    });

    assert.deepEqual(await delivery, {
      status: 'played',
      transcript: 'Resident-authored reply.',
      playedMs: 875,
    });
    assert.deepEqual(h.audios[0].played, [Buffer.from([5, 6])]);
    h.controller.leave();
  });

  it('captured speech never follows a leave and rejoin to the same channel', async () => {
    const h = harness({
      transports: [new FakeTransport(), new FakeTransport()],
      audios: [new FakeAudio(), new FakeAudio()],
    });
    await h.controller.join(fakeChannel());
    const captured = h.controller.captureSpeech(CHANNEL_ID);
    assert.ok(captured);
    assert.equal(h.controller.captureSpeech('another-channel'), null);

    h.controller.leave();
    await h.controller.join(fakeChannel());
    await assert.rejects(
      captured('Belongs to the old call.'),
      /session has ended/,
    );
    assert.deepEqual(h.transports[0].spoken, []);
    assert.deepEqual(h.transports[1].spoken, []);
    h.controller.leave();
  });

  it('cancels a non-settling join and immediately permits a fresh join', async () => {
    const connection = deferred<void>();
    const firstTransport = new FakeTransport();
    firstTransport.connectResult = connection.promise;
    const secondTransport = new FakeTransport();
    const h = harness({
      transports: [firstTransport, secondTransport],
      audios: [new FakeAudio(), new FakeAudio()],
    });

    const firstJoin = h.controller.join(fakeChannel());
    h.controller.leave();
    const secondJoin = h.controller.join(fakeChannel());
    await assert.rejects(firstJoin, /Voice join was cancelled/);
    await secondJoin;
    assert.equal(h.controller.channelId, CHANNEL_ID);
    assert.equal(firstTransport.closes >= 1, true);
    assert.equal(h.audios[0].connects, 0);
    h.controller.leave();
  });

  it('closes on audio failure and permits a clean retry after failed setup', async () => {
    const firstTransport = new FakeTransport();
    firstTransport.connectResult = Promise.reject(
      new Error('provider unavailable'),
    );
    const secondTransport = new FakeTransport();
    const firstAudio = new FakeAudio();
    const secondAudio = new FakeAudio();
    const h = harness({
      transports: [firstTransport, secondTransport],
      audios: [firstAudio, secondAudio],
    });

    await assert.rejects(
      h.controller.join(fakeChannel()),
      /provider unavailable/,
    );
    assert.equal(firstTransport.closes >= 1, true);
    assert.equal(firstAudio.closes >= 1, true);

    await h.controller.join(fakeChannel());
    assert.equal(h.controller.channelId, CHANNEL_ID);
    secondAudio.options.onError?.(new Error('decoder stopped'));
    assert.equal(h.controller.channelId, null);
    assert.equal(secondTransport.closes >= 1, true);
    assert.equal(
      h.enqueued.some((message) =>
        message.content.includes('Discord audio failed'),
      ),
      true,
    );
  });
});
