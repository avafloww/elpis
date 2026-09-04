import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
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
const validatedHttpResponseBrand: unique symbol = Symbol();
type ValidatedHttpResponse = Readonly<{
  [validatedHttpResponseBrand]: true;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}>;

function boundaryFailure(): never {
  throw new GatewayLlmClientBoundaryError();
}

const intrinsicAbortSignalAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted',
)?.get;
const intrinsicAbortSignalReason = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'reason',
)?.get;
const intrinsicEventTargetAddEventListener =
  EventTarget.prototype.addEventListener;
const intrinsicEventTargetRemoveEventListener =
  EventTarget.prototype.removeEventListener;
const intrinsicPromiseConstructor = Promise;
const intrinsicPromisePrototype = Promise.prototype;
const intrinsicHeadersGet = Headers.prototype.get;
const intrinsicReaderCancel = ReadableStreamDefaultReader.prototype.cancel;
const intrinsicReaderRead = ReadableStreamDefaultReader.prototype.read;
const intrinsicReaderReleaseLock =
  ReadableStreamDefaultReader.prototype.releaseLock;
const intrinsicStreamCancel = ReadableStream.prototype.cancel;
const intrinsicStreamGetReader = ReadableStream.prototype.getReader;
const intrinsicResponseBody = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'body',
)?.get;
const intrinsicResponseHeaders = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'headers',
)?.get;
const intrinsicResponseRedirected = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'redirected',
)?.get;
const intrinsicResponseStatus = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'status',
)?.get;
const intrinsicResponseType = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'type',
)?.get;
const intrinsicResponseUrl = Object.getOwnPropertyDescriptor(
  Response.prototype,
  'url',
)?.get;
const typedArrayPrototype = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;
const intrinsicTypedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer',
)?.get;
const intrinsicTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength',
)?.get;
const intrinsicTypedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset',
)?.get;
const intrinsicTypedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)?.get;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;

function signalAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  if (signal === undefined) return false;
  try {
    if (intrinsicAbortSignalAborted === undefined) boundaryFailure();
    const aborted = intrinsicAbortSignalAborted.call(signal) as boolean;
    if (typeof aborted !== 'boolean') boundaryFailure();
    return aborted;
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function abortReason(signal: AbortSignal): unknown {
  try {
    if (intrinsicAbortSignalReason === undefined) boundaryFailure();
    return intrinsicAbortSignalReason.call(signal);
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    intrinsicEventTargetAddEventListener.call(signal, 'abort', listener, {
      once: true,
    });
  } catch {
    boundaryFailure();
  }
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    intrinsicEventTargetRemoveEventListener.call(signal, 'abort', listener);
  } catch {}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signalAborted(signal)) throw abortReason(signal);
}

