import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const CSRF_COOKIE_NAME = '__Host-elpis-csrf';
export const CSRF_HEADER_NAME = 'x-elpis-csrf';
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CONTENT_LENGTH = /^(?:0|[1-9][0-9]*)$/;

export class HttpBoundaryError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'HttpBoundaryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface CanonicalOriginOptions {
  allowLocalHttp?: boolean;
}

/** Parse an origin and reject every non-canonical spelling. */
export function parseCanonicalPublicOrigin(
  value: string,
  options: CanonicalOriginOptions = {},
): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048)
    throw new Error('public URL must be a bounded absolute origin');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('public URL must be an absolute origin');
  }
  const localHttp =
    options.allowLocalHttp === true &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]');
  if (parsed.protocol !== 'https:' && !localHttp)
    throw new Error('public URL must use HTTPS');
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(
      'public URL must not contain credentials, query, or fragment',
    );
  if (parsed.pathname !== '/')
    throw new Error('public URL must not contain a path');
  return parsed.origin;
}

export function singleRequestHeader(
  request: IncomingMessage,
  name: string,
): string | null {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === lower)
      values.push(request.rawHeaders[index + 1] ?? '');
  }
  if (values.length !== 1) return null;
  return values[0];
}

function requiredSingleHeader(request: IncomingMessage, name: string): string {
  const value = singleRequestHeader(request, name);
  if (value === null || value.length === 0)
    throw new HttpBoundaryError(403, 'request_denied');
  return value;
}

export interface BrowserOriginGuard {
  /** The persisted canonical origin, or null before setup. */
  publicUrl: string | null;
  /** Only set by the one setup mutation handler before it mutates state. */
  setupCandidatePublicUrl?: string;
}

function assertExpectedBrowserOrigin(
  request: IncomingMessage,
  canonical: string,
  requireHost: boolean,
): void {
  const origin = requiredSingleHeader(request, 'origin');
  if (origin === canonical) {
    if (
      requireHost &&
      requiredSingleHeader(request, 'host') !== new URL(canonical).host
    )
      throw new HttpBoundaryError(403, 'request_denied');
    return;
  }
  if (
    origin !== 'null' ||
    singleRequestHeader(request, 'sec-fetch-site') !== 'same-origin' ||
    singleRequestHeader(request, 'sec-fetch-mode') !== 'same-origin' ||
    singleRequestHeader(request, 'sec-fetch-dest') !== 'empty' ||
    requiredSingleHeader(request, 'host') !== new URL(canonical).host
  )
    throw new HttpBoundaryError(403, 'request_denied');
}

/** Enforce exact Origin, with a narrow browser-owned null-Origin fallback. */
export function assertBrowserOrigin(
  request: IncomingMessage,
  guard: BrowserOriginGuard,
): void {
  if (guard.publicUrl !== null) {
    let canonical: string;
    try {
      canonical = parseCanonicalPublicOrigin(guard.publicUrl, {
        allowLocalHttp: true,
      });
    } catch {
      throw new HttpBoundaryError(503, 'service_unavailable');
    }
    assertExpectedBrowserOrigin(request, canonical, false);
    return;
  }

  const candidate = guard.setupCandidatePublicUrl;
  if (candidate === undefined)
    throw new HttpBoundaryError(403, 'request_denied');
  let canonical: string;
  try {
    canonical = parseCanonicalPublicOrigin(candidate);
  } catch {
    throw new HttpBoundaryError(403, 'request_denied');
  }
  if (candidate !== canonical)
    throw new HttpBoundaryError(403, 'request_denied');
  assertExpectedBrowserOrigin(request, canonical, true);
}

export function createCsrfToken(
  random: (size: number) => Buffer = randomBytes,
): string {
  const bytes = random(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32)
    throw new Error('CSRF random source returned an invalid value');
  return bytes.toString('base64url');
}

