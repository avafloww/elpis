import { TextDecoder, TextEncoder } from 'node:util';
import {
  isCredentialId,
  isGatewayInstanceId,
  parseEnrollmentCredential,
  parseNodeCredential,
} from './credentials.js';
import { isRequestId } from './codec.js';
import type { InstanceId, RequestId } from './types.js';

export const RESIDENT_CONTROL_PATHS = Object.freeze({
  enrollment: '/api/v1/resident/enrollment',
  rotation: '/api/v1/resident/rotation',
  rotationActivation: '/api/v1/resident/rotation/activate',
  link: '/api/v1/resident/link',
} as const);

export const RESIDENT_CONTROL_FORMATS = Object.freeze({
  enrollmentRequest: 'elpis-gateway-resident-enrollment-request-v1',
  enrollmentResult: 'elpis-gateway-resident-enrollment-result-v1',
  rotationRequest: 'elpis-gateway-resident-rotation-request-v1',
  rotationActivationRequest:
    'elpis-gateway-resident-rotation-activation-request-v1',
  rotationResult: 'elpis-gateway-resident-rotation-result-v1',
  error: 'elpis-gateway-resident-error-v1',
} as const);

export const RESIDENT_CONTROL_LIMITS = Object.freeze({
  bodyBytes: 4096,
  displayNameBytes: 128,
  requestIdBytes: 27,
  credentialVerifierBytes: 32,
  credentialVerifierBase64Bytes: 44,
} as const);

export const RESIDENT_CONTROL_ERROR_CODES = Object.freeze([
  'invalid_request',
  'unauthorized',
  'expired',
  'revoked',
  'conflict',
  'rate_limited',
  'internal_error',
] as const);
export type ResidentControlErrorCode =
  (typeof RESIDENT_CONTROL_ERROR_CODES)[number];

export interface ResidentEnrollmentRequest {
  readonly format: typeof RESIDENT_CONTROL_FORMATS.enrollmentRequest;
  readonly grantToken: string;
  readonly instanceId: InstanceId;
  readonly displayName: string;
  readonly credentialId: string;
  /** Canonical padded standard base64 for exactly 32 bytes. */
  readonly credentialVerifier: string;
  readonly requestId: RequestId;
}
export interface ResidentEnrollmentResult {
  readonly format: typeof RESIDENT_CONTROL_FORMATS.enrollmentResult;
  readonly instanceId: InstanceId;
  readonly credentialId: string;
  readonly replayed: boolean;
}
export interface ResidentRotationRequest {
  readonly format: typeof RESIDENT_CONTROL_FORMATS.rotationRequest;
  readonly credentialId: string;
  readonly credentialVerifier: string;
  readonly requestId: RequestId;
}
export interface ResidentRotationActivationRequest {
  readonly format: typeof RESIDENT_CONTROL_FORMATS.rotationActivationRequest;
  readonly requestId: RequestId;
}
export interface ResidentRotationResult {
  readonly format: typeof RESIDENT_CONTROL_FORMATS.rotationResult;
  readonly instanceId: InstanceId;
  readonly credentialId: string;
  readonly previousCredentialId: string;
  readonly replayed: boolean;
}
export interface ResidentControlError {
  readonly format: typeof RESIDENT_CONTROL_FORMATS.error;
  readonly code: ResidentControlErrorCode;
  readonly requestId?: RequestId;
}

/** Input-independent so logging a codec failure cannot disclose a wire secret. */
export class ResidentControlCodecError extends Error {
  readonly code = 'invalid_request' as const;
  constructor() {
    super('invalid resident control input');
    this.name = 'ResidentControlCodecError';
  }
}

const utf8 = new TextEncoder();
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type JsonRecord = Record<string, unknown>;
export type ResidentControlBody = string | Uint8Array;

