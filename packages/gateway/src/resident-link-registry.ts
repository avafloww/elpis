import {
  GatewayInboundSession,
  GatewayProtocolError,
  LIMITS,
  createGatewayHelloAck,
  createProtocolError,
  serializeGatewayFrame,
  validateCapabilities,
  type Capability,
  type ConnectionId,
  type GatewayToResidentFrame,
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
export type GatewayResidentAdmission =
  | { readonly accepted: true; readonly link: GatewayResidentLinkSummary }
  | {
      readonly accepted: false;
      readonly reason:
        | 'duplicate'
        | 'capacity'
        | 'stopped'
        | 'transport-error';
    };
export interface GatewayResidentLinkRegistryOptions {
  readonly createConnectionId: () => ConnectionId;
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
  readonly #createConnectionId: () => ConnectionId;
  readonly #clock: GatewayResidentLinkClock;
  readonly #supportedCapabilities: readonly Capability[];
  readonly #auditSink: GatewayResidentLinkAudit;
  readonly #handshakeTimeoutMs: number;
  readonly #maxBufferedAmount: number;
  readonly #maxLinks: number;
  readonly #onFrame?: GatewayResidentLinkRegistryOptions['onFrame'];
  readonly #links = new Map<string, LiveLink>();
  #nextGeneration = 1;
  #stopped = false;

  constructor(options: GatewayResidentLinkRegistryOptions) {
    if (
      !options ||
      typeof options.createConnectionId !== 'function' ||
      !options.clock ||
      typeof options.clock.now !== 'function' ||
      typeof options.clock.setTimeout !== 'function' ||
      typeof options.clock.clearTimeout !== 'function' ||
      typeof options.audit !== 'function' ||
      (options.onFrame !== undefined && typeof options.onFrame !== 'function')
    )
      throw new Error('resident link registry options are invalid');
    this.#createConnectionId = options.createConnectionId;
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

  /** First admission for an authenticated instance wins until removal. */
  admit(
    binding: AuthenticatedNode,
    socket: GatewayResidentSocketAdapter,
  ): GatewayResidentAdmission {
    if (this.#stopped) {
      this.#audit({
        action: 'stopped-rejected',
        at: this.#now(),
        instanceId: binding.instanceId,
        credentialId: binding.credentialId,
      });
      this.#safeClose(
        socket,
        GATEWAY_RESIDENT_CLOSE.stopping,
        'registry_stopped',
      );
      return Object.freeze({ accepted: false, reason: 'stopped' });
    }
    // Duplicate rejection does not consume injected ids or generations.
    if (this.#links.has(binding.instanceId)) {
      this.#audit({
        action: 'duplicate-rejected',
        at: this.#now(),
        instanceId: binding.instanceId,
        credentialId: binding.credentialId,
      });
      this.#safeClose(
        socket,
        GATEWAY_RESIDENT_CLOSE.duplicate,
        'duplicate_instance',
      );
      return Object.freeze({ accepted: false, reason: 'duplicate' });
    }
    if (
      this.#links.size >= this.#maxLinks ||
      this.#nextGeneration >= Number.MAX_SAFE_INTEGER
    ) {
      this.#audit({
        action: 'capacity-rejected',
        at: this.#now(),
        instanceId: binding.instanceId,
        credentialId: binding.credentialId,
      });
      this.#safeClose(
        socket,
        GATEWAY_RESIDENT_CLOSE.unavailable,
        'registry_capacity',
      );
      return Object.freeze({ accepted: false, reason: 'capacity' });
    }
    let connectionId: ConnectionId;
    let session: GatewayInboundSession;
    let connectedAt: number;
    let generation: number;
    try {
      connectionId = this.#createConnectionId();
      // Construct exactly one stateful shared decoder against the auth binding.
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
      this.#auditLink('backpressure', link);
      return false;
    }
    if (
      frame.type === 'viewer.open' ||
      frame.type === 'viewer.close' ||
      frame.type === 'viewer.snapshot' ||
      frame.type === 'media.get'
    )
      link.session.registerRequest(frame);
    try {
      link.socket.sendText(encoded);
      link.nextOutboundSeq += 1;
    } catch {
      this.#transportError(link);
      return false;
    }
    if (frame.type === 'error' && frame.fatal)
      this.#terminate(link, GATEWAY_RESIDENT_CLOSE.protocol, 'fatal_error');
    return true;
  }

  /** Close all links, empty first, and permanently reject admission. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    const links = [...this.#links.values()];
    for (const link of links) this.#remove(link);
    for (const link of links)
      this.#safeClose(
        link.socket,
        GATEWAY_RESIDENT_CLOSE.stopping,
        'registry_stopped',
      );
    this.#audit({ action: 'stop', at: this.#now() });
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
      this.#onFrame?.(this.#summary(link), frame);
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
    this.#onFrame?.(this.#summary(link), frame);
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
    this.#links.delete(link.binding.instanceId);
    this.#clearTimer(link);
    const detach = link.detach;
    link.detach = inert;
    try {
      detach();
    } catch {
      /* removal remains authoritative */
    }
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
