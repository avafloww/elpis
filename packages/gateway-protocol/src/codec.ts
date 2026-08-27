import { createHash, randomBytes } from 'node:crypto';
import {
  CAPABILITIES,
  GATEWAY_FRAME_TYPES,
  LIMITS,
  PROTOCOL_ERROR_CODES,
  PROTOCOL_VERSION,
  RESIDENT_FRAME_TYPES,
  type Capability,
  type ConnectionId,
  type GatewayToResidentFrame,
  type InstanceId,
  type ProtocolErrorCode,
  type ProtocolFrame,
  type RequestId,
  type ResidentToGatewayFrame,
  type ViewerId,
} from './types.js';

const utf8 = new TextEncoder();
const ID_BODY = '[A-Za-z0-9_-]{22}';
const ID_PATTERNS = {
  instance: new RegExp(`^egi1\\.${ID_BODY}$`),
  connection: new RegExp(`^egx1\\.${ID_BODY}$`),
  viewer: new RegExp(`^egv1\\.${ID_BODY}$`),
  request: new RegExp(`^egr1\\.${ID_BODY}$`),
} as const;
const SHA256 = /^[0-9a-f]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

type RecordValue = Record<string, unknown>;
export type FrameDirection = 'gateway-to-resident' | 'resident-to-gateway';

export class GatewayProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  readonly fatal: boolean;
  constructor(code: ProtocolErrorCode, message: string, fatal = true) {
    super(message);
    this.name = 'GatewayProtocolError';
    this.code = code;
    this.fatal = fatal;
  }
}

function fail(code: ProtocolErrorCode, message: string): never {
  throw new GatewayProtocolError(code, message);
}
function record(value: unknown, label: string): RecordValue {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail('invalid_frame', `${label} must be an object`);
  return value as RecordValue;
}
function exact(
  value: RecordValue,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, i) => key !== wanted[i])
  )
    fail('invalid_frame', `${label} has missing or extra fields`);
}
function stringValue(
  value: unknown,
  label: string,
  maxBytes: number,
  nonempty = true,
): string {
  if (typeof value !== 'string' || (nonempty && value.length === 0))
    fail(
      'invalid_frame',
      `${label} must be ${nonempty ? 'a non-empty' : 'a'} string`,
    );
  if (utf8.encode(value).byteLength > maxBytes)
    fail('invalid_frame', `${label} exceeds ${maxBytes} UTF-8 bytes`);
  if (/[\u0000-\u001f\u007f]/.test(value))
    fail('invalid_frame', `${label} contains control characters`);
  return value;
}
function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum)
    fail('invalid_frame', `${label} must be a safe integer >= ${minimum}`);
  return value as number;
}
function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean')
    fail('invalid_frame', `${label} must be boolean`);
  return value;
}
function id(value: unknown, kind: keyof typeof ID_PATTERNS): string {
  if (typeof value !== 'string' || !ID_PATTERNS[kind].test(value))
    fail('invalid_frame', `invalid ${kind} id`);
  return value;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value))
    fail('invalid_frame', `${label} must be a lowercase SHA-256 hex digest`);
  return value;
}

export function validateCapabilities(value: unknown): readonly Capability[] {
  if (!Array.isArray(value))
    fail('invalid_frame', 'capabilities must be an array');
  let previous = '';
  const known = new Set<string>(CAPABILITIES);
  for (const capability of value) {
    if (typeof capability !== 'string' || !known.has(capability))
      fail('unknown_capability', 'unsupported capability');
    if (capability <= previous)
      fail('invalid_frame', 'capabilities must be sorted and unique');
    previous = capability;
  }
  return Object.freeze([...value]) as readonly Capability[];
}

export function negotiateCapabilities(
  local: readonly Capability[],
  remote: readonly Capability[],
): readonly Capability[] {
  validateCapabilities([...local]);
  validateCapabilities([...remote]);
  const offered = new Set(remote);
  return Object.freeze(local.filter((capability) => offered.has(capability)));
}