function invalid(): never {
  throw new ResidentControlCodecError();
}
function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ResidentControlCodecError) throw error;
    return invalid();
  }
}
function record(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  return value as JsonRecord;
}
function exact(value: JsonRecord, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, i) => key !== expected[i])
  )
    invalid();
}
function exactFormat(value: unknown, expected: string): void {
  if (value !== expected) invalid();
}
function instanceId(value: unknown): InstanceId {
  if (!isGatewayInstanceId(value)) invalid();
  return value as InstanceId;
}
function credentialId(value: unknown): string {
  if (!isCredentialId(value)) invalid();
  return value;
}
function requestId(value: unknown): RequestId {
  if (!isRequestId(value)) invalid();
  return value;
}
function booleanValue(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid();
  return value;
}
function displayName(value: unknown): string {
  if (typeof value !== 'string') invalid();
  const trimmed = value.trim();
  const encoded = utf8.encode(trimmed);
  if (
    trimmed.length === 0 ||
    /\p{Cc}/u.test(trimmed) ||
    encoded.byteLength > RESIDENT_CONTROL_LIMITS.displayNameBytes ||
    fatalUtf8.decode(encoded) !== trimmed
  )
    invalid();
  return trimmed;
}
function verifierString(value: unknown): string {
  decodeCredentialVerifier(value);
  return value as string;
}
function enrollmentToken(value: unknown): string {
  if (typeof value !== 'string' || parseEnrollmentCredential(value) === null)
    invalid();
  return value;
}
function bodyText(body: ResidentControlBody): string {
  if (typeof body === 'string') {
    const bytes = utf8.encode(body);
    if (
      bytes.byteLength > RESIDENT_CONTROL_LIMITS.bodyBytes ||
      fatalUtf8.decode(bytes) !== body
    )
      invalid();
    return body;
  }
  if (
    !(body instanceof Uint8Array) ||
    body.byteLength > RESIDENT_CONTROL_LIMITS.bodyBytes
  )
    invalid();
  return fatalUtf8.decode(body);
}
function parsedBody(body: ResidentControlBody): JsonRecord {
  return record(JSON.parse(bodyText(body)) as unknown);
}
function serialize(
  value: unknown,
  normalize: (input: unknown) => unknown,
): string {
  return guarded(() => {
    const encoded = JSON.stringify(normalize(value));
    if (
      typeof encoded !== 'string' ||
      utf8.encode(encoded).byteLength > RESIDENT_CONTROL_LIMITS.bodyBytes
    )
      invalid();
    return encoded;
  });
}

function normalizeEnrollmentRequest(value: unknown): ResidentEnrollmentRequest {
  const input = record(value);
  exact(input, [
    'format',
    'grantToken',
    'instanceId',
    'displayName',
    'credentialId',
    'credentialVerifier',
    'requestId',
  ]);
  exactFormat(input.format, RESIDENT_CONTROL_FORMATS.enrollmentRequest);
  return Object.freeze({
    format: RESIDENT_CONTROL_FORMATS.enrollmentRequest,
    grantToken: enrollmentToken(input.grantToken),
    instanceId: instanceId(input.instanceId),
    displayName: displayName(input.displayName),
    credentialId: credentialId(input.credentialId),
    credentialVerifier: verifierString(input.credentialVerifier),
    requestId: requestId(input.requestId),
  });
}
function normalizeEnrollmentResult(value: unknown): ResidentEnrollmentResult {
  const input = record(value);
  exact(input, ['format', 'instanceId', 'credentialId', 'replayed']);
  exactFormat(input.format, RESIDENT_CONTROL_FORMATS.enrollmentResult);
  return Object.freeze({
    format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
    instanceId: instanceId(input.instanceId),
    credentialId: credentialId(input.credentialId),
    replayed: booleanValue(input.replayed),
  });
}
function normalizeRotationRequest(value: unknown): ResidentRotationRequest {
  const input = record(value);
  exact(input, ['format', 'credentialId', 'credentialVerifier', 'requestId']);
  exactFormat(input.format, RESIDENT_CONTROL_FORMATS.rotationRequest);
  return Object.freeze({
    format: RESIDENT_CONTROL_FORMATS.rotationRequest,
    credentialId: credentialId(input.credentialId),
    credentialVerifier: verifierString(input.credentialVerifier),
    requestId: requestId(input.requestId),
  });
}
function normalizeRotationActivationRequest(
  value: unknown,
): ResidentRotationActivationRequest {
  const input = record(value);
  exact(input, ['format', 'requestId']);
  exactFormat(input.format, RESIDENT_CONTROL_FORMATS.rotationActivationRequest);
  return Object.freeze({
    format: RESIDENT_CONTROL_FORMATS.rotationActivationRequest,
    requestId: requestId(input.requestId),
  });
}
function normalizeRotationResult(value: unknown): ResidentRotationResult {
  const input = record(value);
  exact(input, [
    'format',
    'instanceId',
    'credentialId',
    'previousCredentialId',
    'replayed',
  ]);
  exactFormat(input.format, RESIDENT_CONTROL_FORMATS.rotationResult);
  return Object.freeze({
    format: RESIDENT_CONTROL_FORMATS.rotationResult,
    instanceId: instanceId(input.instanceId),
    credentialId: credentialId(input.credentialId),
    previousCredentialId: credentialId(input.previousCredentialId),
    replayed: booleanValue(input.replayed),
  });
}
function normalizeError(value: unknown): ResidentControlError {
  const input = record(value);
  exact(
    input,
    input.requestId === undefined
      ? ['format', 'code']
      : ['format', 'code', 'requestId'],
  );
  exactFormat(input.format, RESIDENT_CONTROL_FORMATS.error);
  if (
    typeof input.code !== 'string' ||
    !(RESIDENT_CONTROL_ERROR_CODES as readonly string[]).includes(input.code)
  )
    invalid();
  if (input.requestId === undefined)
    return Object.freeze({
      format: RESIDENT_CONTROL_FORMATS.error,
      code: input.code as ResidentControlErrorCode,
    });
  return Object.freeze({
    format: RESIDENT_CONTROL_FORMATS.error,
    code: input.code as ResidentControlErrorCode,
    requestId: requestId(input.requestId),
  });
}

