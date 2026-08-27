import * as fs from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
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
    // This release has no resident link, WebSocket, or CONNECT relay.
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

  async stop(): Promise<void> {
    this.#initialized = false;
    if (!this.#server.listening) {
      if (this.#starting !== null) await this.#starting.catch(() => undefined);
      if (!this.#server.listening) return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.#server.closeAllConnections(),
        this.#options.shutdownGraceMs ?? 5_000,
      );
      timer.unref();
      this.#server.close((error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
      this.#server.closeIdleConnections();
    });
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
      if (!rawUrl || Buffer.byteLength(rawUrl) > MAX_REQUEST_TARGET_BYTES)
        throw new HttpBoundaryError(400, 'invalid_request');
      const pathname = rawUrl.split('?', 1)[0];
      const method = request.method ?? '';
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
      if (!isBrowserMutation(method))
        throw new HttpBoundaryError(405, 'method_not_allowed');
      publicUrl = this.#apiPublicUrl();
      // Configured mutation authorization deliberately precedes body handling.
      assertBrowserMutation(request, { publicUrl });
      body = await this.#readApiBody(request);
    } else if (route.policy === 'setup-mutation') {
      if (!isBrowserMutation(method))
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