function errorDetail(value: unknown): void {
  const obj = record(value, 'error');
  exact(obj, ['code', 'message'], 'error');
  stringValue(obj.code, 'error.code', LIMITS.errorCodeBytes);
  stringValue(obj.message, 'error.message', LIMITS.errorMessageBytes);
}
function identity(value: unknown): void {
  const obj = record(value, 'identity');
  exact(
    obj,
    obj.avatar === undefined ? ['name'] : ['name', 'avatar'],
    'identity',
  );
  stringValue(obj.name, 'identity.name', LIMITS.identityNameBytes);
  if (obj.avatar !== undefined) {
    const avatar = record(obj.avatar, 'identity.avatar');
    exact(avatar, ['mediaType', 'byteLength', 'sha256'], 'identity.avatar');
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(
        String(avatar.mediaType),
      )
    )
      fail('invalid_frame', 'identity.avatar.mediaType is unsupported');
    const bytes = safeInteger(avatar.byteLength, 'identity.avatar.byteLength');
    if (bytes > LIMITS.mediaBytes)
      fail('invalid_frame', 'identity avatar is too large');
    sha(avatar.sha256, 'identity.avatar.sha256');
  }
}
function build(value: unknown): void {
  const obj = record(value, 'build');
  exact(
    obj,
    [
      'version',
      ...(obj.revision === undefined ? [] : ['revision']),
      ...(obj.state === undefined ? [] : ['state']),
    ],
    'build',
  );
  stringValue(obj.version, 'build.version', LIMITS.buildValueBytes);
  if (obj.revision !== undefined)
    stringValue(obj.revision, 'build.revision', LIMITS.buildValueBytes);
  if (obj.state !== undefined)
    stringValue(obj.state, 'build.state', LIMITS.buildValueBytes);
}
function opaquePayload(value: unknown): void {
  if (typeof value !== 'string')
    fail('invalid_frame', 'console payload must be a string');
  if (utf8.encode(value).byteLength > LIMITS.consolePayloadBytes)
    fail('invalid_frame', 'console payload exceeds its byte limit');
}
function mediaRoute(value: unknown): void {
  const route = stringValue(value, 'media route', LIMITS.mediaRouteBytes);
  if (route.includes('?') || route.includes('#') || route.includes('\\'))
    fail(
      'invalid_frame',
      'media route must not contain a query, fragment, or backslash',
    );
  if (route === '/identity/avatar') return;
  if (!route.startsWith('/frames/') && !route.startsWith('/attachments/'))
    fail(
      'invalid_frame',
      'media route is not a recognized console-relative route',
    );
  let decoded: string;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    fail('invalid_frame', 'media route has invalid encoding');
  }
  if (/[\u0000-\u001f\u007f\\?#]/.test(decoded))
    fail('invalid_frame', 'media route contains unsafe decoded characters');
  const parts = decoded.split('/').slice(1);
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    fail('invalid_frame', 'media route contains an unsafe segment');
  if (parts[0] === 'frames') {
    if (
      parts.length < 3 ||
      !['watch', 'computer', 'browser', 'motor'].includes(parts[1] ?? '')
    )
      fail('invalid_frame', 'media route is not a recognized frame route');
  } else if (parts[0] === 'attachments' && parts.length < 3) {
    fail('invalid_frame', 'media route is not a recognized attachment route');
  }
}
function mediaResult(frame: RecordValue): void {
  const ok = booleanValue(frame.ok, 'media.result.ok');
  if (!ok) {
    exact(
      frame,
      ['version', 'connectionId', 'seq', 'type', 'requestId', 'ok', 'error'],
      'media.result',
    );
    errorDetail(frame.error);
    return;
  }
  exact(
    frame,
    [
      'version',
      'connectionId',
      'seq',
      'type',
      'requestId',
      'ok',
      'mediaType',
      'byteLength',
      'sha256',
      'data',
    ],
    'media.result',
  );
  stringValue(frame.mediaType, 'media.result.mediaType', 128);
  const byteLength = safeInteger(frame.byteLength, 'media.result.byteLength');
  if (byteLength > LIMITS.mediaBytes)
    fail('invalid_frame', 'media result exceeds its byte limit');
  const digest = sha(frame.sha256, 'media.result.sha256');
  if (typeof frame.data !== 'string' || !B64.test(frame.data))
    fail('invalid_frame', 'media.result.data must be canonical base64');
  const padding = frame.data.endsWith('==')
    ? 2
    : frame.data.endsWith('=')
      ? 1
      : 0;
  const decodedBytes = (frame.data.length / 4) * 3 - padding;
  if (decodedBytes !== byteLength)
    fail('invalid_frame', 'media result byteLength does not match data');
  const bytes = Buffer.from(frame.data, 'base64');
  if (bytes.toString('base64') !== frame.data)
    fail('invalid_frame', 'media.result.data must be canonical base64');
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== digest)
    fail('invalid_frame', 'media result sha256 does not match data');
}

