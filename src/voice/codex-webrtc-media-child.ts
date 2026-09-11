import { types as utilTypes } from 'node:util';

export interface CodexWebRtcPeerCallbacks {
  onAudio(audio: Uint8Array): void;
  onEvent(text: string): void;
  onError(error: Error): void;
}

export interface CodexWebRtcMediaPeer {
  createOffer(): string | Promise<string>;
  applyAnswer(sdp: string): void | Promise<void>;
  appendAudio(audio: Uint8Array): void | Promise<void>;
  sendEvent(text: string): void | Promise<void>;
  close(): void | Promise<void>;
}

export interface CodexWebRtcMediaChildLimits {
  maxIpcMessageBytes: number;
  maxCallIdBytes: number;
  maxSdpBytes: number;
  maxAudioBytes: number;
  maxInputAudioBytes: number;
  maxEventBytes: number;
}

export interface CodexWebRtcMediaChildRuntime {
  receive(message: unknown): void;
  terminate(error: Error): void;
}

type IpcSend = (
  message: Record<string, unknown>,
  callback: (error: Error | null) => void,
) => boolean;

type RuntimeOptions = {
  createPeer(callbacks: CodexWebRtcPeerCallbacks): CodexWebRtcMediaPeer;
  send: IpcSend;
  exit(code: 0 | 1): void;
  limits: CodexWebRtcMediaChildLimits;
};

type State =
  | 'awaiting-offer'
  | 'creating-offer'
  | 'sending-offer'
  | 'awaiting-answer'
  | 'applying-answer'
  | 'sending-ready'
  | 'ready'
  | 'closing'
  | 'terminal';

function requireLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function inertInput(input: unknown): Record<string, unknown> {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    utilTypes.isProxy(input)
  )
    throw new TypeError('media IPC message must be an inert object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('media IPC message must be plain own data');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string')
      throw new TypeError('media IPC message cannot contain symbols');
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !('value' in descriptor))
      throw new TypeError('media IPC message must contain own data');
    const value = descriptor.value;
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'boolean' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      throw new TypeError('media IPC fields must be inert scalar data');
    output[key] = value;
  }
  return output;
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('media IPC message must be an object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('media IPC message must be plain own data');
  const ownKeys = Reflect.ownKeys(input);
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== keys.length ||
    keys.some((key) => !ownKeys.includes(key))
  )
    throw new TypeError('media IPC message has an unexpected shape');
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor))
      throw new TypeError('media IPC message must contain own data');
    output[key] = descriptor.value;
  }
  return output;
}

