import {
  LIMITS,
  isGatewayInstanceId,
  isRequestId,
  type ConsoleOutputFrame,
  type MediaResultFrame,
  type RequestId,
} from '@elpis/gateway-protocol';
import {
  GatewaySelectedViewerBroker,
  type GatewaySelectedViewerSelectionEvent,
} from './selected-viewer-broker.js';
import type { GatewayResidentLinkRegistry } from './resident-link-registry.js';

/** Exact same-origin WebSocket endpoint intended to sit behind proxy auth. */
export const GATEWAY_BROWSER_RELAY_PATH = '/api/v1/browser/relay' as const;
export const GATEWAY_BROWSER_RELAY_CLOSE = Object.freeze({
  policy: 1008,
  binary: 1003,
  invalidUtf8: 1007,
  tooLarge: 1009,
  unavailable: 1011,
} as const);

export type GatewayBrowserRelayCommand =
  | { readonly type: 'viewer.select'; readonly instanceId: string }
  | { readonly type: 'viewer.deselect' }
  | { readonly type: 'console.input'; readonly payload: string }
  | {
      readonly type: 'media.get';
      readonly requestId: RequestId;
      readonly route: string;
    };

export type GatewayBrowserRelayFrame =
  | {
      readonly type: 'viewer.selection';
      readonly reason: GatewaySelectedViewerSelectionEvent['reason'];
      readonly generation: number;
      readonly phase: GatewaySelectedViewerSelectionEvent['phase'];
      readonly instanceId?: string;
    }
  | { readonly type: 'console.output'; readonly payload: string }
  | {
      readonly type: 'media.result';
      readonly requestId: RequestId;
      readonly ok: true;
      readonly mediaType: string;
      readonly byteLength: number;
      readonly sha256: string;
      readonly data: string;
    }
  | {
      readonly type: 'media.result';
      readonly requestId: RequestId;
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    };

export interface GatewayBrowserRelaySocketHandlers {
  text(text: string): void;
  binary(): void;
  error(): void;
  close(): void;
}

/** Minimal complete-message socket seam; HTTP and ws details stay outside. */
export interface GatewayBrowserRelaySocketAdapter {
  readonly bufferedAmount: number;
  sendText(text: string): void;
  close(code: number, reason: string): void;
  attach(handlers: GatewayBrowserRelaySocketHandlers): () => void;
}

export interface GatewayBrowserRelayOptions {
  readonly registry: GatewayResidentLinkRegistry;
  readonly socket: GatewayBrowserRelaySocketAdapter;
  /** Total already-queued plus next-frame UTF-8 bytes. Cannot exceed wire bounds. */
  readonly maxBufferedAmount?: number;
  /** Called exactly once when this relay releases all broker/socket callbacks. */
  readonly onDisconnect?: () => void;
}

const utf8 = new TextEncoder();

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

/** Decode one strict, non-extensible browser command object. */
export function decodeGatewayBrowserRelayCommand(
  text: string,
): GatewayBrowserRelayCommand {
  if (
    typeof text !== 'string' ||
    utf8.encode(text).byteLength > LIMITS.frameBytes
  )
    throw new Error('invalid browser relay frame');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('invalid browser relay frame');
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    if (
      exactObject(value, ['type', 'instanceId']) &&
      value.type === 'viewer.select' &&
      isGatewayInstanceId(value.instanceId)
    )
      return Object.freeze({
        type: 'viewer.select',
        instanceId: value.instanceId,
      });
    if (exactObject(value, ['type']) && value.type === 'viewer.deselect')
      return Object.freeze({ type: 'viewer.deselect' });
    if (
      exactObject(value, ['type', 'payload']) &&
      value.type === 'console.input' &&
      typeof value.payload === 'string' &&
      utf8.encode(value.payload).byteLength <= LIMITS.consolePayloadBytes
    )
      return Object.freeze({ type: 'console.input', payload: value.payload });
    if (
      exactObject(value, ['type', 'requestId', 'route']) &&
      value.type === 'media.get' &&
      isRequestId(value.requestId) &&
      typeof value.route === 'string' &&
      utf8.encode(value.route).byteLength <= LIMITS.mediaRouteBytes
    )
      return Object.freeze({
        type: 'media.get',
        requestId: value.requestId,
        route: value.route,
      });
  }
  throw new Error('invalid browser relay frame');
}