export function csrfCookie(token: string): string {
  if (!CSRF_TOKEN.test(token)) throw new Error('invalid CSRF token');
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

function csrfCookieToken(request: IncomingMessage): string {
  const cookie = requiredSingleHeader(request, 'cookie');
  let found: string | null = null;
  for (const part of cookie.split(';')) {
    const item = part.trim();
    const separator = item.indexOf('=');
    if (separator < 1) continue;
    if (item.slice(0, separator) !== CSRF_COOKIE_NAME) continue;
    if (found !== null) throw new HttpBoundaryError(403, 'request_denied');
    found = item.slice(separator + 1);
  }
  if (found === null || !CSRF_TOKEN.test(found))
    throw new HttpBoundaryError(403, 'request_denied');
  return found;
}

export function assertCsrf(request: IncomingMessage): void {
  const cookie = csrfCookieToken(request);
  const header = requiredSingleHeader(request, CSRF_HEADER_NAME);
  if (!CSRF_TOKEN.test(header))
    throw new HttpBoundaryError(403, 'request_denied');
  const left = Buffer.from(cookie, 'ascii');
  const right = Buffer.from(header, 'ascii');
  if (left.length !== right.length || !timingSafeEqual(left, right))
    throw new HttpBoundaryError(403, 'request_denied');
}

export const BROWSER_MUTATION_METHODS = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export function isBrowserMutation(method: string | undefined): boolean {
  return method !== undefined && BROWSER_MUTATION_METHODS.has(method);
}

export function assertBrowserMutation(
  request: IncomingMessage,
  guard: BrowserOriginGuard,
): void {
  if (!isBrowserMutation(request.method))
    throw new HttpBoundaryError(405, 'method_not_allowed');
  assertBrowserOrigin(request, guard);
  assertCsrf(request);
}

/** Upgrade callers use the same required exact Origin rule (but not CSRF). */
export function assertBrowserUpgradeOrigin(
  request: IncomingMessage,
  publicUrl: string | null,
): void {
  assertBrowserOrigin(request, { publicUrl });
}

function rawHeaderValues(request: IncomingMessage, name: string): string[] {
  const lower = name.toLowerCase();
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === lower)
      values.push(request.rawHeaders[index + 1] ?? '');
  }
  return values;
}

export function validateRequestBodyFraming(
  request: IncomingMessage,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new Error('maxBytes must be a non-negative safe integer');
  const lengths = rawHeaderValues(request, 'content-length');
  const transfers = rawHeaderValues(request, 'transfer-encoding');
  const encodings = rawHeaderValues(request, 'content-encoding');
  if (lengths.length > 1 || transfers.length > 0 || encodings.length > 0)
    throw new HttpBoundaryError(400, 'invalid_request_body');
  if (lengths.length === 0) return 0;
  if (!CONTENT_LENGTH.test(lengths[0]))
    throw new HttpBoundaryError(400, 'invalid_request_body');
  const expected = Number(lengths[0]);
  if (!Number.isSafeInteger(expected))
    throw new HttpBoundaryError(400, 'invalid_request_body');
  if (expected > maxBytes)
    throw new HttpBoundaryError(413, 'request_body_too_large');
  return expected;
}

export interface ReadBodyOptions {
  maxBytes?: number;
  signal?: AbortSignal;
}

/** Read an identity-encoded, Content-Length-framed request body once. */
export async function readBoundedRequestBody(
  request: IncomingMessage,
  options: ReadBodyOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const expected = validateRequestBodyFraming(request, maxBytes);
  if (options.signal?.aborted)
    throw new HttpBoundaryError(408, 'request_timeout');

  const chunks: Buffer[] = [];
  let received = 0;
  const abort = (): void => {
    request.destroy();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const value of request) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      received += chunk.length;
      if (received > maxBytes || received > expected)
        throw new HttpBoundaryError(413, 'request_body_too_large');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpBoundaryError) throw error;
    throw new HttpBoundaryError(
      options.signal?.aborted ? 408 : 400,
      options.signal?.aborted ? 'request_timeout' : 'invalid_request_body',
    );
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
  if (received !== expected)
    throw new HttpBoundaryError(400, 'invalid_request_body');
  return Buffer.concat(chunks, received);
}