export function encodeCredentialVerifier(value: unknown): string {
  return guarded(() => {
    if (
      !(value instanceof Uint8Array) ||
      value.byteLength !== RESIDENT_CONTROL_LIMITS.credentialVerifierBytes
    )
      invalid();
    return Buffer.from(value).toString('base64');
  });
}
export function decodeCredentialVerifier(value: unknown): Buffer {
  return guarded(() => {
    if (
      typeof value !== 'string' ||
      value.length !== RESIDENT_CONTROL_LIMITS.credentialVerifierBase64Bytes
    )
      invalid();
    const decoded = Buffer.from(value, 'base64');
    if (
      decoded.byteLength !== RESIDENT_CONTROL_LIMITS.credentialVerifierBytes ||
      decoded.toString('base64') !== value
    )
      invalid();
    return Buffer.from(decoded);
  });
}

export function decodeResidentEnrollmentRequest(
  body: ResidentControlBody,
): ResidentEnrollmentRequest {
  return guarded(() => normalizeEnrollmentRequest(parsedBody(body)));
}
export function serializeResidentEnrollmentRequest(
  value: ResidentEnrollmentRequest,
): string {
  return serialize(value, normalizeEnrollmentRequest);
}
export function decodeResidentEnrollmentResult(
  body: ResidentControlBody,
): ResidentEnrollmentResult {
  return guarded(() => normalizeEnrollmentResult(parsedBody(body)));
}
export function serializeResidentEnrollmentResult(
  value: ResidentEnrollmentResult,
): string {
  return serialize(value, normalizeEnrollmentResult);
}
export function decodeResidentRotationRequest(
  body: ResidentControlBody,
): ResidentRotationRequest {
  return guarded(() => normalizeRotationRequest(parsedBody(body)));
}
export function serializeResidentRotationRequest(
  value: ResidentRotationRequest,
): string {
  return serialize(value, normalizeRotationRequest);
}
export function decodeResidentRotationActivationRequest(
  body: ResidentControlBody,
): ResidentRotationActivationRequest {
  return guarded(() => normalizeRotationActivationRequest(parsedBody(body)));
}
export function serializeResidentRotationActivationRequest(
  value: ResidentRotationActivationRequest,
): string {
  return serialize(value, normalizeRotationActivationRequest);
}
export function decodeResidentRotationResult(
  body: ResidentControlBody,
): ResidentRotationResult {
  return guarded(() => normalizeRotationResult(parsedBody(body)));
}
export function serializeResidentRotationResult(
  value: ResidentRotationResult,
): string {
  return serialize(value, normalizeRotationResult);
}
export function decodeResidentControlError(
  body: ResidentControlBody,
): ResidentControlError {
  return guarded(() => normalizeError(parsedBody(body)));
}
export function serializeResidentControlError(
  value: ResidentControlError,
): string {
  return serialize(value, normalizeError);
}

export function formatNodeBearerAuthorization(token: string): string {
  return guarded(() => {
    if (parseNodeCredential(token) === null) invalid();
    return 'Bearer ' + token;
  });
}
export function parseNodeBearerAuthorization(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return null;
  const token = value.slice('Bearer '.length);
  return parseNodeCredential(token) === null ? null : token;
}
export function isResidentControlCodecError(
  value: unknown,
): value is ResidentControlCodecError {
  return value instanceof ResidentControlCodecError;
}
