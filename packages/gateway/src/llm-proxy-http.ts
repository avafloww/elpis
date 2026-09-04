import * as http from 'node:http';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_HEADERS,
  LLM_PROXY_LIMITS,
  LLM_PROXY_SAFE_RESPONSE_HEADERS,
  encodeLlmResponseProvenance,
  isSafeLlmResponseHeader,
  serializeLlmProxyError,
  type LlmProxyCatalog,
  type LlmProxyCatalogModel,
  type LlmProxyErrorCode,
  type LlmProxyRequest,
  type LlmSafeResponseHeader,
} from '@elpis/gateway-protocol';
import {
  HttpBoundaryError,
  singleRequestHeader,
  validateRequestBodyFraming,
} from './http-guards.js';
import type { AuthenticatedNode } from './credential-store.js';

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

function sendLlmJson(
  response: http.ServerResponse,
  status: number,
  body: string,
): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(Buffer.byteLength(body)));
  response.end(body);
}

export interface GatewayLlmProxyExchange {
  readonly status: number;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: ReadableStream<Uint8Array> | null;
}

export interface GatewayLlmProxyApi {
  authenticateNode(token: unknown): AuthenticatedNode | null;
  catalogForInstance(instanceId: string): LlmProxyCatalog;
  dispatch(input: {
    readonly instanceId: string;
    readonly request: LlmProxyRequest;
    readonly model: LlmProxyCatalogModel;
    readonly signal: AbortSignal;
  }): Promise<GatewayLlmProxyExchange>;
}

export type GatewayLlmProxyRoute = 'catalog' | 'request';

export interface GatewayLlmProxyRateLimitInput {
  readonly peerAddress: string;
  readonly route: GatewayLlmProxyRoute;
  readonly now: number;
}

export interface GatewayLlmProxyRateLimiter {
  allow(input: GatewayLlmProxyRateLimitInput): boolean;
}

export interface BoundedGatewayLlmProxyRateLimiterOptions {
  maxEntries?: number;
  windowMs?: number;
  requestsPerWindow?: number;
}

type LlmRateBucket = { count: number; resetAt: number };

export class BoundedGatewayLlmProxyRateLimiter implements GatewayLlmProxyRateLimiter {
  readonly #maxEntries: number;
  readonly #windowMs: number;
  readonly #requestsPerWindow: number;
  readonly #buckets = new Map<string, LlmRateBucket>();

