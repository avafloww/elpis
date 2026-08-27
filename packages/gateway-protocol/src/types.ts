/** Wire protocol v1. Package semver major and wire version intentionally match. */
export const PROTOCOL_VERSION = 1 as const;

export const CAPABILITIES = ['console.v1', 'identity.v1', 'media.v1'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const LIMITS = Object.freeze({
  frameBytes: 36 * 1024 * 1024,
  consolePayloadBytes: 8 * 1024 * 1024,
  mediaBytes: 25 * 1024 * 1024,
  mediaRouteBytes: 2 * 1024,
  identityNameBytes: 128,
  buildValueBytes: 128,
  errorCodeBytes: 64,
  errorMessageBytes: 1024,
  viewersPerConnection: 16,
  pendingRequestsPerConnection: 128,
  requestHistoryPerConnection: 4096,
} as const);

export type InstanceId = `egi1.${string}`;
export type ConnectionId = `egx1.${string}`;
export type ViewerId = `egv1.${string}`;
export type RequestId = `egr1.${string}`;

export type AvatarMediaType = 'image/png' | 'image/jpeg' | 'image/webp';
export interface AvatarDescriptor {
  mediaType: AvatarMediaType;
  byteLength: number;
  sha256: string;
}
export interface ResidentIdentity {
  name: string;
  avatar?: AvatarDescriptor;
}
export interface BuildMetadata {
  version: string;
  revision?: string;
  state?: string;
}

export interface Envelope {
  version: typeof PROTOCOL_VERSION;
  connectionId: ConnectionId;
  seq: number;
  type: string;
}

export interface ResidentHelloFrame extends Envelope {
  type: 'hello';
  instanceId: InstanceId;
  capabilities: readonly Capability[];
  identity: ResidentIdentity;
  build: BuildMetadata;
}
export interface GatewayHelloAckFrame extends Envelope {
  type: 'hello.ack';
  instanceId: InstanceId;
  capabilities: readonly Capability[];
}

export type ViewerOperation =
  'viewer.open' | 'viewer.close' | 'viewer.snapshot';
export interface ViewerOperationFrame extends Envelope {
  type: ViewerOperation;
  requestId: RequestId;
  viewerId: ViewerId;
}
export interface ConsoleInputFrame extends Envelope {
  type: 'console.input';
  viewerId: ViewerId;
  payload: string;
}
export interface MediaGetFrame extends Envelope {
  type: 'media.get';
  requestId: RequestId;
  route: string;
}

export interface OperationResultFrame extends Envelope {
  type: 'operation.result';
  requestId: RequestId;
  viewerId: ViewerId;
  operation: ViewerOperation;
  ok: boolean;
  error?: ErrorDetail;
}
export interface ConsoleOutputFrame extends Envelope {
  type: 'console.output';
  viewerId: ViewerId;
  payload: string;
}
export interface SuccessfulMediaResultFrame extends Envelope {
  type: 'media.result';
  requestId: RequestId;
  ok: true;
  mediaType: string;
  byteLength: number;
  sha256: string;
  data: string;
}
export interface FailedMediaResultFrame extends Envelope {
  type: 'media.result';
  requestId: RequestId;
  ok: false;
  error: ErrorDetail;
}
export type MediaResultFrame =
  SuccessfulMediaResultFrame | FailedMediaResultFrame;

export const PROTOCOL_ERROR_CODES = [
  'invalid_json',
  'frame_too_large',
  'unsupported_version',
  'unknown_type',
  'unknown_capability',
  'invalid_frame',
  'invalid_sequence',
  'invalid_handshake',
  'connection_mismatch',
  'instance_mismatch',
  'capability_required',
  'request_mismatch',
  'viewer_limit',
  'request_limit',
] as const;
export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export interface ErrorDetail {
  code: string;
  message: string;
}
export interface ProtocolErrorDetail extends ErrorDetail {
  code: ProtocolErrorCode;
}
export interface ProtocolErrorFrame extends Envelope {
  type: 'error';
  error: ProtocolErrorDetail;
  fatal: boolean;
  requestId?: RequestId;
}

export type GatewayToResidentFrame =
  | GatewayHelloAckFrame
  | ViewerOperationFrame
  | ConsoleInputFrame
  | MediaGetFrame
  | ProtocolErrorFrame;
export type ResidentToGatewayFrame =
  | ResidentHelloFrame
  | OperationResultFrame
  | ConsoleOutputFrame
  | MediaResultFrame
  | ProtocolErrorFrame;
export type ProtocolFrame = GatewayToResidentFrame | ResidentToGatewayFrame;

export const GATEWAY_FRAME_TYPES = [
  'hello.ack',
  'viewer.open',
  'viewer.close',
  'viewer.snapshot',
  'console.input',
  'media.get',
  'error',
] as const;
export const RESIDENT_FRAME_TYPES = [
  'hello',
  'operation.result',
  'console.output',
  'media.result',
  'error',
] as const;