async function toNativePromise<T>(value: unknown): Promise<T> {
  try {
    if (
      !nodeTypes.isPromise(value) ||
      Object.getPrototypeOf(value) !== intrinsicPromisePrototype
    )
      boundaryFailure();
    const ownConstructor = Object.getOwnPropertyDescriptor(
      value,
      'constructor',
    );
    if (ownConstructor === undefined) {
      const inheritedConstructor = Object.getOwnPropertyDescriptor(
        intrinsicPromisePrototype,
        'constructor',
      );
      if (
        inheritedConstructor === undefined ||
        !('value' in inheritedConstructor) ||
        inheritedConstructor.value !== intrinsicPromiseConstructor
      )
        boundaryFailure();
    } else if (
      !('value' in ownConstructor) ||
      ownConstructor.value !== intrinsicPromiseConstructor
    ) {
      boundaryFailure();
    }
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
  return await (value as Promise<T>);
}

async function consumePromise(value: unknown): Promise<void> {
  try {
    await toNativePromise(value);
  } catch {}
}

function observePromise(value: unknown): void {
  void consumePromise(value);
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

function cancelHttpResponse(
  response: ValidatedHttpResponse,
  signal?: AbortSignal,
): void {
  try {
    if (response.body !== null)
      observePromise(intrinsicStreamCancel.call(response.body));
  } catch {}
  throwIfAborted(signal);
}

function throwIfHttpResponseAborted(
  response: ValidatedHttpResponse,
  signal: AbortSignal | undefined,
): void {
  if (signalAborted(signal)) cancelHttpResponse(response, signal);
}

function header(response: ValidatedHttpResponse, name: string): string | null {
  return intrinsicHeadersGet.call(response.headers, name);
}

function copyUint8Array(value: unknown): Uint8Array {
  try {
    if (
      intrinsicTypedArrayBuffer === undefined ||
      intrinsicTypedArrayByteLength === undefined ||
      intrinsicTypedArrayByteOffset === undefined ||
      intrinsicTypedArrayTag === undefined ||
      intrinsicTypedArrayTag.call(value) !== 'Uint8Array'
    )
      boundaryFailure();
    const buffer = intrinsicTypedArrayBuffer.call(value) as ArrayBufferLike;
    const byteLength = intrinsicTypedArrayByteLength.call(value) as number;
    const byteOffset = intrinsicTypedArrayByteOffset.call(value) as number;
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0
    )
      boundaryFailure();
    const source = new Uint8Array(buffer, byteOffset, byteLength);
    const copy = new Uint8Array(byteLength);
    intrinsicUint8ArraySet.call(copy, source);
    return copy;
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
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
  if (signalAborted(signal)) {
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

async function cancelLateResponse(request: Promise<Response>): Promise<void> {
  try {
    cancelBody(await request);
  } catch {}
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
  addAbortListener(signal, onAbort);
  try {
    if (signalAborted(signal)) {
      void cancelLateResponse(request);
      throw abortReason(signal);
    }
    try {
      return await Promise.race([request, aborted]);
    } catch (error) {
      if (signalAborted(signal)) {
        void cancelLateResponse(request);
        throw abortReason(signal);
      }
      void error;
      return boundaryFailure();
    }
  } finally {
    removeAbortListener(signal, onAbort);
  }
}

function validateHttpResponse(
  response: Response,
  target: string,
  signal: AbortSignal | undefined,
): ValidatedHttpResponse {
  try {
    if (
      intrinsicResponseBody === undefined ||
      intrinsicResponseHeaders === undefined ||
      intrinsicResponseRedirected === undefined ||
      intrinsicResponseStatus === undefined ||
      intrinsicResponseType === undefined ||
      intrinsicResponseUrl === undefined
    )
      boundaryFailure();
    const status = intrinsicResponseStatus.call(response) as number;
    const redirected = intrinsicResponseRedirected.call(response) as boolean;
    const type = intrinsicResponseType.call(response) as ResponseType;
    const url = intrinsicResponseUrl.call(response) as string;
    const headers = intrinsicResponseHeaders.call(response) as Headers;
    const body = intrinsicResponseBody.call(
      response,
    ) as ReadableStream<Uint8Array> | null;
    const validated = Object.freeze({
      [validatedHttpResponseBrand]: true as const,
      status,
      headers,
      body,
    });
    if (
      !Number.isInteger(status) ||
      status < 200 ||
      status > 599 ||
      typeof redirected !== 'boolean' ||
      redirected ||
      (type !== 'basic' && type !== 'cors' && type !== 'default') ||
      (url !== '' && url !== target) ||
      header(validated, 'content-encoding') !== null
    ) {
      cancelHttpResponse(validated, signal);
      boundaryFailure();
    }
    throwIfHttpResponseAborted(validated, signal);
    return validated;
  } catch (error) {
    throwIfResponseAborted(response, signal);
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    cancelBody(response, signal);
    boundaryFailure();
  }
}

async function readBoundedBody(
  response: ValidatedHttpResponse,
  maximum: number,
  signal: AbortSignal | undefined,
): Promise<BodyRead> {
  let announced: number | null;
  try {
    announced = exactContentLength(header(response, 'content-length'));
  } catch {
    throwIfHttpResponseAborted(response, signal);
    cancelHttpResponse(response, signal);
    return { ok: false };
  }
  if (announced === -1 || (announced !== null && announced > maximum)) {
    throwIfHttpResponseAborted(response, signal);
    cancelHttpResponse(response, signal);
    return { ok: false };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const body = response.body;
    throwIfHttpResponseAborted(response, signal);
    if (body === null) return { ok: false };
    reader = intrinsicStreamGetReader.call(
      body,
    ) as ReadableStreamDefaultReader<Uint8Array>;
    throwIfHttpResponseAborted(response, signal);
  } catch {
    throwIfHttpResponseAborted(response, signal);
    cancelHttpResponse(response, signal);
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
  if (signal !== undefined) addAbortListener(signal, onAbort);
  try {
    if (signalAborted(signal)) {
      cancelReader(reader);
      throw abortReason(signal);
    }
    for (;;) {
      if (signalAborted(signal)) throw abortReason(signal);
      let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>>;
      try {
        pendingRead = toNativePromise(intrinsicReaderRead.call(reader));
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
        if (signalAborted(signal)) throw abortReason(signal);
        cancelReaderAndCheckAbort(reader, signal);
        return { ok: false };
      }
      if (signalAborted(signal)) throw abortReason(signal);
      try {
        const done = item.done;
        if (signalAborted(signal)) throw abortReason(signal);
        if (done !== true && done !== false) {
          cancelReaderAndCheckAbort(reader, signal);
          return { ok: false };
        }
        if (done) break;
        const chunk = item.value;
        if (signalAborted(signal)) throw abortReason(signal);
        const copy = copyUint8Array(chunk);
        if (signalAborted(signal)) throw abortReason(signal);
        const byteLength = copy.byteLength;
        if (byteLength > maximum - size) {
          cancelReaderAndCheckAbort(reader, signal);
          return { ok: false };
        }
        size += byteLength;
        chunks.push(copy);
      } catch {
        if (signalAborted(signal)) throw abortReason(signal);
        cancelReaderAndCheckAbort(reader, signal);
        return { ok: false };
      }
    }
    if (signalAborted(signal)) throw abortReason(signal);
    if (announced !== null && announced !== size) {
      framingMismatch = true;
      cancelReaderAndCheckAbort(reader, signal);
    }
  } finally {
    try {
      intrinsicReaderReleaseLock.call(reader);
    } catch {}
    if (signal !== undefined) removeAbortListener(signal, onAbort);
  }
  if (signalAborted(signal)) {
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
  response: ValidatedHttpResponse,
  status: number,
  signal: AbortSignal | undefined,
): void {
  try {
    if (
      status < 400 ||
      header(response, 'content-type') !== 'application/json; charset=utf-8'
    ) {
      cancelHttpResponse(response, signal);
      throwIfHttpResponseAborted(response, signal);
      boundaryFailure();
    }
    throwIfHttpResponseAborted(response, signal);
  } catch (error) {
    throwIfHttpResponseAborted(response, signal);
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    cancelHttpResponse(response, signal);
    boundaryFailure();
  }
}

async function gatewayError(
  response: ValidatedHttpResponse,
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
    throwIfHttpResponseAborted(response, signal);
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
      !('value' in transport)
    )
      boundaryFailure();
    return Object.freeze({
      model: model.value as LlmProxyCatalogModel,
      payload: copyUint8Array(payload.value),
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
      if (signalAborted(signal)) throw abortReason(signal);
      boundaryFailure();
    }
    const fetched = await fetchOnce(pending, signal);
    if (signalAborted(signal)) {
      cancelBody(fetched, signal);
      throw abortReason(signal);
    }
    const response = validateHttpResponse(fetched, target, signal);
    throwIfHttpResponseAborted(response, signal);
    if (response.status !== 200)
      return gatewayError(response, response.status, signal);
    try {
      if (
        header(response, LLM_PROXY_HEADERS.provenance) !== null ||
        header(response, 'content-type') !== 'application/json; charset=utf-8'
      ) {
        cancelHttpResponse(response, signal);
        boundaryFailure();
      }
    } catch (error) {
      throwIfHttpResponseAborted(response, signal);
      if (error instanceof GatewayLlmClientBoundaryError) throw error;
      cancelHttpResponse(response, signal);
      boundaryFailure();
    }
    const result = await readBoundedBody(
      response,
      LLM_PROXY_LIMITS.catalogBodyBytes,
      signal,
    );
    if (!result.ok) {
      throwIfHttpResponseAborted(response, signal);
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
      if (signalAborted(signal)) throw abortReason(signal);
      boundaryFailure();
    }
    const fetched = await fetchOnce(pending, signal);
    if (signalAborted(signal)) {
      cancelBody(fetched, signal);
      throw abortReason(signal);
    }
    const response = validateHttpResponse(fetched, target, signal);
    throwIfHttpResponseAborted(response, signal);

    let encodedProvenance: string | null;
    try {
      encodedProvenance = header(response, LLM_PROXY_HEADERS.provenance);
    } catch {
      throwIfHttpResponseAborted(response, signal);
      cancelHttpResponse(response, signal);
      boundaryFailure();
    }
    if (signalAborted(signal)) {
      cancelHttpResponse(response, signal);
      throw abortReason(signal);
    }
    if (encodedProvenance === null)
      return gatewayError(response, response.status, signal, rid);

    let provenance: ReturnType<typeof decodeLlmResponseProvenance>;
    try {
      provenance = decodeLlmResponseProvenance(encodedProvenance);
    } catch {
      cancelHttpResponse(response, signal);
      boundaryFailure();
    }
    if (
      provenance.requestId !== rid ||
      provenance.modelRef !== model.modelRef ||
      provenance.targetGeneration !== model.targetGeneration ||
      provenance.route !== exact.route ||
      provenance.status !== response.status
    ) {
      cancelHttpResponse(response, signal);
      boundaryFailure();
    }

    try {
      const headers = new Headers();
      for (const header of provenance.headers)
        headers.append(header.name, header.value);
      const body = response.body;
      if (signalAborted(signal)) {
        cancelHttpResponse(response, signal);
        throw abortReason(signal);
      }
      return new Response(body, {
        status: provenance.status,
        headers,
      });
    } catch {
      if (signalAborted(signal)) {
        cancelHttpResponse(response, signal);
        throw abortReason(signal);
      }
      cancelHttpResponse(response, signal);
      boundaryFailure();
    }
  }
}

export function createGatewayLlmClient(
  options: GatewayLlmClientOptions,
): GatewayLlmClient {
  return new GatewayLlmClient(options);
}
