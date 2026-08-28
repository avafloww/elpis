import * as fs from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import {
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_HEADERS,
  RESIDENT_CONTROL_LIMITS,
  RESIDENT_CONTROL_PATHS,
  LIMITS,
  isConnectionId,
  parseNodeBearerAuthorization,
  decodeResidentEnrollmentResult,
  decodeResidentRotationResult,
  serializeResidentControlError,
  serializeResidentEnrollmentResult,
  serializeResidentRotationResult,
  type ResidentControlErrorCode,
} from '@elpis/gateway-protocol';
import {
  assertBrowserMutation,
  createCsrfToken,
  csrfCookie,
  HttpBoundaryError,
  isBrowserMutation,
  readBoundedRequestBody,
  singleRequestHeader,
  validateRequestBodyFraming,
  type BrowserOriginGuard,
} from './http-guards.js';
import {
  BoundedResidentControlRateLimiter,
  ResidentControlApiError,
  type ResidentControlApi,
  type ResidentControlRateLimiter,
  type ResidentControlRoute,
} from './resident-control-api.js';
import type {
  AuthenticatedNode,
  GatewayCredentialStore,
} from './credential-store.js';
import {
  GatewayResidentLinkRegistry,
  type GatewayResidentSocketAdapter,
  type GatewayResidentSocketHandlers,
} from './resident-link-registry.js';

import {
  GatewayApiError,
  type BrowserApi,
  type GatewayApiResponse,
  type BrowserApiRoute,
  type JsonObject,
} from './browser-api.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8790;
const DEFAULT_MAX_STATIC_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_TARGET_BYTES = 8192;
export const MAX_API_RESPONSE_BYTES = 1024 * 1024;

const UPGRADE_FAILURE_BODY = 'WebSocket upgrade rejected\n';
const UPGRADE_STATUS_TEXT: Readonly<Record<number, string>> = Object.freeze({
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
});

/** Write a bounded, credential-independent HTTP response and end the peer. */
function rejectUpgrade(socket: Duplex, status: number): void {
  const boundedStatus =
    UPGRADE_STATUS_TEXT[status] === undefined ? 500 : status;
  const reason = UPGRADE_STATUS_TEXT[boundedStatus]!;
  const bytes = Buffer.byteLength(UPGRADE_FAILURE_BODY);
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.end(
    'HTTP/1.1 ' +
      boundedStatus +
      ' ' +
      reason +
      '\r\n' +
      'Connection: close\r\n' +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      'Content-Length: ' +
      bytes +
      '\r\n' +
      'Cache-Control: no-store\r\n' +
      'X-Content-Type-Options: nosniff\r\n\r\n' +
      UPGRADE_FAILURE_BODY,
  );
}

function hasRequestHeader(
  request: http.IncomingMessage,
  name: string,
): boolean {
  const lower = name.toLowerCase();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === lower) return true;
  }
  return false;
}

function validWebSocketHandshake(request: http.IncomingMessage): boolean {
  const upgrade = singleRequestHeader(request, 'upgrade');
  const version = singleRequestHeader(request, 'sec-websocket-version');
  const key = singleRequestHeader(request, 'sec-websocket-key');
  if (
    request.method !== 'GET' ||
    upgrade?.toLowerCase() !== 'websocket' ||
    version !== '13' ||
    key === null ||
    !/^[A-Za-z0-9+/]{22}==$/.test(key)
  )
    return false;
  return Buffer.from(key, 'base64').length === 16;
}

