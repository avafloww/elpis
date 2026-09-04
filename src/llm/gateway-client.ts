import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_HEADERS,
  LLM_PROXY_LIMITS,
  LLM_PROXY_PATHS,
  decodeLlmProxyCatalog,
  decodeLlmProxyError,
  decodeLlmResponseProvenance,
  formatNodeBearerAuthorization,
  isRequestId,
  serializeLlmProxyCatalog,
  serializeLlmProxyRequest,
  type LlmProxyCatalog,
  type LlmProxyCatalogModel,
  type LlmProxyErrorCode,
  type LlmProxyRoute,
  type LlmProxyTransportMetadata,
  type RequestId,
} from '@elpis/gateway-protocol';
import {
  GatewayResidentStateError,
  type GatewayResidentSnapshot,
  type GatewayResidentStore,
} from '../store/gateway-resident.js';

/** The deliberately small authority surface used by the transport boundary. */
export type GatewayLlmResidentStore = Pick<
  GatewayResidentStore,
  'read' | 'activeNodeToken'
>;

export type GatewayLlmFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export interface GatewayLlmClientOptions {
  readonly store: GatewayLlmResidentStore;
  readonly fetch?: GatewayLlmFetch;
  /** Injectable only so request identifiers can be asserted in boundary tests. */
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface GatewayLlmDispatchInput {
  readonly model: LlmProxyCatalogModel;
  readonly route: LlmProxyRoute;
  readonly transport: LlmProxyTransportMetadata;
  readonly payload: Uint8Array;
}

/** A canonical error produced by Gateway, not an upstream provider response. */
export class GatewayLlmClientError extends Error {
  readonly code: LlmProxyErrorCode;
  readonly requestId?: RequestId;

  constructor(code: LlmProxyErrorCode, requestId?: RequestId) {
    super('gateway LLM request failed');
    this.name = 'GatewayLlmClientError';
    this.code = code;
    this.requestId = requestId;
  }
}

/** A fixed-message local transport/protocol failure. */
export class GatewayLlmClientBoundaryError extends Error {
  constructor() {
    super('gateway LLM transport boundary failed');
    this.name = 'GatewayLlmClientBoundaryError';
  }
}

type ActiveAuthority = Readonly<{ endpoint: string; authorization: string }>;
type BodyRead =
  { readonly ok: true; readonly body: Uint8Array } | { readonly ok: false };

function boundaryFailure(): never {
  throw new GatewayLlmClientBoundaryError();
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException('This operation was aborted', 'AbortError')
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

const intrinsicPromiseThen = Promise.prototype.then;
const intrinsicReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const intrinsicReaderReleaseLock =
  ReadableStreamDefaultReader.prototype.releaseLock;
const intrinsicStreamCancel = ReadableStream.prototype.cancel;
const intrinsicResponseBody = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'body',
)?.get;

function toNativePromise<T>(value: T | PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    try {
      if (
        value instanceof Promise &&
        Object.getOwnPropertyDescriptor(value, 'constructor') !== undefined
      ) {
        reject(new GatewayLlmClientBoundaryError());
        return;
      }
      void intrinsicPromiseThen.call(value, resolve, reject);
      return;
    } catch {}
    let normalized: Promise<T>;
    try {
      normalized = Promise.resolve(value);
    } catch (error) {
      reject(error);
      return;
    }
    try {
      void intrinsicPromiseThen.call(normalized, resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function observePromise(value: unknown): void {
  const normalized = toNativePromise(value);
  try {
    void intrinsicPromiseThen.call(normalized, undefined, () => undefined);
  } catch {}
}

function safeResponseBody(
  response: Response,
): ReadableStream<Uint8Array> | null {
  try {
    if (intrinsicResponseBody !== undefined)
      return intrinsicResponseBody.call(
        response,
      ) as ReadableStream<Uint8Array> | null;
  } catch {}
  try {
    const descriptor = Object.getOwnPropertyDescriptor(response, 'body');
    if (
      descriptor !== undefined &&
      'value' in descriptor &&
      (descriptor.value === null || descriptor.value instanceof ReadableStream)
    )
      return descriptor.value as ReadableStream<Uint8Array> | null;
  } catch {}
  return null;
}

function cancelBody(response: Response, signal?: AbortSignal): void {
  try {
    const body = safeResponseBody(response);
    if (body !== null) observePromise(intrinsicStreamCancel.call(body));
  } catch {
    // Cancellation is an observation/cleanup path and must not replace the failure.
  }
  throwIfAborted(signal);
}

function cancelReader(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel'>,
): void {
  try {
    observePromise(intrinsicReaderCancel.call(reader));
  } catch {}
}

function cancelReaderAndCheckAbort(
  reader: Pick<ReadableStreamDefaultReader<Uint8Array>, 'cancel'>,
  signal: AbortSignal | undefined,
): void {
  cancelReader(reader);
  throwIfAborted(signal);
}

function throwIfResponseAborted(
  response: Response,
  signal: AbortSignal | undefined,
): void {
  if (signal?.aborted) {
    cancelBody(response, signal);
    throw abortReason(signal);
  }
}

function exactContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return -1;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : -1;
}

function canonicalEndpoint(snapshot: GatewayResidentSnapshot): string {
  try {
    const phase = snapshot.phase;
    const endpoint = snapshot.endpoint;
    if ((phase !== 'active' && phase !== 'rotating') || endpoint === null)
      throw new GatewayResidentStateError('invalid_state');
    const parsed = new URL(endpoint);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      parsed.origin !== endpoint
    )
      throw new GatewayResidentStateError('corrupt_state');
    return endpoint;
  } catch (error) {
    if (error instanceof GatewayResidentStateError) throw error;
    throw new GatewayResidentStateError('corrupt_state');
  }
}

function activeAuthority(store: GatewayLlmResidentStore): ActiveAuthority {
  let snapshot: GatewayResidentSnapshot;
  try {
    snapshot = store.read();
  } catch (error) {
    if (error instanceof GatewayResidentStateError) throw error;
    throw new GatewayResidentStateError('corrupt_state');
  }
  const endpoint = canonicalEndpoint(snapshot);
  // This is intentionally a separate read on every HTTP call. The token is never
  // retained by the client, so a completed rotation affects the next call only.
  let authorization: string;
  try {
    authorization = formatNodeBearerAuthorization(store.activeNodeToken());
  } catch (error) {
    if (error instanceof GatewayResidentStateError) throw error;
    throw new GatewayResidentStateError('corrupt_state');
  }
  return Object.freeze({ endpoint, authorization });
}

async function fetchOnce(
  request: Promise<Response>,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (signal === undefined) {
    try {
      return await request;
    } catch {
      return boundaryFailure();
    }
  }
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => rejectAbort?.(abortReason(signal));
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) {
      request.then(cancelBody, () => undefined);
      throw abortReason(signal);
    }
    try {
      return await Promise.race([request, aborted]);
    } catch (error) {
      if (signal.aborted) {
        request.then(cancelBody, () => undefined);
        throw abortReason(signal);
      }
      void error;
      return boundaryFailure();
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function validateHttpResponse(
  response: Response,
  target: string,
  signal: AbortSignal | undefined,
): number {
  try {
    const status = response.status;
    const redirected = response.redirected;
    const type = response.type;
    if (
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599 ||
      typeof redirected !== 'boolean' ||
      redirected ||
      (type !== 'basic' && type !== 'cors' && type !== 'default') ||
      (response.url !== '' && response.url !== target) ||
      response.headers.get('content-encoding') !== null
    ) {
      cancelBody(response, signal);
      throwIfResponseAborted(response, signal);
      boundaryFailure();
    }
    throwIfResponseAborted(response, signal);
    return status;
  } catch (error) {
    throwIfResponseAborted(response, signal);
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    cancelBody(response, signal);
    boundaryFailure();
  }
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  signal: AbortSignal | undefined,
): Promise<BodyRead> {
  let announced: number | null;
  try {
    announced = exactContentLength(response.headers.get('content-length'));
  } catch {
    throwIfResponseAborted(response, signal);
    cancelBody(response, signal);
    return { ok: false };
  }
  if (announced === -1 || (announced !== null && announced > maximum)) {
    throwIfResponseAborted(response, signal);
    cancelBody(response, signal);
    return { ok: false };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const body = response.body;
    throwIfResponseAborted(response, signal);
    if (body === null) return { ok: false };
    reader = body.getReader();
    throwIfResponseAborted(response, signal);
  } catch {
    throwIfResponseAborted(response, signal);
    cancelBody(response, signal);
    return { ok: false };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  let framingMismatch = false;
  let rejectAbort: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = (): void => {
    cancelReader(reader);
    if (signal !== undefined) rejectAbort?.(abortReason(signal));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) {
      cancelReader(reader);
      throw abortReason(signal);
    }
    for (;;) {
      if (signal?.aborted) throw abortReason(signal);
      let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>>;
      try {
        pendingRead = toNativePromise(reader.read());
      } catch {
        cancelReaderAndCheckAbort(reader, signal);
        return { ok: false };
      }
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await (signal === undefined
          ? pendingRead
          : Promise.race([pendingRead, aborted]));
      } catch {
        if (signal?.aborted) throw abortReason(signal);
        cancelReaderAndCheckAbort(reader, signal);
        return { ok: false };
      }
      if (signal?.aborted) throw abortReason(signal);
      try {
        const done = item.done;
        if (signal?.aborted) throw abortReason(signal);
        if (done !== true && done !== false) {
          cancelReaderAndCheckAbort(reader, signal);
          return { ok: false };
        }
        if (done) break;
        const chunk = item.value;
        if (signal?.aborted) throw abortReason(signal);
        if (!(chunk instanceof Uint8Array)) {
          cancelReaderAndCheckAbort(reader, signal);
          return { ok: false };
        }
        const byteLength = chunk.byteLength;
        if (signal?.aborted) throw abortReason(signal);
        if (!Number.isSafeInteger(byteLength) || byteLength > maximum - size) {
          cancelReaderAndCheckAbort(reader, signal);
          return { ok: false };
        }
        const copy = Uint8Array.from(chunk);
        if (signal?.aborted) throw abortReason(signal);
        if (copy.byteLength !== byteLength) {
          cancelReaderAndCheckAbort(reader, signal);
          return { ok: false };
        }
        size += byteLength;
        chunks.push(copy);
      } catch {
        if (signal?.aborted) throw abortReason(signal);
        cancelReaderAndCheckAbort(reader, signal);
        return { ok: false };
      }
    }
    if (signal?.aborted) throw abortReason(signal);
    if (announced !== null && announced !== size) {
      framingMismatch = true;
      cancelReaderAndCheckAbort(reader, signal);
    }
  } finally {
    try {
      intrinsicReaderReleaseLock.call(reader);
    } catch {}
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) {
    cancelReader(reader);
    throw abortReason(signal);
  }
  if (framingMismatch) return { ok: false };
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

function requireGatewayErrorHttpShape(
  response: Response,
  status: number,
  signal: AbortSignal | undefined,
): void {
  try {
    if (
      status < 400 ||
      response.headers.get('content-type') !== 'application/json; charset=utf-8'
    ) {
      cancelBody(response, signal);
      throwIfResponseAborted(response, signal);
      boundaryFailure();
    }
    throwIfResponseAborted(response, signal);
  } catch (error) {
    throwIfResponseAborted(response, signal);
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    cancelBody(response, signal);
    boundaryFailure();
  }
}

async function gatewayError(
  response: Response,
  status: number,
  signal: AbortSignal | undefined,
  expectedRequestId?: RequestId,
): Promise<never> {
  requireGatewayErrorHttpShape(response, status, signal);
  const result = await readBoundedBody(
    response,
    LLM_PROXY_LIMITS.errorBodyBytes,
    signal,
  );
  if (!result.ok) {
    throwIfResponseAborted(response, signal);
    boundaryFailure();
  }
  try {
    const decoded = decodeLlmProxyError(result.body);
    if (
      (expectedRequestId === undefined && decoded.requestId !== undefined) ||
      (expectedRequestId !== undefined &&
        decoded.requestId !== undefined &&
        decoded.requestId !== expectedRequestId)
    )
      boundaryFailure();
    throw new GatewayLlmClientError(decoded.code, decoded.requestId);
  } catch (error) {
    if (error instanceof GatewayLlmClientError) throw error;
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function requestId(bytes: (size: number) => Uint8Array): RequestId {
  try {
    const generated = bytes(16);
    if (!(generated instanceof Uint8Array) || generated.byteLength !== 16)
      boundaryFailure();
    const value = 'egr1.' + Buffer.from(generated).toString('base64url');
    if (!isRequestId(value)) boundaryFailure();
    return value;
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function normalizedModel(value: LlmProxyCatalogModel): LlmProxyCatalogModel {
  try {
    const catalog = decodeLlmProxyCatalog(
      serializeLlmProxyCatalog({
        format: LLM_PROXY_FORMATS.catalog,
        revision: 0,
        models: [value],
      }),
    );
    return catalog.models[0];
  } catch {
    boundaryFailure();
  }
}

function exactDispatch(
  value: GatewayLlmDispatchInput,
): GatewayLlmDispatchInput {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      boundaryFailure();
    const keys = Reflect.ownKeys(value).sort();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== 4 ||
      keys[0] !== 'model' ||
      keys[1] !== 'payload' ||
      keys[2] !== 'route' ||
      keys[3] !== 'transport'
    )
      boundaryFailure();
    const model = descriptors.model;
    const payload = descriptors.payload;
    const route = descriptors.route;
    const transport = descriptors.transport;
    if (
      model === undefined ||
      !('value' in model) ||
      payload === undefined ||
      !('value' in payload) ||
      route === undefined ||
      !('value' in route) ||
      transport === undefined ||
      !('value' in transport) ||
      !(payload.value instanceof Uint8Array)
    )
      boundaryFailure();
    return Object.freeze({
      model: model.value as LlmProxyCatalogModel,
      payload: Uint8Array.from(payload.value),
      route: route.value as LlmProxyRoute,
      transport: transport.value as LlmProxyTransportMetadata,
    });
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

/** Authenticated, no-retry HTTP boundary for Gateway-owned LLM transport. */
export class GatewayLlmClient {
  readonly #store: GatewayLlmResidentStore;
  readonly #fetch: GatewayLlmFetch;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(options: GatewayLlmClientOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('gateway LLM client options are required');
    if (
      typeof options.fetch !== 'undefined' &&
      typeof options.fetch !== 'function'
    )
      throw new TypeError('gateway LLM fetch must be a function');
    if (
      typeof options.randomBytes !== 'undefined' &&
      typeof options.randomBytes !== 'function'
    )
      throw new TypeError('gateway LLM random bytes must be a function');
    this.#store = options.store;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#randomBytes = options.randomBytes ?? systemRandomBytes;
  }

  async fetchCatalog(signal?: AbortSignal): Promise<LlmProxyCatalog> {
    const authority = activeAuthority(this.#store);
    throwIfAborted(signal);
    const target = authority.endpoint + LLM_PROXY_PATHS.catalog;
    let pending: Promise<Response>;
    try {
      pending = toNativePromise(
        this.#fetch(target, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            authorization: authority.authorization,
          },
          redirect: 'error',
          signal,
        }),
      );
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      boundaryFailure();
    }
    const response = await fetchOnce(pending, signal);
    if (signal?.aborted) {
      cancelBody(response, signal);
      throw abortReason(signal);
    }
    const status = validateHttpResponse(response, target, signal);
    if (signal?.aborted) {
      cancelBody(response, signal);
      throw abortReason(signal);
    }
    if (status !== 200) return gatewayError(response, status, signal);
    try {
      if (
        response.headers.get(LLM_PROXY_HEADERS.provenance) !== null ||
        response.headers.get('content-type') !==
          'application/json; charset=utf-8'
      ) {
        cancelBody(response, signal);
        boundaryFailure();
      }
    } catch (error) {
      throwIfResponseAborted(response, signal);
      if (error instanceof GatewayLlmClientBoundaryError) throw error;
      cancelBody(response, signal);
      boundaryFailure();
    }
    const result = await readBoundedBody(
      response,
      LLM_PROXY_LIMITS.catalogBodyBytes,
      signal,
    );
    if (!result.ok) {
      throwIfResponseAborted(response, signal);
      boundaryFailure();
    }
    try {
      return decodeLlmProxyCatalog(result.body);
    } catch {
      boundaryFailure();
    }
  }

  async dispatch(
    input: GatewayLlmDispatchInput,
    signal?: AbortSignal,
  ): Promise<Response> {
    const authority = activeAuthority(this.#store);
    throwIfAborted(signal);
    const exact = exactDispatch(input);
    const model = normalizedModel(exact.model);
    if (!model.allowedRoutes.includes(exact.route)) boundaryFailure();
    const payload = exact.payload;
    const rid = requestId(this.#randomBytes);
    let body: string;
    try {
      const sha256 = createHash('sha256').update(payload).digest('hex');
      body = serializeLlmProxyRequest({
        format: LLM_PROXY_FORMATS.request,
        requestId: rid,
        modelRef: model.modelRef,
        targetGeneration: model.targetGeneration,
        route: exact.route,
        transport: exact.transport,
        byteLength: payload.byteLength,
        sha256,
        payload,
      });
    } catch (error) {
      if (error instanceof GatewayLlmClientBoundaryError) throw error;
      boundaryFailure();
    }

    const target = authority.endpoint + LLM_PROXY_PATHS.request;
    let pending: Promise<Response>;
    try {
      pending = toNativePromise(
        this.#fetch(target, {
          method: 'POST',
          headers: {
            accept: 'application/octet-stream, application/json',
            'accept-encoding': 'identity',
            authorization: authority.authorization,
            'content-type': 'application/json',
          },
          body,
          redirect: 'error',
          signal,
        }),
      );
    } catch {
      if (signal?.aborted) throw abortReason(signal);
      boundaryFailure();
    }
    const response = await fetchOnce(pending, signal);
    if (signal?.aborted) {
      cancelBody(response, signal);
      throw abortReason(signal);
    }
    const status = validateHttpResponse(response, target, signal);
    if (signal?.aborted) {
      cancelBody(response, signal);
      throw abortReason(signal);
    }

    let encodedProvenance: string | null;
    try {
      encodedProvenance = response.headers.get(LLM_PROXY_HEADERS.provenance);
    } catch {
      throwIfResponseAborted(response, signal);
      cancelBody(response, signal);
      boundaryFailure();
    }
    if (signal?.aborted) {
      cancelBody(response, signal);
      throw abortReason(signal);
    }
    if (encodedProvenance === null)
      return gatewayError(response, status, signal, rid);

    let provenance: ReturnType<typeof decodeLlmResponseProvenance>;
    try {
      provenance = decodeLlmResponseProvenance(encodedProvenance);
    } catch {
      cancelBody(response, signal);
      boundaryFailure();
    }
    if (
      provenance.requestId !== rid ||
      provenance.modelRef !== model.modelRef ||
      provenance.targetGeneration !== model.targetGeneration ||
      provenance.route !== exact.route ||
      provenance.status !== status
    ) {
      cancelBody(response, signal);
      boundaryFailure();
    }

    try {
      const headers = new Headers();
      for (const header of provenance.headers)
        headers.append(header.name, header.value);
      const body = response.body;
      if (signal?.aborted) {
        cancelBody(response, signal);
        throw abortReason(signal);
      }
      return new Response(body, {
        status: provenance.status,
        headers,
      });
    } catch {
      if (signal?.aborted) {
        cancelBody(response, signal);
        throw abortReason(signal);
      }
      cancelBody(response, signal);
      boundaryFailure();
    }
  }
}

export function createGatewayLlmClient(
  options: GatewayLlmClientOptions,
): GatewayLlmClient {
  return new GatewayLlmClient(options);
}