function selectionFrame(
  event: GatewaySelectedViewerSelectionEvent,
): GatewayBrowserRelayFrame {
  return Object.freeze({
    type: 'viewer.selection' as const,
    reason: event.reason,
    generation: event.generation,
    phase: event.phase,
    ...(event.instanceId === undefined ? {} : { instanceId: event.instanceId }),
  });
}

function consoleFrame(frame: ConsoleOutputFrame): GatewayBrowserRelayFrame {
  return Object.freeze({
    type: 'console.output' as const,
    payload: frame.payload,
  });
}

function mediaFrame(
  frame: MediaResultFrame,
  requestId: RequestId,
): GatewayBrowserRelayFrame {
  return frame.ok
    ? Object.freeze({
        type: 'media.result' as const,
        requestId,
        ok: true as const,
        mediaType: frame.mediaType,
        byteLength: frame.byteLength,
        sha256: frame.sha256,
        data: frame.data,
      })
    : Object.freeze({
        type: 'media.result' as const,
        requestId,
        ok: false as const,
        error: Object.freeze({
          code: frame.error.code,
          message: frame.error.message,
        }),
      });
}

/**
 * One browser transport owns exactly one pure selected-viewer broker. There is
 * deliberately no user, application session, cookie, or browser bearer token:
 * deployment authentication is the reverse proxy's job and Origin is enforced
 * by the HTTP upgrade boundary.
 */
export class GatewayBrowserRelayConnection {
  readonly #socket: GatewayBrowserRelaySocketAdapter;
  readonly #broker: GatewaySelectedViewerBroker;
  readonly #maxBufferedAmount: number;
  readonly #onDisconnect?: () => void;
  readonly #mediaRequests = new Map<RequestId, RequestId>();
  readonly #mediaClientIds = new Set<RequestId>();
  #mediaStarting:
    { readonly clientId: RequestId; consumed: boolean } | undefined;
  #detach: (() => void) | undefined;
  #terminalPending = false;
  #disconnected = false;

