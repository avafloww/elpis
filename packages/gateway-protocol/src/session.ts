import {
  decodeGatewayFrame,
  decodeResidentFrame,
  GatewayProtocolError,
  negotiateCapabilities,
  validateCapabilities,
} from './codec.js';
import {
  LIMITS,
  PROTOCOL_VERSION,
  type Capability,
  type ConnectionId,
  type ConsoleOutputFrame,
  type FailedMediaResultFrame,
  type GatewayHelloAckFrame,
  type GatewayToResidentFrame,
  type InstanceId,
  type MediaGetFrame,
  type MediaResultFrame,
  type OperationResultFrame,
  type ProtocolErrorFrame,
  type RequestId,
  type ResidentHelloFrame,
  type ResidentToGatewayFrame,
  type SuccessfulMediaResultFrame,
  type ViewerId,
  type ViewerOperationFrame,
} from './types.js';

function protocolFailure(
  code: GatewayProtocolError['code'],
  message: string,
): never {
  throw new GatewayProtocolError(code, message);
}

function sameCapabilities(
  actual: readonly Capability[],
  expected: readonly Capability[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function needs(frameType: string): Capability | undefined {
  if (
    frameType.startsWith('viewer.') ||
    frameType.startsWith('console.') ||
    frameType === 'operation.result'
  )
    return 'console.v1';
  if (frameType.startsWith('media.')) return 'media.v1';
  return undefined;
}

function rememberRequest(
  ids: Set<RequestId>,
  order: RequestId[],
  id: RequestId,
): void {
  if (ids.has(id))
    protocolFailure('request_mismatch', 'request id was already used');
  ids.add(id);
  order.push(id);
  if (order.length > LIMITS.requestHistoryPerConnection) {
    const expired = order.shift();
    if (expired !== undefined) ids.delete(expired);
  }
}

interface SessionOptions {
  connectionId: ConnectionId;
  instanceId: InstanceId;
}

interface PendingRequest {
  type: string;
  viewerId?: ViewerId;
}

/** Stateful decoder for frames arriving at a Gateway from one resident link. */
export class GatewayInboundSession {
  readonly connectionId: ConnectionId;
  readonly instanceId: InstanceId;
  readonly supportedCapabilities: readonly Capability[];
  private negotiated: readonly Capability[] = Object.freeze([]);
  private residentHello?: ResidentHelloFrame;
  private nextSeq = 1;
  private terminal = false;
  private pending = new Map<RequestId, PendingRequest>();
  private requestIds = new Set<RequestId>();
  private requestOrder: RequestId[] = [];
  private viewers = new Set<ViewerId>();

  constructor(
    options: SessionOptions & { supportedCapabilities: readonly Capability[] },
  ) {
    this.connectionId = options.connectionId;
    this.instanceId = options.instanceId;
    this.supportedCapabilities = validateCapabilities([
      ...options.supportedCapabilities,
    ]);
  }

  get negotiatedCapabilities(): readonly Capability[] {
    return this.negotiated;
  }

  get hello(): ResidentHelloFrame | undefined {
    return this.residentHello;
  }

  /** Register an outbound request before sending it so its result is correlated. */
  registerRequest(frame: ViewerOperationFrame | MediaGetFrame): void {
    if (this.terminal)
      protocolFailure('invalid_handshake', 'session is terminal');
    if (!this.residentHello)
      protocolFailure('invalid_handshake', 'resident hello is not complete');
    if (frame.connectionId !== this.connectionId)
      protocolFailure(
        'connection_mismatch',
        'outbound request has the wrong connection id',
      );
    if (this.requestIds.has(frame.requestId))
      protocolFailure('request_mismatch', 'request id was already used');
    if (this.pending.size >= LIMITS.pendingRequestsPerConnection)
      protocolFailure('request_limit', 'too many requests are pending');
    const capability = needs(frame.type);
    if (capability && !this.negotiated.includes(capability))
      protocolFailure(
        'capability_required',
        `${frame.type} requires ${capability}`,
      );
    if (
      'viewerId' in frame &&
      [...this.pending.values()].some(
        (request) => request.viewerId === frame.viewerId,
      )
    )
      protocolFailure(
        'request_mismatch',
        'viewer already has an outstanding operation',
      );
    if (frame.type === 'viewer.open') {
      if (this.viewers.has(frame.viewerId))
        protocolFailure('request_mismatch', 'viewer is already open');
      if (this.viewers.size >= LIMITS.viewersPerConnection)
        protocolFailure('viewer_limit', 'viewer limit reached');
      this.viewers.add(frame.viewerId);
    } else if (
      (frame.type === 'viewer.close' || frame.type === 'viewer.snapshot') &&
      !this.viewers.has(frame.viewerId)
    ) {
      protocolFailure('request_mismatch', 'viewer is not open');
    }
    rememberRequest(this.requestIds, this.requestOrder, frame.requestId);
    this.pending.set(frame.requestId, {
      type: frame.type,
      ...('viewerId' in frame ? { viewerId: frame.viewerId } : {}),
    });
  }

  receive(input: string | unknown): ResidentToGatewayFrame {
    try {
      return this.receiveFrame(input);
    } catch (error) {
      if (error instanceof GatewayProtocolError && error.fatal)
        this.terminal = true;
      throw error;
    }
  }

  private advanceSequence(): void {
    if (this.nextSeq === Number.MAX_SAFE_INTEGER) this.terminal = true;
    else this.nextSeq += 1;
  }

  private receiveFrame(input: string | unknown): ResidentToGatewayFrame {
    if (this.terminal)
      protocolFailure('invalid_handshake', 'session is terminal');
    const frame = decodeResidentFrame(input);
    if (frame.connectionId !== this.connectionId)
      protocolFailure('connection_mismatch', 'connection id changed');
    if (frame.seq !== this.nextSeq)
      protocolFailure(
        'invalid_sequence',
        'resident sequence is not contiguous',
      );
    if (!this.residentHello) {
      if (frame.type !== 'hello')
        protocolFailure(
          'invalid_handshake',
          'first resident frame must be hello',
        );
      if (frame.instanceId !== this.instanceId)
        protocolFailure(
          'instance_mismatch',
          'hello instance id does not match authenticated credential',
        );
      this.residentHello = frame;
      this.negotiated = negotiateCapabilities(
        this.supportedCapabilities,
        frame.capabilities,
      );
      this.advanceSequence();
      return frame;
    }
    if (frame.type === 'hello')
      protocolFailure('invalid_handshake', 'second hello is not allowed');
    const capability = needs(frame.type);
    if (capability && !this.negotiated.includes(capability))
      protocolFailure(
        'capability_required',
        `${frame.type} requires ${capability}`,
      );
    if (frame.type === 'console.output' && !this.viewers.has(frame.viewerId))
      protocolFailure(
        'request_mismatch',
        'console output names a viewer that is not open',
      );
    if (frame.type === 'operation.result') {
      const expected = this.pending.get(frame.requestId);
      if (
        !expected ||
        expected.type !== frame.operation ||
        expected.viewerId !== frame.viewerId
      )
        protocolFailure(
          'request_mismatch',
          'operation result does not match an outstanding request',
        );
      this.pending.delete(frame.requestId);
      if (frame.operation === 'viewer.open' && !frame.ok)
        this.viewers.delete(frame.viewerId);
      if (frame.operation === 'viewer.close' && frame.ok)
        this.viewers.delete(frame.viewerId);
    } else if (frame.type === 'media.result') {
      const expected = this.pending.get(frame.requestId);
      if (!expected || expected.type !== 'media.get')
        protocolFailure(
          'request_mismatch',
          'media result does not match an outstanding request',
        );
      this.pending.delete(frame.requestId);
    } else if (frame.type === 'error' && frame.requestId !== undefined) {
      const expected = this.pending.get(frame.requestId);
      if (!expected)
        protocolFailure(
          'request_mismatch',
          'error does not match an outstanding request',
        );
      this.pending.delete(frame.requestId);
      if (expected.type === 'viewer.open' && expected.viewerId !== undefined)
        this.viewers.delete(expected.viewerId);
    }
    this.advanceSequence();
    if (frame.type === 'error' && frame.fatal) this.terminal = true;
    return frame;
  }
}

interface PendingViewerOperation {
  operation: ViewerOperationFrame['type'];
  viewerId: ViewerId;
}

type ResidentEnvelopeFields = 'version' | 'connectionId' | 'seq' | 'type';

/** Typed resident effect payloads. Envelope and sequence are session-owned. */
export type ResidentOperationResultEffect = Omit<
  OperationResultFrame,
  ResidentEnvelopeFields
>;
export type ResidentConsoleOutputEffect = Omit<
  ConsoleOutputFrame,
  ResidentEnvelopeFields
>;
export type ResidentMediaResultEffect =
  | Omit<SuccessfulMediaResultFrame, ResidentEnvelopeFields>
  | Omit<FailedMediaResultFrame, ResidentEnvelopeFields>;

/** Stateful decoder for Gateway frames arriving at one resident link. */
export class ResidentInboundSession {
  readonly connectionId: ConnectionId;
  readonly instanceId: InstanceId;
  readonly offeredCapabilities: readonly Capability[];
  readonly gatewayCapabilities?: readonly Capability[];
  private negotiated: readonly Capability[] = Object.freeze([]);
  private gatewayAck?: GatewayHelloAckFrame;
  private nextSeq = 1;
  private terminal = false;
  private requestIds = new Set<RequestId>();
  private requestOrder: RequestId[] = [];
  private pendingOperations = new Map<RequestId, PendingViewerOperation>();
  private pendingMedia = new Set<RequestId>();
  private nextOutboundSeq = 2;
  private viewers = new Set<ViewerId>();

  constructor(
    options: SessionOptions & {
      offeredCapabilities: readonly Capability[];
      gatewayCapabilities?: readonly Capability[];
    },
  ) {
    this.connectionId = options.connectionId;
    this.instanceId = options.instanceId;
    this.offeredCapabilities = validateCapabilities([
      ...options.offeredCapabilities,
    ]);
    this.gatewayCapabilities =
      options.gatewayCapabilities === undefined
        ? undefined
        : validateCapabilities([...options.gatewayCapabilities]);
  }

  get negotiatedCapabilities(): readonly Capability[] {
    return this.negotiated;
  }

  get ack(): GatewayHelloAckFrame | undefined {
    return this.gatewayAck;
  }

  /**
   * Build and apply one viewer effect result. The session, not the caller, owns
   * the resident envelope and contiguous outbound sequence.
   */
  operationResult(effect: ResidentOperationResultEffect): OperationResultFrame {
    this.assertOutboundReady();
    const expected = this.pendingOperations.get(effect.requestId);
    if (
      !expected ||
      expected.operation !== effect.operation ||
      expected.viewerId !== effect.viewerId
    )
      protocolFailure(
        'request_mismatch',
        'operation result does not match a received request',
      );
    const frame = decodeResidentFrame({
      ...effect,
      version: PROTOCOL_VERSION,
      connectionId: this.connectionId,
      seq: this.nextOutboundSeq,
      type: 'operation.result',
    }) as OperationResultFrame;
    this.pendingOperations.delete(frame.requestId);
    if (frame.operation === 'viewer.open' && frame.ok)
      this.viewers.add(frame.viewerId);
    if (frame.operation === 'viewer.close' && frame.ok)
      this.viewers.delete(frame.viewerId);
    this.advanceOutboundSequence();
    return frame;
  }

  /** Build console output for a viewer whose open effect succeeded. */
  consoleOutput(effect: ResidentConsoleOutputEffect): ConsoleOutputFrame {
    this.assertOutboundReady();
    if (!this.viewers.has(effect.viewerId))
      protocolFailure(
        'request_mismatch',
        'console output names a viewer that is not open',
      );
    const frame = decodeResidentFrame({
      ...effect,
      version: PROTOCOL_VERSION,
      connectionId: this.connectionId,
      seq: this.nextOutboundSeq,
      type: 'console.output',
    }) as ConsoleOutputFrame;
    this.advanceOutboundSequence();
    return frame;
  }

  /** Build a result only for one outstanding media.get request. */
  mediaResult(effect: ResidentMediaResultEffect): MediaResultFrame {
    this.assertOutboundReady();
    if (!this.pendingMedia.has(effect.requestId))
      protocolFailure(
        'request_mismatch',
        'media result does not match a received request',
      );
    const frame = decodeResidentFrame({
      ...effect,
      version: PROTOCOL_VERSION,
      connectionId: this.connectionId,
      seq: this.nextOutboundSeq,
      type: 'media.result',
    }) as MediaResultFrame;
    this.pendingMedia.delete(frame.requestId);
    this.advanceOutboundSequence();
    return frame;
  }

  /**
   * Compatibility entry point for callers that still hold a complete frame.
   * Its envelope must exactly equal the session-owned next envelope.
   */
  completeOperation(input: OperationResultFrame): OperationResultFrame {
    const frame = decodeResidentFrame(input);
    if (frame.type !== 'operation.result')
      protocolFailure('request_mismatch', 'frame is not an operation result');
    if (frame.connectionId !== this.connectionId)
      protocolFailure(
        'connection_mismatch',
        'operation result has wrong connection',
      );
    if (frame.seq !== this.nextOutboundSeq)
      protocolFailure(
        'invalid_sequence',
        'resident outbound sequence is not contiguous',
      );
    const { requestId, viewerId, operation, ok, ...rest } = frame;
    return this.operationResult({
      requestId,
      viewerId,
      operation,
      ok,
      ...('error' in rest && rest.error !== undefined
        ? { error: rest.error }
        : {}),
    });
  }

  private assertOutboundReady(): void {
    if (this.terminal)
      protocolFailure('invalid_handshake', 'session is terminal');
    if (!this.gatewayAck)
      protocolFailure(
        'invalid_handshake',
        'gateway hello acknowledgement is not complete',
      );
  }

  private advanceOutboundSequence(): void {
    if (this.nextOutboundSeq === Number.MAX_SAFE_INTEGER) this.terminal = true;
    else this.nextOutboundSeq += 1;
  }

  receive(input: string | unknown): GatewayToResidentFrame {
    try {
      return this.receiveFrame(input);
    } catch (error) {
      if (error instanceof GatewayProtocolError && error.fatal)
        this.terminal = true;
      throw error;
    }
  }

  private advanceSequence(): void {
    if (this.nextSeq === Number.MAX_SAFE_INTEGER) this.terminal = true;
    else this.nextSeq += 1;
  }

  private receiveFrame(input: string | unknown): GatewayToResidentFrame {
    if (this.terminal)
      protocolFailure('invalid_handshake', 'session is terminal');
    const frame = decodeGatewayFrame(input);
    if (frame.connectionId !== this.connectionId)
      protocolFailure('connection_mismatch', 'connection id changed');
    if (frame.seq !== this.nextSeq)
      protocolFailure('invalid_sequence', 'gateway sequence is not contiguous');
    if (!this.gatewayAck) {
      if (frame.type === 'error') {
        if (!frame.fatal)
          protocolFailure(
            'invalid_handshake',
            'pre-handshake error must be fatal',
          );
        this.advanceSequence();
        this.terminal = true;
        return frame;
      }
      if (frame.type !== 'hello.ack')
        protocolFailure(
          'invalid_handshake',
          'first gateway frame must be hello.ack',
        );
      if (frame.instanceId !== this.instanceId)
        protocolFailure(
          'instance_mismatch',
          'hello acknowledgement has the wrong instance id',
        );
      const expected =
        this.gatewayCapabilities === undefined
          ? frame.capabilities
          : negotiateCapabilities(
              this.offeredCapabilities,
              this.gatewayCapabilities,
            );
      if (
        !frame.capabilities.every((capability) =>
          this.offeredCapabilities.includes(capability),
        ) ||
        !sameCapabilities(frame.capabilities, expected)
      )
        protocolFailure(
          'invalid_handshake',
          'hello acknowledgement capabilities are not the exact negotiated intersection',
        );
      this.gatewayAck = frame;
      this.negotiated = Object.freeze([...frame.capabilities]);
      this.advanceSequence();
      return frame;
    }
    if (frame.type === 'hello.ack')
      protocolFailure(
        'invalid_handshake',
        'second hello acknowledgement is not allowed',
      );
    const capability = needs(frame.type);
    if (capability && !this.negotiated.includes(capability))
      protocolFailure(
        'capability_required',
        `${frame.type} requires ${capability}`,
      );

    if (
      frame.type === 'viewer.open' ||
      frame.type === 'viewer.close' ||
      frame.type === 'viewer.snapshot'
    ) {
      if (this.requestIds.has(frame.requestId))
        protocolFailure('request_mismatch', 'request id was already used');
      if (
        this.pendingOperations.size + this.pendingMedia.size >=
        LIMITS.pendingRequestsPerConnection
      )
        protocolFailure('request_limit', 'too many requests are pending');
      if (
        [...this.pendingOperations.values()].some(
          (operation) => operation.viewerId === frame.viewerId,
        )
      )
        protocolFailure(
          'request_mismatch',
          'viewer already has an outstanding operation',
        );
      if (frame.type === 'viewer.open') {
        if (this.viewers.has(frame.viewerId))
          protocolFailure('request_mismatch', 'viewer is already open');
        const opening = [...this.pendingOperations.values()].filter(
          (operation) => operation.operation === 'viewer.open',
        ).length;
        if (this.viewers.size + opening >= LIMITS.viewersPerConnection)
          protocolFailure('viewer_limit', 'viewer limit reached');
      } else if (!this.viewers.has(frame.viewerId)) {
        protocolFailure('request_mismatch', 'viewer is not open');
      }
      rememberRequest(this.requestIds, this.requestOrder, frame.requestId);
      this.pendingOperations.set(frame.requestId, {
        operation: frame.type,
        viewerId: frame.viewerId,
      });
    } else if (frame.type === 'media.get') {
      if (
        this.pendingOperations.size + this.pendingMedia.size >=
        LIMITS.pendingRequestsPerConnection
      )
        protocolFailure('request_limit', 'too many requests are pending');
      if (
        frame.route === '/identity/avatar' &&
        !this.negotiated.includes('identity.v1')
      )
        protocolFailure(
          'capability_required',
          'identity avatar media requires identity.v1',
        );
      rememberRequest(this.requestIds, this.requestOrder, frame.requestId);
      this.pendingMedia.add(frame.requestId);
    } else if (
      frame.type === 'console.input' &&
      !this.viewers.has(frame.viewerId)
    ) {
      protocolFailure('request_mismatch', 'viewer is not open');
    }
    this.advanceSequence();
    if (frame.type === 'error' && frame.fatal) this.terminal = true;
    return frame;
  }
}

export function createResidentHello(
  input: Omit<ResidentHelloFrame, 'version' | 'type'>,
): ResidentHelloFrame {
  return decodeResidentFrame({
    version: PROTOCOL_VERSION,
    type: 'hello',
    ...input,
  }) as ResidentHelloFrame;
}

export function createGatewayHelloAck(
  input: Omit<GatewayHelloAckFrame, 'version' | 'type'>,
): GatewayHelloAckFrame {
  return decodeGatewayFrame({
    version: PROTOCOL_VERSION,
    type: 'hello.ack',
    ...input,
  }) as GatewayHelloAckFrame;
}

export function createProtocolError(
  input: Omit<ProtocolErrorFrame, 'version' | 'type'>,
): ProtocolErrorFrame {
  return decodeGatewayFrame({
    version: PROTOCOL_VERSION,
    type: 'error',
    ...input,
  }) as ProtocolErrorFrame;
}
