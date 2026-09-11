import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  useOPUS,
} from 'werift';

const { OpusEncoder } = createRequire(import.meta.url)(
  '@discordjs/opus',
) as typeof import('@discordjs/opus');

export type CodexWeriftRtpHeader = {
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
};

type Subscription = { unSubscribe(): void };

type WeriftEvent<Args extends unknown[]> = {
  subscribe(listener: (...args: Args) => void): Subscription;
};

type DataChannelState = 'connecting' | 'open' | 'closing' | 'closed';
type PeerConnectionState =
  'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';
type IceGatheringState = 'new' | 'gathering' | 'complete';

type RtpPacketLike = {
  payload: Uint8Array;
};

type AudioTrack<Packet extends RtpPacketLike> = {
  readonly onReceiveRtp: WeriftEvent<[Packet, unknown?]>;
  writeRtp(packet: Packet): void;
  stop(): void;
};

type DataChannel = {
  readonly onMessage: WeriftEvent<[string | Buffer]>;
  readonly error: WeriftEvent<[Error]>;
  readonly stateChanged: WeriftEvent<[DataChannelState]>;
  readonly readyState: DataChannelState;
  readonly bufferedAmount: number;
  send(text: string): void;
  close(): void;
};

type PeerConnection<Packet extends RtpPacketLike> = {
  readonly connectionStateChange: WeriftEvent<[PeerConnectionState]>;
  readonly iceGatheringStateChange: WeriftEvent<[IceGatheringState]>;
  readonly connectionState: PeerConnectionState;
  readonly iceGatheringState: IceGatheringState;
  readonly localDescription?: { type: string; sdp: string } | null;
  createDataChannel(
    label: string,
    options?: { ordered?: boolean },
  ): DataChannel;
  addTransceiver(
    track: AudioTrack<Packet>,
    options?: { direction?: string },
  ): { receiver: { track: AudioTrack<Packet> } };
  createOffer(): Promise<{ type: 'offer'; sdp: string }>;
  setLocalDescription(description: {
    type: 'offer';
    sdp: string;
  }): Promise<unknown>;
  setRemoteDescription(description: {
    type: 'answer';
    sdp: string;
  }): Promise<unknown>;
  close(): void | Promise<void>;
};

type OpusCodec = {
  encode(pcm: Buffer): Buffer;
  decode(payload: Buffer): Buffer;
};

export type CodexWeriftMediaPeerOptions<Packet extends RtpPacketLike> = {
  createPeerConnection(configuration: {
    codecs: {
      audio: Array<{
        mimeType: 'audio/opus';
        clockRate: 48_000;
        channels: 2;
        payloadType: 111;
      }>;
    };
  }): PeerConnection<Packet>;
  createAudioTrack(): AudioTrack<Packet>;
  opusCodec: OpusCodec;
  randomUint16(): number;
  randomUint32(): number;
  createRtpPacket(header: CodexWeriftRtpHeader, payload: Uint8Array): Packet;
  maxInboundPcmBytes: number;
  maxInboundTextBytes: number;
  maxBufferedAmount: number;
  onAudio(pcm: Uint8Array): void;
  onEvent(text: string): void;
  onError(error: Error): void;
};

export type CodexWeriftMediaPeer = {
  createOffer(): Promise<string>;
  applyAnswer(sdp: string): Promise<void>;
  appendAudio(pcm: Uint8Array): void;
  sendEvent(text: string): void;
  close(): Promise<void>;
};

const PCM_FRAME_BYTES = 960;
const RTP_TIMESTAMP_STEP = 960;

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function uint16(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff)
    throw new TypeError(`${name} must be an unsigned 16-bit integer`);
  return value;
}

function uint32(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff)
    throw new TypeError(`${name} must be an unsigned 32-bit integer`);
  return value;
}

function errorFrom(value: unknown, fallback: string): Error {
  return value instanceof Error ? value : new Error(fallback);
}