  constructor(options: BoundedGatewayLlmProxyRateLimiterOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 1024;
    this.#windowMs = options.windowMs ?? 60_000;
    this.#requestsPerWindow = options.requestsPerWindow ?? 600;
    for (const [label, value] of [
      ['maxEntries', this.#maxEntries],
      ['windowMs', this.#windowMs],
      ['requestsPerWindow', this.#requestsPerWindow],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(`${label} must be a positive safe integer`);
    }
  }

  allow(input: GatewayLlmProxyRateLimitInput): boolean {
    if (
      !input ||
      typeof input.peerAddress !== 'string' ||
      input.peerAddress.length < 1 ||
      input.peerAddress.length > 128 ||
      input.peerAddress.includes('\0') ||
      !['catalog', 'request'].includes(input.route) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      input.now > Number.MAX_SAFE_INTEGER - this.#windowMs
    )
      return false;
    const key = input.peerAddress + '\0' + input.route;
    let bucket = this.#buckets.get(key);
    if (bucket && input.now >= bucket.resetAt) {
      this.#buckets.delete(key);
      bucket = undefined;
    }
    if (!bucket) {
      if (this.#buckets.size >= this.#maxEntries) {
        for (const [candidate, value] of this.#buckets) {
          if (input.now >= value.resetAt) this.#buckets.delete(candidate);
        }
      }
      if (this.#buckets.size >= this.#maxEntries) return false;
      this.#buckets.set(key, {
        count: 1,
        resetAt: input.now + this.#windowMs,
      });
      return true;
    }
    if (bucket.count >= this.#requestsPerWindow) return false;
    bucket.count += 1;
    return true;
  }
}

export class GatewayLlmHttpError extends Error {
  readonly status: number;
  readonly code: LlmProxyErrorCode;
  readonly requestId?: LlmProxyRequest['requestId'];

  constructor(
    status: number,
    code: LlmProxyErrorCode,
    requestId?: LlmProxyRequest['requestId'],
  ) {
    super('gateway LLM HTTP request failed');
    this.name = 'GatewayLlmHttpError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function sendLlmError(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  status: number,
  code: LlmProxyErrorCode,
  requestId?: LlmProxyRequest['requestId'],
): void {
  if (!request.complete || code === 'cancelled') {
    response.setHeader('Connection', 'close');
    if (!request.complete) request.resume();
  }
  let body: string;
  try {
    body = serializeLlmProxyError({
      format: LLM_PROXY_FORMATS.error,
      code,
      ...(requestId === undefined ? {} : { requestId }),
    });
  } catch {
    status = 500;
    body = serializeLlmProxyError({
      format: LLM_PROXY_FORMATS.error,
      code: 'internal_error',
    });
  }
  sendLlmJson(response, status, body);
}

function ownedLlmResponseHeaders(
  value: unknown,
): readonly (readonly [string, string])[] {
  if (!Array.isArray(value))
    throw new GatewayLlmHttpError(500, 'internal_error');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    !length ||
    !('value' in length) ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > LLM_PROXY_SAFE_RESPONSE_HEADERS.length
  )
    throw new GatewayLlmHttpError(500, 'internal_error');
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== length.value + 1 ||
    keys.some((key) =>
      typeof key === 'symbol'
        ? true
        : key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key),
    )
  )
    throw new GatewayLlmHttpError(500, 'internal_error');
  const result: (readonly [string, string])[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new GatewayLlmHttpError(500, 'internal_error');
    const entry = descriptor.value;
    if (!Array.isArray(entry))
      throw new GatewayLlmHttpError(500, 'internal_error');
    const entryKeys = Reflect.ownKeys(entry);
    const entryLength = Object.getOwnPropertyDescriptor(entry, 'length');
    const name = Object.getOwnPropertyDescriptor(entry, '0');
    const headerValue = Object.getOwnPropertyDescriptor(entry, '1');
    if (
      entryKeys.length !== 3 ||
      entryKeys.some((key) => !['0', '1', 'length'].includes(String(key))) ||
      !entryLength ||
      !('value' in entryLength) ||
      entryLength.value !== 2 ||
      !name?.enumerable ||
      !headerValue?.enumerable ||
      !('value' in name) ||
      !('value' in headerValue) ||
      typeof name.value !== 'string' ||
      typeof headerValue.value !== 'string'
    )
      throw new GatewayLlmHttpError(500, 'internal_error');
    result.push(Object.freeze([name.value, headerValue.value] as const));
  }
  return Object.freeze(result);
}

function normalizedLlmExchange(value: unknown): GatewayLlmProxyExchange {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new GatewayLlmHttpError(500, 'internal_error');
  const input = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(input);
  if (
    keys.length !== 3 ||
    !keys.includes('status') ||
    !keys.includes('headers') ||
    !keys.includes('body')
  )
    throw new GatewayLlmHttpError(500, 'internal_error');
  const status = Object.getOwnPropertyDescriptor(input, 'status');
  const headers = Object.getOwnPropertyDescriptor(input, 'headers');
  const body = Object.getOwnPropertyDescriptor(input, 'body');
  if (
    !status?.enumerable ||
    !headers?.enumerable ||
    !body?.enumerable ||
    !('value' in status) ||
    !('value' in headers) ||
    !('value' in body) ||
    !Number.isSafeInteger(status.value) ||
    status.value < 200 ||
    status.value > 599 ||
    (body.value !== null && !(body.value instanceof ReadableStream)) ||
    (body.value !== null && [204, 205, 304].includes(status.value as number))
  )
    throw new GatewayLlmHttpError(500, 'internal_error');
  return {
    status: status.value as number,
    headers: ownedLlmResponseHeaders(headers.value),
    body: body.value as ReadableStream<Uint8Array> | null,
  };
}

function safeLlmResponseHeaders(
  entries: readonly (readonly [string, string])[],
): readonly LlmSafeResponseHeader[] {
  const candidates: LlmSafeResponseHeader[] = [];
  const counts = new Map<string, number>();
  try {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [rawName, rawValue] = entry;
      if (typeof rawName !== 'string' || typeof rawValue !== 'string') continue;
      const name = rawName.toLowerCase();
      if (
        !isSafeLlmResponseHeader(name) ||
        rawValue.length === 0 ||
        Buffer.byteLength(rawValue) >
          LLM_PROXY_LIMITS.responseHeaderValueBytes ||
        !/^[\x20-\x7e]+$/.test(rawValue)
      )
        continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      candidates.push({ name, value: rawValue });
    }
  } catch {
    throw new GatewayLlmHttpError(500, 'internal_error');
  }
  return Object.freeze(
    candidates
      .filter((entry) => counts.get(entry.name) === 1)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((entry) => Object.freeze(entry)),
  );
}

type GatewayLlmAbortKind =
  'call_timeout' | 'stream_idle_timeout' | 'client' | 'shutdown';

export class GatewayLlmAbort extends Error {
  readonly kind: GatewayLlmAbortKind;

