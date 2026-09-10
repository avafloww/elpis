import { EventEmitter } from 'node:events';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import prism from 'prism-media';
import {
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioResource,
  type VoiceConnection,
  type DiscordGatewayAdapterCreator,
} from '@discordjs/voice';
import type { VoiceChannel } from 'discord.js';

/** The PCM format exposed to the inhabitant's audio callback. */
export const VOICE_CALLBACK_SAMPLE_RATE = 24_000;
export const VOICE_CALLBACK_CHANNELS = 1;

/** The PCM format that Discord's Opus encoder consumes. */
export const DISCORD_SAMPLE_RATE = 48_000;
export const DISCORD_CHANNELS = 2;
export const DISCORD_FRAME_SAMPLES = 960;
export const MAX_RESPONSE_AUDIO_SECONDS = 120;

const BYTES_PER_SAMPLE = 2;

export interface DiscordAudioError extends Error {
  cause?: unknown;
}

export interface DiscordAudioSessionOptions {
  /** Discord user id whose microphone is allowed to reach the callback. */
  operatorUserId: string;
  /** Called for each bounded PCM16 mono 24 kHz receive chunk. */
  onAudio?: (pcm16Mono24k: Buffer) => void | Promise<void>;
  /** Called when the operator starts a receive utterance. */
  onSpeechStart?: () => void | Promise<void>;
  /** Called when Discord's speaking map reports that the operator stopped. */
  onUtteranceEnd?: () => void | Promise<void>;
  /** Receives operational errors. Audio bytes are never included. */
  onError?: (error: DiscordAudioError) => void;
  /** Silence required to finish one receive utterance. */
  utteranceSilenceMs?: number;
  /** Maximum PCM bytes delivered for one utterance. */
  maxUtteranceBytes?: number;
  /** Maximum bytes buffered for outbound playback. */
  maxPlaybackBufferBytes?: number;
  /** Maximum Opus packets retained by the receive stream's object queue. */
  maxReceivePackets?: number;
  /** Maximum time to wait for the voice connection to become ready. */
  readyTimeoutMs?: number;
  /** Dependency overrides keep the adapter deterministic and network-free in tests. */
  dependencies?: Partial<DiscordAudioDependencies>;
}

export interface DiscordAudioSession {
  /** Join one voice channel and start the operator-only receive pipeline. */
  connect(channel: VoiceChannel): Promise<VoiceConnection>;
  /** Queue PCM16 mono 24 kHz for Discord playback. Returns false if bounded storage is full. */
  playPcm16(pcm16Mono24k: Uint8Array): boolean;
  /** Finish the current response and resolve with the duration actually played. */
  finishPlayback(): Promise<number>;
  /** Immediately stop playback, discard queued audio, and return duration already played. */
  interruptPlayback(): number;
  /** Stop receive/playback and destroy the voice connection. */
  close(): void;
  /** The current connection, if connected. */
  readonly connection: VoiceConnection | null;
}

interface AudioPlayerLike extends EventEmitter {
  play(resource: AudioResource): void;
  stop(force?: boolean): boolean;
  state?: { status?: string };
}

interface ReceiveStreamLike extends Readable {
  end?: unknown;
}

interface VoiceReceiverLike {
  speaking: EventEmitter;
  subscribe(
    userId: string,
    options?: Record<string, unknown>,
  ): ReceiveStreamLike;
}

interface VoiceConnectionLike extends EventEmitter {
  receiver: VoiceReceiverLike;
  subscribe(player: AudioPlayerLike): unknown;
  destroy(adapterAvailable?: boolean): void;
  state: { status?: string };
}

export interface DiscordAudioDependencies {
  joinVoiceChannel(options: {
    channelId: string;
    guildId: string;
    adapterCreator: DiscordGatewayAdapterCreator;
    selfDeaf: boolean;
    selfMute: boolean;
    daveEncryption: boolean;
  }): VoiceConnection;
  createAudioPlayer(options?: Record<string, unknown>): AudioPlayerLike;
  createAudioResource(
    input: Readable,
    options: {
      inputType: StreamType;
      metadata: { kind: 'elpis-discord-voice' };
    },
  ): AudioResource;
  entersState(
    connection: VoiceConnection,
    status: VoiceConnectionStatus,
    timeout: number,
  ): Promise<VoiceConnection>;
  createDecoder(options: {
    rate: number;
    channels: number;
    frameSize: number;
  }): Transform;
}