function rawDataBytes(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/** Complete-message ws adapter with fatal UTF-8 and text-only semantics. */
class WsResidentSocketAdapter implements GatewayResidentSocketAdapter {
  readonly #socket: WebSocket;
  constructor(socket: WebSocket) {
    this.#socket = socket;
  }
  get bufferedAmount(): number {
    return this.#socket.bufferedAmount;
  }
  sendText(text: string): void {
    if (this.#socket.readyState !== WebSocket.OPEN)
      throw new Error('resident transport is not open');
    this.#socket.send(text, { binary: false, compress: false });
  }
  close(code: number, reason: string): void {
    if (this.#socket.readyState === WebSocket.OPEN)
      this.#socket.close(code, reason);
    else if (this.#socket.readyState === WebSocket.CONNECTING)
      this.#socket.terminate();
  }
  attach(handlers: GatewayResidentSocketHandlers): () => void {
    const onMessage = (data: RawData, binary: boolean): void => {
      if (binary) {
        handlers.binary();
        return;
      }
      try {
        handlers.text(
          new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(rawDataBytes(data)),
        );
      } catch {
        if (this.#socket.readyState === WebSocket.OPEN)
          this.#socket.close(1007, 'invalid_utf8');
      }
    };
    const onError = (): void => handlers.error();
    const onClose = (): void => handlers.close();
    this.#socket.on('message', onMessage);
    this.#socket.on('error', onError);
    this.#socket.on('close', onClose);
    return () => {
      this.#socket.off('message', onMessage);
      this.#socket.off('error', onError);
      this.#socket.off('close', onClose);
    };
  }
}

export interface ResidentLinkCredentialStore {
  authenticateNode(
    token: unknown,
  ): ReturnType<GatewayCredentialStore['authenticateNode']>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export interface GatewayHttpStoreView {
  config(): { publicUrl: string | null };
}

export interface GatewayListenOptions {
  host?: string;
  port?: number;
}

export interface GatewayHttpServiceOptions {
  /** A single, explicit directory containing public browser files. */
  publicRoot: string;
  listen?: GatewayListenOptions;
  /** A store is the default source for both public origin and readiness. */
  store?: GatewayHttpStoreView;
  /** Overrides store.config() only as the origin source. */
  getPublicUrl?: () => string | null;
  /** Overrides the store probe only as the readiness source. */
  checkReady?: () => boolean | Promise<boolean>;
  /** A typed browser route adapter; HTTP policy remains owned by this service. */
  api?: BrowserApi;
  /** Non-browser resident enrollment and credential-rotation adapter. */
  residentControl?: ResidentControlApi;
  /** Active-node authentication for the resident WebSocket boundary. */
  residentCredentialStore?: ResidentLinkCredentialStore;
  /** Registry which owns authenticated resident WebSocket sessions. */
  residentLinkRegistry?: GatewayResidentLinkRegistry;
  /** Optional bounded limiter seam; defaults to direct-peer fixed windows. */
  residentRateLimiter?: ResidentControlRateLimiter;
  /** Deterministic time source for resident rate limiting. */
  residentNow?: () => number;
  maxBodyBytes?: number;
  maxStaticBytes?: number;
  bodyTimeoutMs?: number;
  shutdownGraceMs?: number;
}

export interface GatewayListenAddress {
  host: string;
  port: number;
}

function securityHeaders(response: http.ServerResponse): void {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'",
  );
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  response.setHeader('Cache-Control', 'no-store');
}

function send(
  response: http.ServerResponse,
  status: number,
  body: Buffer | string,
  contentType = 'text/plain; charset=utf-8',
  head = false,
): void {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body;
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Content-Length', String(bytes.length));
  response.end(head ? undefined : bytes);
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  value: Record<string, unknown>,
  head = false,
): void {
  send(
    response,
    status,
    JSON.stringify(value),
    'application/json; charset=utf-8',
    head,
  );
}

function residentNamespaceTarget(rawUrl: string): boolean {
  const query = rawUrl.search(/[?#]/);
  const pathname = query < 0 ? rawUrl : rawUrl.slice(0, query);
  return (
    pathname === '/api/v1/resident' || pathname.startsWith('/api/v1/resident/')
  );
}

function exactResidentRoute(rawUrl: string): ResidentControlRoute | null {
  if (rawUrl === RESIDENT_CONTROL_PATHS.enrollment) return 'enrollment';
  if (rawUrl === RESIDENT_CONTROL_PATHS.rotation) return 'rotation';
  if (rawUrl === RESIDENT_CONTROL_PATHS.rotationActivation)
    return 'rotationActivation';
  return null;
}

function residentSuccessBody(
  route: ResidentControlRoute,
  result: unknown,
): { status: 200 | 201; body: string } {
  if (
    result === null ||
    typeof result !== 'object' ||
    (Object.getPrototypeOf(result) !== Object.prototype &&
      Object.getPrototypeOf(result) !== null)
  )
    throw new Error('invalid resident adapter result');
  const value = result as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  const statusDescriptor = Object.getOwnPropertyDescriptor(value, 'status');
  const bodyDescriptor = Object.getOwnPropertyDescriptor(value, 'body');
  if (
    keys.length !== 2 ||
    !keys.includes('status') ||
    !keys.includes('body') ||
    !statusDescriptor?.enumerable ||
    !bodyDescriptor?.enumerable ||
    !('value' in statusDescriptor) ||
    !('value' in bodyDescriptor) ||
    typeof bodyDescriptor.value !== 'string' ||
    (statusDescriptor.value !== 200 && statusDescriptor.value !== 201)
  )
    throw new Error('invalid resident adapter result');
  const status = statusDescriptor.value;
  const body = bodyDescriptor.value;
  const decoded =
    route === 'enrollment'
      ? decodeResidentEnrollmentResult(body)
      : decodeResidentRotationResult(body);
  const canonical =
    route === 'enrollment'
      ? serializeResidentEnrollmentResult(
          decoded as ReturnType<typeof decodeResidentEnrollmentResult>,
        )
      : serializeResidentRotationResult(
          decoded as ReturnType<typeof decodeResidentRotationResult>,
        );
  const expectedStatus =
    route === 'rotationActivation' || decoded.replayed ? 200 : 201;
  if (body !== canonical || status !== expectedStatus)
    throw new Error('invalid resident adapter result');
  return { status, body: canonical };
}

function apiNamespaceTarget(rawUrl: string): boolean {
  const query = rawUrl.search(/[?#]/);
  const pathname = query < 0 ? rawUrl : rawUrl.slice(0, query);
  return pathname === '/api/v1' || pathname.startsWith('/api/v1/');
}

function exactApiPathname(rawUrl: string): string | null {
  if (rawUrl.includes('?') || rawUrl.includes('#') || rawUrl.includes('%'))
    return null;
  for (let index = 0; index < rawUrl.length; index += 1) {
    const code = rawUrl.charCodeAt(index);
    if (code < 0x21 || code > 0x7e || code === 0x5c) return null;
  }
  return rawUrl;
}

function requireJsonContentType(request: http.IncomingMessage): void {
  const value = singleRequestHeader(request, 'content-type');
  if (
    value === null ||
    !/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*utf-8)?$/i.test(
      value,
    )
  )
    throw new HttpBoundaryError(415, 'unsupported_media_type');
}

function deepFreezeJsonObject(value: Record<string, unknown>): JsonObject {
  const pending: object[] = [value];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const child of Object.values(current)) {
      if (typeof child === 'number' && !Number.isFinite(child))
        throw new HttpBoundaryError(400, 'invalid_request_body');
      if (child !== null && typeof child === 'object') {
        const prototype = Object.getPrototypeOf(child);
        if (
          (Array.isArray(child) && prototype !== Array.prototype) ||
          (!Array.isArray(child) && prototype !== Object.prototype)
        )
          throw new HttpBoundaryError(400, 'invalid_request_body');
        pending.push(child);
      }
    }
    Object.freeze(current);
  }
  return value as JsonObject;
}

function decodeJsonObject(bytes: Buffer): JsonObject {
  let text: string;
  try {
    // Keeping a BOM in the decoded text makes JSON.parse reject it as non-JSON.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new HttpBoundaryError(400, 'invalid_request_body');
  }
  if (text.length === 0)
    throw new HttpBoundaryError(400, 'invalid_request_body');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpBoundaryError(400, 'invalid_request_body');
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new HttpBoundaryError(400, 'invalid_request_body');
  return deepFreezeJsonObject(value as Record<string, unknown>);
}

function apiCallbackFailure(error: unknown): HttpBoundaryError {
  if (
    error instanceof GatewayApiError &&
    Number.isSafeInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599 &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.stableCode)
  )
    return new HttpBoundaryError(error.status, error.stableCode);
  return new HttpBoundaryError(500, 'internal_error');
}

function apiResponseBytes(response: GatewayApiResponse): {
  status: 200 | 201;
  bytes: Buffer;
} {
  if (
    response === null ||
    typeof response !== 'object' ||
    (Object.getPrototypeOf(response) !== Object.prototype &&
      Object.getPrototypeOf(response) !== null)
  )
    throw new HttpBoundaryError(500, 'internal_error');
  const responseKeys = Reflect.ownKeys(response);
  const statusDescriptor = Object.getOwnPropertyDescriptor(response, 'status');
  const bodyDescriptor = Object.getOwnPropertyDescriptor(response, 'body');
  if (
    responseKeys.length !== 2 ||
    !responseKeys.includes('status') ||
    !responseKeys.includes('body') ||
    !statusDescriptor?.enumerable ||
    !bodyDescriptor?.enumerable ||
    !('value' in statusDescriptor) ||
    !('value' in bodyDescriptor)
  )
    throw new HttpBoundaryError(500, 'internal_error');
  const status = statusDescriptor.value as unknown;
  if (status !== 200 && status !== 201)
    throw new HttpBoundaryError(500, 'internal_error');
  const root: unknown = bodyDescriptor.value;
  if (
    root === null ||
    typeof root !== 'object' ||
    Array.isArray(root) ||
    (Object.getPrototypeOf(root) !== Object.prototype &&
      Object.getPrototypeOf(root) !== null)
  )
    throw new HttpBoundaryError(500, 'internal_error');

  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; exit?: boolean }> = [{ value: root }];
  let minimumBytes = 0;
  try {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const value = frame.value;
      if (frame.exit) {
        active.delete(value as object);
        continue;
      }
      if (value === null || typeof value === 'boolean') {
        minimumBytes += value === null ? 4 : value ? 4 : 5;
      } else if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
        minimumBytes += 1;
      } else if (typeof value === 'string') {
        minimumBytes += Buffer.byteLength(value) + 2;
      } else if (typeof value === 'object') {
        minimumBytes += 2;
        if (active.has(value)) throw new Error('cyclic JSON value');
        active.add(value);
        stack.push({ value, exit: true });
        if (Array.isArray(value)) {
          if (Object.getPrototypeOf(value) !== Array.prototype)
            throw new Error('non-plain JSON array');
          const keys = Reflect.ownKeys(value);
          if (keys.length !== value.length + 1 || !keys.includes('length'))
            throw new Error('non-JSON array properties');
          for (let index = value.length - 1; index >= 0; index -= 1) {
            const descriptor = Object.getOwnPropertyDescriptor(
              value,
              String(index),
            );
            if (!descriptor?.enumerable || !('value' in descriptor))
              throw new Error('sparse or accessor JSON array');
            stack.push({ value: descriptor.value });
            minimumBytes += 1;
          }
        } else {
          const prototype = Object.getPrototypeOf(value);
          if (prototype !== Object.prototype && prototype !== null)
            throw new Error('non-plain JSON object');
          for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string')
              throw new Error('symbol JSON property');
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !('value' in descriptor))
              throw new Error('non-data JSON property');
            minimumBytes += Buffer.byteLength(key) + 3;
            stack.push({ value: descriptor.value });
          }
        }
      } else {
        throw new Error('non-JSON value');
      }
      if (minimumBytes > MAX_API_RESPONSE_BYTES)
        throw new Error('oversized JSON response');
    }
    const json = JSON.stringify(root);
    const bytes = Buffer.from(json);
    if (bytes.length > MAX_API_RESPONSE_BYTES)
      throw new Error('oversized JSON response');
    return { status, bytes };
  } catch {
    throw new HttpBoundaryError(500, 'internal_error');
  }
}

