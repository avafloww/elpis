import { randomBytes as systemRandomBytes } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import {
  LIMITS,
  RESIDENT_CONTROL_HEADERS,
  RESIDENT_CONTROL_PATHS,
  ResidentInboundSession as GatewayOutboundSession,
  createResidentHello,
  formatNodeBearerAuthorization,
  serializeResidentFrame,
  type BuildMetadata,
  type Capability,
  type ConnectionId,
  type GatewayToResidentFrame,
  type InstanceId,
  type ResidentIdentity,
} from '@elpis/gateway-protocol';
import type { DashboardRemoteConfig } from './config.js';
import type {
  GatewayResidentSnapshot,
  GatewayResidentStore,
} from './store/gateway-resident.js';

export const GATEWAY_LINK_DEFAULTS = Object.freeze({
  handshakeTimeoutMs: 10_000,
  enrollmentPollMs: 1_000,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
} as const);

export const GATEWAY_LINK_CLOSE = Object.freeze({
  normal: 1000,
  stopping: 1001,
  protocol: 1002,
  invalidData: 1007,
  unavailable: 1011,
} as const);

export type GatewayLinkState =
  | 'idle'
  | 'not_configured'
  | 'waiting_for_enrollment'
  | 'configuration_error'
  | 'connecting'
  | 'handshaking'
  | 'ready'
  | 'backoff'
  | 'faulted'
  | 'stopped';

/** Deliberately bounded and free of endpoint, headers, credentials and errors. */
export interface GatewayLinkStatus {
  readonly state: GatewayLinkState;
  /** Saturating count of consecutive attempts without a validated ack. */
  readonly failures: number;
}

export interface GatewayLinkStoreView {
  read(): GatewayResidentSnapshot;
  activeNodeToken(): string;
}

export interface GatewayLinkClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GatewayLinkSocketHandlers {
  readonly open: () => void;
  readonly message: (data: string | Uint8Array, binary: boolean) => void;
  readonly error: () => void;
  readonly close: () => void;
}

/** A complete-message, transport-neutral client socket. */
export interface GatewayLinkSocket {
  sendText(text: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  attach(handlers: GatewayLinkSocketHandlers): void | (() => void);
}

export interface GatewayLinkSocketOptions {
  /** Exact shared-codec bearer value. It must never be retained by observers. */
  readonly authorization: string;
  readonly connectionId: ConnectionId;
  readonly maxPayload: number;
  readonly perMessageDeflate: false;
}

export type GatewayLinkSocketFactory = (
  url: string,
  options: GatewayLinkSocketOptions,
) => GatewayLinkSocket;

export interface GatewayLinkEvents {
  status(status: GatewayLinkStatus): void;
}

export interface GatewayLinkControllerOptions {
  readonly remote: DashboardRemoteConfig | null;
  readonly store: GatewayLinkStoreView;
  readonly identity: ResidentIdentity;
  readonly build: BuildMetadata;
  /** Advertise only capabilities whose effects are wired in this residence. */
  readonly offeredCapabilities?: readonly Capability[];
  readonly socketFactory?: GatewayLinkSocketFactory;
  readonly clock?: GatewayLinkClock;
  /** Equal-jitter source. Values must be finite and in [0, 1). */
  readonly random?: () => number;
  /** Connection-id entropy. It must return exactly the requested byte count. */
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly events?: GatewayLinkEvents;
  /** Receives only post-ack frames accepted by the shared outbound session. */
  readonly onFrame?: (frame: GatewayToResidentFrame) => void;
  readonly handshakeTimeoutMs?: number;
  readonly enrollmentPollMs?: number;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
}

type LiveAttempt = {
  readonly generation: number;
  readonly socket: GatewayLinkSocket;
  readonly session: GatewayOutboundSession;
  readonly hello: string;
  detach: () => void;
  timer: unknown;
  opened: boolean;
  ready: boolean;
};

const MAX_FAILURES = 31;
const VALIDATION_CONNECTION_ID = 'egx1.AAAAAAAAAAAAAAAAAAAAAA' as ConnectionId;
const VALIDATION_INSTANCE_ID = 'egi1.AAAAAAAAAAAAAAAAAAAAAA' as InstanceId;
const DEFAULT_CAPABILITIES = Object.freeze(['identity.v1'] as const);
const SOCKET_CLOSE_GRACE_MS = 1_000;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const inert = (): void => undefined;

const systemClock: GatewayLinkClock = Object.freeze({
  now: Date.now,
  setTimeout(callback: () => void, delayMs: number): unknown {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  },
});

function boundedPositive(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const actual = value ?? fallback;
  if (
    !Number.isSafeInteger(actual) ||
    actual < 1 ||
    actual > 24 * 60 * 60 * 1_000
  )
    throw new TypeError(name + ' is out of bounds');
  return actual;
}

function canonicalOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048)
    return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
}

