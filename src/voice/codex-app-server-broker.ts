import { types as utilTypes } from 'node:util';
import {
  APP_SERVER_MAX_LINE_BYTES,
  AppServerClient,
  type AppServerProcess,
  type AppServerTimers,
} from './app-server-client.js';

type ClientInfo = { name: string; title: string; version: string };
type TimerHandle = unknown;
type StartingClose = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: Error): void;
};
type Signal = 'SIGTERM' | 'SIGKILL';

type Emitter = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
};

type AppChild = Emitter & {
  stdin: Emitter & {
    write(data: string, callback?: (error?: Error | null) => void): boolean;
    end(): void;
  };
  stdout: Emitter;
  kill(signal: Signal): boolean;
};

type MediaChild = Emitter & {
  connected?: boolean;
  send(
    value: Record<string, unknown>,
    callback?: (error: Error | null) => void,
  ): boolean;
  disconnect?(): void;
  kill(signal: Signal): boolean;
};

export interface CodexAppServerVoiceBrokerOptions {
  appServerFactory(): AppChild;
  mediaChildFactory(): MediaChild;
  clientInfo: ClientInfo;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  killTimeoutMs: number;
  maxJsonLineBytes: number;
  maxIpcMessageBytes: number;
  maxAudioFrameBytes: number;
  callIdFactory(): string;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  onAudio?(audio: Uint8Array): void;
  onEvent?(text: string): void;
  onError?(error: Error): void;
}

type Phase =
  | 'initializing'
  | 'thread-starting'
  | 'offer-waiting'
  | 'realtime-starting'
  | 'started-waiting'
  | 'sdp-waiting'
  | 'ready-waiting'
  | 'open'
  | 'shutting'
  | 'done'
  | 'failed';

type Session = {
  generation: number;
  phase: Phase;
  app: AppChild;
  client: AppServerClient;
  media?: MediaChild;
  mediaFactoryPending: boolean;
  callId?: string;
  threadId?: string;
  startupTimer?: TimerHandle;
  mediaTimer?: TimerHandle;
  mediaTimerVersion: number;
  mediaExited: boolean;
  mediaPendingSendBytes: number;
  mediaCloseAcknowledged: boolean;
  mediaCloseForced: boolean;
  mediaCloseError?: Error;
  appExited: boolean;
  startSettled: boolean;
  failureNotified: boolean;
  resolveStart(value: { threadId: string }): void;
  rejectStart(error: Error): void;
  startPromise: Promise<{ threadId: string }>;
  shutdownStarted: boolean;
  resolveMediaClosed(): void;
  rejectMediaClosed(error: Error): void;
  mediaClosed: Promise<void>;
  mediaClosedSettled: boolean;
  shutdownPromise?: Promise<void>;
  onAppError: (error: unknown) => void;
  onAppExit: (code: unknown, signal: unknown) => void;
  onMediaError?: (error: unknown) => void;
  onMediaExit?: (code: unknown, signal: unknown) => void;
  onMediaDisconnect?: () => void;
  onMediaMessage?: (message: unknown) => void;
};

const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function asError(value: unknown, prefix: string): Error {
  if (value instanceof Error) return value;
  return new Error(`${prefix}: ${String(value)}`);
}

function strictBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0)
    throw new TypeError(`${label} must be canonical base64`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value)
    throw new TypeError(`${label} must be canonical base64`);
  return decoded;
}