const defaultDependencies: DiscordAudioDependencies = {
  joinVoiceChannel: (options) => joinVoiceChannel(options),
  createAudioPlayer: (options) =>
    createAudioPlayer(options as Parameters<typeof createAudioPlayer>[0]),
  createAudioResource: (input, options) => createAudioResource(input, options),
  entersState: (connection, status, timeout) =>
    entersState(connection, status, timeout),
  createDecoder: (options) => new prism.opus.Decoder(options),
};

function errorFromUnknown(value: unknown, prefix?: string): DiscordAudioError {
  const error =
    value instanceof Error
      ? value
      : new Error(typeof value === 'string' ? value : 'Discord audio failure');
  if (prefix) {
    const wrapped = new Error(`${prefix}: ${error.message}`, { cause: error });
    return wrapped as DiscordAudioError;
  }
  return error as DiscordAudioError;
}

function invokeSafely(
  callback: (() => void | Promise<void>) | undefined,
  onError: (error: DiscordAudioError) => void,
): void {
  if (!callback) return;
  try {
    Promise.resolve(callback()).catch((error: unknown) =>
      onError(errorFromUnknown(error)),
    );
  } catch (error) {
    onError(errorFromUnknown(error));
  }
}

/**
 * Convert PCM16 mono 24 kHz to the 48 kHz stereo PCM expected by Discord's
 * Opus encoder. Zero-order upsampling keeps this operation allocation-bounded
 * and introduces no asynchronous buffering; the encoder performs 20 ms packetization.
 */
export function pcm16Mono24kToStereo48k(input: Uint8Array): Buffer {
  const sampleCount = Math.floor(input.byteLength / BYTES_PER_SAMPLE);
  const output = Buffer.allocUnsafe(sampleCount * 8);
  for (let sample = 0; sample < sampleCount; sample++) {
    const value = input[sample * 2] | (input[sample * 2 + 1] << 8);
    const offset = sample * 8;
    output.writeInt16LE((value << 16) >> 16, offset);
    output.writeInt16LE((value << 16) >> 16, offset + 2);
    output.writeInt16LE((value << 16) >> 16, offset + 4);
    output.writeInt16LE((value << 16) >> 16, offset + 6);
  }
  return output;
}

/**
 * Convert complete PCM16 stereo 48 kHz frames to mono 24 kHz. Each output
 * sample averages two adjacent stereo frames, providing a small anti-aliasing
 * filter while preserving signed PCM16 range.
 *
 * Incomplete trailing frames are intentionally ignored. The receive transform
 * below carries those bytes into the next decoder chunk.
 */
export function pcm16Stereo48kToMono24k(input: Uint8Array): Buffer {
  const completeSamples = Math.floor(input.byteLength / 8);
  const output = Buffer.allocUnsafe(completeSamples * 2);
  for (let sample = 0; sample < completeSamples; sample++) {
    const first = sample * 8;
    const left0 = input[first] | (input[first + 1] << 8);
    const right0 = input[first + 2] | (input[first + 3] << 8);
    const left1 = input[first + 4] | (input[first + 5] << 8);
    const right1 = input[first + 6] | (input[first + 7] << 8);
    const average =
      (((left0 << 16) >> 16) +
        ((right0 << 16) >> 16) +
        ((left1 << 16) >> 16) +
        ((right1 << 16) >> 16)) /
      4;
    output.writeInt16LE(
      Math.max(-32768, Math.min(32767, Math.round(average))),
      sample * 2,
    );
  }
  return output;
}

/** Stream conversion used after the Discord Opus decoder. */
export class Pcm16Stereo48kToMono24kTransform extends Transform {
  private pending = Buffer.alloc(0);
  private previousMono: number | null = null;

  constructor() {
    super();
  }