function ownFields(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('media IPC message must be an object');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null)
    throw new TypeError('media IPC message must be plain own data');
  const output = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor))
      throw new TypeError('media IPC message must contain own data');
    output[key] = descriptor.value;
  }
  return output;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function wireBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function strictBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new TypeError('audio must use canonical base64');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value)
    throw new TypeError('audio must use canonical base64');
  return decoded;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createCodexWebRtcMediaChildRuntime(
  options: RuntimeOptions,
): CodexWebRtcMediaChildRuntime {
  const limits = {
    maxIpcMessageBytes: requireLimit(
      options.limits.maxIpcMessageBytes,
      'maxIpcMessageBytes',
    ),
    maxCallIdBytes: requireLimit(
      options.limits.maxCallIdBytes,
      'maxCallIdBytes',
    ),
    maxSdpBytes: requireLimit(options.limits.maxSdpBytes, 'maxSdpBytes'),
    maxAudioBytes: requireLimit(options.limits.maxAudioBytes, 'maxAudioBytes'),
    maxInputAudioBytes: requireLimit(
      options.limits.maxInputAudioBytes,
      'maxInputAudioBytes',
    ),
    maxEventBytes: requireLimit(options.limits.maxEventBytes, 'maxEventBytes'),
  };

  let state: State = 'awaiting-offer';
  let callId: string | undefined;
  let peerCloseAttempted = false;
  let exitCalled = false;
  let pendingSendBytes = 0;
  let pendingInputBytes = 0;
  let bufferedReadyBytes = 0;
  const bufferedReadyMessages: Array<Record<string, unknown>> = [];
  let inputChain = Promise.resolve();

  const terminal = (): boolean => state === 'terminal' || exitCalled;

  const exitOnce = (code: 0 | 1): void => {
    if (exitCalled) return;
    exitCalled = true;
    state = 'terminal';
    options.exit(code);
  };

  let peer!: CodexWebRtcMediaPeer;
  let peerBound = false;
  let deferredPeerFailure: Error | undefined;

  const closePeer = async (): Promise<void> => {
    if (peerCloseAttempted) return;
    peerCloseAttempted = true;
    await peer.close();
  };

  const fail = (error: unknown): void => {
    if (state === 'terminal' || exitCalled) return;
    state = 'terminal';
    bufferedReadyMessages.length = 0;
    bufferedReadyBytes = 0;
    void closePeer().catch(() => undefined);
    exitOnce(1);
    void asError(error);
  };

  const send = (message: Record<string, unknown>): Promise<void> => {
    const bytes = wireBytes(message);
    if (bytes > limits.maxIpcMessageBytes)
      return Promise.reject(new RangeError('media IPC message is too large'));
    if (pendingSendBytes + bytes > limits.maxIpcMessageBytes)
      return Promise.reject(new RangeError('media IPC backlog is too large'));
    pendingSendBytes += bytes;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const callback = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        pendingSendBytes -= bytes;
        if (error) reject(asError(error));
        else resolve();
      };
      try {
        options.send(message, callback);
      } catch (error) {
        callback(asError(error));
      }
    });
  };

  const forward = (message: Record<string, unknown>): void => {
    const bytes = wireBytes(message);
    if (bytes > limits.maxIpcMessageBytes) {
      fail(new RangeError('media IPC message is too large'));
      return;
    }
    if (state === 'applying-answer' || state === 'sending-ready') {
      if (bufferedReadyBytes + bytes > limits.maxIpcMessageBytes) {
        fail(new RangeError('media readiness backlog is too large'));
        return;
      }
      bufferedReadyMessages.push(message);
      bufferedReadyBytes += bytes;
      return;
    }
    if (state !== 'ready') {
      fail(new Error('peer media arrived before answer readiness'));
      return;
    }
    void send(message).catch(fail);
  };

  const flushReadyMessages = (): void => {
    while (bufferedReadyMessages.length > 0 && !terminal()) {
      const message = bufferedReadyMessages.shift()!;
      bufferedReadyBytes -= wireBytes(message);
      void send(message).catch(fail);
    }
    if (!terminal()) state = 'ready';
  };

  const correlatedCallId = (value: unknown): string => {
    if (typeof value !== 'string' || value.length === 0)
      throw new TypeError('media IPC call ID is invalid');
    if (utf8Bytes(value) > limits.maxCallIdBytes)
      throw new RangeError('media IPC call ID is too large');
    if (callId !== undefined && value !== callId)
      throw new Error('media IPC call correlation failed');
    return value;
  };

  const requireWireBound = (message: Record<string, unknown>): void => {
    if (wireBytes(message) > limits.maxIpcMessageBytes)
      throw new RangeError('media IPC message is too large');
  };

  const handle = async (input: unknown): Promise<void> => {
    if (state === 'terminal' || state === 'closing') return;
    const base = ownFields(input, ['type', 'callId']);
    if (typeof base.type !== 'string')
      throw new TypeError('media IPC message type is invalid');

    if (base.type === 'offer.create') {
      const message = exactRecord(input, ['type', 'callId']);
      requireWireBound(message);
      if (state !== 'awaiting-offer')
        throw new Error('unexpected or duplicate media offer request');
      const id = correlatedCallId(message.callId);
      callId = id;
      state = 'creating-offer';
      const sdp = await peer.createOffer();
      if (terminal()) return;
      if (typeof sdp !== 'string' || sdp.length === 0)
        throw new TypeError('media offer SDP is invalid');
      if (utf8Bytes(sdp) > limits.maxSdpBytes)
        throw new RangeError('media offer SDP is too large');
      const response = { type: 'offer', callId: id, sdp };
      requireWireBound(response);
      state = 'sending-offer';
      await send(response);
      if (terminal()) return;
      state = 'awaiting-answer';
      return;
    }

    if (base.type === 'answer.apply') {
      const message = exactRecord(input, ['type', 'callId', 'sdp']);
      requireWireBound(message);
      if (state !== 'awaiting-answer')
        throw new Error('unexpected or duplicate media answer');
      correlatedCallId(message.callId);
      if (typeof message.sdp !== 'string' || message.sdp.length === 0)
        throw new TypeError('media answer SDP is invalid');
      if (utf8Bytes(message.sdp) > limits.maxSdpBytes)
        throw new RangeError('media answer SDP is too large');
      state = 'applying-answer';
      await peer.applyAnswer(message.sdp);
      if (terminal()) return;
      const response = { type: 'ready', callId: callId! };
      requireWireBound(response);
      state = 'sending-ready';
      await send(response);
      if (terminal()) return;
      flushReadyMessages();
      return;
    }

    if (base.type === 'audio.append') {
      const message = exactRecord(input, ['type', 'callId', 'audio']);
      requireWireBound(message);
      if (state !== 'ready')
        throw new Error('media audio arrived before ready');
      correlatedCallId(message.callId);
      if (typeof message.audio !== 'string')
        throw new TypeError('media audio must be base64 text');
      const audio = strictBase64(message.audio);
      if (audio.byteLength > limits.maxInputAudioBytes)
        throw new RangeError('media input audio is too large');
      await peer.appendAudio(audio);
      return;
    }

    if (base.type === 'event.send') {
      const message = exactRecord(input, ['type', 'callId', 'text']);
      requireWireBound(message);
      if (state !== 'ready')
        throw new Error('media event arrived before ready');
      correlatedCallId(message.callId);
      if (typeof message.text !== 'string')
        throw new TypeError('media event must be text');
      if (utf8Bytes(message.text) > limits.maxEventBytes)
        throw new RangeError('media event is too large');
      await peer.sendEvent(message.text);
      return;
    }

    if (base.type === 'close') {
      const message = exactRecord(input, ['type', 'callId']);
      requireWireBound(message);
      if (callId === undefined)
        throw new Error('media close arrived before call binding');
      correlatedCallId(message.callId);
      state = 'closing';
      await closePeer();
      const response = { type: 'closed', callId: callId! };
      requireWireBound(response);
      await send(response);
      exitOnce(0);
      return;
    }

    throw new TypeError('unknown media IPC message type');
  };

  const enqueueInput = (message: unknown): void => {
    if (state === 'terminal' || state === 'closing') return;
    let bytes: number;
    let copy: Record<string, unknown>;
    try {
      copy = inertInput(message);
      const encoded = JSON.stringify(copy);
      bytes = Buffer.byteLength(encoded, 'utf8');
      if (bytes > limits.maxIpcMessageBytes)
        throw new RangeError('inbound media IPC message is too large');
      if (pendingInputBytes + bytes > limits.maxIpcMessageBytes)
        throw new RangeError('inbound media IPC backlog is too large');
    } catch (error) {
      fail(error);
      return;
    }
    pendingInputBytes += bytes;
    inputChain = inputChain
      .then(() => handle(copy))
      .then(
        () => {
          pendingInputBytes -= bytes;
        },
        (error) => {
          pendingInputBytes -= bytes;
          fail(error);
        },
      );
  };

  const forwardAudio = (audio: Uint8Array): void => {
    if (terminal() || state === 'closing') return;
    if (!(audio instanceof Uint8Array)) {
      fail(new TypeError('peer audio must be bytes'));
      return;
    }
    if (audio.byteLength > limits.maxAudioBytes) {
      fail(new RangeError('peer audio is too large'));
      return;
    }
    forward({
      type: 'audio',
      callId: callId!,
      audio: Buffer.from(audio).toString('base64'),
    });
  };

  const forwardEvent = (text: string): void => {
    if (terminal() || state === 'closing') return;
    if (typeof text !== 'string') {
      fail(new TypeError('peer event must be text'));
      return;
    }
    if (utf8Bytes(text) > limits.maxEventBytes) {
      fail(new RangeError('peer event is too large'));
      return;
    }
    forward({ type: 'event', callId: callId!, text });
  };

  peer = options.createPeer({
    onAudio(audio) {
      if (!peerBound) {
        deferredPeerFailure ??= new Error(
          'peer audio arrived during construction',
        );
        return;
      }
      forwardAudio(audio);
    },
    onEvent(text) {
      if (!peerBound) {
        deferredPeerFailure ??= new Error(
          'peer event arrived during construction',
        );
        return;
      }
      forwardEvent(text);
    },
    onError(error) {
      if (!peerBound) {
        deferredPeerFailure ??= asError(error);
        return;
      }
      fail(error);
    },
  });
  peerBound = true;
  if (deferredPeerFailure) fail(deferredPeerFailure);

  return { receive: enqueueInput, terminate: fail };
}