function sendError(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  code: string,
): void {
  if (!request.complete) {
    response.setHeader('Connection', 'close');
    request.resume();
  }
  sendJson(response, status, { error: code }, request.method === 'HEAD');
}

function residentErrorStatusMatches(
  status: number,
  code: ResidentControlErrorCode,
): boolean {
  switch (code) {
    case 'invalid_request':
      return [400, 404, 405, 408, 413, 415].includes(status);
    case 'unauthorized':
      return status === 401;
    case 'expired':
      return status === 410;
    case 'revoked':
      return status === 403;
    case 'conflict':
      return status === 409;
    case 'rate_limited':
      return status === 429;
    case 'internal_error':
      return status === 500;
  }
}

function sendResidentError(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  code: ResidentControlErrorCode,
  requestId?: string,
): void {
  if (!residentErrorStatusMatches(status, code)) {
    status = 500;
    code = 'internal_error';
    requestId = undefined;
  }
  if (!request.complete) {
    response.setHeader('Connection', 'close');
    request.resume();
  }
  let body: string;
  try {
    const value =
      requestId === undefined
        ? { format: RESIDENT_CONTROL_FORMATS.error, code }
        : { format: RESIDENT_CONTROL_FORMATS.error, code, requestId };
    // Normal request IDs reach here only after the shared decoder accepts them.
    body = serializeResidentControlError(
      value as Parameters<typeof serializeResidentControlError>[0],
    );
  } catch {
    // A malformed injected adapter error cannot break the response boundary.
    status = 500;
    body = serializeResidentControlError({
      format: RESIDENT_CONTROL_FORMATS.error,
      code: 'internal_error',
    });
  }
  send(response, status, body, 'application/json; charset=utf-8');
}

