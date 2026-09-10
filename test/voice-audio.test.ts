import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { test } from 'node:test';
import {
  StreamType,
  VoiceConnectionStatus,
  generateDependencyReport,
} from '@discordjs/voice';
import {
  createDiscordAudioSession,
  pcm16Mono24kToStereo48k,
  pcm16Stereo48kToMono24k,
  type DiscordAudioDependencies,
} from '../src/voice/discord-audio.js';

const require = createRequire(import.meta.url);

class FakeReceiver {
  readonly speaking = new EventEmitter();
  readonly subscriptions: Array<{
    userId: string;
    options: Record<string, unknown> | undefined;
    stream: PassThrough;
  }> = [];

  subscribe(userId: string, options?: Record<string, unknown>): PassThrough {
    const stream = new PassThrough({ objectMode: true });
    this.subscriptions.push({ userId, options, stream });
    return stream;
  }
}

class FakeConnection extends EventEmitter {
  readonly receiver = new FakeReceiver();
  readonly joinConfig = { channelId: 'voice-channel' };
  readonly state = { status: VoiceConnectionStatus.Ready };
  subscribedPlayer: FakePlayer | null = null;
  destroyed = false;

  subscribe(player: FakePlayer): void {
    this.subscribedPlayer = player;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakePlayer extends EventEmitter {
  readonly state = { status: 'idle' };
  played: unknown[] = [];
  stopCalls: boolean[] = [];

  play(resource: unknown): void {
    this.played.push(resource);
    this.state.status = 'playing';
  }

  stop(force?: boolean): boolean {
    this.stopCalls.push(Boolean(force));
    this.state.status = 'idle';
    this.emit('idle');
    return true;
  }
}

function makeVoiceChannel(): {
  id: string;
  guild: { id: string; voiceAdapterCreator: () => never };
} {
  return {
    id: 'voice-channel',
    guild: {
      id: 'guild',
      voiceAdapterCreator: (() => {
        throw new Error('fake adapter must not be called');
      }) as () => never,
    },
  };
}

function makeHarness(
  overrides: {
    onAudio?: (pcm: Buffer) => void;
    onSpeechStart?: () => void;
    onUtteranceEnd?: () => void;
    onError?: (error: Error) => void;
    maxUtteranceBytes?: number;
    maxPlaybackBufferBytes?: number;
  } = {},
): {
  session: ReturnType<typeof createDiscordAudioSession>;
  connection: FakeConnection;
  receiver: FakeReceiver;
  player: FakePlayer;
  resourceInputs: PassThrough[];
  joinOptions: Array<Record<string, unknown>>;
} {
  const connection = new FakeConnection();
  const player = new FakePlayer();
  const resourceInputs: PassThrough[] = [];
  const joinOptions: Array<Record<string, unknown>> = [];
  const dependencies: DiscordAudioDependencies = {
    joinVoiceChannel: (options) => {
      joinOptions.push(options as unknown as Record<string, unknown>);
      return connection as never;
    },
    createAudioPlayer: () => player,
    createAudioResource: (input, options) => {
      assert.equal(options.inputType, StreamType.Raw);
      resourceInputs.push(input as PassThrough);
      // The fake player only needs a resource-shaped object. The real resource
      // exposes these fields and is responsible for measuring packet playback.
      return { ended: false, playbackDuration: 0 } as never;
    },
    entersState: async (voiceConnection) => voiceConnection,
    createDecoder: () =>
      new Transform({
        transform(chunk, _encoding, callback) {
          callback(null, chunk);
        },
      }),
  };
  const session = createDiscordAudioSession({
    operatorUserId: '123456789',
    utteranceSilenceMs: 10,
    maxUtteranceBytes: overrides.maxUtteranceBytes,
    maxPlaybackBufferBytes: overrides.maxPlaybackBufferBytes,
    dependencies,
    ...overrides,
  });
  return {
    session,
    connection,
    receiver: connection.receiver,
    player,
    resourceInputs,
    joinOptions,
  };
}

function stereoFrame(...values: [number, number, number, number]): Buffer {
  const output = Buffer.alloc(values.length * 8);
  values.forEach(([left0, right0, left1, right1], index) => {
    const offset = index * 8;
    output.writeInt16LE(left0, offset);
    output.writeInt16LE(right0, offset + 2);
    output.writeInt16LE(left1, offset + 4);
    output.writeInt16LE(right1, offset + 6);
  });
  return output;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test('PCM conversion uses the callback and Discord formats', () => {
  const mono = Buffer.alloc(4);
  mono.writeInt16LE(1000, 0);
  mono.writeInt16LE(-2000, 2);
  const stereo = pcm16Mono24kToStereo48k(mono);
  assert.equal(stereo.length, 16);
  assert.deepEqual(
    [0, 2, 4, 6].map((offset) => stereo.readInt16LE(offset)),
    [1000, 1000, 1000, 1000],
  );
  assert.deepEqual(
    [8, 10, 12, 14].map((offset) => stereo.readInt16LE(offset)),
    [-2000, -2000, -2000, -2000],
  );

  const callbackPcm = pcm16Stereo48kToMono24k(
    stereoFrame([1000, 3000, 5000, 7000]),
  );
  assert.equal(callbackPcm.length, 2);
  assert.equal(callbackPcm.readInt16LE(0), 4000);
});

test('native Opus and DAVE dependencies are available', () => {
  const { OpusEncoder } = require('@discordjs/opus') as {
    OpusEncoder: new (
      rate: number,
      channels: number,
    ) => {
      encode(pcm: Buffer, frameSize: number): Buffer;
      decode(packet: Buffer): Buffer;
    };
  };
  const encoder = new OpusEncoder(48_000, 2);
  const pcm = Buffer.alloc(960 * 2 * 2);
  const packet = encoder.encode(pcm, 960);
  assert.ok(packet.length > 0);
  assert.equal(encoder.decode(packet).length, pcm.length);
  assert.match(generateDependencyReport(), /@snazzah\/davey: 0\.1\./);
});

test('session subscribes only to the operator and emits bounded PCM/VAD callbacks', async (t) => {
  const received: Buffer[] = [];
  let speechStarts = 0;
  let utteranceEnds = 0;
  const harness = makeHarness({
    onAudio: (pcm) => received.push(Buffer.from(pcm)),
    onSpeechStart: () => speechStarts++,
    onUtteranceEnd: () => utteranceEnds++,
  });
  t.after(() => harness.session.close());

  await harness.session.connect(makeVoiceChannel() as never);
  assert.deepEqual(
    harness.receiver.subscriptions.map((s) => s.userId),
    ['123456789'],
  );
  assert.equal(harness.joinOptions[0].selfDeaf, false);
  assert.equal(harness.joinOptions[0].daveEncryption, true);

  harness.receiver.speaking.emit('start', 'other-user');
  assert.equal(speechStarts, 0);
  harness.receiver.speaking.emit('start', '123456789');
  assert.equal(speechStarts, 1);
  const stream = harness.receiver.subscriptions[0].stream;
  stream.write(stereoFrame([1000, 3000, 5000, 7000]));
  await tick();
  assert.equal(received.length, 1);
  assert.equal(received[0].readInt16LE(0), 4000);
  stream.write(stereoFrame([2000, 4000, 6000, 8000]));
  await tick();
  assert.equal(Buffer.concat(received).length, 4);

  harness.receiver.speaking.emit('end', 'other-user');
  assert.equal(utteranceEnds, 0);
  harness.receiver.speaking.emit('end', '123456789');
  assert.equal(utteranceEnds, 1);
  stream.end();
  await tick();
  assert.equal(utteranceEnds, 1);
  assert.equal(harness.receiver.subscriptions.length, 1);
});

test('playback is converted, bounded, drainable, and interruptible', async (t) => {
  const harness = makeHarness({ maxPlaybackBufferBytes: 16 });
  t.after(() => harness.session.close());
  await harness.session.connect(makeVoiceChannel() as never);

  const input = Buffer.alloc(6);
  input.writeInt16LE(1000, 0);
  input.writeInt16LE(-1000, 2);
  input.writeInt16LE(3000, 4);
  assert.equal(harness.session.playPcm16(input), false);
  assert.equal(harness.resourceInputs.length, 1);
  const output: Buffer[] = [];
  harness.resourceInputs[0].on('data', (chunk) =>
    output.push(Buffer.from(chunk)),
  );
  await tick();
  assert.equal(Buffer.concat(output).length, 16);

  const receipt = harness.session.finishPlayback();
  await tick();
  harness.player.emit('idle');
  assert.equal(await receipt, 0);

  const played = harness.session.playPcm16(Buffer.from([0, 0]));
  assert.equal(played, true);
  const interruptedReceipt = harness.session.finishPlayback();
  const interruptedMs = harness.session.interruptPlayback();
  assert.equal(interruptedMs, 0);
  assert.equal(await interruptedReceipt, interruptedMs);
  assert.deepEqual(harness.player.stopCalls, [true]);
});

test('playback stream wakes for delayed chunks and reaches EOF after draining', async (t) => {
  const harness = makeHarness({ maxPlaybackBufferBytes: 32 });
  t.after(() => harness.session.close());
  await harness.session.connect(makeVoiceChannel() as never);

  assert.equal(harness.session.playPcm16(Buffer.from([1, 0])), true);
  assert.equal(harness.resourceInputs.length, 1);
  const observed: Buffer[] = [];
  harness.resourceInputs[0].on('data', (chunk) =>
    observed.push(Buffer.from(chunk)),
  );
  await tick();
  assert.equal(observed.length, 1);
  assert.equal(harness.resourceInputs[0].readableLength, 0);

  // This chunk arrives after the first one has fully drained. It must wake the
  // same Readable rather than waiting forever for another initial _read call.
  assert.equal(harness.session.playPcm16(Buffer.from([2, 0])), true);
  await tick();
  assert.equal(observed.length, 2);
  assert.equal(harness.resourceInputs[0].readableLength, 0);

  const receipt = harness.session.finishPlayback();
  await tick();
  assert.equal(harness.resourceInputs[0].readableEnded, true);
  harness.player.emit('idle');
  assert.equal(await receipt, 0);
});

test('receive and playback failures reach onError without unhandled audio data', async (t) => {
  const errors: Error[] = [];
  const harness = makeHarness({ onError: (error) => errors.push(error) });
  t.after(() => harness.session.close());
  await harness.session.connect(makeVoiceChannel() as never);

  harness.receiver.subscriptions[0].stream.destroy(
    new Error('decode input failed'),
  );
  await tick();
  assert.ok(
    errors.some((error) => error.message.includes('Discord audio receive')),
  );

  assert.equal(harness.session.playPcm16(Buffer.from([0, 0])), true);
  const receipt = harness.session.finishPlayback();
  harness.player.emit('error', new Error('player failed'));
  await assert.rejects(receipt, /Discord audio playback/);
});

test('external voice state loss reports once, closes resources, and is idempotent', async () => {
  const errors: Error[] = [];
  const harness = makeHarness({ onError: (error) => errors.push(error) });
  await harness.session.connect(makeVoiceChannel() as never);

  harness.connection.emit(
    'stateChange',
    { status: VoiceConnectionStatus.Ready },
    { status: VoiceConnectionStatus.Disconnected },
  );
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'Discord voice connection disconnected');
  assert.equal(harness.connection.destroyed, true);
  assert.equal(harness.session.connection, null);

  harness.session.close();
  harness.connection.state.status = VoiceConnectionStatus.Destroyed;
  harness.connection.emit(
    'stateChange',
    { status: VoiceConnectionStatus.Disconnected },
    { status: VoiceConnectionStatus.Destroyed },
  );
  assert.equal(errors.length, 1);
});

test('receive utterance overflow reports and closes instead of dropping silently', async (t) => {
  const errors: Error[] = [];
  const harness = makeHarness({
    maxUtteranceBytes: 2,
    onError: (error) => errors.push(error),
  });
  t.after(() => harness.session.close());
  await harness.session.connect(makeVoiceChannel() as never);
  const stream = harness.receiver.subscriptions[0].stream;
  stream.write(stereoFrame([1000, 3000, 5000, 7000]));
  await tick();
  stream.write(stereoFrame([2000, 4000, 6000, 8000]));
  await tick();
  assert.equal(
    errors.some((error) =>
      error.message.includes('Discord receive utterance exceeded'),
    ),
    true,
  );
  assert.equal(harness.session.connection, null);
  assert.equal(harness.connection.destroyed, true);
});
