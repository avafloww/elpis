import {
  GatewayInboundSession,
  GatewayProtocolError,
  LIMITS,
  PROTOCOL_VERSION,
  createGatewayHelloAck,
  createProtocolError,
  isConnectionId,
  serializeGatewayFrame,
  validateCapabilities,
  type Capability,
  type ConnectionId,
  type GatewayToResidentFrame,
  type ConsoleInputFrame,
  type MediaGetFrame,
  type ViewerOperationFrame,
  type InstanceId,
  type ProtocolErrorCode,
  type ResidentToGatewayFrame,
} from '@elpis/gateway-protocol';
import type { AuthenticatedNode } from './credential-store.js';

const utf8 = new TextEncoder();
export const GATEWAY_RESIDENT_CLOSE = Object.freeze({
  normal: 1000,
  stopping: 1001,
  protocol: 1002,
  duplicate: 1008,
  unavailable: 1011,
} as const);

export interface GatewayResidentSocketHandlers {
  readonly text: (text: string) => void;
  readonly binary: () => void;
  readonly error: () => void;
  readonly close: () => void;
}
/** A complete-message, transport-neutral socket adapter. */
export interface GatewayResidentSocketAdapter {
  readonly bufferedAmount: number;
  sendText(text: string): void;
  close(code: number, reason: string): void;
  attach(handlers: GatewayResidentSocketHandlers): void | (() => void);
}
export interface GatewayResidentLinkClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export type GatewayResidentLinkAuditAction =
  | 'admitted'
  | 'ready'
  | 'duplicate-rejected'
  | 'capacity-rejected'
  | 'stopped-rejected'
  | 'protocol-error'
  | 'handshake-timeout'
  | 'backpressure'
  | 'transport-error'
  | 'closed'
  | 'stop';
/** Secret-free by construction: no bearer, header, frame, payload, identity or build fields. */
export interface GatewayResidentLinkAuditEvent {
  readonly action: GatewayResidentLinkAuditAction;
  readonly at: number;
  readonly instanceId?: string;
  readonly credentialId?: string;
  readonly connectionId?: string;
  readonly generation?: number;
  readonly protocolCode?: ProtocolErrorCode;
}
export type GatewayResidentLinkAudit = (
  event: Readonly<GatewayResidentLinkAuditEvent>,
) => void;
export interface GatewayResidentLinkSummary {
  readonly instanceId: string;
  readonly credentialId: string;
  readonly connectionId: ConnectionId;
  readonly generation: number;
  readonly connectedAt: number;
  readonly readyAt?: number;
  readonly state: 'awaiting-hello' | 'ready';
  readonly capabilities: readonly Capability[];
}
export type GatewayResidentAdmissionRejection =
  'duplicate' | 'capacity' | 'stopped';
export type GatewayResidentAdmission =
  | { readonly accepted: true; readonly link: GatewayResidentLinkSummary }
  | {
      readonly accepted: false;
      readonly reason: GatewayResidentAdmissionRejection | 'transport-error';
    };
export type GatewayResidentOutboundEffect =
  | Omit<ViewerOperationFrame, 'version' | 'connectionId' | 'seq'>
  | Omit<ConsoleInputFrame, 'version' | 'connectionId' | 'seq'>
  | Omit<MediaGetFrame, 'version' | 'connectionId' | 'seq'>;

export type GatewayResidentLinkEvent =
  | {
      readonly type: 'ready';
      readonly link: GatewayResidentLinkSummary;
    }
  | {
      readonly type: 'frame';
      readonly link: GatewayResidentLinkSummary;
      readonly frame: ResidentToGatewayFrame;
    }
  | {
      readonly type: 'removed';
      readonly link: GatewayResidentLinkSummary;
    };

export type GatewayResidentLinkListener = (
  event: Readonly<GatewayResidentLinkEvent>,
) => void;

