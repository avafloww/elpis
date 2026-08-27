import {
  createHash,
  randomBytes as systemRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

const PUBLIC_ID_PATTERN = '[A-Za-z0-9_-]{22}';
const SECRET_PATTERN = '[A-Za-z0-9_-]{43}';
const INSTANCE_PATTERN = new RegExp(`^egi1\\.${PUBLIC_ID_PATTERN}$`);
const ENROLLMENT_PATTERN = new RegExp(
  `^ege1\\.(${PUBLIC_ID_PATTERN})\\.(${SECRET_PATTERN})$`,
);
const NODE_PATTERN = new RegExp(
  `^egc1\\.(${PUBLIC_ID_PATTERN})\\.(${SECRET_PATTERN})$`,
);

export type RandomBytes = (size: number) => Buffer;

export interface GatewayCredentialMaterial {
  readonly id: string;
  readonly token: string;
  readonly verifier: Buffer;
}

export interface ParsedGatewayCredential {
  readonly id: string;
  readonly verifier: Buffer;
}

function exactRandom(bytes: RandomBytes, size: number): Buffer {
  const value = bytes(size);
  if (!Buffer.isBuffer(value) || value.length !== size)
    throw new Error(
      `credential random source must return exactly ${size} bytes`,
    );
  return Buffer.from(value);
}

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function createMaterial(
  prefix: 'ege1' | 'egc1',
  bytes: RandomBytes,
): GatewayCredentialMaterial {
  const id = exactRandom(bytes, 16).toString('base64url');
  const secret = exactRandom(bytes, 32).toString('base64url');
  return Object.freeze({
    id,
    token: `${prefix}.${id}.${secret}`,
    verifier: digest(secret),
  });
}

function parse(
  token: unknown,
  pattern: RegExp,
): ParsedGatewayCredential | null {
  if (typeof token !== 'string') return null;
  const match = token.match(pattern);
  if (!match) return null;
  return Object.freeze({ id: match[1], verifier: digest(match[2]) });
}

export function newGatewayInstanceId(
  bytes: RandomBytes = systemRandomBytes,
): string {
  return `egi1.${exactRandom(bytes, 16).toString('base64url')}`;
}

export function isGatewayInstanceId(value: unknown): value is string {
  return typeof value === 'string' && INSTANCE_PATTERN.test(value);
}

export function createEnrollmentCredential(
  bytes: RandomBytes = systemRandomBytes,
): GatewayCredentialMaterial {
  return createMaterial('ege1', bytes);
}

export function createNodeCredential(
  bytes: RandomBytes = systemRandomBytes,
): GatewayCredentialMaterial {
  return createMaterial('egc1', bytes);
}

export function parseEnrollmentCredential(
  token: unknown,
): ParsedGatewayCredential | null {
  return parse(token, ENROLLMENT_PATTERN);
}

export function parseNodeCredential(
  token: unknown,
): ParsedGatewayCredential | null {
  return parse(token, NODE_PATTERN);
}

export function isCredentialId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

export function exactVerifier(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32)
    throw new Error('credential verifier must contain exactly 32 bytes');
  return Buffer.from(value);
}

export function verifierMatches(actual: Buffer, expected: unknown): boolean {
  let safeExpected: Buffer;
  try {
    safeExpected = exactVerifier(expected);
  } catch {
    return false;
  }
  return actual.length === 32 && timingSafeEqual(actual, safeExpected);
}
