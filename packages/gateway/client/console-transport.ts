import type {
  ConsoleTransport,
  ConsoleTransportListener,
} from '../../../src/console/client/transport.js';
import type { ConsoleMediaResolver } from '../../../src/console/client/media-resolver.js';
import type {
  JsonObject,
  ServerFrame,
} from '../../../src/console/client/types.js';

export const GATEWAY_CONSOLE_RELAY_PATH = '/api/v1/browser/relay' as const;

const FRAME_BYTES = 36 * 1024 * 1024;
const CONSOLE_BYTES = 8 * 1024 * 1024;
const MEDIA_BYTES = 25 * 1024 * 1024;
const MEDIA_ROUTE_BYTES = 2 * 1024;
const MAX_PENDING_MEDIA = 128;
const MAX_REQUEST_HISTORY = 4096;
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const INSTANCE_ID = /^egi1\.[A-Za-z0-9_-]{22}$/;
const REQUEST_ID = /^egr1\.[A-Za-z0-9_-]{22}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextEncoder();

const SELECTION_REASONS = [
  'selected',
  'snapshot',
  'ready',
  'deselected',
  'unavailable',
  'operation_failed',
  'link_removed',
  'backpressure',
  'disconnected',
] as const;
const SELECTION_PHASES = [
  'idle',
  'opening',
  'snapshotting',
  'ready',
  'closed',
] as const;

type SelectionReason = (typeof SELECTION_REASONS)[number];
type SelectionPhase = (typeof SELECTION_PHASES)[number];

export type GatewayConsoleRelayFrame =
  | {
      readonly type: 'viewer.selection';
      readonly reason: SelectionReason;
      readonly generation: number;
      readonly phase: SelectionPhase;
      readonly instanceId?: string;
    }
  | { readonly type: 'console.output'; readonly payload: string }
  | {
      readonly type: 'media.result';
      readonly requestId: string;
      readonly ok: true;
      readonly mediaType: string;
      readonly byteLength: number;
      readonly sha256: string;
      readonly data: string;
    }
  | {
      readonly type: 'media.result';
      readonly requestId: string;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true && 'value' in descriptor;
    })
  );
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && utf8.encode(value).byteLength <= maximum;
}

function canonicalBase64(value: string): boolean {
  if (!BASE64.test(value)) return false;
  try {
    return btoa(atob(value)) === value;
  } catch {
    return false;
  }
}

function validSelection(value: Record<string, unknown>): boolean {
  const phase = value.phase as SelectionPhase;
  const reason = value.reason as SelectionReason;
  const active =
    phase === 'opening' || phase === 'snapshotting' || phase === 'ready';
  if (active !== Object.hasOwn(value, 'instanceId')) return false;
  if (active && !INSTANCE_ID.test(String(value.instanceId))) return false;
  if (reason === 'selected') return phase === 'opening';
  if (reason === 'snapshot') return phase === 'snapshotting';
  if (reason === 'ready') return phase === 'ready';
  if (reason === 'disconnected') return phase === 'closed';
  if (reason === 'unavailable') return phase !== 'closed';
  return phase === 'idle';
}