interface SafeTarget {
  segments: string[];
  extensionless: boolean;
}

function safeStaticTarget(rawUrl: string): SafeTarget {
  const question = rawUrl.indexOf('?');
  const pathname = question < 0 ? rawUrl : rawUrl.slice(0, question);
  if (
    pathname.length < 1 ||
    Buffer.byteLength(pathname) > MAX_REQUEST_TARGET_BYTES ||
    !pathname.startsWith('/') ||
    pathname.includes('\\') ||
    pathname.includes('\0') ||
    pathname.startsWith('//')
  )
    throw new HttpBoundaryError(400, 'invalid_request');
  if (pathname === '/') return { segments: [], extensionless: true };
  const encoded = pathname.slice(1).split('/');
  if (encoded.some((part) => part.length === 0))
    throw new HttpBoundaryError(404, 'not_found');
  const segments = encoded.map((part) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new HttpBoundaryError(400, 'invalid_request');
    }
    if (
      decoded.length === 0 ||
      decoded === '.' ||
      decoded === '..' ||
      decoded.startsWith('.') ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    )
      throw new HttpBoundaryError(404, 'not_found');
    return decoded;
  });
  return {
    segments,
    extensionless: path.extname(segments[segments.length - 1] ?? '') === '',
  };
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..' + path.sep) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

async function assertNoSymlinks(
  root: string,
  segments: string[],
): Promise<void> {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new HttpBoundaryError(404, 'not_found');
  }
}