export interface GatewayResidentLinkRegistryOptions {
  readonly clock: GatewayResidentLinkClock;
  readonly supportedCapabilities: readonly Capability[];
  readonly audit: GatewayResidentLinkAudit;
  readonly handshakeTimeoutMs?: number;
  readonly maxBufferedAmount?: number;
  readonly maxLinks?: number;
  /** Internal delivery sink, not an audit/log sink. */
  readonly onFrame?: (
    link: GatewayResidentLinkSummary,
    frame: ResidentToGatewayFrame,
  ) => void;
}
interface LiveLink {
  readonly binding: AuthenticatedNode;
  readonly connectionId: ConnectionId;
  readonly generation: number;
  readonly connectedAt: number;
  readonly socket: GatewayResidentSocketAdapter;
  readonly session: GatewayInboundSession;
  timer: unknown;
  detach: () => void;
  state: 'awaiting-hello' | 'ready';
  readyAt?: number;
  nextOutboundSeq: number;
  sending: boolean;
}
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFERED_AMOUNT = LIMITS.frameBytes;
const DEFAULT_MAX_LINKS = 1024;
function boundedInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(label + ' must be a positive safe integer');
  return value;
}
function inert(): void {}

/** Owns authenticated resident links and performs no HTTP/upgrade work. */
export class GatewayResidentLinkRegistry {
  readonly #clock: GatewayResidentLinkClock;
  readonly #supportedCapabilities: readonly Capability[];
  readonly #auditSink: GatewayResidentLinkAudit;
  readonly #handshakeTimeoutMs: number;
  readonly #maxBufferedAmount: number;
  readonly #maxLinks: number;
  readonly #onFrame?: GatewayResidentLinkRegistryOptions['onFrame'];
  readonly #links = new Map<string, LiveLink>();
  readonly #listeners = new Set<GatewayResidentLinkListener>();
  #nextGeneration = 1;
  #stopped = false;