/** Validate and own one exact relay frame; unknown and extra fields are rejected. */
export function decodeGatewayConsoleRelayFrame(
  input: string,
): GatewayConsoleRelayFrame {
  if (typeof input !== 'string' || utf8.encode(input).byteLength > FRAME_BYTES)
    throw new Error('invalid gateway console relay frame');
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error('invalid gateway console relay frame');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('invalid gateway console relay frame');
  if (
    !exactObject(
      value,
      Reflect.ownKeys(value).filter(
        (key): key is string => typeof key === 'string',
      ),
    )
  )
    throw new Error('invalid gateway console relay frame');

  if (value.type === 'viewer.selection') {
    const keys = Object.hasOwn(value, 'instanceId')
      ? ['type', 'reason', 'generation', 'phase', 'instanceId']
      : ['type', 'reason', 'generation', 'phase'];
    if (
      exactObject(value, keys) &&
      (SELECTION_REASONS as readonly unknown[]).includes(value.reason) &&
      (SELECTION_PHASES as readonly unknown[]).includes(value.phase) &&
      Number.isSafeInteger(value.generation) &&
      Number(value.generation) >= 0 &&
      validSelection(value)
    )
      return Object.freeze({ ...value }) as GatewayConsoleRelayFrame;
  }

  if (
    exactObject(value, ['type', 'payload']) &&
    value.type === 'console.output' &&
    boundedText(value.payload, CONSOLE_BYTES)
  )
    return Object.freeze({
      type: 'console.output',
      payload: value.payload,
    });

  if (value.type === 'media.result' && value.ok === true) {
    if (
      exactObject(value, [
        'type',
        'requestId',
        'ok',
        'mediaType',
        'byteLength',
        'sha256',
        'data',
      ]) &&
      REQUEST_ID.test(String(value.requestId)) &&
      boundedText(value.mediaType, 128) &&
      Number.isSafeInteger(value.byteLength) &&
      Number(value.byteLength) >= 0 &&
      Number(value.byteLength) <= MEDIA_BYTES &&
      typeof value.sha256 === 'string' &&
      SHA256.test(value.sha256) &&
      typeof value.data === 'string' &&
      canonicalBase64(value.data)
    ) {
      const padding = value.data.endsWith('==')
        ? 2
        : value.data.endsWith('=')
          ? 1
          : 0;
      if ((value.data.length / 4) * 3 - padding === value.byteLength)
        return Object.freeze({ ...value }) as GatewayConsoleRelayFrame;
    }
  }

  if (
    value.type === 'media.result' &&
    value.ok === false &&
    exactObject(value, ['type', 'requestId', 'ok', 'error']) &&
    REQUEST_ID.test(String(value.requestId)) &&
    exactObject(value.error, ['code', 'message']) &&
    boundedText(value.error.code, 64) &&
    value.error.code.length > 0 &&
    boundedText(value.error.message, 1024)
  )
    return Object.freeze({
      type: 'media.result',
      requestId: value.requestId as string,
      ok: false,
      error: Object.freeze({
        code: value.error.code,
        message: value.error.message,
      }),
    });

  throw new Error('invalid gateway console relay frame');
}

/** Accept only the protocol's typed, origin-relative resident media routes. */
export function isGatewayConsoleMediaRoute(route: unknown): route is string {
  if (
    !boundedText(route, MEDIA_ROUTE_BYTES) ||
    route.includes('?') ||
    route.includes('#') ||
    route.includes('\\')
  )
    return false;
  if (route === '/identity/avatar') return true;
  if (!route.startsWith('/attachments/') && !route.startsWith('/frames/'))
    return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    return false;
  }
  if (/[\u0000-\u001f\u007f\\?#]/.test(decoded)) return false;
  const parts = decoded.split('/').slice(1);
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    return false;
  if (parts[0] === 'attachments') return parts.length >= 3;
  return (
    parts.length >= 3 &&
    ['watch', 'computer', 'browser', 'motor'].includes(parts[1] ?? '')
  );
}

const MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain; charset=utf-8',
  'application/json; charset=utf-8',
  'application/pdf',
  'application/octet-stream',
]);
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function validMediaType(route: string, mediaType: string): boolean {
  if (!MEDIA_TYPES.has(mediaType)) return false;
  if (route === '/identity/avatar') return AVATAR_TYPES.has(mediaType);
  if (route.startsWith('/frames/')) return IMAGE_TYPES.has(mediaType);
  return true;
}