  constructor(options: GatewayBrowserRelayOptions) {
    if (
      !options ||
      !options.registry ||
      !options.socket ||
      typeof options.socket.sendText !== 'function' ||
      typeof options.socket.close !== 'function' ||
      typeof options.socket.attach !== 'function' ||
      (options.onDisconnect !== undefined &&
        typeof options.onDisconnect !== 'function')
    )
      throw new TypeError('browser relay options are invalid');
    const maximum = options.maxBufferedAmount ?? LIMITS.frameBytes;
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < 1 ||
      maximum > LIMITS.frameBytes
    )
      throw new TypeError('maxBufferedAmount is outside its allowed range');
    this.#socket = options.socket;
    this.#maxBufferedAmount = maximum;
    this.#onDisconnect = options.onDisconnect;
    this.#broker = new GatewaySelectedViewerBroker({
      registry: options.registry,
      onConsoleOutput: (frame) => this.#send(consoleFrame(frame)),
      onMediaResult: (frame) => this.#deliverMedia(frame),
      onSelection: (event) => {
        if (
          event.reason === 'deselected' ||
          event.reason === 'operation_failed' ||
          event.reason === 'link_removed' ||
          event.reason === 'backpressure' ||
          event.reason === 'disconnected'
        )
          this.#clearMedia();
        this.#send(selectionFrame(event));
      },
    });
    try {
      const detach = this.#socket.attach({
        text: (text) => this.#text(text),
        binary: () =>
          this.#scheduleTerminal(
            GATEWAY_BROWSER_RELAY_CLOSE.binary,
            'text_required',
          ),
        error: () => this.disconnect(),
        close: () => this.disconnect(),
      });
      if (typeof detach !== 'function')
        throw new TypeError('browser relay socket did not provide detach');
      if (this.#disconnected) {
        try {
          detach();
        } catch {}
      } else this.#detach = detach;
    } catch {
      this.disconnect();
      throw new TypeError('browser relay socket attach failed');
    }
  }

  get state(): GatewaySelectedViewerBroker['state'] {
    return this.#broker.state;
  }

  /** Terminal and idempotent; remote viewer cleanup runs before callback release. */
  disconnect(): void {
    if (this.#disconnected) return;
    this.#disconnected = true;
    this.#terminalPending = true;
    this.#clearMedia();
    try {
      this.#broker.disconnect();
    } finally {
      const detach = this.#detach;
      this.#detach = undefined;
      try {
        detach?.();
      } catch {}
      try {
        this.#onDisconnect?.();
      } catch {}
    }
  }

  stop(): void {
    if (this.#disconnected) return;
    this.disconnect();
    try {
      this.#socket.close(
        GATEWAY_BROWSER_RELAY_CLOSE.unavailable,
        'server_stopping',
      );
    } catch {}
  }

  #text(text: string): void {
    if (this.#terminalPending || this.#disconnected) return;
    let command: GatewayBrowserRelayCommand;
    try {
      command = decodeGatewayBrowserRelayCommand(text);
    } catch {
      this.#scheduleTerminal(
        GATEWAY_BROWSER_RELAY_CLOSE.policy,
        'invalid_frame',
      );
      return;
    }
    try {
      if (command.type === 'viewer.select')
        this.#broker.select(command.instanceId);
      else if (command.type === 'viewer.deselect') this.#broker.deselect();
      else if (command.type === 'console.input')
        this.#broker.input(command.payload);
      else this.#requestMedia(command.requestId, command.route);
    } catch {
      this.#scheduleTerminal(
        GATEWAY_BROWSER_RELAY_CLOSE.unavailable,
        'relay_failure',
      );
    }
  }

  #requestMedia(clientId: RequestId, route: string): void {
    if (this.#mediaClientIds.has(clientId)) {
      this.#scheduleTerminal(
        GATEWAY_BROWSER_RELAY_CLOSE.policy,
        'duplicate_request',
      );
      return;
    }
    const starting = { clientId, consumed: false };
    this.#mediaClientIds.add(clientId);
    this.#mediaStarting = starting;
    let residentId: RequestId | undefined;
    try {
      residentId = this.#broker.media(route);
    } finally {
      if (this.#mediaStarting === starting) this.#mediaStarting = undefined;
    }
    if (residentId !== undefined) {
      if (!starting.consumed) this.#mediaRequests.set(residentId, clientId);
      return;
    }
    if (starting.consumed) return;
    this.#mediaClientIds.delete(clientId);
    this.#send({
      type: 'media.result',
      requestId: clientId,
      ok: false,
      error: { code: 'invalid_request', message: 'media request was rejected' },
    });
  }

  #deliverMedia(frame: MediaResultFrame): boolean {
    let clientId = this.#mediaRequests.get(frame.requestId);
    if (clientId !== undefined) {
      this.#mediaRequests.delete(frame.requestId);
    } else if (this.#mediaStarting && !this.#mediaStarting.consumed) {
      clientId = this.#mediaStarting.clientId;
      this.#mediaStarting.consumed = true;
    } else return false;
    this.#mediaClientIds.delete(clientId);
    return this.#send(mediaFrame(frame, clientId));
  }

  #clearMedia(): void {
    this.#mediaRequests.clear();
    this.#mediaClientIds.clear();
    this.#mediaStarting = undefined;
  }

  #send(frame: GatewayBrowserRelayFrame): boolean {
    if (this.#terminalPending || this.#disconnected) return false;
    let encoded: string;
    let buffered: number;
    try {
      encoded = JSON.stringify(frame);
      buffered = this.#socket.bufferedAmount;
    } catch {
      this.#scheduleTerminal(
        GATEWAY_BROWSER_RELAY_CLOSE.unavailable,
        'relay_failure',
      );
      return false;
    }
    const bytes = utf8.encode(encoded).byteLength;
    if (
      bytes > LIMITS.frameBytes ||
      !Number.isSafeInteger(buffered) ||
      buffered < 0 ||
      buffered + bytes > this.#maxBufferedAmount
    ) {
      this.#scheduleTerminal(
        GATEWAY_BROWSER_RELAY_CLOSE.tooLarge,
        'backpressure',
      );
      return false;
    }
    try {
      this.#socket.sendText(encoded);
      return true;
    } catch {
      this.#scheduleTerminal(
        GATEWAY_BROWSER_RELAY_CLOSE.unavailable,
        'send_failed',
      );
      return false;
    }
  }

  // Broker callbacks may be synchronous inside a state transition. Deferral
  // prevents disconnect from re-entering that transition and orphaning a viewer.
  #scheduleTerminal(code: number, reason: string): void {
    if (this.#terminalPending || this.#disconnected) return;
    this.#terminalPending = true;
    queueMicrotask(() => {
      if (this.#disconnected) return;
      this.disconnect();
      try {
        this.#socket.close(code, reason);
      } catch {}
    });
  }
}

export function createGatewayBrowserRelayConnection(
  options: GatewayBrowserRelayOptions,
): GatewayBrowserRelayConnection {
  return new GatewayBrowserRelayConnection(options);
}