  override _transform(
    chunk: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      const input = this.pending.length
        ? Buffer.concat([this.pending, Buffer.from(chunk)])
        : Buffer.from(chunk);
      const completeBytes = input.length - (input.length % 4);
      const complete = input.subarray(0, completeBytes);
      this.pending = input.subarray(completeBytes);

      const output = Buffer.allocUnsafe(
        Math.floor(complete.length / 8) * 2 + 2,
      );
      let outputOffset = 0;
      for (let offset = 0; offset + 3 < complete.length; offset += 4) {
        const left = complete.readInt16LE(offset);
        const right = complete.readInt16LE(offset + 2);
        const mono = Math.round((left + right) / 2);
        if (this.previousMono === null) {
          this.previousMono = mono;
        } else {
          output.writeInt16LE(
            Math.max(
              -32768,
              Math.min(32767, Math.round((this.previousMono + mono) / 2)),
            ),
            outputOffset,
          );
          outputOffset += 2;
          this.previousMono = null;
        }
      }
      if (outputOffset > 0) this.push(output.subarray(0, outputOffset));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    // An odd final stereo frame cannot form a complete output sample. Do not
    // synthesize microphone data at utterance boundaries.
    this.pending = Buffer.alloc(0);
    this.previousMono = null;
    callback();
  }
}

/**
 * A Readable with a hard byte bound. `enqueue` truncates only at complete
 * stereo PCM frames and returns the number of bytes accepted.
 */
class BoundedPlaybackStream extends Readable {
  private readonly maxBytes: number;
  private readonly pending: Buffer[] = [];
  private pendingBytes = 0;
  private endRequested = false;
  private endPushed = false;

  constructor(maxBytes: number) {
    super({ highWaterMark: maxBytes });
    this.maxBytes = maxBytes;
  }

  enqueue(input: Uint8Array): number {
    if (this.destroyed || this.readableEnded || this.endRequested) return 0;
    const available = this.maxBytes - this.readableLength - this.pendingBytes;
    const completeBytes = Math.max(
      0,
      Math.floor(Math.min(input.byteLength, available) / 4) * 4,
    );
    if (completeBytes === 0) return 0;
    const chunk = Buffer.from(input.subarray(0, completeBytes));
    this.pending.push(chunk);
    this.pendingBytes += completeBytes;
    // A prior `_read()` may have returned while the queue was empty, leaving
    // Node's internal `reading` flag set. Calling the implementation directly
    // is the explicit producer wakeup that handles later asynchronous chunks;
    // `read(0)` is a no-op in that state.
    this._read();
    return completeBytes;
  }

  clear(): void {
    this.pending.length = 0;
    this.pendingBytes = 0;
    this.endRequested = false;
    this.endPushed = false;
  }

  availableBytes(): number {
    return Math.max(0, this.maxBytes - this.readableLength - this.pendingBytes);
  }

  get finishRequested(): boolean {
    return this.endRequested;
  }

  finishInput(): void {
    if (this.destroyed || this.readableEnded) return;
    this.endRequested = true;
    this._read();
  }

  override _read(): void {
    while (this.pending.length > 0 && this.readableLength < this.maxBytes) {
      const chunk = this.pending.shift();
      if (!chunk) break;
      this.pendingBytes -= chunk.length;
      const room = this.maxBytes - this.readableLength;
      if (room <= 0) {
        this.pending.unshift(chunk);
        this.pendingBytes += chunk.length;
        break;
      }
      const completeBytes = Math.floor(Math.min(chunk.length, room) / 4) * 4;
      if (completeBytes <= 0) {
        this.pending.unshift(chunk);
        this.pendingBytes += chunk.length;
        break;
      }
      this.push(chunk.subarray(0, completeBytes));
      if (completeBytes < chunk.length) {
        const remainder = chunk.subarray(completeBytes);
        this.pending.unshift(remainder);
        this.pendingBytes += remainder.length;
      }
      if (this.readableLength >= this.maxBytes) break;
    }
    if (this.endRequested && !this.endPushed && this.pending.length === 0) {
      this.endPushed = true;
      this.push(null);
    }
  }
}