function linkTarget(origin: string): string {
  const target = new URL(RESIDENT_CONTROL_PATHS.link, origin);
  target.protocol = 'wss:';
  return target.href;
}

function connectionId(source: (size: number) => Uint8Array): ConnectionId {
  const bytes = source(16);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16)
    throw new TypeError('gateway link entropy is invalid');
  return `egx1.${Buffer.from(bytes).toString('base64url')}` as ConnectionId;
}

function snapshotIsActive(snapshot: GatewayResidentSnapshot): boolean {
  return snapshot.phase === 'active' || snapshot.phase === 'rotating';
}

function frozenStatus(
  state: GatewayLinkState,
  failures: number,
): GatewayLinkStatus {
  return Object.freeze({ state, failures });
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return Uint8Array.from(data);
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
  return Uint8Array.from(Buffer.from(data));
}

/** Production adapter: no Origin, subprotocol, redirects or compression. */
export class WsGatewayLinkSocket implements GatewayLinkSocket {
  readonly #socket: WebSocket;

  constructor(url: string, options: GatewayLinkSocketOptions) {
    this.#socket = new WebSocket(url, {
      headers: {
        authorization: options.authorization,
        [RESIDENT_CONTROL_HEADERS.connectionId]: options.connectionId,
      },
      followRedirects: false,
      maxPayload: options.maxPayload,
      perMessageDeflate: false,
    });
    // Detaching one controller attempt must never leave EventEmitter without
    // an error listener while the WebSocket close handshake is still pending.
    this.#socket.on('error', () => undefined);
  }

  sendText(text: string): void {
    if (this.#socket.readyState !== WebSocket.OPEN)
      throw new Error('gateway link transport is not open');
    this.#socket.send(text, { binary: false, compress: false });
  }

  close(code: number, reason: string): void {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(code, reason);
      const timer = setTimeout(() => {
        if (this.#socket.readyState !== WebSocket.CLOSED)
          this.#socket.terminate();
      }, SOCKET_CLOSE_GRACE_MS);
      timer.unref?.();
      this.#socket.once('close', () => clearTimeout(timer));
    } else if (this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.terminate();
    }
  }

  terminate(): void {
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
  }

  attach(handlers: GatewayLinkSocketHandlers): () => void {
    const onOpen = (): void => handlers.open();
    const onMessage = (data: RawData, binary: boolean): void => {
      try {
        handlers.message(rawDataBytes(data), binary);
      } catch {
        handlers.error();
      }
    };
    const onError = (): void => handlers.error();
    const onClose = (): void => handlers.close();
    this.#socket.on('open', onOpen);
    this.#socket.on('message', onMessage);
    this.#socket.on('error', onError);
    this.#socket.on('close', onClose);
    return () => {
      this.#socket.off('open', onOpen);
      this.#socket.off('message', onMessage);
      this.#socket.off('error', onError);
      this.#socket.off('close', onClose);
    };
  }
}

export function createWsGatewayLinkSocket(
  url: string,
  options: GatewayLinkSocketOptions,
): GatewayLinkSocket {
  return new WsGatewayLinkSocket(url, options);
}