  constructor(kind: GatewayLlmAbortKind) {
    super('gateway LLM request aborted');
    this.name = 'GatewayLlmAbort';
    this.kind = kind;
  }
}

export function abortLlmRequest(
  controller: AbortController,
  kind: GatewayLlmAbortKind,
): void {
  if (!controller.signal.aborted) controller.abort(new GatewayLlmAbort(kind));
}

export function raceLlmAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    promise.then(
      () => undefined,
      () => undefined,
    );
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', aborted);
      operation();
    };
    const aborted = (): void => finish(() => reject(signal.reason));
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) aborted();
  });
}

async function readLlmChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timer =
    timeoutMs === 0
      ? null
      : setTimeout(
          () => abortLlmRequest(controller, 'stream_idle_timeout'),
          timeoutMs,
        );
  timer?.unref();
  try {
    return await raceLlmAbort(reader.read(), controller.signal);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function waitForDrain(
  response: http.ServerResponse,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || response.destroyed)
    return Promise.reject(new Error('downstream closed'));
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', drained);
      response.off('close', closed);
      response.off('error', closed);
      signal.removeEventListener('abort', closed);
    };
    const finish = (operation: () => void): void => {
      cleanup();
      operation();
    };
    const drained = (): void => finish(resolve);
    const closed = (): void =>
      finish(() => reject(new Error('downstream closed')));
    response.once('drain', drained);
    response.once('close', closed);
    response.once('error', closed);
    signal.addEventListener('abort', closed, { once: true });
    if (signal.aborted || response.destroyed) closed();
  });
}