class DiscordAudioSessionImpl implements DiscordAudioSession {
  private readonly options: Required<
    Pick<
      DiscordAudioSessionOptions,
      | 'utteranceSilenceMs'
      | 'maxUtteranceBytes'
      | 'maxPlaybackBufferBytes'
      | 'maxReceivePackets'
      | 'readyTimeoutMs'
    >
  >;
  private readonly deps: DiscordAudioDependencies;
  private _connection: VoiceConnectionLike | null = null;
  private player: AudioPlayerLike | null = null;
  private playerSubscription: unknown = null;
  private playbackStream: BoundedPlaybackStream | null = null;
  private playbackResource: AudioResource | null = null;
  private playbackFinish: Promise<number> | null = null;
  private playbackFinishResolve: ((playedMs: number) => void) | null = null;
  private playbackFinishReject: ((error: Error) => void) | null = null;
  private playbackFinishIdleListener: (() => void) | null = null;
  private receiveStream: ReceiveStreamLike | null = null;
  private receiveDecoder: Transform | null = null;
  private receiveConverter: Pcm16Stereo48kToMono24kTransform | null = null;
  private utteranceBytes = 0;
  private utteranceLimited = false;
  private utteranceStarted = false;
  private closing = false;
  private connectPromise: Promise<VoiceConnection> | null = null;
  private readonly onSpeakingStartBound = (userId: string) => {
    if (userId !== this.config.operatorUserId) return;
    if (!this.receiveStream) this.startReceiveSubscription();
    this.invoke(this.config.onSpeechStart);
  };
  private readonly onSpeakingEndBound = (userId: string) => {
    if (userId === this.config.operatorUserId && this.utteranceStarted) {
      // SpeakingMap's end event is a useful fallback when a stream was
      // interrupted by a decoder error. Normal utterances use stream end below.
      this.invoke(this.config.onUtteranceEnd);
      this.utteranceStarted = false;
    }
  };
  private readonly onConnectionErrorBound = (error: unknown) => {
    this.reportError(errorFromUnknown(error, 'Discord voice connection'));
  };
  private readonly onConnectionStateChangeBound = (
    _oldState: unknown,
    newState: unknown,
  ) => {
    if (this.closing || !newState || typeof newState !== 'object') return;
    const status = (newState as { status?: unknown }).status;
    if (
      status !== VoiceConnectionStatus.Disconnected &&
      status !== VoiceConnectionStatus.Destroyed
    )
      return;
    this.reportError(
      errorFromUnknown(new Error('Discord voice connection disconnected')),
    );
    this.close();
  };

  constructor(private readonly config: DiscordAudioSessionOptions) {
    if (!config.operatorUserId || !/^\d+$/.test(config.operatorUserId)) {
      throw new TypeError(
        'operatorUserId must be a non-empty Discord snowflake',
      );
    }
    this.options = {
      utteranceSilenceMs: config.utteranceSilenceMs ?? 350,
      maxUtteranceBytes:
        config.maxUtteranceBytes ?? VOICE_CALLBACK_SAMPLE_RATE * 2 * 60,
      maxPlaybackBufferBytes:
        config.maxPlaybackBufferBytes ??
        DISCORD_SAMPLE_RATE *
          DISCORD_CHANNELS *
          BYTES_PER_SAMPLE *
          MAX_RESPONSE_AUDIO_SECONDS,
      maxReceivePackets: config.maxReceivePackets ?? 64,
      readyTimeoutMs: config.readyTimeoutMs ?? 15_000,
    };
    if (
      !Number.isSafeInteger(this.options.utteranceSilenceMs) ||
      this.options.utteranceSilenceMs < 1 ||
      !Number.isSafeInteger(this.options.maxUtteranceBytes) ||
      this.options.maxUtteranceBytes < 2 ||
      !Number.isSafeInteger(this.options.maxReceivePackets) ||
      this.options.maxReceivePackets < 1 ||
      !Number.isSafeInteger(this.options.readyTimeoutMs) ||
      this.options.readyTimeoutMs < 1 ||
      !Number.isSafeInteger(this.options.maxPlaybackBufferBytes)
    ) {
      throw new RangeError('voice audio bounds must be positive');
    }
    if (
      this.options.maxPlaybackBufferBytes <
      DISCORD_CHANNELS * BYTES_PER_SAMPLE * 2
    ) {
      throw new RangeError(
        'maxPlaybackBufferBytes is too small for one stereo frame',
      );
    }
    this.deps = { ...defaultDependencies, ...config.dependencies };
  }