function inputObject(input: string | unknown): RecordValue {
  let encoded: string;
  if (typeof input === 'string') {
    encoded = input;
  } else {
    try {
      encoded = JSON.stringify(input);
    } catch {
      fail('invalid_frame', 'frame is not serializable');
    }
    if (encoded === undefined)
      fail('invalid_frame', 'frame is not serializable');
  }
  if (utf8.encode(encoded).byteLength > LIMITS.frameBytes)
    fail('frame_too_large', 'frame exceeds its byte limit');
  try {
    return record(JSON.parse(encoded) as unknown, 'frame');
  } catch (error) {
    if (error instanceof GatewayProtocolError) throw error;
    fail(
      typeof input === 'string' ? 'invalid_json' : 'invalid_frame',
      'frame is not valid JSON',
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function decodeFrame(
  input: string | unknown,
  direction: FrameDirection,
): ProtocolFrame {
  const frame = inputObject(input);
  if (frame.version !== PROTOCOL_VERSION)
    fail('unsupported_version', 'unsupported protocol version');
  id(frame.connectionId, 'connection');
  safeInteger(frame.seq, 'seq', 1);
  if (typeof frame.type !== 'string')
    fail('unknown_type', 'frame type must be a string');
  const allowed: readonly string[] =
    direction === 'gateway-to-resident'
      ? GATEWAY_FRAME_TYPES
      : RESIDENT_FRAME_TYPES;
  if (!allowed.includes(frame.type))
    fail('unknown_type', `unknown ${direction} frame type`);
  const base = ['version', 'connectionId', 'seq', 'type'];
  switch (frame.type) {
    case 'hello':
      exact(
        frame,
        [...base, 'instanceId', 'capabilities', 'identity', 'build'],
        'hello',
      );
      id(frame.instanceId, 'instance');
      validateCapabilities(frame.capabilities);
      identity(frame.identity);
      build(frame.build);
      break;
    case 'hello.ack':
      exact(frame, [...base, 'instanceId', 'capabilities'], 'hello.ack');
      id(frame.instanceId, 'instance');
      validateCapabilities(frame.capabilities);
      break;
    case 'viewer.open':
    case 'viewer.close':
    case 'viewer.snapshot':
      exact(frame, [...base, 'requestId', 'viewerId'], frame.type);
      id(frame.requestId, 'request');
      id(frame.viewerId, 'viewer');
      break;
    case 'console.input':
    case 'console.output':
      exact(frame, [...base, 'viewerId', 'payload'], frame.type);
      id(frame.viewerId, 'viewer');
      opaquePayload(frame.payload);
      break;
    case 'media.get':
      exact(frame, [...base, 'requestId', 'route'], 'media.get');
      id(frame.requestId, 'request');
      mediaRoute(frame.route);
      break;
    case 'operation.result': {
      const ok = booleanValue(frame.ok, 'operation.result.ok');
      exact(
        frame,
        [
          ...base,
          'requestId',
          'viewerId',
          'operation',
          'ok',
          ...(ok ? [] : ['error']),
        ],
        'operation.result',
      );
      id(frame.requestId, 'request');
      id(frame.viewerId, 'viewer');
      if (
        !['viewer.open', 'viewer.close', 'viewer.snapshot'].includes(
          String(frame.operation),
        )
      )
        fail('invalid_frame', 'invalid operation.result operation');
      if (!ok) errorDetail(frame.error);
      break;
    }
    case 'media.result':
      id(frame.requestId, 'request');
      mediaResult(frame);
      break;
    case 'error':
      exact(
        frame,
        [
          ...base,
          'error',
          'fatal',
          ...(frame.requestId === undefined ? [] : ['requestId']),
        ],
        'error',
      );
      errorDetail(frame.error);
      if (
        !(PROTOCOL_ERROR_CODES as readonly unknown[]).includes(
          (frame.error as RecordValue).code,
        )
      )
        fail('invalid_frame', 'error.code is not a v1 protocol error code');
      booleanValue(frame.fatal, 'error.fatal');
      if (frame.requestId !== undefined) id(frame.requestId, 'request');
      break;
  }
  return deepFreeze(frame) as unknown as ProtocolFrame;
}

export function decodeGatewayFrame(
  input: string | unknown,
): GatewayToResidentFrame {
  return decodeFrame(input, 'gateway-to-resident') as GatewayToResidentFrame;
}
export function decodeResidentFrame(
  input: string | unknown,
): ResidentToGatewayFrame {
  return decodeFrame(input, 'resident-to-gateway') as ResidentToGatewayFrame;
}
export function serializeFrame(
  frame: ProtocolFrame,
  direction: FrameDirection,
): string {
  const validated = decodeFrame(frame, direction);
  const encoded = JSON.stringify(validated);
  if (utf8.encode(encoded).byteLength > LIMITS.frameBytes)
    fail('frame_too_large', 'frame exceeds its byte limit');
  return encoded;
}
export const serializeGatewayFrame = (frame: GatewayToResidentFrame): string =>
  serializeFrame(frame, 'gateway-to-resident');
export const serializeResidentFrame = (frame: ResidentToGatewayFrame): string =>
  serializeFrame(frame, 'resident-to-gateway');

function randomId(prefix: string): string {
  return `${prefix}.${randomBytes(16).toString('base64url')}`;
}
export const newInstanceId = (): InstanceId => randomId('egi1') as InstanceId;
export const newConnectionId = (): ConnectionId =>
  randomId('egx1') as ConnectionId;
export const newViewerId = (): ViewerId => randomId('egv1') as ViewerId;
export const newRequestId = (): RequestId => randomId('egr1') as RequestId;

export function isProtocolError(value: unknown): value is GatewayProtocolError {
  return value instanceof GatewayProtocolError;
}
export function isProtocolErrorCode(value: string): value is ProtocolErrorCode {
  return (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}