/** Owns one non-blocking outbound resident link. */
export class GatewayLinkController {
  readonly #origin: string | null;
  readonly #configurationInvalid: boolean;
  readonly #store: GatewayLinkStoreView;
  readonly #identity: ResidentIdentity;
  readonly #build: BuildMetadata;
  readonly #offeredCapabilities: readonly Capability[];
  readonly #socketFactory: GatewayLinkSocketFactory;
  readonly #clock: GatewayLinkClock;
  readonly #random: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #events?: GatewayLinkEvents;
  readonly #onFrame?: (frame: GatewayToResidentFrame) => void;
  readonly #handshakeTimeoutMs: number;
  readonly #enrollmentPollMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;

  #current = frozenStatus('idle', 0);
  #started = false;
  #stopped = false;
  #generation = 0;
  #failures = 0;
  #timer: unknown = undefined;
  #live: LiveAttempt | null = null;

  constructor(options: GatewayLinkControllerOptions) {
    if (
      !options ||
      !options.store ||
      typeof options.store.read !== 'function' ||
      typeof options.store.activeNodeToken !== 'function' ||
      (options.socketFactory !== undefined &&
        typeof options.socketFactory !== 'function') ||
      (options.random !== undefined && typeof options.random !== 'function') ||
      (options.randomBytes !== undefined &&
        typeof options.randomBytes !== 'function') ||
      (options.onFrame !== undefined &&
        typeof options.onFrame !== 'function') ||
      (options.events !== undefined &&
        typeof options.events.status !== 'function')
    )
      throw new TypeError('gateway link options are invalid');
    let origin: unknown = null;
    if (options.remote !== null) {
      try {
        origin = options.remote.url;
      } catch {
        origin = undefined;
      }
    }
    this.#configurationInvalid =
      options.remote !== null && !canonicalOrigin(origin);
    this.#origin = canonicalOrigin(origin) ? origin : null;
    this.#store = options.store;
    const validatedHello = createResidentHello({
      connectionId: VALIDATION_CONNECTION_ID,
      seq: 1,
      instanceId: VALIDATION_INSTANCE_ID,
      capabilities: options.offeredCapabilities ?? DEFAULT_CAPABILITIES,
      identity: options.identity,
      build: options.build,
    });
    this.#identity = validatedHello.identity;
    this.#build = validatedHello.build;
    this.#offeredCapabilities = validatedHello.capabilities;
    this.#socketFactory = options.socketFactory ?? createWsGatewayLinkSocket;
    this.#clock = options.clock ?? systemClock;
    if (
      !this.#clock ||
      typeof this.#clock.now !== 'function' ||
      typeof this.#clock.setTimeout !== 'function' ||
      typeof this.#clock.clearTimeout !== 'function'
    )
      throw new TypeError('gateway link clock is invalid');
    this.#random = options.random ?? Math.random;
    this.#randomBytes = options.randomBytes ?? systemRandomBytes;
    this.#events = options.events;
    this.#onFrame = options.onFrame;
    this.#handshakeTimeoutMs = boundedPositive(
      options.handshakeTimeoutMs,
      GATEWAY_LINK_DEFAULTS.handshakeTimeoutMs,
      'handshakeTimeoutMs',
    );
    this.#enrollmentPollMs = boundedPositive(
      options.enrollmentPollMs,
      GATEWAY_LINK_DEFAULTS.enrollmentPollMs,
      'enrollmentPollMs',
    );
    this.#retryBaseMs = boundedPositive(
      options.retryBaseMs,
      GATEWAY_LINK_DEFAULTS.retryBaseMs,
      'retryBaseMs',
    );
    this.#retryMaxMs = boundedPositive(
      options.retryMaxMs,
      GATEWAY_LINK_DEFAULTS.retryMaxMs,
      'retryMaxMs',
    );
    if (this.#retryMaxMs < this.#retryBaseMs)
      throw new TypeError('retryMaxMs is smaller than retryBaseMs');
  }

  get status(): GatewayLinkStatus {
    return this.#current;
  }

  start(): void {
    if (this.#stopped || this.#started) return;
    this.#started = true;
    this.#drive();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    this.#clearControllerTimer();
    const live = this.#live;
    this.#live = null;
    if (live !== null)
      this.#dispose(live, GATEWAY_LINK_CLOSE.stopping, 'stopping');
    this.#transition('stopped');
  }

  #drive(): void {
    if (!this.#started || this.#stopped || this.#live !== null) return;
    this.#clearControllerTimer();
    if (this.#configurationInvalid) {
      this.#transition('configuration_error');
      return;
    }
    const origin = this.#origin;
    if (origin === null) {
      this.#transition('not_configured');
      return;
    }

    let first: GatewayResidentSnapshot;
    try {
      first = this.#store.read();
    } catch {
      this.#fault();
      return;
    }
    if (!snapshotIsActive(first)) {
      this.#transition('waiting_for_enrollment');
      this.#armControllerTimer(this.#enrollmentPollMs);
      return;
    }
    if (first.endpoint !== origin) {
      this.#transition('configuration_error');
      return;
    }

    // Token access is deliberately inside the attempt and after active-state checks.
    let authorization: string;
    let second: GatewayResidentSnapshot;
    try {
      authorization = formatNodeBearerAuthorization(
        this.#store.activeNodeToken(),
      );
      second = this.#store.read();
    } catch {
      this.#fault();
      return;
    }
    if (
      !snapshotIsActive(second) ||
      second.instanceId !== first.instanceId ||
      second.endpoint !== origin ||
      second.activeCredentialId !== first.activeCredentialId
    ) {
      this.#transition('waiting_for_enrollment');
      this.#armControllerTimer(this.#enrollmentPollMs);
      return;
    }

    let id: ConnectionId;
    let session: GatewayOutboundSession;
    let hello: string;
    let socket: GatewayLinkSocket;
    try {
      id = connectionId(this.#randomBytes);
      session = new GatewayOutboundSession({
        connectionId: id,
        instanceId: second.instanceId as InstanceId,
        offeredCapabilities: this.#offeredCapabilities,
      });
      hello = serializeResidentFrame(
        createResidentHello({
          connectionId: id,
          seq: 1,
          instanceId: second.instanceId as InstanceId,
          capabilities: this.#offeredCapabilities,
          identity: this.#identity,
          build: this.#build,
        }),
      );
      socket = this.#socketFactory(linkTarget(origin), {
        authorization,
        connectionId: id,
        maxPayload: LIMITS.frameBytes,
        perMessageDeflate: false,
      });
      if (!socket || typeof socket.attach !== 'function')
        throw new TypeError(
          'gateway link socket factory returned an invalid socket',
        );
    } catch {
      // Do not retain the exception, URL, header, or token. Synchronous setup
      // faults are local and durable; reconnecting cannot repair them.
      this.#fault();
      return;
    }
    authorization = '';

    const live: LiveAttempt = {
      generation: ++this.#generation,
      socket,
      session,
      hello,
      detach: inert,
      timer: undefined,
      opened: false,
      ready: false,
    };
    this.#live = live;
    this.#transition('connecting');
    if (!this.#isCurrent(live)) return;

    let detach: void | (() => void);
    try {
      detach = socket.attach({
        open: () => this.#dispatch(live, () => this.#opened(live)),
        message: (data, binary) =>
          this.#dispatch(live, () => this.#message(live, data, binary)),
        error: () => this.#dispatch(live, () => this.#transportEnded(live)),
        close: () => this.#dispatch(live, () => this.#transportEnded(live)),
      });
    } catch {
      this.#fault(live);
      return;
    }
    if (typeof detach === 'function') {
      if (this.#isCurrent(live)) live.detach = detach;
      else {
        try {
          detach();
        } catch {}
      }
    }
    if (!this.#isCurrent(live)) return;
    this.#armLiveTimer(live);
  }

  #opened(live: LiveAttempt): void {
    if (live.opened) {
      this.#protocolFailure(
        live,
        GATEWAY_LINK_CLOSE.protocol,
        'duplicate_open',
      );
      return;
    }
    live.opened = true;
    this.#transition('handshaking');
    if (!this.#isCurrent(live)) return;
    try {
      live.socket.sendText(live.hello);
    } catch {
      this.#attemptFailed(live);
    }
  }

  #message(
    live: LiveAttempt,
    data: string | Uint8Array,
    binary: boolean,
  ): void {
    if (binary) {
      this.#protocolFailure(live, GATEWAY_LINK_CLOSE.protocol, 'binary_frame');
      return;
    }
    let text: string;
    try {
      if (typeof data === 'string') {
        const bytes = encoder.encode(data);
        if (bytes.byteLength > LIMITS.frameBytes || utf8.decode(bytes) !== data)
          throw new TypeError('invalid text');
        text = data;
      } else {
        if (
          !(data instanceof Uint8Array) ||
          data.byteLength > LIMITS.frameBytes
        )
          throw new TypeError('invalid bytes');
        text = utf8.decode(data);
      }
    } catch {
      this.#protocolFailure(
        live,
        GATEWAY_LINK_CLOSE.invalidData,
        'invalid_utf8',
      );
      return;
    }
    let frame: GatewayToResidentFrame;
    try {
      frame = live.session.receive(text);
    } catch {
      this.#protocolFailure(
        live,
        GATEWAY_LINK_CLOSE.protocol,
        'protocol_error',
      );
      return;
    }
    if (!live.ready) {
      if (frame.type !== 'hello.ack') {
        this.#protocolFailure(live, GATEWAY_LINK_CLOSE.protocol, 'invalid_ack');
        return;
      }
      live.ready = true;
      this.#clearLiveTimer(live);
      // This is the sole reset point for consecutive attempt state.
      this.#failures = 0;
      this.#transition('ready');
      return;
    }
    if (frame.type === 'error' && frame.fatal) {
      this.#protocolFailure(live, GATEWAY_LINK_CLOSE.protocol, 'fatal_error');
      return;
    }
    try {
      this.#onFrame?.(frame);
    } catch {}
  }

  #dispatch(live: LiveAttempt, operation: () => void): void {
    if (!this.#isCurrent(live)) return;
    try {
      operation();
    } catch {
      if (this.#isCurrent(live)) this.#attemptFailed(live);
    }
  }

  #transportEnded(live: LiveAttempt): void {
    this.#attemptFailed(live);
  }

  #protocolFailure(live: LiveAttempt, code: number, reason: string): void {
    this.#attemptFailed(live, code, reason);
  }

  #fault(live: LiveAttempt | null = null): void {
    if (this.#stopped) return;
    if (live !== null && !this.#isCurrent(live)) return;
    this.#clearControllerTimer();
    if (live !== null) {
      this.#generation += 1;
      this.#live = null;
      this.#dispose(live, GATEWAY_LINK_CLOSE.unavailable, 'local_fault');
    }
    this.#transition('faulted');
  }

  #attemptFailed(
    live: LiveAttempt | null = null,
    code: number = GATEWAY_LINK_CLOSE.unavailable,
    reason: string = 'transport_error',
  ): void {
    if (this.#stopped) return;
    if (live !== null && !this.#isCurrent(live)) return;
    if (live !== null) {
      this.#generation += 1;
      this.#live = null;
      this.#dispose(live, code, reason);
    }
    this.#failures = Math.min(MAX_FAILURES, this.#failures + 1);
    this.#scheduleAfterFailure();
  }

  #scheduleAfterFailure(): void {
    if (this.#stopped) return;
    // Recheck durable state before declaring a retry/backoff.
    let snapshot: GatewayResidentSnapshot;
    try {
      snapshot = this.#store.read();
    } catch {
      this.#fault();
      return;
    }
    const active =
      snapshotIsActive(snapshot) &&
      this.#origin !== null &&
      snapshot.endpoint === this.#origin;
    if (!active) {
      this.#transition('waiting_for_enrollment');
      this.#armControllerTimer(this.#enrollmentPollMs);
      return;
    }
    const exponent = Math.min(this.#failures - 1, 30);
    const ceiling = Math.min(
      this.#retryMaxMs,
      this.#retryBaseMs * 2 ** exponent,
    );
    let fraction = 0.5;
    try {
      const value = this.#random();
      if (!Number.isFinite(value) || value < 0 || value >= 1)
        throw new TypeError('invalid random value');
      fraction = value;
    } catch {}
    // Equal jitter is bounded away from a hot loop and never exceeds the cap.
    const delay = Math.min(
      ceiling,
      Math.floor(ceiling / 2 + fraction * Math.ceil(ceiling / 2)),
    );
    this.#transition('backoff');
    this.#armControllerTimer(Math.max(1, delay));
  }

  #armControllerTimer(delay: number): void {
    if (this.#stopped || this.#timer !== undefined) return;
    const generation = this.#generation;
    let handle: unknown;
    let scheduling = true;
    let firedSynchronously = false;
    try {
      handle = this.#clock.setTimeout(() => {
        if (scheduling) {
          firedSynchronously = true;
          return;
        }
        if (this.#stopped || generation !== this.#generation) return;
        this.#timer = undefined;
        this.#drive();
      }, delay);
    } catch {
      if (!this.#stopped && generation === this.#generation)
        this.#transition('faulted');
      return;
    }
    scheduling = false;
    if (
      this.#stopped ||
      generation !== this.#generation ||
      firedSynchronously
    ) {
      try {
        this.#clock.clearTimeout(handle);
      } catch {}
      if (!this.#stopped && generation === this.#generation)
        this.#transition('faulted');
    } else {
      this.#timer = handle;
    }
  }

  #armLiveTimer(live: LiveAttempt): void {
    if (!this.#isCurrent(live) || live.ready || live.timer !== undefined)
      return;
    let handle: unknown;
    let scheduling = true;
    let firedSynchronously = false;
    try {
      handle = this.#clock.setTimeout(() => {
        if (scheduling) {
          firedSynchronously = true;
          return;
        }
        this.#dispatch(live, () =>
          this.#attemptFailed(
            live,
            GATEWAY_LINK_CLOSE.unavailable,
            'handshake_timeout',
          ),
        );
      }, this.#handshakeTimeoutMs);
    } catch {
      this.#fault(live);
      return;
    }
    scheduling = false;
    if (firedSynchronously) {
      try {
        this.#clock.clearTimeout(handle);
      } catch {}
      this.#fault(live);
    } else if (this.#isCurrent(live) && !live.ready) live.timer = handle;
    else {
      try {
        this.#clock.clearTimeout(handle);
      } catch {}
    }
  }

  #clearControllerTimer(): void {
    const timer = this.#timer;
    this.#timer = undefined;
    if (timer !== undefined) {
      try {
        this.#clock.clearTimeout(timer);
      } catch {}
    }
  }

  #clearLiveTimer(live: LiveAttempt): void {
    const timer = live.timer;
    live.timer = undefined;
    if (timer !== undefined) {
      try {
        this.#clock.clearTimeout(timer);
      } catch {}
    }
  }

  #dispose(live: LiveAttempt, code: number, reason: string): void {
    this.#clearLiveTimer(live);
    try {
      live.detach();
    } catch {}
    live.detach = inert;
    try {
      live.socket.close(code, reason);
    } catch {
      try {
        live.socket.terminate();
      } catch {}
    }
  }

  #isCurrent(live: LiveAttempt): boolean {
    return (
      !this.#stopped &&
      this.#live === live &&
      live.generation === this.#generation
    );
  }

  #transition(state: GatewayLinkState): void {
    if (this.#stopped && state !== 'stopped') return;
    if (
      this.#current.state === state &&
      this.#current.failures === this.#failures
    )
      return;
    const next = frozenStatus(state, this.#failures);
    this.#current = next;
    try {
      this.#events?.status(next);
    } catch {}
  }
}

export function createGatewayLinkController(
  options: GatewayLinkControllerOptions,
): GatewayLinkController {
  return new GatewayLinkController(options);
}

export type GatewayLinkResidentStore = Pick<
  GatewayResidentStore,
  'read' | 'activeNodeToken'
>;