  get connection(): VoiceConnection | null {
    return this._connection as VoiceConnection | null;
  }

  connect(channel: VoiceChannel): Promise<VoiceConnection> {
    if (this.closing)
      return Promise.reject(new Error('Discord audio session is closed'));
    if (this._connection) {
      const currentChannelId = (
        this._connection as unknown as { joinConfig?: { channelId?: string } }
      ).joinConfig?.channelId;
      if (!currentChannelId || currentChannelId === channel.id) {
        return Promise.resolve(this._connection as unknown as VoiceConnection);
      }
      return Promise.reject(
        new Error('Discord audio session already joined another channel'),
      );
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal(channel).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private async connectInternal(
    channel: VoiceChannel,
  ): Promise<VoiceConnection> {
    const connection = this.deps.joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
    }) as unknown as VoiceConnectionLike;
    this._connection = connection;
    connection.on('error', this.onConnectionErrorBound);
    connection.on('stateChange', this.onConnectionStateChangeBound);
    try {
      await this.deps.entersState(
        connection as unknown as VoiceConnection,
        VoiceConnectionStatus.Ready,
        this.options.readyTimeoutMs,
      );
      if (this.closing)
        throw new Error('Discord audio session closed while connecting');
      this.player = this.deps.createAudioPlayer({
        behaviors: { noSubscriber: 'stop' },
      });
      this.player.on('error', (error: unknown) => {
        const playbackError = errorFromUnknown(error, 'Discord audio playback');
        this.reportError(playbackError);
        this.failPlayback(playbackError);
      });
      this.playerSubscription = connection.subscribe(this.player);
      connection.receiver.speaking.on('start', this.onSpeakingStartBound);
      connection.receiver.speaking.on('end', this.onSpeakingEndBound);
      this.startReceiveSubscription();
      return connection as unknown as VoiceConnection;
    } catch (error) {
      this.reportError(errorFromUnknown(error, 'Discord audio connection'));
      connection.removeListener('error', this.onConnectionErrorBound);
      connection.removeListener(
        'stateChange',
        this.onConnectionStateChangeBound,
      );
      if (connection.state.status !== VoiceConnectionStatus.Destroyed)
        this.destroyConnection(connection);
      this._connection = null;
      throw error;
    }
  }