function decodeBase64(
  data: string,
  expected: number,
): Uint8Array<ArrayBuffer> | null {
  if (!canonicalBase64(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  if ((data.length / 4) * 3 - padding !== expected) return null;
  let decoded: string;
  try {
    decoded = atob(data);
  } catch {
    return null;
  }
  if (decoded.length !== expected || btoa(decoded) !== data) return null;
  const bytes = new Uint8Array(new ArrayBuffer(expected));
  for (let index = 0; index < expected; index += 1)
    bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function browserRequestId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (
    'egr1.' +
    btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  );
}

function relayUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + location.host + GATEWAY_CONSOLE_RELAY_PATH;
}

type PendingMedia = {
  readonly route: string;
  readonly epoch: number;
  readonly promise: Promise<string | null>;
  readonly resolve: (url: string | null) => void;
};
type CacheEntry = { readonly url: string; readonly byteLength: number };

export interface GatewayConsoleTransport
  extends ConsoleTransport, ConsoleMediaResolver {
  /** Terminal, idempotent cleanup for sockets, requests, and blob URLs. */
  close(): void;
}

/**
 * One fixed-instance, same-origin relay adapter for the shared Console hook.
 * A connection is not reported as ready until Gateway confirms the fresh
 * viewer.snapshot barrier.
 */
class GatewayConsoleTransportImpl implements GatewayConsoleTransport {
  readonly #instanceId: string;
  #socket: WebSocket | null = null;
  #listener: ConsoleTransportListener | null = null;
  #retryTimer: number | null = null;
  #retry = 500;
  #attempted = false;
  #disposed = false;
  #ready = false;
  #selectionPhase: SelectionPhase = 'idle';
  #selectionGeneration = 0;
  #sawSnapshot = false;
  #epoch = 0;
  readonly #pending = new Map<string, PendingMedia>();
  readonly #verifying = new Set<PendingMedia>();
  readonly #inflight = new Map<string, Promise<string | null>>();
  readonly #requestIds = new Set<string>();
  readonly #requestOrder: string[] = [];
  readonly #cache = new Map<string, CacheEntry>();
  #cacheBytes = 0;

  constructor(instanceId: string) {
    if (!INSTANCE_ID.test(instanceId))
      throw new TypeError('invalid Gateway instance id');
    this.#instanceId = instanceId;
  }

  subscribe(listener: ConsoleTransportListener): () => void {
    if (this.#listener || this.#disposed)
      throw new Error('Gateway Console transport is not subscribable');
    if (typeof listener !== 'function') throw new TypeError('invalid listener');
    this.#listener = listener;
    this.#connect();
    return () => this.close();
  }

  send(frame: JsonObject): boolean {
    if (!this.#ready || !exactObject(frame, Object.keys(frame))) return false;
    let payload: string;
    try {
      payload = JSON.stringify(frame);
    } catch {
      return false;
    }
    if (!boundedText(payload, CONSOLE_BYTES)) return false;
    return this.#sendCommand({ type: 'console.input', payload });
  }

  resolve(route: string): Promise<string | null> {
    if (!isGatewayConsoleMediaRoute(route) || !this.#ready || this.#disposed)
      return Promise.resolve(null);
    const cached = this.#cache.get(route);
    if (cached) {
      this.#cache.delete(route);
      this.#cache.set(route, cached);
      return Promise.resolve(cached.url);
    }
    const active = this.#inflight.get(route);
    if (active) return active;
    if (this.#pending.size >= MAX_PENDING_MEDIA) return Promise.resolve(null);

    const requestId = this.#freshRequestId();
    if (!requestId) return Promise.resolve(null);
    let settle!: (url: string | null) => void;
    const promise = new Promise<string | null>((resolve) => {
      settle = resolve;
    });
    const pending: PendingMedia = {
      route,
      epoch: this.#epoch,
      promise,
      resolve: settle,
    };
    this.#pending.set(requestId, pending);
    this.#inflight.set(route, promise);
    if (!this.#sendCommand({ type: 'media.get', requestId, route })) {
      this.#pending.delete(requestId);
      this.#inflight.delete(route);
      settle(null);
    }
    return promise;
  }

  close(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    this.#epoch += 1;
    if (this.#retryTimer !== null) window.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket?.readyState === 1)
      this.#sendOn(socket, { type: 'viewer.deselect' });
    try {
      socket?.close(1000, 'client_closed');
    } catch {}
    this.#clearMedia();
    this.#listener = null;
  }

  #connect(): void {
    if (this.#disposed) return;
    this.#listener?.({
      type: 'connection',
      value: this.#attempted ? 'reconnecting' : 'connecting',
    });
    this.#attempted = true;
    this.#ready = false;
    this.#selectionPhase = 'idle';
    this.#selectionGeneration = 0;
    this.#sawSnapshot = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(relayUrl());
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#socket !== socket || this.#disposed) return;
      if (
        !this.#sendOn(socket, {
          type: 'viewer.select',
          instanceId: this.#instanceId,
        })
      )
        this.#closeInvalid(socket, 1011, 'relay_unavailable', false);
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket || this.#disposed) return;
      if (typeof event.data !== 'string') {
        this.#invalid(socket);
        return;
      }
      let frame: GatewayConsoleRelayFrame;
      try {
        frame = decodeGatewayConsoleRelayFrame(event.data);
      } catch {
        this.#invalid(socket);
        return;
      }
      this.#frame(socket, frame);
    };
    socket.onerror = () => {
      if (this.#socket !== socket || this.#disposed) return;
      try {
        socket.close();
      } catch {
        this.#socket = null;
        this.#scheduleReconnect();
      }
    };
    socket.onclose = () => {
      if (this.#socket !== socket || this.#disposed) return;
      this.#socket = null;
      this.#ready = false;
      this.#selectionPhase = 'idle';
      this.#epoch += 1;
      this.#cancelMedia();
      this.#listener?.({ type: 'connection', value: 'reconnecting' });
      this.#scheduleReconnect();
    };
  }

  #frame(socket: WebSocket, frame: GatewayConsoleRelayFrame): void {
    if (frame.type === 'viewer.selection') {
      if (!this.#validSelectionTransition(frame)) {
        this.#invalid(socket);
        return;
      }
      this.#selectionGeneration = frame.generation;
      this.#selectionPhase = frame.phase;
      if (frame.reason === 'selected') this.#sawSnapshot = false;
      if (frame.phase === 'ready') {
        this.#ready = true;
        this.#retry = 500;
        this.#listener?.({ type: 'connection', value: 'connected' });
      } else if (frame.phase === 'idle' || frame.phase === 'closed') {
        this.#ready = false;
        this.#epoch += 1;
        this.#cancelMedia();
        this.#listener?.({ type: 'connection', value: 'unavailable' });
        this.#restartSelection(socket);
      }
      return;
    }

    if (frame.type === 'console.output') {
      if (
        this.#selectionPhase !== 'snapshotting' &&
        this.#selectionPhase !== 'ready'
      ) {
        this.#invalid(socket);
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(frame.payload);
      } catch {
        this.#invalid(socket);
        return;
      }
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        typeof (value as Record<string, unknown>).t !== 'string'
      ) {
        this.#invalid(socket);
        return;
      }
      if (
        this.#selectionPhase === 'snapshotting' &&
        (value as Record<string, unknown>).t === 'snapshot'
      )
        this.#sawSnapshot = true;
      this.#listener?.({ type: 'frame', frame: value as ServerFrame });
      return;
    }

    const pending = this.#pending.get(frame.requestId);
    if (!pending) {
      this.#invalid(socket);
      return;
    }
    this.#pending.delete(frame.requestId);
    if (!frame.ok) {
      this.#finishPending(pending, null);
      return;
    }
    this.#verifying.add(pending);
    void this.#verifyMedia(socket, pending, frame);
  }

  async #verifyMedia(
    socket: WebSocket,
    pending: PendingMedia,
    frame: Extract<
      GatewayConsoleRelayFrame,
      { type: 'media.result'; ok: true }
    >,
  ): Promise<void> {
    const bytes = decodeBase64(frame.data, frame.byteLength);
    if (!bytes || !validMediaType(pending.route, frame.mediaType)) {
      this.#finishPending(pending, null);
      this.#invalid(socket);
      return;
    }
    let digest: string;
    try {
      digest = hex(await crypto.subtle.digest('SHA-256', bytes.buffer));
    } catch {
      this.#finishPending(pending, null);
      this.#invalid(socket);
      return;
    }
    if (digest !== frame.sha256) {
      this.#finishPending(pending, null);
      this.#invalid(socket);
      return;
    }
    if (
      this.#disposed ||
      this.#socket !== socket ||
      !this.#ready ||
      pending.epoch !== this.#epoch
    ) {
      this.#finishPending(pending, null);
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(
        new Blob([bytes.buffer], { type: frame.mediaType }),
      );
    } catch {
      this.#finishPending(pending, null);
      return;
    }
    if (
      !this.#cacheMedia(pending.route, {
        url,
        byteLength: frame.byteLength,
      })
    ) {
      this.#finishPending(pending, null);
      return;
    }
    this.#finishPending(pending, url);
  }

  #finishPending(pending: PendingMedia, value: string | null): void {
    this.#verifying.delete(pending);
    if (this.#inflight.get(pending.route) === pending.promise)
      this.#inflight.delete(pending.route);
    pending.resolve(value);
  }

  #cacheMedia(route: string, entry: CacheEntry): boolean {
    const previous = this.#cache.get(route);
    if (previous) {
      URL.revokeObjectURL(entry.url);
      return false;
    }
    if (
      this.#cache.size >= MAX_CACHE_ENTRIES ||
      entry.byteLength > MAX_CACHE_BYTES - this.#cacheBytes
    ) {
      URL.revokeObjectURL(entry.url);
      return false;
    }
    this.#cache.set(route, entry);
    this.#cacheBytes += entry.byteLength;
    return true;
  }

  #cancelMedia(): void {
    for (const pending of this.#pending.values()) pending.resolve(null);
    for (const pending of this.#verifying) pending.resolve(null);
    this.#pending.clear();
    this.#verifying.clear();
    this.#inflight.clear();
  }

  #clearMedia(): void {
    this.#cancelMedia();
    for (const entry of this.#cache.values()) URL.revokeObjectURL(entry.url);
    this.#cache.clear();
    this.#cacheBytes = 0;
  }

  #freshRequestId(): string | null {
    for (let attempts = 0; attempts < 8; attempts += 1) {
      let requestId: string;
      try {
        requestId = browserRequestId();
      } catch {
        return null;
      }
      if (!REQUEST_ID.test(requestId) || this.#requestIds.has(requestId))
        continue;
      this.#requestIds.add(requestId);
      this.#requestOrder.push(requestId);
      if (this.#requestOrder.length > MAX_REQUEST_HISTORY) {
        const oldest = this.#requestOrder.shift();
        if (oldest) this.#requestIds.delete(oldest);
      }
      return requestId;
    }
    return null;
  }

  #sendCommand(command: Record<string, unknown>): boolean {
    const socket = this.#socket;
    return socket?.readyState === 1 && this.#sendOn(socket, command);
  }

  #sendOn(socket: WebSocket, command: Record<string, unknown>): boolean {
    let encoded: string;
    try {
      encoded = JSON.stringify(command);
      if (
        utf8.encode(encoded).byteLength > FRAME_BYTES ||
        !Number.isSafeInteger(socket.bufferedAmount) ||
        socket.bufferedAmount < 0 ||
        socket.bufferedAmount + utf8.encode(encoded).byteLength > FRAME_BYTES
      )
        return false;
      socket.send(encoded);
      return true;
    } catch {
      return false;
    }
  }

  #validSelectionTransition(
    frame: Extract<GatewayConsoleRelayFrame, { type: 'viewer.selection' }>,
  ): boolean {
    const active =
      frame.phase === 'opening' ||
      frame.phase === 'snapshotting' ||
      frame.phase === 'ready';
    if (active && frame.instanceId !== this.#instanceId) return false;
    if (frame.reason === 'unavailable' && active)
      return (
        frame.generation === this.#selectionGeneration &&
        frame.phase === this.#selectionPhase
      );
    if (frame.reason === 'selected')
      return (
        this.#selectionPhase === 'idle' &&
        frame.generation > this.#selectionGeneration
      );
    if (frame.reason === 'snapshot')
      return (
        this.#selectionPhase === 'opening' &&
        frame.generation === this.#selectionGeneration
      );
    if (frame.reason === 'ready')
      return (
        this.#selectionPhase === 'snapshotting' &&
        frame.generation === this.#selectionGeneration &&
        this.#sawSnapshot
      );
    if (frame.phase === 'idle')
      return frame.generation >= this.#selectionGeneration;
    return (
      frame.reason === 'disconnected' &&
      frame.phase === 'closed' &&
      frame.generation >= this.#selectionGeneration
    );
  }

  #restartSelection(socket: WebSocket): void {
    if (this.#socket !== socket || this.#disposed) return;
    this.#socket = null;
    try {
      socket.close(1000, 'selection_lost');
    } catch {}
    this.#scheduleReconnect();
  }

  #invalid(socket: WebSocket): void {
    this.#listener?.({ type: 'malformed' });
    this.#closeInvalid(socket, 1008, 'invalid_frame', true);
  }

  #closeInvalid(
    socket: WebSocket,
    code: number,
    reason: string,
    clear: boolean,
  ): void {
    this.#ready = false;
    if (clear) {
      this.#epoch += 1;
      this.#cancelMedia();
    }
    try {
      socket.close(code, reason);
    } catch {
      if (this.#socket === socket) {
        this.#socket = null;
        this.#scheduleReconnect();
      }
    }
  }

  #scheduleReconnect(): void {
    if (this.#disposed || this.#retryTimer !== null) return;
    const delay = this.#retry;
    this.#retry = Math.min(8000, delay * 2);
    this.#retryTimer = window.setTimeout(() => {
      this.#retryTimer = null;
      this.#connect();
    }, delay);
  }
}

export function createGatewayConsoleTransport(
  instanceId: string,
): GatewayConsoleTransport {
  return new GatewayConsoleTransportImpl(instanceId);
}