function requireDeadline(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${label} must be a non-negative safe integer`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} protocol value must be an object`);
  if (utilTypes.isProxy(value))
    throw new Error(`${label} protocol value must be own data`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} protocol value has an unexpected prototype`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Reflect.ownKeys(descriptors);
  if (
    actual.length !== keys.length ||
    !keys.every((key) => own(descriptors, key))
  ) {
    throw new Error(`${label} protocol value has unexpected fields`);
  }
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !('value' in descriptor))
      throw new Error(`${label} protocol field is not own data`);
  }
  return value as Record<string, unknown>;
}

function inertJson(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('IPC contains a nonfinite number');
    return value;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value))
    throw new Error('IPC message is not inert JSON data');
  if (seen.has(value)) throw new Error('IPC message contains a cycle');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Reflect.ownKeys(descriptors).length !== value.length + 1)
        throw new Error('IPC array has unexpected fields');
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor?.enumerable || !('value' in descriptor))
          throw new Error('IPC array slot is not own data');
        result.push(inertJson(descriptor.value, seen));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new Error('IPC object has an unexpected prototype');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string')
        throw new Error('IPC object has a symbol field');
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable || !('value' in descriptor))
        throw new Error('IPC field is not own data');
      result[key] = inertJson(descriptor.value, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function adaptedAppProcess(child: AppChild): AppServerProcess {
  return {
    stdin: {
      on: (event, listener) => child.stdin.on(event, listener),
      removeListener: (event, listener) =>
        child.stdin.removeListener(event, listener),
      write: (data, callback) => {
        let called = false;
        const done = (error?: Error | null): void => {
          if (called) return;
          called = true;
          callback(error);
        };
        const accepted = child.stdin.write(data, done);
        // Minimal process-shaped test doubles commonly expose a synchronous,
        // callback-less write. Normalize those without changing real streams.
        if (child.stdin.write.length < 2) done(null);
        return accepted;
      },
      end: () => child.stdin.end(),
    },
    stdout: child.stdout as AppServerProcess['stdout'],
    on: (event, listener) => child.on(event, listener),
    removeListener: (event, listener) => child.removeListener(event, listener),
    kill: (signal) => child.kill(signal),
  };
}

export class CodexAppServerVoiceBroker {
  readonly #options: CodexAppServerVoiceBrokerOptions;
  #generation = 0;
  #starting = false;
  #startingCancelled = false;
  #startingClose?: StartingClose;
  #session?: Session;

  constructor(options: CodexAppServerVoiceBrokerOptions) {
    requireDeadline(options.startupTimeoutMs, 'startupTimeoutMs');
    requireDeadline(options.shutdownTimeoutMs, 'shutdownTimeoutMs');
    requireDeadline(options.killTimeoutMs, 'killTimeoutMs');
    requireDeadline(options.maxJsonLineBytes, 'maxJsonLineBytes');
    requireDeadline(options.maxIpcMessageBytes, 'maxIpcMessageBytes');
    requireDeadline(options.maxAudioFrameBytes, 'maxAudioFrameBytes');
    if (
      options.maxJsonLineBytes === 0 ||
      options.maxIpcMessageBytes === 0 ||
      options.maxAudioFrameBytes === 0
    )
      throw new TypeError('message size limits must be positive');
    // v0.26 exposes one audited JSONL limit. Requiring that exact value keeps
    // framing and byte accounting delegated to AppServerClient rather than
    // growing a second parser at this boundary.
    if (options.maxJsonLineBytes !== APP_SERVER_MAX_LINE_BYTES)
      throw new RangeError('maxJsonLineBytes must match AppServerClient limit');
    this.#options = options;
  }

  start(): Promise<{ threadId: string }> {
    if (this.#starting)
      return Promise.reject(new Error('one call is already starting'));
    if (this.#session && this.#session.phase !== 'done')
      return Promise.reject(new Error('one call is already active'));

    this.#starting = true;
    this.#startingCancelled = false;
    let app: AppChild;
    try {
      app = this.#options.appServerFactory();
    } catch (error) {
      this.#starting = false;
      this.#settleStartingClose();
      return Promise.reject(asError(error, 'app-server factory failed'));
    }

    let resolveStart!: (value: { threadId: string }) => void;
    let rejectStart!: (error: Error) => void;
    const startPromise = new Promise<{ threadId: string }>(
      (resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      },
    );
    // The broker owns lifecycle cancellation even if its caller elects not to
    // observe start() after invoking close(). Keep that rejection handled while
    // preserving the original promise and outcome for callers that do await it.
    void startPromise.catch(() => undefined);
    let resolveMediaClosed!: () => void;
    let rejectMediaClosed!: (error: Error) => void;
    const mediaClosed = new Promise<void>((resolve, reject) => {
      resolveMediaClosed = resolve;
      rejectMediaClosed = reject;
    });
    const generation = ++this.#generation;
    let session!: Session;
    const timers: AppServerTimers = {
      setTimeout: this.#options.setTimeout,
      clearTimeout: this.#options.clearTimeout,
    };
    let client: AppServerClient;
    try {
      client = new AppServerClient(adaptedAppProcess(app), {
        timers,
        sigtermAfterMs: this.#options.shutdownTimeoutMs,
        sigkillAfterMs: this.#options.killTimeoutMs,
        reapAfterMs: this.#options.killTimeoutMs,
        onNotification: (method, params) => {
          if (this.#current(session))
            this.#notification(session, method, params);
        },
      });
    } catch (error) {
      const failure = asError(error, 'app-server adoption failed');
      const disposalFailure = this.#disposeUnadoptedApp(app);
      this.#starting = false;
      this.#settleStartingClose(disposalFailure ?? failure);
      return Promise.reject(failure);
    }
    session = {
      generation,
      phase: 'initializing',
      app,
      client,
      mediaTimerVersion: 0,
      mediaExited: false,
      mediaFactoryPending: false,
      mediaPendingSendBytes: 0,
      mediaCloseAcknowledged: false,
      mediaCloseForced: false,
      appExited: false,
      startSettled: false,
      failureNotified: false,
      resolveStart,
      rejectStart,
      startPromise,
      shutdownStarted: false,
      resolveMediaClosed,
      rejectMediaClosed,
      mediaClosed,
      mediaClosedSettled: false,
      onAppError: (error) => {
        const failure = asError(error, 'app-server process error');
        queueMicrotask(() => {
          if (this.#current(session) && !session.shutdownStarted)
            this.#fail(session, failure);
        });
      },
      onAppExit: (code, signal) => {
        if (!this.#current(session)) return;
        session.appExited = true;
        const failure = new Error(
          `app-server exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
        );
        queueMicrotask(() => {
          if (this.#current(session) && !session.shutdownStarted)
            this.#fail(session, failure);
        });
      },
    };
    this.#session = session;
    try {
      app.on('error', session.onAppError);
      app.on('exit', session.onAppExit);
    } catch (error) {
      this.#session = undefined;
      const failure = asError(error, 'app-server adoption failed');
      this.#settleStart(session, failure);
      this.#finishMediaClose(session);
      for (const [event, listener] of [
        ['error', session.onAppError],
        ['exit', session.onAppExit],
      ] as const) {
        try {
          app.removeListener(event, listener);
        } catch {
          // Disposal below remains authoritative when detachment is unavailable.
        }
      }
      const disposalFailure = this.#disposeUnadoptedApp(app);
      this.#starting = false;
      this.#settleStartingClose(disposalFailure ?? failure);
      return startPromise;
    }
    this.#starting = false;
    if (this.#startingCancelled) {
      this.#startingCancelled = false;
      this.#settleStart(session, new Error('voice startup cancelled by close'));
      const shutdown = this.#shutdown(session);
      const pending = this.#startingClose;
      this.#startingClose = undefined;
      if (pending) void shutdown.then(pending.resolve, pending.reject);
      return startPromise;
    }
    this.#startingCancelled = false;
    this.#settleStartingClose();

    try {
      let fired = false;
      const handle = this.#options.setTimeout(() => {
        fired = true;
        if (!this.#current(session) || session.startSettled) return;
        session.startupTimer = undefined;
        this.#fail(
          session,
          new Error(
            `startup deadline exceeded after ${this.#options.startupTimeoutMs} ms`,
          ),
        );
      }, this.#options.startupTimeoutMs);
      if (fired || session.startSettled || session.shutdownStarted)
        this.#safeClear(handle);
      else session.startupTimer = handle;
    } catch (error) {
      this.#fail(session, asError(error, 'startup timer failed'));
      return startPromise;
    }

    void this.#open(session);
    return startPromise;
  }

  appendAudio(audio: Uint8Array): void {
    const session = this.#requireOpenSession();
    if (!(audio instanceof Uint8Array))
      throw new TypeError('media audio must be bytes');
    if (audio.byteLength === 0) return;
    if (audio.byteLength > this.#options.maxAudioFrameBytes)
      throw new RangeError('media audio frame is too large');
    const message = {
      type: 'audio.append',
      callId: session.callId!,
      audio: Buffer.from(audio).toString('base64'),
    };
    this.#requireMediaMessageBound(message, 'media audio');
    this.#sendMedia(session, message);
  }

  sendEvent(text: string): void {
    const session = this.#requireOpenSession();
    if (typeof text !== 'string')
      throw new TypeError('media event must be text');
    if (Buffer.byteLength(text, 'utf8') > this.#options.maxIpcMessageBytes)
      throw new RangeError('media event is too large');
    const message = {
      type: 'event.send',
      callId: session.callId!,
      text,
    };
    this.#requireMediaMessageBound(message, 'media event');
    this.#sendMedia(session, message);
  }

  close(): Promise<void> {
    if (this.#starting) {
      this.#startingCancelled = true;
      if (!this.#startingClose) {
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        void promise.catch(() => undefined);
        this.#startingClose = { promise, resolve, reject };
      }
      return this.#startingClose.promise;
    }
    const session = this.#session;
    if (!session || session.phase === 'done') return Promise.resolve();
    if (!session.startSettled)
      this.#settleStart(
        session,
        asError('broker closed', 'voice startup cancelled'),
      );
    return this.#shutdown(session);
  }

  #settleStartingClose(error?: Error): void {
    this.#startingCancelled = false;
    const pending = this.#startingClose;
    this.#startingClose = undefined;
    if (!pending) return;
    if (error) pending.reject(error);
    else pending.resolve();
  }

  #disposeUnadoptedApp(app: AppChild): Error | undefined {
    let failure: Error | undefined;
    try {
      app.stdin.end();
    } catch (error) {
      failure = asError(error, 'unadopted app-server stdin close failed');
    }
    try {
      if (!app.kill('SIGKILL'))
        failure ??= new Error('unadopted app-server SIGKILL was not delivered');
    } catch (error) {
      failure ??= asError(error, 'unadopted app-server SIGKILL failed');
    }
    return failure;
  }

  #requireMediaMessageBound(
    message: Record<string, unknown>,
    label: string,
  ): void {
    if (
      Buffer.byteLength(JSON.stringify(message)) >
      this.#options.maxIpcMessageBytes
    )
      throw new RangeError(`${label} IPC message is too large`);
  }

  #requireOpenSession(): Session {
    const session = this.#session;
    if (!session || session.phase !== 'open' || session.shutdownStarted)
      throw new Error('voice media is not open');
    return session;
  }

  async #open(session: Session): Promise<void> {
    try {
      await session.client.request('initialize', {
        clientInfo: this.#options.clientInfo,
        capabilities: { experimentalApi: true },
      });
      this.#assertOpening(session, 'initializing');
      await session.client.notify('initialized');
      this.#assertOpening(session, 'initializing');
      session.phase = 'thread-starting';
      const result = await session.client.request('thread/start', {
        ephemeral: true,
      });
      this.#assertOpening(session, 'thread-starting');
      const outer = exactRecord(result, ['thread'], 'thread/start result');
      const thread = exactRecord(outer.thread, ['id'], 'thread/start thread');
      if (typeof thread.id !== 'string' || thread.id.length === 0)
        throw new Error('thread/start protocol result has invalid thread ID');
      if (
        Buffer.byteLength(this.#realtimeStopLine(thread.id)) >
        this.#options.maxJsonLineBytes
      )
        throw new Error('thread ID exceeds bounded shutdown framing');
      session.threadId = thread.id;

      const callId = this.#options.callIdFactory();
      if (typeof callId !== 'string' || callId.length === 0)
        throw new Error('call ID factory returned an invalid call ID');
      session.callId = callId;
      this.#assertOpening(session, 'thread-starting');

      let media: MediaChild;
      session.mediaFactoryPending = true;
      try {
        media = this.#options.mediaChildFactory();
      } catch (error) {
        session.mediaFactoryPending = false;
        if (session.shutdownStarted) this.#finishMediaClose(session);
        throw asError(error, 'media child factory failed');
      }
      session.mediaFactoryPending = false;
      session.media = media;
      this.#attachMedia(session, media);
      if (session.shutdownStarted) {
        this.#closeMedia(session);
        return;
      }
      this.#assertOpening(session, 'thread-starting');
      session.phase = 'offer-waiting';
      this.#sendMedia(session, { type: 'offer.create', callId });
    } catch (error) {
      if (this.#current(session) && !session.shutdownStarted)
        this.#fail(session, asError(error, 'voice startup failed'));
    }
  }

  #notification(session: Session, method: string, params: unknown): void {
    if (session.shutdownStarted) return;
    try {
      if (method === 'thread/realtime/started') {
        if (session.phase !== 'started-waiting')
          throw new Error(
            'unexpected or duplicate realtime started notification',
          );
        const value = exactRecord(
          params,
          ['threadId', 'realtimeSessionId', 'version'],
          'realtime started notification',
        );
        if (
          value.threadId !== session.threadId ||
          typeof value.realtimeSessionId !== 'string' ||
          value.realtimeSessionId.length === 0 ||
          value.version !== 'v3'
        )
          throw new Error('realtime started notification correlation failed');
        session.phase = 'sdp-waiting';
        return;
      }
      if (method === 'thread/realtime/sdp') {
        if (session.phase !== 'sdp-waiting')
          throw new Error('unexpected or duplicate realtime SDP notification');
        const value = exactRecord(
          params,
          ['threadId', 'sdp'],
          'realtime SDP notification',
        );
        if (
          value.threadId !== session.threadId ||
          typeof value.sdp !== 'string'
        )
          throw new Error('realtime SDP notification correlation failed');
        session.phase = 'ready-waiting';
        this.#sendMedia(session, {
          type: 'answer.apply',
          callId: session.callId!,
          sdp: value.sdp,
        });
      }
    } catch (error) {
      this.#fail(session, asError(error, 'signaling protocol failure'));
    }
  }

  #attachMedia(session: Session, media: MediaChild): void {
    session.onMediaError = (error) => {
      if (!this.#current(session)) return;
      const failure = asError(error, 'media process error');
      if (session.shutdownStarted) {
        this.#recordMediaCloseFailure(session, failure);
      } else {
        this.#fail(session, failure);
      }
    };
    session.onMediaExit = (code, signal) => {
      if (!this.#current(session)) return;
      session.mediaExited = true;
      if (!session.shutdownStarted) {
        const failure = new Error(
          `media child exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
        );
        this.#finishMediaClose(session, failure);
        this.#fail(session, failure);
        return;
      }
      let failure = session.mediaCloseError;
      if (!failure && session.mediaCloseForced) {
        failure = new Error(
          `media child required forced shutdown (code ${String(code)}, signal ${String(signal)})`,
        );
      } else if (!failure) {
        if (code !== 0 || signal !== null) {
          failure = new Error(
            `media child failed during graceful shutdown (code ${String(code)}, signal ${String(signal)})`,
          );
        } else if (!session.mediaCloseAcknowledged) {
          failure = new Error(
            'media child exited without a truthful closed receipt',
          );
        }
      }
      this.#finishMediaClose(session, failure);
    };
    session.onMediaDisconnect = () => {
      if (this.#current(session) && !session.shutdownStarted)
        this.#fail(session, new Error('media IPC disconnected unexpectedly'));
    };
    session.onMediaMessage = (message) => {
      if (this.#current(session)) this.#mediaMessage(session, message);
    };
    media.on('error', session.onMediaError);
    media.on('exit', session.onMediaExit);
    media.on('disconnect', session.onMediaDisconnect);
    media.on('message', session.onMediaMessage);
  }

  #mediaMessage(session: Session, input: unknown): void {
    try {
      const copy = inertJson(input) as Record<string, unknown>;
      const encoded = JSON.stringify(copy);
      if (Buffer.byteLength(encoded) > this.#options.maxIpcMessageBytes)
        throw new RangeError('media IPC message is too large');
      if (session.shutdownStarted) {
        if (copy.type !== 'closed') return;
        const closed = exactRecord(
          copy,
          ['type', 'callId'],
          'media closed receipt',
        );
        if (closed.type !== 'closed' || closed.callId !== session.callId)
          throw new Error('media closed receipt correlation failed');
        if (session.mediaCloseAcknowledged)
          throw new Error('duplicate media closed receipt');
        session.mediaCloseAcknowledged = true;
        return;
      }
      if (copy.type === 'offer') {
        const offer = exactRecord(
          copy,
          ['type', 'callId', 'sdp'],
          'media offer',
        );
        if (
          offer.callId !== session.callId ||
          session.phase !== 'offer-waiting' ||
          typeof offer.sdp !== 'string'
        )
          throw new Error('unexpected or uncorrelated media offer');
        session.phase = 'realtime-starting';
        void this.#startRealtime(session, offer.sdp);
        return;
      }
      if (copy.type === 'ready') {
        const ready = exactRecord(copy, ['type', 'callId'], 'media ready');
        if (
          ready.callId !== session.callId ||
          session.phase !== 'ready-waiting'
        )
          throw new Error('unexpected or uncorrelated media ready');
        session.phase = 'open';
        this.#settleStart(session, undefined);
        return;
      }
      if (copy.type === 'audio') {
        const audio = exactRecord(
          copy,
          ['type', 'callId', 'audio'],
          'media audio',
        );
        if (audio.callId !== session.callId || session.phase !== 'open')
          throw new Error('unexpected or uncorrelated media audio');
        this.#options.onAudio?.(strictBase64(audio.audio, 'media audio'));
        return;
      }
      if (copy.type === 'event') {
        const event = exactRecord(
          copy,
          ['type', 'callId', 'text'],
          'media event',
        );
        if (
          event.callId !== session.callId ||
          session.phase !== 'open' ||
          typeof event.text !== 'string'
        )
          throw new Error('unexpected or uncorrelated media event');
        this.#options.onEvent?.(event.text);
        return;
      }
      throw new Error('unexpected media IPC message');
    } catch (error) {
      const failure = asError(error, 'media IPC protocol failure');
      if (session.shutdownStarted)
        this.#recordMediaCloseFailure(session, failure);
      else this.#fail(session, failure);
    }
  }

  async #startRealtime(session: Session, offer: string): Promise<void> {
    try {
      session.phase = 'started-waiting';
      await session.client.request('thread/realtime/start', {
        threadId: session.threadId,
        clientManagedHandoffs: true,
        delegationAckFiller: null,
        flushTranscriptTailOnSessionEnd: null,
        codexResponsesAsItems: null,
        codexResponseItemPrefix: null,
        codexResponseHandoffMode: null,
        codexResponseHandoffChannelPrefixes: null,
        model: null,
        outputModality: 'audio',
        includeStartupContext: false,
        initialItems: null,
        realtimeStartInstructions: null,
        realtimeEndInstructions: null,
        realtimeSessionId: null,
        transport: { type: 'webrtc', sdp: offer },
        version: 'v3',
        voice: null,
      });
    } catch (error) {
      if (this.#current(session) && !session.shutdownStarted)
        this.#fail(session, asError(error, 'realtime startup failed'));
    }
  }

  #sendMedia(session: Session, message: Record<string, unknown>): void {
    const copy = inertJson(message) as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    if (bytes > this.#options.maxIpcMessageBytes)
      throw new RangeError('outbound media IPC message is too large');
    if (
      session.mediaPendingSendBytes + bytes >
      this.#options.maxIpcMessageBytes
    ) {
      const failure = new RangeError('outbound media IPC backlog is too large');
      this.#fail(session, failure);
      throw failure;
    }

    session.mediaPendingSendBytes += bytes;
    let callbackCalled = false;
    let synchronous = true;
    let synchronousFailure: Error | undefined;
    const callback = (error: Error | null): void => {
      if (callbackCalled) return;
      callbackCalled = true;
      session.mediaPendingSendBytes -= bytes;
      if (!error || !this.#current(session) || session.shutdownStarted) return;
      const failure = asError(error, 'media IPC send failed');
      this.#fail(session, failure);
      if (synchronous) synchronousFailure = failure;
    };

    try {
      const accepted = session.media!.send(copy, callback);
      if (!accepted && !callbackCalled && session.media!.connected === false)
        throw new Error('media IPC send was not accepted');
    } catch (error) {
      if (!callbackCalled) callback(asError(error, 'media IPC send failed'));
      const failure = asError(error, 'media IPC send failed');
      this.#fail(session, failure);
      throw failure;
    } finally {
      synchronous = false;
    }
    if (synchronousFailure) throw synchronousFailure;
  }

  #fail(session: Session, error: Error): void {
    if (!this.#current(session) || session.shutdownStarted) return;
    if (session.phase === 'open' && !session.failureNotified) {
      session.failureNotified = true;
      try {
        this.#options.onError?.(error);
      } catch {
        // Cleanup remains owned here even if the observer fails.
      }
    }
    this.#settleStart(session, error);
    void this.#shutdown(session);
  }

  #settleStart(session: Session, error?: Error): void {
    if (session.startSettled) return;
    session.startSettled = true;
    if (session.startupTimer !== undefined) {
      this.#safeClear(session.startupTimer);
      session.startupTimer = undefined;
    }
    if (error) session.rejectStart(error);
    else session.resolveStart({ threadId: session.threadId! });
  }

  #shutdown(session: Session): Promise<void> {
    if (session.shutdownPromise) return session.shutdownPromise;
    session.shutdownStarted = true;
    session.phase = 'shutting';
    if (session.startupTimer !== undefined) {
      this.#safeClear(session.startupTimer);
      session.startupTimer = undefined;
    }

    this.#attemptRealtimeStop(session);
    const appClosed = session.client.close().catch((error: unknown) => {
      if (session.appExited) return;
      throw asError(error, 'app-server shutdown failed');
    });
    this.#closeMedia(session);
    const finish = (phase: 'done' | 'failed'): void => {
      session.phase = phase;
      this.#detach(session);
    };
    session.shutdownPromise = Promise.all([
      appClosed,
      session.mediaClosed,
    ]).then(
      () => finish('done'),
      (error: unknown) => {
        finish('failed');
        throw asError(error, 'voice shutdown failed');
      },
    );
    return session.shutdownPromise;
  }

  #realtimeStopLine(threadId: string): string {
    return (
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'thread/realtime/stop',
        params: { threadId },
      }) + '\n'
    );
  }

  #attemptRealtimeStop(session: Session): void {
    if (!session.threadId) return;
    // AppServerClient.close cancels queued work. This terminal frame must reach
    // stdin even when an earlier request write is still awaiting its callback.
    try {
      session.app.stdin.write(
        this.#realtimeStopLine(session.threadId),
        () => undefined,
      );
    } catch {
      // Signal escalation still owns shutdown when the terminal write is unavailable.
    }
  }

  #closeMedia(session: Session): void {
    if (session.mediaFactoryPending) return;
    const media = session.media;
    if (!media || session.mediaExited) {
      this.#finishMediaClose(session);
      return;
    }
    if (session.callId) {
      try {
        const close = { type: 'close', callId: session.callId };
        if (
          Buffer.byteLength(JSON.stringify(close)) >
          this.#options.maxIpcMessageBytes
        )
          throw new RangeError('media close IPC message is too large');
        const accepted = media.send(close, (error) => {
          if (error)
            this.#recordMediaCloseFailure(
              session,
              asError(error, 'media close IPC send failed'),
            );
        });
        if (!accepted && media.connected === false)
          this.#recordMediaCloseFailure(
            session,
            new Error('media close IPC send was not accepted'),
          );
      } catch (error) {
        this.#recordMediaCloseFailure(
          session,
          asError(error, 'media close IPC send failed'),
        );
      }
    }
    if (session.mediaExited || session.mediaCloseForced) return;
    this.#scheduleMedia(session, this.#options.shutdownTimeoutMs, () => {
      this.#signalMedia(session, 'SIGTERM');
    });
  }

  #recordMediaCloseFailure(session: Session, error: Error): void {
    if (session.mediaClosedSettled) return;
    session.mediaCloseError ??= error;
    this.#signalMedia(session, 'SIGTERM');
  }

  #signalMedia(session: Session, signal: Signal): void {
    if (session.mediaExited || session.mediaClosedSettled) return;
    session.mediaCloseForced = true;
    let delivered = false;
    try {
      delivered = session.media!.kill(signal);
    } catch {
      delivered = false;
    }
    if (session.mediaExited || session.mediaClosedSettled) return;
    if (signal === 'SIGTERM') {
      if (!delivered) {
        this.#signalMedia(session, 'SIGKILL');
      } else {
        this.#scheduleMedia(session, this.#options.killTimeoutMs, () => {
          this.#signalMedia(session, 'SIGKILL');
        });
      }
    } else {
      this.#scheduleMedia(session, this.#options.killTimeoutMs, () => {
        this.#finishMediaClose(
          session,
          new Error('media child did not exit after SIGKILL'),
        );
      });
    }
  }

  #scheduleMedia(session: Session, delay: number, callback: () => void): void {
    const version = ++session.mediaTimerVersion;
    let fired = false;
    try {
      const handle = this.#options.setTimeout(() => {
        fired = true;
        if (
          !this.#current(session) ||
          session.mediaClosedSettled ||
          version !== session.mediaTimerVersion
        )
          return;
        session.mediaTimer = undefined;
        callback();
      }, delay);
      if (
        fired ||
        session.mediaClosedSettled ||
        version !== session.mediaTimerVersion
      )
        this.#safeClear(handle);
      else session.mediaTimer = handle;
    } catch {
      if (
        !fired &&
        !session.mediaClosedSettled &&
        version === session.mediaTimerVersion
      )
        callback();
    }
  }

  #finishMediaClose(session: Session, error?: Error): void {
    if (session.mediaClosedSettled) return;
    session.mediaClosedSettled = true;
    session.mediaTimerVersion += 1;
    if (session.mediaTimer !== undefined) {
      this.#safeClear(session.mediaTimer);
      session.mediaTimer = undefined;
    }
    if (error) session.rejectMediaClosed(error);
    else session.resolveMediaClosed();
  }

  #detach(session: Session): void {
    session.app.removeListener('error', session.onAppError);
    session.app.removeListener('exit', session.onAppExit);
    const media = session.media;
    if (media) {
      if (session.onMediaError)
        media.removeListener('error', session.onMediaError);
      if (session.onMediaExit)
        media.removeListener('exit', session.onMediaExit);
      if (session.onMediaDisconnect)
        media.removeListener('disconnect', session.onMediaDisconnect);
      if (session.onMediaMessage)
        media.removeListener('message', session.onMediaMessage);
    }
  }

  #assertOpening(session: Session, phase: Phase): void {
    if (
      !this.#current(session) ||
      session.shutdownStarted ||
      session.phase !== phase
    )
      throw new Error('voice startup was superseded or closed');
  }

  #current(session: Session): boolean {
    return this.#session === session && this.#generation === session.generation;
  }

  #safeClear(handle: TimerHandle): void {
    try {
      this.#options.clearTimeout(handle);
    } catch {
      // Clearing is best-effort; generation/version fences make stale callbacks inert.
    }
  }
}