export function createCodexWeriftMediaPeer<Packet extends RtpPacketLike>(
  options: CodexWeriftMediaPeerOptions<Packet>,
): CodexWeriftMediaPeer {
  const maxInboundPcmBytes = positiveLimit(
    options.maxInboundPcmBytes,
    'maxInboundPcmBytes',
  );
  const maxInboundTextBytes = positiveLimit(
    options.maxInboundTextBytes,
    'maxInboundTextBytes',
  );
  const maxBufferedAmount = positiveLimit(
    options.maxBufferedAmount,
    'maxBufferedAmount',
  );
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const acquired = (() => {
    let connection: PeerConnection<Packet> | undefined;
    let localTrack: AudioTrack<Packet> | undefined;
    let channel: DataChannel | undefined;
    try {
      connection = options.createPeerConnection({
        codecs: {
          audio: [
            {
              mimeType: 'audio/opus',
              clockRate: 48_000,
              channels: 2,
              payloadType: 111,
            },
          ],
        },
      });
      localTrack = options.createAudioTrack();
      channel = connection.createDataChannel('oai-events', { ordered: true });
      const transceiver = connection.addTransceiver(localTrack, {
        direction: 'sendrecv',
      });
      return {
        connection,
        localTrack,
        channel,
        receiverTrack: transceiver.receiver.track,
        ssrc: uint32(options.randomUint32(), 'RTP SSRC'),
        initialSequenceNumber: uint16(
          options.randomUint16(),
          'RTP sequence number',
        ),
        initialTimestamp: uint32(options.randomUint32(), 'RTP timestamp'),
      };
    } catch (error) {
      try {
        channel?.close();
      } catch {}
      try {
        localTrack?.stop();
      } catch {}
      try {
        void Promise.resolve(connection?.close()).catch(() => undefined);
      } catch {}
      throw error;
    }
  })();
  const { connection, localTrack, channel, receiverTrack, ssrc } = acquired;
  let sequenceNumber = acquired.initialSequenceNumber;
  let timestamp = acquired.initialTimestamp;
  let marker = true;
  let pcmRemainder = Buffer.alloc(0);
  let closed = false;
  let failed = false;
  let reportedError = false;
  let answerStarted = false;
  let closePromise: Promise<void> | undefined;
  let readiness:
    | {
        resolve(): void;
        reject(error: Error): void;
      }
    | undefined;
  let offerWaiter:
    | {
        reject(error: Error): void;
      }
    | undefined;
  const subscriptions: Subscription[] = [];

  const inactive = (): boolean => closed || failed;

  const rejectWaiters = (error: Error): void => {
    const currentReadiness = readiness;
    readiness = undefined;
    currentReadiness?.reject(error);
    const currentOffer = offerWaiter;
    offerWaiter = undefined;
    currentOffer?.reject(error);
  };

  const reportFailure = (value: unknown, fallback: string): void => {
    if (inactive()) return;
    failed = true;
    const error = errorFrom(value, fallback);
    rejectWaiters(error);
    if (reportedError) return;
    reportedError = true;
    options.onError(error);
  };

  const settleReadiness = (): void => {
    if (
      inactive() ||
      connection.connectionState !== 'connected' ||
      channel.readyState !== 'open'
    )
      return;
    const current = readiness;
    readiness = undefined;
    current?.resolve();
  };

  try {
    const addSubscription = (subscribe: () => Subscription): void => {
      subscriptions.push(subscribe());
    };
    addSubscription(() =>
      connection.connectionStateChange.subscribe((state) => {
        if (inactive()) return;
        if (state === 'failed' || state === 'closed') {
          reportFailure(
            new Error(`WebRTC connection ${state}`),
            'WebRTC connection failed',
          );
          return;
        }
        settleReadiness();
      }),
    );
    addSubscription(() =>
      channel.stateChanged.subscribe((state) => {
        if (inactive()) return;
        if (state === 'closed') {
          reportFailure(
            new Error('WebRTC data channel closed'),
            'WebRTC data channel failed',
          );
          return;
        }
        settleReadiness();
      }),
    );
    addSubscription(() =>
      channel.error.subscribe((error) => {
        reportFailure(error, 'WebRTC data channel failed');
      }),
    );
    addSubscription(() =>
      channel.onMessage.subscribe((value) => {
        if (inactive()) return;
        try {
          let text: string;
          if (typeof value === 'string') {
            if (Buffer.byteLength(value, 'utf8') > maxInboundTextBytes)
              throw new RangeError('WebRTC event text exceeds byte limit');
            text = value;
          } else if (Buffer.isBuffer(value)) {
            if (value.byteLength > maxInboundTextBytes)
              throw new RangeError('WebRTC event text exceeds byte limit');
            text = decoder.decode(value);
          } else {
            throw new TypeError('WebRTC event must be text');
          }
          options.onEvent(text);
        } catch (error) {
          reportFailure(error, 'WebRTC event text decode failed');
        }
      }),
    );
    addSubscription(() =>
      receiverTrack.onReceiveRtp.subscribe((packet) => {
        if (inactive()) return;
        try {
          const decoded = options.opusCodec.decode(Buffer.from(packet.payload));
          if (decoded.byteLength > maxInboundPcmBytes)
            throw new RangeError('decoded PCM exceeds byte limit');
          options.onAudio(decoded);
        } catch (error) {
          reportFailure(error, 'WebRTC Opus decode failed');
        }
      }),
    );
  } catch (error) {
    for (const subscription of subscriptions.splice(0)) {
      try {
        subscription.unSubscribe();
      } catch {}
    }
    try {
      channel.close();
    } catch {}
    try {
      localTrack.stop();
    } catch {}
    try {
      void Promise.resolve(connection.close()).catch(() => undefined);
    } catch {}
    throw error;
  }

  const requireActive = (): void => {
    if (closed) throw new Error('WebRTC media peer is closed');
    if (failed) throw new Error('WebRTC media peer has failed');
  };

  const createOffer = async (): Promise<string> => {
    requireActive();
    const draft = await connection.createOffer();
    requireActive();
    await connection.setLocalDescription(draft);
    requireActive();
    if (connection.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const subscription = connection.iceGatheringStateChange.subscribe(
          (state) => {
            if (state !== 'complete' || settled) return;
            settled = true;
            subscription.unSubscribe();
            offerWaiter = undefined;
            resolve();
          },
        );
        offerWaiter = {
          reject(error) {
            if (settled) return;
            settled = true;
            subscription.unSubscribe();
            reject(error);
          },
        };
        if (connection.iceGatheringState === 'complete' && !settled) {
          settled = true;
          subscription.unSubscribe();
          offerWaiter = undefined;
          resolve();
        }
      });
    }
    requireActive();
    const sdp = connection.localDescription?.sdp;
    if (typeof sdp !== 'string' || sdp.length === 0)
      throw new Error('WebRTC local offer SDP is unavailable');
    return sdp;
  };

  const applyAnswer = async (sdp: string): Promise<void> => {
    requireActive();
    if (answerStarted) throw new Error('WebRTC answer was already applied');
    if (typeof sdp !== 'string' || sdp.length === 0)
      throw new TypeError('WebRTC answer SDP is invalid');
    answerStarted = true;
    await connection.setRemoteDescription({ type: 'answer', sdp });
    requireActive();
    const ready = new Promise<void>((resolve, reject) => {
      readiness = { resolve, reject };
    });
    settleReadiness();
    await ready;
  };

  const appendAudio = (pcm: Uint8Array): void => {
    requireActive();
    if (!(pcm instanceof Uint8Array))
      throw new TypeError('WebRTC PCM input must be bytes');
    if (pcm.byteLength > PCM_FRAME_BYTES)
      throw new RangeError('WebRTC PCM append exceeds one 960-byte frame');
    pcmRemainder = Buffer.concat([pcmRemainder, Buffer.from(pcm)]);
    while (pcmRemainder.byteLength >= PCM_FRAME_BYTES) {
      const frame = pcmRemainder.subarray(0, PCM_FRAME_BYTES);
      pcmRemainder = Buffer.from(pcmRemainder.subarray(PCM_FRAME_BYTES));
      const payload = options.opusCodec.encode(frame);
      const packet = options.createRtpPacket(
        {
          marker,
          payloadType: 111,
          sequenceNumber,
          timestamp,
          ssrc,
        },
        payload,
      );
      localTrack.writeRtp(packet);
      marker = false;
      sequenceNumber = (sequenceNumber + 1) & 0xffff;
      timestamp = (timestamp + RTP_TIMESTAMP_STEP) >>> 0;
    }
  };

  const sendEvent = (text: string): void => {
    requireActive();
    if (typeof text !== 'string')
      throw new TypeError('WebRTC event must be text');
    if (channel.readyState !== 'open')
      throw new Error('WebRTC data channel is not open');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (channel.bufferedAmount + bytes > maxBufferedAmount)
      throw new RangeError('WebRTC data channel backpressure limit exceeded');
    channel.send(text);
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    let resolveClose!: () => void;
    let rejectClose!: (error: Error) => void;
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    closed = true;
    rejectWaiters(new Error('WebRTC media peer closed'));
    pcmRemainder = Buffer.alloc(0);

    void (async () => {
      let firstFailure: Error | undefined;
      const attempt = (operation: () => void): void => {
        try {
          operation();
        } catch (error) {
          firstFailure ??= errorFrom(error, 'WebRTC media cleanup failed');
        }
      };
      for (const subscription of subscriptions.splice(0))
        attempt(() => subscription.unSubscribe());
      attempt(() => channel.close());
      attempt(() => localTrack.stop());
      try {
        await connection.close();
      } catch (error) {
        firstFailure ??= errorFrom(error, 'WebRTC peer cleanup failed');
      }
      if (firstFailure) throw firstFailure;
    })().then(resolveClose, rejectClose);
    return closePromise;
  };

  return { createOffer, applyAnswer, appendAudio, sendEvent, close };
}

export type DefaultCodexWeriftMediaPeerOptions = {
  maxInboundPcmBytes: number;
  maxInboundTextBytes: number;
  maxBufferedAmount: number;
  onAudio(pcm: Uint8Array): void;
  onEvent(text: string): void;
  onError(error: Error): void;
};

export function createDefaultCodexWeriftMediaPeer(
  options: DefaultCodexWeriftMediaPeerOptions,
): CodexWeriftMediaPeer {
  return createCodexWeriftMediaPeer<RtpPacket>({
    createPeerConnection: () =>
      new RTCPeerConnection({
        codecs: { audio: [useOPUS({ payloadType: 111 })] },
      }) as unknown as PeerConnection<RtpPacket>,
    createAudioTrack: () =>
      new MediaStreamTrack({
        kind: 'audio',
      }) as unknown as AudioTrack<RtpPacket>,
    opusCodec: new OpusEncoder(24_000, 1),
    randomUint16: () => randomBytes(2).readUInt16BE(0),
    randomUint32: () => randomBytes(4).readUInt32BE(0),
    createRtpPacket: (header, payload) =>
      new RtpPacket(
        new RtpHeader({ version: 2, ...header }),
        Buffer.from(payload),
      ),
    ...options,
  });
}