  constructor(options: GatewayResidentLinkRegistryOptions) {
    if (
      !options ||
      !options.clock ||
      typeof options.clock.now !== 'function' ||
      typeof options.clock.setTimeout !== 'function' ||
      typeof options.clock.clearTimeout !== 'function' ||
      typeof options.audit !== 'function' ||
      (options.onFrame !== undefined && typeof options.onFrame !== 'function')
    )
      throw new Error('resident link registry options are invalid');
    this.#clock = options.clock;
    this.#supportedCapabilities = validateCapabilities([
      ...options.supportedCapabilities,
    ]);
    this.#auditSink = options.audit;
    this.#handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshakeTimeoutMs',
    );
    this.#maxBufferedAmount = boundedInteger(
      options.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT,
      'maxBufferedAmount',
    );
    this.#maxLinks = boundedInteger(
      options.maxLinks ?? DEFAULT_MAX_LINKS,
      'maxLinks',
    );
    this.#onFrame = options.onFrame;
  }
  get size(): number {
    return this.#links.size;
  }
  get stopped(): boolean {
    return this.#stopped;
  }

  summaries(): readonly GatewayResidentLinkSummary[] {
    return Object.freeze(
      [...this.#links.values()]
        .sort((a, b) =>
          a.binding.instanceId.localeCompare(b.binding.instanceId),
        )
        .map((link) => this.#summary(link)),
    );
  }
  summary(instanceId: string): GatewayResidentLinkSummary | undefined {
    const link = this.#links.get(instanceId);
    return link === undefined ? undefined : this.#summary(link);
  }
  /** Lookup only succeeds for the exact live instance/connection pair. */
  lookup(
    instanceId: string,
    connectionId: ConnectionId,
  ): GatewayResidentLinkSummary | undefined {
    const link = this.#links.get(instanceId);
    return link?.connectionId === connectionId
      ? this.#summary(link)
      : undefined;
  }

  /** Subscribe to decoded frames and link lifecycle without owning a transport. */
  subscribe(listener: GatewayResidentLinkListener): () => void {
    if (typeof listener !== 'function')
      throw new TypeError('resident link listener must be a function');
    if (this.#stopped) return inert;
    this.#listeners.add(listener);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      this.#listeners.delete(listener);
    };
  }

  /**
   * Build and send the next envelope for an exact ready link. Sequence ownership
   * stays in the registry so higher-level brokers cannot race its inbound session.
   */
  sendEffect(
    instanceId: string,
    connectionId: ConnectionId,
    effect: GatewayResidentOutboundEffect,
  ): boolean {
    const link = this.#links.get(instanceId);
    if (!link || link.connectionId !== connectionId || link.state !== 'ready')
      return false;
    return this.send(instanceId, connectionId, {
      ...effect,
      version: PROTOCOL_VERSION,
      connectionId,
      seq: link.nextOutboundSeq,
    } as GatewayToResidentFrame);
  }

  /** Fail closed when a broker cannot clean up a viewer over the live link. */
  disconnect(
    instanceId: string,
    connectionId: ConnectionId,
    reason = 'broker_cleanup',
  ): boolean {
    const link = this.#links.get(instanceId);
    if (!link || link.connectionId !== connectionId) return false;
    const safeReason = /^[a-z][a-z0-9_]{0,63}$/.test(reason)
      ? reason
      : 'broker_cleanup';
    this.#terminate(link, GATEWAY_RESIDENT_CLOSE.unavailable, safeReason);
    return true;
  }

  /**
   * Synchronous upgrade preflight. Rejections are audited here so HTTP can
   * fail before WebSocket bytes are written; admit repeats the checks as the
   * final publication defense.
   */
  preflight(
    binding: AuthenticatedNode,
  ): GatewayResidentAdmissionRejection | null {
    return this.#admissionRejection(binding, true);
  }

  /** First admission for an authenticated instance wins until removal. */
  admit(
    binding: AuthenticatedNode,
    socket: GatewayResidentSocketAdapter,
    connectionId: ConnectionId,
  ): GatewayResidentAdmission {
    const rejection = this.#admissionRejection(binding, true);
    if (rejection !== null) {
      const [code, reason] =
        rejection === 'stopped'
          ? [GATEWAY_RESIDENT_CLOSE.stopping, 'registry_stopped']
          : rejection === 'duplicate'
            ? [GATEWAY_RESIDENT_CLOSE.duplicate, 'duplicate_instance']
            : [GATEWAY_RESIDENT_CLOSE.unavailable, 'registry_capacity'];
      this.#safeClose(socket, code, reason);
      return Object.freeze({ accepted: false, reason: rejection });
    }
    let session: GatewayInboundSession;
    let connectedAt: number;
    let generation: number;
    try {
      if (!isConnectionId(connectionId))
        throw new Error('connection id is invalid');
      // Construct exactly one stateful shared decoder against the authenticated upgrade binding.
      session = new GatewayInboundSession({
        connectionId,
        instanceId: binding.instanceId as InstanceId,
        supportedCapabilities: this.#supportedCapabilities,
      });
      connectedAt = this.#now();
      generation = this.#nextGeneration++;
    } catch {
      this.#safeClose(
        socket,
        GATEWAY_RESIDENT_CLOSE.unavailable,
        'transport_error',
      );
      return Object.freeze({ accepted: false, reason: 'transport-error' });
    }
    const link: LiveLink = {
      binding: Object.freeze({
        instanceId: binding.instanceId,
        credentialId: binding.credentialId,
      }),
      connectionId,
      generation,
      connectedAt,
      socket,
      session,
      timer: undefined,
      detach: inert,
      state: 'awaiting-hello',
      nextOutboundSeq: 1,
      sending: false,
    };
    // Publication is the first-wins linearization point.
    this.#links.set(binding.instanceId, link);
    try {
      let attaching = true;
      let reentered = false;
      const dispatch = (operation: () => void): void => {
        if (attaching) {
          reentered = true;
          return;
        }
        this.#dispatch(link, operation);
      };
      const detach = socket.attach({
        text: (text) => dispatch(() => this.#receiveText(link, text)),
        binary: () =>
          dispatch(() =>
            this.#protocolFailure(
              link,
              new GatewayProtocolError(
                'invalid_frame',
                'resident link accepts text frames only',
              ),
            ),
          ),
        error: () => dispatch(() => this.#transportError(link)),
        close: () => dispatch(() => this.#peerClosed(link)),
      });
      attaching = false;
      link.detach = typeof detach === 'function' ? detach : inert;
      if (reentered) throw new Error('socket attach reentered admission');
      if (!this.#isCurrent(link))
        return Object.freeze({ accepted: false, reason: 'transport-error' });
      if (link.state === 'awaiting-hello') {
        const timer = this.#clock.setTimeout(
          () => this.#dispatch(link, () => this.#handshakeTimeout(link)),
          this.#handshakeTimeoutMs,
        );
        if (this.#isCurrent(link) && link.state === 'awaiting-hello')
          link.timer = timer;
        else this.#clock.clearTimeout(timer);
      }
      if (!this.#isCurrent(link))
        return Object.freeze({ accepted: false, reason: 'transport-error' });
    } catch {
      this.#auditLink('transport-error', link);
      this.#remove(link);
      this.#safeClose(
        socket,
        GATEWAY_RESIDENT_CLOSE.unavailable,
        'transport_error',
      );
      return Object.freeze({ accepted: false, reason: 'transport-error' });
    }
    this.#auditLink('admitted', link);
    return Object.freeze({ accepted: true, link: this.#summary(link) });
  }

  /** Send to an exact ready link. False denotes miss or bounded backpressure. */
  send(
    instanceId: string,
    connectionId: ConnectionId,
    frame: GatewayToResidentFrame,
  ): boolean {
    const link = this.#links.get(instanceId);
    if (!link || link.connectionId !== connectionId || link.state !== 'ready')
      return false;
    if (link.sending) {
      this.#terminate(
        link,
        GATEWAY_RESIDENT_CLOSE.unavailable,
        'reentrant_send',
      );
      return false;
    }
    link.sending = true;
    try {
      if (frame.type === 'hello.ack')
        throw new GatewayProtocolError(
          'invalid_handshake',
          'hello acknowledgement is owned by the registry',
        );
      if (frame.connectionId !== connectionId)
        throw new GatewayProtocolError(
          'connection_mismatch',
          'outbound frame has wrong connection id',
        );
      if (frame.seq !== link.nextOutboundSeq)
        throw new GatewayProtocolError(
          'invalid_sequence',
          'outbound sequence is not contiguous',
        );
      const encoded = serializeGatewayFrame(frame);
      if (!this.#hasCapacity(link, encoded)) {
        if (this.#isCurrent(link)) this.#auditLink('backpressure', link);
        return false;
      }
      if (!this.#isCurrent(link)) return false;
      if (
        frame.type === 'viewer.open' ||
        frame.type === 'viewer.close' ||
        frame.type === 'viewer.snapshot' ||
        frame.type === 'media.get'
      )
        link.session.registerRequest(frame);
      try {
        link.socket.sendText(encoded);
      } catch {
        this.#transportError(link);
        return false;
      }
      if (!this.#isCurrent(link)) return false;
      link.nextOutboundSeq += 1;
      if (frame.type === 'error' && frame.fatal)
        this.#terminate(link, GATEWAY_RESIDENT_CLOSE.protocol, 'fatal_error');
      return true;
    } finally {
      link.sending = false;
    }
  }

  /** Close all links, empty first, and permanently reject admission. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const links = [...this.#links.values()];
    for (const link of links) this.#remove(link);
    this.#listeners.clear();
    for (const link of links)
      this.#safeClose(
        link.socket,
        GATEWAY_RESIDENT_CLOSE.stopping,
        'registry_stopped',
      );
    this.#audit({ action: 'stop', at: this.#now() });
  }

  #admissionRejection(
    binding: AuthenticatedNode,
    audit: boolean,
  ): GatewayResidentAdmissionRejection | null {
    let reason: GatewayResidentAdmissionRejection | null = null;
    if (this.#stopped) reason = 'stopped';
    else if (this.#links.has(binding.instanceId)) reason = 'duplicate';
    else if (
      this.#links.size >= this.#maxLinks ||
      this.#nextGeneration >= Number.MAX_SAFE_INTEGER
    )
      reason = 'capacity';
    if (reason !== null && audit) {
      this.#audit({
        action:
          reason === 'stopped'
            ? 'stopped-rejected'
            : reason === 'duplicate'
              ? 'duplicate-rejected'
              : 'capacity-rejected',
        at: this.#now(),
        instanceId: binding.instanceId,
        credentialId: binding.credentialId,
      });
    }
    return reason;
  }

  #receiveText(link: LiveLink, text: string): void {
    if (!this.#isCurrent(link)) return;
    if (typeof text !== 'string') {
      this.#protocolFailure(
        link,
        new GatewayProtocolError(
          'invalid_frame',
          'adapter yielded non-text data',
        ),
      );
      return;
    }
    if (utf8.encode(text).byteLength > LIMITS.frameBytes) {
      this.#protocolFailure(
        link,
        new GatewayProtocolError(
          'frame_too_large',
          'frame exceeds its byte limit',
        ),
      );
      return;
    }
    let frame: ResidentToGatewayFrame;
    try {
      frame = link.session.receive(text);
    } catch (error) {
      this.#protocolFailure(
        link,
        error instanceof GatewayProtocolError
          ? error
          : new GatewayProtocolError('invalid_frame', 'frame decoding failed'),
      );
      return;
    }
    if (link.state === 'awaiting-hello') {
      // The session guarantees this is the one valid hello and computes intersection.
      if (frame.type !== 'hello') {
        this.#protocolFailure(
          link,
          new GatewayProtocolError(
            'invalid_handshake',
            'first resident frame must be hello',
          ),
        );
        return;
      }
      this.#clearTimer(link);
      const ack = createGatewayHelloAck({
        connectionId: link.connectionId,
        seq: link.nextOutboundSeq,
        instanceId: link.binding.instanceId as InstanceId,
        capabilities: link.session.negotiatedCapabilities,
      });
      const encoded = serializeGatewayFrame(ack);
      if (!this.#hasCapacity(link, encoded)) {
        this.#auditLink('backpressure', link);
        this.#terminate(
          link,
          GATEWAY_RESIDENT_CLOSE.unavailable,
          'backpressure',
        );
        return;
      }
      try {
        link.socket.sendText(encoded);
      } catch {
        this.#transportError(link);
        return;
      }
      link.nextOutboundSeq += 1;
      link.state = 'ready';
      link.readyAt = this.#now();
      this.#auditLink('ready', link);
      const summary = this.#summary(link);
      this.#notify(Object.freeze({ type: 'ready', link: summary }));
      this.#onFrame?.(summary, frame);
      this.#notify(Object.freeze({ type: 'frame', link: summary, frame }));
      return;
    }
    if (frame.type === 'error' && frame.fatal) {
      this.#terminate(
        link,
        GATEWAY_RESIDENT_CLOSE.protocol,
        'peer_fatal_error',
      );
      return;
    }
    const summary = this.#summary(link);
    this.#onFrame?.(summary, frame);
    this.#notify(Object.freeze({ type: 'frame', link: summary, frame }));
  }

  #dispatch(link: LiveLink, operation: () => void): void {
    if (!this.#isCurrent(link)) return;
    try {
      operation();
    } catch {
      this.#terminate(
        link,
        GATEWAY_RESIDENT_CLOSE.unavailable,
        'internal_error',
      );
    }
  }
  #protocolFailure(link: LiveLink, error: GatewayProtocolError): void {
    if (!this.#isCurrent(link)) return;
    this.#audit({
      action: 'protocol-error',
      at: this.#now(),
      instanceId: link.binding.instanceId,
      credentialId: link.binding.credentialId,
      connectionId: link.connectionId,
      generation: link.generation,
      protocolCode: error.code,
    });
    const encoded = serializeGatewayFrame(
      createProtocolError({
        connectionId: link.connectionId,
        seq: link.nextOutboundSeq,
        error: { code: error.code, message: error.message },
        fatal: true,
      }),
    );
    if (this.#hasCapacity(link, encoded)) {
      try {
        link.socket.sendText(encoded);
        link.nextOutboundSeq += 1;
      } catch {
        /* close below */
      }
    }
    this.#terminate(link, GATEWAY_RESIDENT_CLOSE.protocol, 'protocol_error');
  }
  #handshakeTimeout(link: LiveLink): void {
    if (!this.#isCurrent(link) || link.state !== 'awaiting-hello') return;
    this.#auditLink('handshake-timeout', link);
    this.#protocolFailure(
      link,
      new GatewayProtocolError('invalid_handshake', 'resident hello timed out'),
    );
  }
  #transportError(link: LiveLink): void {
    if (!this.#isCurrent(link)) return;
    this.#auditLink('transport-error', link);
    this.#terminate(
      link,
      GATEWAY_RESIDENT_CLOSE.unavailable,
      'transport_error',
    );
  }
  #peerClosed(link: LiveLink): void {
    if (!this.#isCurrent(link)) return;
    this.#auditLink('closed', link);
    this.#remove(link);
  }
  #terminate(link: LiveLink, code: number, reason: string): void {
    if (!this.#isCurrent(link)) return;
    this.#remove(link);
    this.#safeClose(link.socket, code, reason);
  }
  #remove(link: LiveLink): boolean {
    if (!this.#isCurrent(link)) return false;
    const summary = this.#summary(link);
    this.#links.delete(link.binding.instanceId);
    this.#clearTimer(link);
    const detach = link.detach;
    link.detach = inert;
    try {
      detach();
    } catch {
      /* removal remains authoritative */
    }
    this.#notify(Object.freeze({ type: 'removed', link: summary }));
    return true;
  }
  #isCurrent(link: LiveLink): boolean {
    return (
      this.#links.get(link.binding.instanceId)?.generation === link.generation
    );
  }
  #clearTimer(link: LiveLink): void {
    if (link.timer === undefined) return;
    const timer = link.timer;
    link.timer = undefined;
    try {
      this.#clock.clearTimeout(timer);
    } catch {
      /* removal remains authoritative */
    }
  }
  #now(): number {
    const value = this.#clock.now();
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error('resident link clock returned an invalid time');
    return value;
  }
  #hasCapacity(link: LiveLink, encoded: string): boolean {
    let buffered: number;
    try {
      buffered = link.socket.bufferedAmount;
    } catch {
      return false;
    }
    return (
      Number.isSafeInteger(buffered) &&
      buffered >= 0 &&
      buffered + utf8.encode(encoded).byteLength <= this.#maxBufferedAmount
    );
  }
  #safeClose(
    socket: GatewayResidentSocketAdapter,
    code: number,
    reason: string,
  ): void {
    try {
      socket.close(code, reason);
    } catch {
      /* already gone */
    }
  }
  #summary(link: LiveLink): GatewayResidentLinkSummary {
    const capabilities = Object.freeze([
      ...(link.state === 'ready' ? link.session.negotiatedCapabilities : []),
    ]);
    return Object.freeze({
      instanceId: link.binding.instanceId,
      credentialId: link.binding.credentialId,
      connectionId: link.connectionId,
      generation: link.generation,
      connectedAt: link.connectedAt,
      ...(link.readyAt === undefined ? {} : { readyAt: link.readyAt }),
      state: link.state,
      capabilities,
    });
  }
  #notify(event: Readonly<GatewayResidentLinkEvent>): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        /* one state consumer cannot alter link ownership or starve its peers */
      }
    }
  }
  #auditLink(action: GatewayResidentLinkAuditAction, link: LiveLink): void {
    this.#audit({
      action,
      at: this.#now(),
      instanceId: link.binding.instanceId,
      credentialId: link.binding.credentialId,
      connectionId: link.connectionId,
      generation: link.generation,
    });
  }
  #audit(event: GatewayResidentLinkAuditEvent): void {
    try {
      this.#auditSink(Object.freeze({ ...event }));
    } catch {
      /* observability cannot alter admission */
    }
  }
}
export function createGatewayResidentLinkRegistry(
  options: GatewayResidentLinkRegistryOptions,
): GatewayResidentLinkRegistry {
  return new GatewayResidentLinkRegistry(options);
}