  private startReceiveSubscription(): void {
    const connection = this._connection;
    if (!connection || this.closing || this.receiveStream) return;
    let stream: ReceiveStreamLike | null = null;
    try {
      // This is the only receive subscription. Filtering at subscription time
      // ensures packets from every other participant are never decoded or held.
      stream = connection.receiver.subscribe(this.config.operatorUserId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: this.options.utteranceSilenceMs,
        },
        highWaterMark: this.options.maxReceivePackets,
      });
      const decoder = this.deps.createDecoder({
        rate: DISCORD_SAMPLE_RATE,
        channels: DISCORD_CHANNELS,
        frameSize: DISCORD_FRAME_SAMPLES,
      });
      const converter = new Pcm16Stereo48kToMono24kTransform();
      if (!stream) throw new Error('Discord audio receiver returned no stream');
      const activeStream = stream;
      this.receiveStream = activeStream;
      this.receiveDecoder = decoder;
      this.receiveConverter = converter;
      this.utteranceBytes = 0;
      this.utteranceLimited = false;
      activeStream.once('end', () => this.finishReceiveUtterance(activeStream));
      activeStream.once('close', () =>
        this.finishReceiveUtterance(activeStream),
      );
      activeStream.on('error', (error: unknown) => {
        this.reportError(errorFromUnknown(error, 'Discord audio receive'));
        if (this.receiveStream === activeStream)
          this.clearReceivePipeline(activeStream);
      });
      decoder.on('error', (error: unknown) => {
        this.reportError(errorFromUnknown(error, 'Discord Opus decode'));
        if (this.receiveStream === activeStream)
          this.clearReceivePipeline(activeStream);
      });
      converter.on('data', (chunk: Buffer) => this.handleReceivePcm(chunk));
      converter.on('error', (error: unknown) => {
        this.reportError(errorFromUnknown(error, 'Discord PCM conversion'));
        if (this.receiveStream === activeStream)
          this.clearReceivePipeline(activeStream);
      });
      activeStream.pipe(decoder).pipe(converter);
    } catch (error) {
      this.reportError(errorFromUnknown(error, 'Discord audio subscription'));
      this.clearReceivePipeline(stream);
    }
  }

  private handleReceivePcm(chunk: Buffer): void {
    if (this.closing || chunk.length === 0) return;
    this.utteranceStarted = true;
    if (this.utteranceLimited) return;
    const remaining = this.options.maxUtteranceBytes - this.utteranceBytes;
    if (remaining <= 0) {
      this.utteranceLimited = true;
      this.reportError(
        errorFromUnknown(
          new Error('Discord receive utterance exceeded its configured limit'),
        ),
      );
      this.close();
      return;
    }
    const accepted = chunk.subarray(
      0,
      Math.floor(Math.min(chunk.length, remaining) / 2) * 2,
    );
    if (accepted.length) {
      this.utteranceBytes += accepted.length;
      this.invokeAudio(accepted);
    }
    if (accepted.length < chunk.length) {
      this.utteranceLimited = true;
      this.reportError(
        errorFromUnknown(
          new Error('Discord receive utterance exceeded its configured limit'),
        ),
      );
      this.close();
    }
  }

  private finishReceiveUtterance(stream: ReceiveStreamLike): void {
    if (this.receiveStream !== stream) return;
    this.clearReceivePipeline(stream);
    if (this.utteranceStarted) {
      this.invoke(this.config.onUtteranceEnd);
      this.utteranceStarted = false;
    }
  }

  private clearReceivePipeline(stream: ReceiveStreamLike | null): void {
    if (stream && !stream.destroyed) {
      stream.unpipe();
      stream.destroy();
    }
    if (this.receiveDecoder && !this.receiveDecoder.destroyed)
      this.receiveDecoder.destroy();
    if (this.receiveConverter && !this.receiveConverter.destroyed)
      this.receiveConverter.destroy();
    this.receiveStream = null;
    this.receiveDecoder = null;
    this.receiveConverter = null;
    this.utteranceBytes = 0;
    this.utteranceLimited = false;
  }

  private invokeAudio(chunk: Buffer): void {
    if (!this.config.onAudio) return;
    try {
      Promise.resolve(this.config.onAudio(chunk)).catch((error: unknown) =>
        this.reportError(errorFromUnknown(error, 'Discord audio callback')),
      );
    } catch (error) {
      this.reportError(errorFromUnknown(error, 'Discord audio callback'));
    }
  }

  private invoke(callback: (() => void | Promise<void>) | undefined): void {
    invokeSafely(callback, (error) => this.reportError(error));
  }

  playPcm16(pcm16Mono24k: Uint8Array): boolean {
    if (this.closing || !this.player || pcm16Mono24k.byteLength < 2)
      return false;
    if (
      !this.playbackStream ||
      this.playbackStream.destroyed ||
      this.playbackStream.readableEnded ||
      this.playbackStream.finishRequested
    ) {
      if (this.playbackFinishResolve)
        this.settlePlayback(this.playedPlaybackMs());
      this.playbackStream = new BoundedPlaybackStream(
        this.options.maxPlaybackBufferBytes,
      );
      try {
        const resource = this.deps.createAudioResource(this.playbackStream, {
          inputType: StreamType.Raw,
          metadata: { kind: 'elpis-discord-voice' },
        });
        this.playbackResource = resource;
        this.player.play(resource);
      } catch (error) {
        this.reportError(
          errorFromUnknown(error, 'Discord audio playback setup'),
        );
        this.playbackStream.destroy(error as Error);
        this.playbackStream = null;
        this.playbackResource = null;
        return false;
      }
    }
    const availableInputBytes = Math.floor(
      (this.playbackStream.availableBytes() / 8) * 2,
    );
    const inputBytes = Math.min(
      Math.floor(pcm16Mono24k.byteLength / 2) * 2,
      availableInputBytes,
    );
    if (inputBytes <= 0) return false;
    const converted = pcm16Mono24kToStereo48k(
      pcm16Mono24k.subarray(0, inputBytes),
    );
    const accepted = this.playbackStream.enqueue(converted);
    const completeInputBytes = Math.floor(pcm16Mono24k.byteLength / 2) * 2;
    return inputBytes === completeInputBytes && accepted === converted.length;
  }

  finishPlayback(): Promise<number> {
    if (!this.playbackStream || !this.playbackResource || !this.player) {
      return Promise.resolve(0);
    }
    if (this.playbackFinish) return this.playbackFinish;
    this.playbackFinish = new Promise<number>((resolve, reject) => {
      this.playbackFinishResolve = resolve;
      this.playbackFinishReject = reject;
      const onIdle = () => this.settlePlayback(this.playedPlaybackMs());
      this.playbackFinishIdleListener = onIdle;
      this.player?.once('idle', onIdle);
    });
    this.playbackStream.finishInput();
    // A fake/injected player may not expose state events. A real player emits
    // `idle` after its resource reaches EOF; this fallback handles an already
    // ended resource without leaving the caller's receipt promise pending.
    if (this.playbackResource.ended && this.player.state?.status === 'idle') {
      queueMicrotask(() => this.settlePlayback(this.playedPlaybackMs()));
    }
    return this.playbackFinish;
  }

  interruptPlayback(): number {
    const playedMs = this.playedPlaybackMs();
    this.settlePlayback(playedMs);
    if (this.playbackStream) {
      this.playbackStream.clear();
      this.playbackStream.destroy();
      this.playbackStream = null;
    }
    try {
      this.player?.stop(true);
    } catch (error) {
      this.reportError(errorFromUnknown(error, 'Discord audio playback stop'));
    }
    this.playbackResource = null;
    return playedMs;
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.interruptPlayback();
    this.clearReceivePipeline(this.receiveStream);
    const connection = this._connection;
    if (connection) {
      connection.receiver.speaking.removeListener(
        'start',
        this.onSpeakingStartBound,
      );
      connection.receiver.speaking.removeListener(
        'end',
        this.onSpeakingEndBound,
      );
      connection.removeListener('error', this.onConnectionErrorBound);
      connection.removeListener(
        'stateChange',
        this.onConnectionStateChangeBound,
      );
      if (connection.state.status !== VoiceConnectionStatus.Destroyed)
        this.destroyConnection(connection);
    }
    this.playerSubscription = null;
    this.player = null;
    this._connection = null;
  }

  private destroyConnection(connection: VoiceConnectionLike): void {
    try {
      connection.destroy();
    } catch (error) {
      this.reportError(
        errorFromUnknown(error, 'Discord audio connection cleanup'),
      );
    }
  }

  private playedPlaybackMs(): number {
    const duration = this.playbackResource?.playbackDuration;
    return typeof duration === 'number' && Number.isFinite(duration)
      ? duration
      : 0;
  }

  private settlePlayback(playedMs: number): void {
    const resolve = this.playbackFinishResolve;
    if (!resolve) return;
    this.clearPlaybackFinishListeners();
    this.playbackFinishResolve = null;
    this.playbackFinishReject = null;
    this.playbackFinish = null;
    resolve(Math.max(0, playedMs));
  }

  private failPlayback(error: Error): void {
    const reject = this.playbackFinishReject;
    if (!reject) return;
    this.clearPlaybackFinishListeners();
    this.playbackFinishResolve = null;
    this.playbackFinishReject = null;
    this.playbackFinish = null;
    reject(error);
  }

  private clearPlaybackFinishListeners(): void {
    if (this.playbackFinishIdleListener && this.player) {
      this.player.removeListener('idle', this.playbackFinishIdleListener);
    }
    this.playbackFinishIdleListener = null;
  }

  private reportError(error: DiscordAudioError): void {
    try {
      this.config.onError?.(error);
    } catch {
      // Error observers cannot be allowed to destabilize the voice pipeline.
    }
  }
}

export function createDiscordAudioSession(
  options: DiscordAudioSessionOptions,
): DiscordAudioSession {
  return new DiscordAudioSessionImpl(options);
}