export function readLlmBody(
  request: http.IncomingMessage,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<Buffer> {
  requireJsonContentType(request);
  const expected = validateRequestBodyFraming(
    request,
    LLM_PROXY_LIMITS.requestBodyBytes,
  );
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onSignalAbort);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onPeerAbort);
      request.off('error', onPeerAbort);
    };
    const finish = (operation: () => void, pause: boolean): void => {
      if (settled) return;
      settled = true;
      if (pause) request.pause();
      cleanup();
      operation();
    };
    const fail = (error: GatewayLlmHttpError): void =>
      finish(() => reject(error), true);
    const onData = (value: Buffer | Uint8Array | string): void => {
      const chunk = Buffer.from(value);
      received += chunk.byteLength;
      if (received > expected || received > LLM_PROXY_LIMITS.requestBodyBytes) {
        fail(new GatewayLlmHttpError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      if (received !== expected) {
        fail(new GatewayLlmHttpError(400, 'invalid_request'));
        return;
      }
      finish(() => resolve(Buffer.concat(chunks, received)), false);
    };
    const onPeerAbort = (): void =>
      fail(new GatewayLlmHttpError(503, 'cancelled'));
    const onSignalAbort = (): void =>
      fail(new GatewayLlmHttpError(503, 'cancelled'));
    const timer = setTimeout(
      () => fail(new GatewayLlmHttpError(408, 'invalid_request')),
      timeoutMs,
    );
    timer.unref();
    signal.addEventListener('abort', onSignalAbort, { once: true });
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onPeerAbort);
    request.once('error', onPeerAbort);
    if (signal.aborted) onSignalAbort();
  });
}

export async function streamLlmExchange(
  response: http.ServerResponse,
  exchange: GatewayLlmProxyExchange,
  request: LlmProxyRequest,
  controller: AbortController,
  streamIdleTimeoutMs: number,
): Promise<void> {
  const signal = controller.signal;
  const normalized = normalizedLlmExchange(exchange);
  const safeHeaders = safeLlmResponseHeaders(normalized.headers);
  const provenance = encodeLlmResponseProvenance({
    format: LLM_PROXY_FORMATS.responseProvenance,
    requestId: request.requestId,
    modelRef: request.modelRef,
    targetGeneration: request.targetGeneration,
    route: request.route,
    status: normalized.status,
    headers: safeHeaders,
  });
  const reader =
    normalized.body === null
      ? null
      : (ReadableStream.prototype.getReader.call(
          normalized.body,
        ) as ReadableStreamDefaultReader<Uint8Array>);
  let bytes = 0;
  try {
    const first =
      reader === null
        ? { done: true as const, value: undefined }
        : await readLlmChunk(reader, controller, streamIdleTimeoutMs);
    if (!first.done) {
      if (!(first.value instanceof Uint8Array))
        throw new GatewayLlmHttpError(500, 'internal_error', request.requestId);
      bytes = first.value.byteLength;
      if (bytes > LLM_PROXY_LIMITS.responseBytes)
        throw new GatewayLlmHttpError(
          502,
          'upstream_unavailable',
          request.requestId,
        );
    }
    response.statusCode = normalized.status;
    response.setHeader(LLM_PROXY_HEADERS.provenance, provenance);
    response.setHeader('Content-Type', 'application/octet-stream');
    if (!first.done && !response.write(first.value))
      await waitForDrain(response, signal);
    while (reader !== null && !first.done) {
      const next = await readLlmChunk(reader, controller, streamIdleTimeoutMs);
      if (next.done) break;
      if (!(next.value instanceof Uint8Array))
        throw new Error('invalid upstream chunk');
      bytes += next.value.byteLength;
      if (bytes > LLM_PROXY_LIMITS.responseBytes)
        throw new Error('upstream response too large');
      if (!response.write(next.value)) await waitForDrain(response, signal);
    }
    response.end();
  } catch (error) {
    void reader?.cancel().catch(() => undefined);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof GatewayLlmHttpError) throw error;
    const reason = signal.reason;
    if (reason instanceof GatewayLlmAbort) {
      throw new GatewayLlmHttpError(
        reason.kind === 'call_timeout' || reason.kind === 'stream_idle_timeout'
          ? 504
          : 503,
        reason.kind === 'call_timeout' || reason.kind === 'stream_idle_timeout'
          ? 'upstream_timeout'
          : 'cancelled',
        request.requestId,
      );
    }
    throw new GatewayLlmHttpError(
      502,
      'upstream_unavailable',
      request.requestId,
    );
  } finally {
    try {
      reader?.releaseLock();
    } catch {
      // A cancelled source may still own a pending read; late settlement is observed.
    }
  }
}
