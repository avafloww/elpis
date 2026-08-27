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
  validateRequestBodyFraming,
  type BrowserOriginGuard,
} from './http-guards.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8790;
const DEFAULT_MAX_STATIC_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_TARGET_BYTES = 8192;

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
      if (pathname === '/api/csrf') {
        if (method !== 'GET')
          throw new HttpBoundaryError(405, 'method_not_allowed');
        const token = createCsrfToken();
        response.setHeader('Set-Cookie', csrfCookie(token));
        sendJson(response, 200, { csrfToken: token });
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