async function boundedStaticFile(
  root: string,
  segments: string[],
  maxBytes: number,
): Promise<Buffer> {
  const candidate = path.join(root, ...segments);
  if (!within(root, candidate)) throw new HttpBoundaryError(404, 'not_found');
  await assertNoSymlinks(root, segments);
  const resolved = await realpath(candidate);
  if (!within(root, resolved)) throw new HttpBoundaryError(404, 'not_found');
  const handle = await open(
    resolved,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new HttpBoundaryError(404, 'not_found');
    if (stat.size > maxBytes) throw new HttpBoundaryError(404, 'not_found');
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    const beyond = await handle.read(extra, 0, 1, offset);
    if (offset !== buffer.length || beyond.bytesRead !== 0)
      throw new HttpBoundaryError(404, 'not_found');
    return buffer;
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isSpaRoute(target: SafeTarget): boolean {
  const first = target.segments[0];
  return (
    target.extensionless &&
    first !== 'api' &&
    first !== 'healthz' &&
    first !== 'readyz'
  );
}

export class GatewayHttpService {
  readonly #options: GatewayHttpServiceOptions;
  readonly #root: string;
  readonly #server: http.Server;
  readonly #residentRateLimiter: ResidentControlRateLimiter;
  readonly #webSocketServer: WebSocketServer;
  #stopping: Promise<void> | null = null;
  #initialized = false;
  #starting: Promise<GatewayListenAddress> | null = null;

  constructor(options: GatewayHttpServiceOptions) {
    if (!options || typeof options.publicRoot !== 'string')
      throw new Error('publicRoot is required');
    const rootStat = fs.lstatSync(options.publicRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error('publicRoot must be a real directory');
    this.#root = fs.realpathSync(options.publicRoot);
    this.#options = options;
    this.#residentRateLimiter =
      options.residentRateLimiter ?? new BoundedResidentControlRateLimiter();
    const hasResidentCredentials =
      options.residentCredentialStore !== undefined;
    const hasResidentRegistry = options.residentLinkRegistry !== undefined;
    if (hasResidentCredentials !== hasResidentRegistry)
      throw new Error(
        'residentCredentialStore and residentLinkRegistry must be configured together',
      );
    if (
      options.residentCredentialStore !== undefined &&
      (!options.residentCredentialStore ||
        typeof options.residentCredentialStore.authenticateNode !== 'function')
    )
      throw new Error('residentCredentialStore must provide authenticateNode');
    if (
      options.residentNow !== undefined &&
      typeof options.residentNow !== 'function'
    )
      throw new Error('residentNow must be a function');
    if (
      options.residentRateLimiter !== undefined &&
      (!options.residentRateLimiter ||
        typeof options.residentRateLimiter.allow !== 'function')
    )
      throw new Error('residentRateLimiter must provide allow');
    for (const [label, value] of [
      ['maxBodyBytes', options.maxBodyBytes],
      ['maxStaticBytes', options.maxStaticBytes],
      ['bodyTimeoutMs', options.bodyTimeoutMs],
      ['shutdownGraceMs', options.shutdownGraceMs],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
        throw new Error(`${label} must be a positive safe integer`);
    }
    this.#server = http.createServer(
      {
        maxHeaderSize: 16 * 1024,
        requireHostHeader: true,
        requestTimeout: 15_000,
        headersTimeout: 10_000,
        keepAliveTimeout: 5_000,
        connectionsCheckingInterval: 1_000,
      },
      (request, response) => void this.#handle(request, response),
    );
    this.#server.maxRequestsPerSocket = 100;
    this.#server.on('clientError', (_error, socket) => {
      if (socket.writable)
        socket.end(
          'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
    });
    this.#webSocketServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: LIMITS.frameBytes,
    });
    // Final non-logging EventEmitter error boundary.
    this.#webSocketServer.on('error', () => undefined);
    this.#server.on('upgrade', (request, socket, head) =>
      this.#handleUpgrade(request, socket, head),
    );
    this.#server.on('connect', (_request, socket) => socket.destroy());
  }

  get listening(): boolean {
    return this.#server.listening;
  }

  address(): GatewayListenAddress | null {
    const value = this.#server.address();
    if (value === null || typeof value === 'string') return null;
    return { host: value.address, port: value.port };
  }

  async start(): Promise<GatewayListenAddress> {
    if (this.#server.listening) return this.address()!;
    if (this.#starting !== null) return this.#starting;
    const host = this.#options.listen?.host ?? DEFAULT_HOST;
    const port = this.#options.listen?.port ?? DEFAULT_PORT;
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
      throw new Error('listen port is invalid');
    if (typeof host !== 'string' || host.length < 1)
      throw new Error('listen host is invalid');
    this.#starting = new Promise<GatewayListenAddress>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.off('listening', onListening);
        this.#starting = null;
        reject(error);
      };
      const onListening = (): void => {
        this.#server.off('error', onError);
        this.#initialized = true;
        const address = this.address();
        this.#starting = null;
        if (address === null) reject(new Error('listener has no TCP address'));
        else resolve(address);
      };
      this.#server.once('error', onError);
      this.#server.once('listening', onListening);
      this.#server.listen({ host, port, exclusive: true });
    });
    return this.#starting;
  }

  stop(): Promise<void> {
    if (this.#stopping !== null) return this.#stopping;
    this.#stopping = this.#stop();
    return this.#stopping;
  }

  async #stop(): Promise<void> {
    this.#initialized = false;
    // Empty and permanently stop the registry before closing the listener.
    this.#options.residentLinkRegistry?.stop();
    if (!this.#server.listening) {
      if (this.#starting !== null) await this.#starting.catch(() => undefined);
      if (!this.#server.listening) {
        for (const socket of this.#webSocketServer.clients) socket.terminate();
        this.#webSocketServer.close();
        return;
      }
    }
    const webSocketsClosed = new Promise<void>((resolve) =>
      this.#webSocketServer.close(() => resolve()),
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Node's HTTP closeAllConnections deliberately excludes upgraded peers.
        for (const socket of this.#webSocketServer.clients) socket.terminate();
        this.#server.closeAllConnections();
      }, this.#options.shutdownGraceMs ?? 5_000);
      timer.unref();
      this.#server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      this.#server.closeIdleConnections();
    });
    await webSocketsClosed;
  }

  #handleUpgrade(
    request: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void {
    // Query, percent, wrong path/method, browser-origin, and protocol selection
    // confusion all fail before credential parsing.
    if (
      request.url !== RESIDENT_CONTROL_PATHS.link ||
      !validWebSocketHandshake(request) ||
      hasRequestHeader(request, 'origin') ||
      hasRequestHeader(request, 'sec-websocket-protocol')
    ) {
      rejectUpgrade(socket, 404);
      return;
    }

    let now: number;
    try {
      now = (this.#options.residentNow ?? Date.now)();
    } catch {
      rejectUpgrade(socket, 500);
      return;
    }
    let allowed = false;
    try {
      allowed =
        Number.isSafeInteger(now) &&
        this.#residentRateLimiter.allow({
          peerAddress: request.socket.remoteAddress ?? '<unknown>',
          route: 'link',
          now,
        }) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) {
      rejectUpgrade(socket, 429);
      return;
    }

    // rawHeaders-backed exact-single extraction plus the shared codec rejects
    // comma joins, alternate schemes, whitespace variants, and malformed tokens.
    const authorization = singleRequestHeader(request, 'authorization');
    const token = parseNodeBearerAuthorization(authorization);
    const connectionId = singleRequestHeader(
      request,
      RESIDENT_CONTROL_HEADERS.connectionId,
    );
    const credentials = this.#options.residentCredentialStore;
    const registry = this.#options.residentLinkRegistry;
    let binding: AuthenticatedNode | null = null;
    try {
      if (token !== null && credentials)
        binding = credentials.authenticateNode(token);
    } catch {
      rejectUpgrade(socket, 500);
      return;
    }
    if (binding === null || !registry) {
      rejectUpgrade(socket, 401);
      return;
    }
    if (!isConnectionId(connectionId)) {
      rejectUpgrade(socket, 400);
      return;
    }
    let rejection: ReturnType<GatewayResidentLinkRegistry['preflight']>;
    try {
      rejection = registry.preflight(binding);
    } catch {
      rejectUpgrade(socket, 500);
      return;
    }
    if (rejection !== null) {
      rejectUpgrade(socket, rejection === 'duplicate' ? 409 : 503);
      return;
    }

    try {
      // Passing the exact head buffer is required when a peer pipelines its
      // first WebSocket frame with the HTTP upgrade request.
      this.#webSocketServer.handleUpgrade(
        request,
        socket,
        head,
        (webSocket) => {
          // Keep one inert listener for the whole transport lifetime; registry
          // teardown detaches its adapter listener while ws may still report a
          // terminal parser error such as maxPayload.
          webSocket.on('error', () => undefined);
          // admit repeats all publication checks as a defense.
          const adapter = new WsResidentSocketAdapter(webSocket);
          try {
            registry.admit(binding!, adapter, connectionId);
          } catch {
            adapter.close(1011, 'admission_failed');
          }
        },
      );
    } catch {
      rejectUpgrade(socket, 400);
    }
  }

  #publicUrl(): string | null {
    if (this.#options.getPublicUrl) return this.#options.getPublicUrl();
    if (this.#options.store) return this.#options.store.config().publicUrl;
    return null;
  }

  async #ready(): Promise<boolean> {
    if (!this.#initialized) return false;
    try {
      if (this.#options.checkReady)
        return (await this.#options.checkReady()) === true;
      if (this.#options.store) {
        this.#options.store.config();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async #handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    securityHeaders(response);
    try {
      const rawUrl = request.url;
      if (!rawUrl) throw new HttpBoundaryError(400, 'invalid_request');
      const method = request.method ?? '';

      // Resident control is a separate non-browser boundary. Dispatch it
      // before generic API/body policy so every failure uses its wire codec.
      if (residentNamespaceTarget(rawUrl)) {
        await this.#handleResidentControl(request, response, rawUrl, method);
        return;
      }
      if (Buffer.byteLength(rawUrl) > MAX_REQUEST_TARGET_BYTES)
        throw new HttpBoundaryError(400, 'invalid_request');
      const pathname = rawUrl.split('?', 1)[0];

      if (!isBrowserMutation(method)) {
        const length = validateRequestBodyFraming(
          request,
          this.#options.maxBodyBytes,
        );
        if (length !== 0)
          throw new HttpBoundaryError(400, 'invalid_request_body');
      }

      if (pathname === '/healthz') {
        if (method !== 'GET' && method !== 'HEAD')
          throw new HttpBoundaryError(405, 'method_not_allowed');
        sendJson(response, 200, { status: 'ok' }, method === 'HEAD');
        return;
      }
      if (pathname === '/readyz') {
        if (method !== 'GET' && method !== 'HEAD')
          throw new HttpBoundaryError(405, 'method_not_allowed');
        const ready = await this.#ready();
        sendJson(
          response,
          ready ? 200 : 503,
          { status: ready ? 'ready' : 'unavailable' },
          method === 'HEAD',
        );
        return;
      }
      if (rawUrl === '/api/csrf') {
        if (method !== 'GET')
          throw new HttpBoundaryError(405, 'method_not_allowed');
        const token = createCsrfToken();
        response.setHeader('Set-Cookie', csrfCookie(token));
        sendJson(response, 200, { csrfToken: token });
        return;
      }

      if (apiNamespaceTarget(rawUrl)) {
        if (!this.#options.api) throw new HttpBoundaryError(404, 'not_found');
        try {
          await this.#handleBrowserApi(request, response, rawUrl, method);
        } catch (error) {
          if (error instanceof HttpBoundaryError) throw error;
          throw new HttpBoundaryError(500, 'internal_error');
        }
        return;
      }

      if (isBrowserMutation(method)) {
        let publicUrl: string | null;
        try {
          publicUrl = this.#publicUrl();
        } catch {
          throw new HttpBoundaryError(503, 'service_unavailable');
        }
        const guard: BrowserOriginGuard = { publicUrl };
        assertBrowserMutation(request, guard);
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          this.#options.bodyTimeoutMs ?? 10_000,
        );
        timer.unref();
        try {
          await readBoundedRequestBody(request, {
            maxBytes: this.#options.maxBodyBytes,
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        throw new HttpBoundaryError(404, 'not_found');
      }
      if (method !== 'GET' && method !== 'HEAD')
        throw new HttpBoundaryError(405, 'method_not_allowed');
      await this.#serveStatic(response, rawUrl, method === 'HEAD');
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpBoundaryError) {
        sendError(request, response, error.statusCode, error.code);
        return;
      }
      sendError(request, response, 404, 'not_found');
    }
  }

  async #readResidentBody(request: http.IncomingMessage): Promise<Buffer> {
    requireJsonContentType(request);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.bodyTimeoutMs ?? 10_000,
    );
    timer.unref();
    try {
      return await readBoundedRequestBody(request, {
        maxBytes: RESIDENT_CONTROL_LIMITS.bodyBytes,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async #handleResidentControl(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    rawUrl: string,
    method: string,
  ): Promise<void> {
    try {
      if (Buffer.byteLength(rawUrl) > MAX_REQUEST_TARGET_BYTES)
        throw new ResidentControlApiError(400, 'invalid_request');
      const route = exactResidentRoute(rawUrl);
      if (route === null || !this.#options.residentControl)
        throw new ResidentControlApiError(404, 'invalid_request');
      if (method !== 'POST')
        throw new ResidentControlApiError(405, 'invalid_request');

      let now: number;
      try {
        now = (this.#options.residentNow ?? Date.now)();
      } catch {
        throw new ResidentControlApiError(500, 'internal_error');
      }
      if (!Number.isSafeInteger(now))
        throw new ResidentControlApiError(500, 'internal_error');
      const admitted = this.#residentRateLimiter.allow({
        peerAddress: request.socket.remoteAddress ?? '<unknown>',
        route,
        now,
      });
      if (admitted !== true)
        throw new ResidentControlApiError(429, 'rate_limited');

      const api = this.#options.residentControl;
      const authorization = singleRequestHeader(request, 'authorization');
      let proposalProof: ReturnType<typeof api.authorizeProposal> | undefined;
      let activationToken: string | undefined;
      if (route === 'rotation') {
        // Current-node authentication intentionally precedes content type,
        // framing, timeout setup, and all body I/O.
        proposalProof = api.authorizeProposal(authorization);
      } else if (route === 'rotationActivation') {
        // This checks syntax only. The pending verifier is authenticated by
        // GatewayCredentialStore.activateRotation after request decoding.
        activationToken = api.activationAuthorization(authorization);
      }

      const body = await this.#readResidentBody(request);
      const adapterResult =
        route === 'enrollment'
          ? api.enroll(body)
          : route === 'rotation'
            ? api.proposeRotation(proposalProof!, body)
            : api.activateRotation(activationToken!, body);
      const result = residentSuccessBody(route, adapterResult);
      send(
        response,
        result.status,
        result.body,
        'application/json; charset=utf-8',
      );
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof ResidentControlApiError) {
        sendResidentError(
          request,
          response,
          error.status,
          error.code,
          error.requestId,
        );
        return;
      }
      if (error instanceof HttpBoundaryError) {
        sendResidentError(
          request,
          response,
          error.statusCode,
          'invalid_request',
        );
        return;
      }
      sendResidentError(request, response, 500, 'internal_error');
    }
  }

  #apiPublicUrl(): string | null {
    try {
      return this.#publicUrl();
    } catch {
      throw new HttpBoundaryError(503, 'service_unavailable');
    }
  }

  async #readApiBody(request: http.IncomingMessage): Promise<JsonObject> {
    requireJsonContentType(request);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.bodyTimeoutMs ?? 10_000,
    );
    timer.unref();
    try {
      const bytes = await readBoundedRequestBody(request, {
        maxBytes: this.#options.maxBodyBytes,
        signal: controller.signal,
      });
      return decodeJsonObject(bytes);
    } finally {
      clearTimeout(timer);
    }
  }

  async #handleBrowserApi(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    rawUrl: string,
    method: string,
  ): Promise<void> {
    const pathname = exactApiPathname(rawUrl);
    if (pathname === null) throw new HttpBoundaryError(404, 'not_found');

    let route: BrowserApiRoute | null;
    try {
      route = this.#options.api!.match(method, pathname);
    } catch {
      throw new HttpBoundaryError(500, 'internal_error');
    }
    if (route === null) throw new HttpBoundaryError(404, 'not_found');
    if (route === undefined || typeof route !== 'object')
      throw new HttpBoundaryError(500, 'internal_error');

    let body: JsonObject | null;
    let publicUrl: string | null;
    if (route.policy === 'read') {
      if (method !== 'GET' && method !== 'HEAD')
        throw new HttpBoundaryError(405, 'method_not_allowed');
      body = null;
      publicUrl = this.#apiPublicUrl();
    } else if (route.policy === 'mutation') {
      if (
        !isBrowserMutation(method) ||
        (route.method !== undefined && route.method !== method)
      )
        throw new HttpBoundaryError(405, 'method_not_allowed');
      publicUrl = this.#apiPublicUrl();
      if (route.requiresSetup === true && publicUrl === null)
        throw apiCallbackFailure(new GatewayApiError(409, 'setup_required'));
      // Configured mutation authorization deliberately precedes body handling.
      assertBrowserMutation(request, { publicUrl });
      body = await this.#readApiBody(request);
    } else if (route.policy === 'setup-mutation') {
      if (
        !isBrowserMutation(method) ||
        (route.method !== undefined && route.method !== method)
      )
        throw new HttpBoundaryError(405, 'method_not_allowed');
      body = await this.#readApiBody(request);
      let candidate: string;
      try {
        candidate = route.candidatePublicUrl(body);
      } catch (error) {
        throw apiCallbackFailure(error);
      }
      publicUrl = this.#apiPublicUrl();
      const guard: BrowserOriginGuard = {
        publicUrl,
        setupCandidatePublicUrl: candidate,
      };
      assertBrowserMutation(request, guard);
    } else {
      throw new HttpBoundaryError(500, 'internal_error');
    }

    let descriptor: GatewayApiResponse;
    try {
      descriptor = await route.handle(body as never, publicUrl);
    } catch (error) {
      throw apiCallbackFailure(error);
    }
    let result: ReturnType<typeof apiResponseBytes>;
    try {
      result = apiResponseBytes(descriptor);
    } catch (error) {
      if (error instanceof HttpBoundaryError) throw error;
      throw new HttpBoundaryError(500, 'internal_error');
    }
    send(
      response,
      result.status,
      result.bytes,
      'application/json; charset=utf-8',
      method === 'HEAD',
    );
  }

  async #serveStatic(
    response: http.ServerResponse,
    rawUrl: string,
    head: boolean,
  ): Promise<void> {
    const target = safeStaticTarget(rawUrl);
    const maxBytes = this.#options.maxStaticBytes ?? DEFAULT_MAX_STATIC_BYTES;
    let segments =
      target.segments.length === 0 ? ['index.html'] : target.segments;
    let body: Buffer;
    let spa = false;
    try {
      body = await boundedStaticFile(this.#root, segments, maxBytes);
    } catch (error) {
      if (!isSpaRoute(target) || !isMissingFile(error)) throw error;
      segments = ['index.html'];
      body = await boundedStaticFile(this.#root, segments, maxBytes);
      spa = true;
    }
    const extension = path
      .extname(segments[segments.length - 1]!)
      .toLowerCase();
    const contentType = CONTENT_TYPES[extension];
    if (!contentType) throw new HttpBoundaryError(404, 'not_found');
    if (!spa && extension !== '.html')
      response.setHeader('Cache-Control', 'private, max-age=300');
    send(response, 200, body, contentType, head);
  }
}

export function createGatewayHttpService(
  options: GatewayHttpServiceOptions,
): GatewayHttpService {
  return new GatewayHttpService(options);
}
