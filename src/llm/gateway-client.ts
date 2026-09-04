import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_HEADERS,
  LLM_PROXY_LIMITS,
  LLM_PROXY_PATHS,
  decodeLlmProxyCatalog,
  decodeLlmProxyError,
  decodeLlmProxyRequest,
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
const intrinsicArrayIncludes = Array.prototype.includes;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicArrayPrototype = Array.prototype;
const intrinsicArrayPush = Array.prototype.push;
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectGetOwnPropertyDescriptors =
  Object.getOwnPropertyDescriptors;
const intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicIsPromise = nodeTypes.isPromise;
const intrinsicIsProxy = nodeTypes.isProxy;
const hashPrototype = Object.getPrototypeOf(createHash('sha256')) as {
  update: (...args: unknown[]) => unknown;
  digest: (...args: unknown[]) => unknown;
};
const intrinsicHashUpdate = hashPrototype.update;
const intrinsicHashDigest = hashPrototype.digest;
const intrinsicPromiseConstructor = Promise;
const intrinsicPromisePrototype = Promise.prototype;
const intrinsicHeadersAppend = Headers.prototype.append;
const intrinsicHeadersConstructor = Headers;
const intrinsicHeadersGet = Headers.prototype.get;
const intrinsicResponseConstructor = Response;
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
const intrinsicUint8ArrayConstructor = Uint8Array;
const intrinsicUint8ArraySet = Uint8Array.prototype.set;

function signalAborted(signal: AbortSignal | undefined): signal is AbortSignal {
  if (signal === undefined) return false;
  try {
    if (intrinsicAbortSignalAborted === undefined) boundaryFailure();
    const aborted = intrinsicReflectApply(
      intrinsicAbortSignalAborted,
      signal,
      [],
    ) as boolean;
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
    return intrinsicReflectApply(intrinsicAbortSignalReason, signal, []);
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    intrinsicReflectApply(intrinsicEventTargetAddEventListener, signal, [
      'abort',
      listener,
      { once: true },
    ]);
  } catch {
    boundaryFailure();
  }
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    intrinsicReflectApply(intrinsicEventTargetRemoveEventListener, signal, [
      'abort',
      listener,
    ]);
  } catch {}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signalAborted(signal)) throw abortReason(signal);
}

async function toNativePromise<T>(value: unknown): Promise<T> {
  try {
    if (
      !intrinsicIsPromise(value) ||
      intrinsicObjectGetPrototypeOf(value) !== intrinsicPromisePrototype
    )
      boundaryFailure();
    const ownConstructor = intrinsicObjectGetOwnPropertyDescriptor(
      value,
      'constructor',
    );
    if (ownConstructor === undefined) {
      const inheritedConstructor = intrinsicObjectGetOwnPropertyDescriptor(
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

async function settlePromise<T>(
  pending: Promise<T>,
  resolve: (value: T) => void,
  reject: (reason: unknown) => void,
): Promise<void> {
  try {
    resolve(await pending);
  } catch (error) {
    reject(error);
  }
}

async function waitForPromiseOrAbort<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void,
): Promise<T> {
  if (signal === undefined) return await pending;
  let resolveOutcome!: (value: T) => void;
  let rejectOutcome!: (reason: unknown) => void;
  const outcome = new intrinsicPromiseConstructor<T>((resolve, reject) => {
    resolveOutcome = resolve;
    rejectOutcome = reject;
  });
  const handleAbort = (): void => {
    try {
      onAbort?.();
    } catch {}
    rejectOutcome(abortReason(signal));
  };
  addAbortListener(signal, handleAbort);
  try {
    if (signalAborted(signal)) {
      try {
        onAbort?.();
      } catch {}
      throw abortReason(signal);
    }
    void settlePromise(pending, resolveOutcome, rejectOutcome);
    return await outcome;
  } finally {
    removeAbortListener(signal, handleAbort);
  }
}

function safeResponseBody(
  response: Response,
): ReadableStream<Uint8Array> | null {
  try {
    if (intrinsicResponseBody !== undefined)
      return intrinsicReflectApply(
        intrinsicResponseBody,
        response,
        [],
      ) as ReadableStream<Uint8Array> | null;
  } catch {}
  try {
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(
      response,
      'body',
    );
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
    if (body !== null)
      observePromise(intrinsicReflectApply(intrinsicStreamCancel, body, []));
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
      observePromise(
        intrinsicReflectApply(intrinsicStreamCancel, response.body, []),
      );
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
  return intrinsicReflectApply(intrinsicHeadersGet, response.headers, [
    name,
  ]) as string | null;
}

function uint8ArrayByteLength(value: Uint8Array): number {
  try {
    if (intrinsicTypedArrayByteLength === undefined) boundaryFailure();
    const byteLength = intrinsicReflectApply(
      intrinsicTypedArrayByteLength,
      value,
      [],
    ) as number;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) boundaryFailure();
    return byteLength;
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function copyUint8Array(value: unknown): Uint8Array {
  try {
    if (
      intrinsicTypedArrayBuffer === undefined ||
      intrinsicTypedArrayByteLength === undefined ||
      intrinsicTypedArrayByteOffset === undefined ||
      intrinsicTypedArrayTag === undefined ||
      intrinsicReflectApply(intrinsicTypedArrayTag, value, []) !== 'Uint8Array'
    )
      boundaryFailure();
    const buffer = intrinsicReflectApply(
      intrinsicTypedArrayBuffer,
      value,
      [],
    ) as ArrayBufferLike;
    const byteLength = intrinsicReflectApply(
      intrinsicTypedArrayByteLength,
      value,
      [],
    ) as number;
    const byteOffset = intrinsicReflectApply(
      intrinsicTypedArrayByteOffset,
      value,
      [],
    ) as number;
    if (
      !Number.isSafeInteger(byteLength) ||
      byteLength < 0 ||
      !Number.isSafeInteger(byteOffset) ||
      byteOffset < 0
    )
      boundaryFailure();
    const source = new intrinsicUint8ArrayConstructor(
      buffer,
      byteOffset,
      byteLength,
    );
    const copy = new intrinsicUint8ArrayConstructor(byteLength);
    intrinsicReflectApply(intrinsicUint8ArraySet, copy, [source]);
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
    observePromise(intrinsicReflectApply(intrinsicReaderCancel, reader, []));
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
  try {
    return await waitForPromiseOrAbort(request, signal);
  } catch (error) {
    if (signalAborted(signal)) {
      void cancelLateResponse(request);
      throw abortReason(signal);
    }
    void error;
    return boundaryFailure();
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
    const status = intrinsicReflectApply(
      intrinsicResponseStatus,
      response,
      [],
    ) as number;
    const redirected = intrinsicReflectApply(
      intrinsicResponseRedirected,
      response,
      [],
    ) as boolean;
    const type = intrinsicReflectApply(
      intrinsicResponseType,
      response,
      [],
    ) as ResponseType;
    const url = intrinsicReflectApply(
      intrinsicResponseUrl,
      response,
      [],
    ) as string;
    const headers = intrinsicReflectApply(
      intrinsicResponseHeaders,
      response,
      [],
    ) as Headers;
    const body = intrinsicReflectApply(
      intrinsicResponseBody,
      response,
      [],
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
    reader = intrinsicReflectApply(
      intrinsicStreamGetReader,
      body,
      [],
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
  const onAbort = (): void => cancelReader(reader);
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
        pendingRead = toNativePromise(
          intrinsicReflectApply(intrinsicReaderRead, reader, []),
        );
      } catch {
        cancelReaderAndCheckAbort(reader, signal);
        return { ok: false };
      }
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await waitForPromiseOrAbort(pendingRead, signal);
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
        const byteLength = uint8ArrayByteLength(copy);
        if (byteLength > maximum - size) {
          cancelReaderAndCheckAbort(reader, signal);
          return { ok: false };
        }
        size += byteLength;
        intrinsicReflectApply(intrinsicArrayPush, chunks, [copy]);
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
      intrinsicReflectApply(intrinsicReaderReleaseLock, reader, []);
    } catch {}
    if (signal !== undefined) removeAbortListener(signal, onAbort);
  }
  if (signalAborted(signal)) {
    cancelReader(reader);
    throw abortReason(signal);
  }
  if (framingMismatch) return { ok: false };
  try {
    const body = new intrinsicUint8ArrayConstructor(size);
    let offset = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const byteLength = uint8ArrayByteLength(chunk);
      intrinsicReflectApply(intrinsicUint8ArraySet, body, [chunk, offset]);
      if (signalAborted(signal)) throw abortReason(signal);
      offset += byteLength;
    }
    if (offset !== size) boundaryFailure();
    throwIfAborted(signal);
    return { ok: true, body };
  } catch (error) {
    if (signalAborted(signal)) throw abortReason(signal);
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
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

function sameTransport(
  left: LlmProxyTransportMetadata,
  right: LlmProxyTransportMetadata,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'none') return true;
  return right.kind === 'codex' && left.sessionId === right.sessionId;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  const byteLength = uint8ArrayByteLength(left);
  if (byteLength !== uint8ArrayByteLength(right)) return false;
  for (let index = 0; index < byteLength; index += 1)
    if (left[index] !== right[index]) return false;
  return true;
}

function payloadSha256(payload: Uint8Array): string {
  try {
    const hash = createHash('sha256');
    intrinsicReflectApply(intrinsicHashUpdate, hash, [payload]);
    return intrinsicReflectApply(intrinsicHashDigest, hash, ['hex']) as string;
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function requestId(
  bytes: (size: number) => Uint8Array,
  signal: AbortSignal | undefined,
): RequestId {
  try {
    const generated = bytes(16);
    throwIfAborted(signal);
    if (!(generated instanceof Uint8Array) || generated.byteLength !== 16)
      boundaryFailure();
    const value = 'egr1.' + Buffer.from(generated).toString('base64url');
    if (!isRequestId(value)) boundaryFailure();
    return value;
  } catch (error) {
    if (signalAborted(signal)) throw abortReason(signal);
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

const dispatchKeys = ['model', 'payload', 'route', 'transport'] as const;
const modelKeys = [
  'modelRef',
  'targetGeneration',
  'providerType',
  'model',
  'allowedRoutes',
  'contextSize',
  'reasoningEffort',
  'reasoningSummary',
  'reasoningContext',
  'toolTier',
  'externalThinking',
  'toolContractVersion',
  'callTimeoutMs',
  'streamIdleTimeoutMs',
] as const;
const transportNoneKeys = ['kind'] as const;
const transportCodexKeys = ['kind', 'sessionId'] as const;

function ownDataDescriptors(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, PropertyDescriptor> {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      intrinsicIsProxy(value) ||
      intrinsicObjectGetPrototypeOf(value) !== intrinsicObjectPrototype
    )
      boundaryFailure();
    const keys = intrinsicReflectOwnKeys(value);
    if (keys.length !== expectedKeys.length) boundaryFailure();
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') boundaryFailure();
      let expected = false;
      for (let candidate = 0; candidate < expectedKeys.length; candidate += 1)
        if (key === expectedKeys[candidate]) expected = true;
      if (!expected) boundaryFailure();
    }
    const descriptors = intrinsicObjectGetOwnPropertyDescriptors(value);
    for (let index = 0; index < expectedKeys.length; index += 1) {
      const descriptor = descriptors[expectedKeys[index]];
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      )
        boundaryFailure();
    }
    return descriptors;
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function snapshotRoutes(value: unknown): readonly LlmProxyRoute[] {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      !intrinsicArrayIsArray(value) ||
      intrinsicIsProxy(value) ||
      intrinsicObjectGetPrototypeOf(value) !== intrinsicArrayPrototype
    )
      boundaryFailure();
    const descriptors = intrinsicObjectGetOwnPropertyDescriptors(
      value,
    ) as unknown as Record<PropertyKey, PropertyDescriptor>;
    const lengthDescriptor = descriptors['length'];
    const lengthValue =
      lengthDescriptor !== undefined && 'value' in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (
      typeof lengthValue !== 'number' ||
      !Number.isSafeInteger(lengthValue) ||
      lengthValue < 0
    )
      boundaryFailure();
    const length = lengthValue;
    const keys = intrinsicReflectOwnKeys(value);
    if (keys.length !== length + 1) boundaryFailure();
    const routes: LlmProxyRoute[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      )
        boundaryFailure();
      intrinsicReflectApply(intrinsicArrayPush, routes, [
        descriptor.value as LlmProxyRoute,
      ]);
    }
    return intrinsicObjectFreeze(routes);
  } catch (error) {
    if (error instanceof GatewayLlmClientBoundaryError) throw error;
    boundaryFailure();
  }
}

function snapshotModel(value: unknown): LlmProxyCatalogModel {
  const descriptors = ownDataDescriptors(value, modelKeys);
  return intrinsicObjectFreeze({
    modelRef: descriptors.modelRef.value as string,
    targetGeneration: descriptors.targetGeneration
      .value as LlmProxyCatalogModel['targetGeneration'],
    providerType: descriptors.providerType
      .value as LlmProxyCatalogModel['providerType'],
    model: descriptors.model.value as string,
    allowedRoutes: snapshotRoutes(descriptors.allowedRoutes.value),
    contextSize: descriptors.contextSize.value as number | null,
    reasoningEffort: descriptors.reasoningEffort.value as string | null,
    reasoningSummary: descriptors.reasoningSummary.value as string | null,
    reasoningContext: descriptors.reasoningContext.value as string | null,
    toolTier: descriptors.toolTier.value as LlmProxyCatalogModel['toolTier'],
    externalThinking: descriptors.externalThinking.value as boolean,
    toolContractVersion: descriptors.toolContractVersion.value as string,
    callTimeoutMs: descriptors.callTimeoutMs.value as number,
    streamIdleTimeoutMs: descriptors.streamIdleTimeoutMs.value as number,
  });
}

function snapshotTransport(value: unknown): LlmProxyTransportMetadata {
  try {
    if (
      value === null ||
      typeof value !== 'object' ||
      intrinsicIsProxy(value) ||
      intrinsicObjectGetPrototypeOf(value) !== intrinsicObjectPrototype
    )
      boundaryFailure();
    const kindDescriptor = intrinsicObjectGetOwnPropertyDescriptor(
      value,
      'kind',
    );
    if (
      kindDescriptor === undefined ||
      !('value' in kindDescriptor) ||
      kindDescriptor.enumerable !== true
    )
      boundaryFailure();
    if (kindDescriptor.value === 'none') {
      ownDataDescriptors(value, transportNoneKeys);
      return intrinsicObjectFreeze({ kind: 'none' });
    }
    if (kindDescriptor.value !== 'codex') boundaryFailure();
    const descriptors = ownDataDescriptors(value, transportCodexKeys);
    return intrinsicObjectFreeze({
      kind: 'codex',
      sessionId: descriptors.sessionId.value as string,
    });
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
    const descriptors = ownDataDescriptors(value, dispatchKeys);
    return intrinsicObjectFreeze({
      model: snapshotModel(descriptors.model.value),
      payload: copyUint8Array(descriptors.payload.value),
      route: descriptors.route.value as LlmProxyRoute,
      transport: snapshotTransport(descriptors.transport.value),
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
    if (
      !intrinsicReflectApply(intrinsicArrayIncludes, model.allowedRoutes, [
        exact.route,
      ])
    )
      boundaryFailure();
    const payload = exact.payload;
    const rid = requestId(this.#randomBytes, signal);
    throwIfAborted(signal);
    let body: string;
    try {
      const sha256 = payloadSha256(payload);
      const byteLength = uint8ArrayByteLength(payload);
      body = serializeLlmProxyRequest({
        format: LLM_PROXY_FORMATS.request,
        requestId: rid,
        modelRef: model.modelRef,
        targetGeneration: model.targetGeneration,
        route: exact.route,
        transport: exact.transport,
        byteLength,
        sha256,
        payload,
      });
      const wire = decodeLlmProxyRequest(body);
      if (
        wire.requestId !== rid ||
        wire.modelRef !== model.modelRef ||
        wire.targetGeneration !== model.targetGeneration ||
        wire.route !== exact.route ||
        !sameTransport(wire.transport, exact.transport) ||
        wire.byteLength !== byteLength ||
        wire.sha256 !== sha256 ||
        !sameBytes(wire.payload, payload)
      )
        boundaryFailure();
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
      const headers = new intrinsicHeadersConstructor();
      for (let index = 0; index < provenance.headers.length; index += 1) {
        const approved = provenance.headers[index];
        intrinsicReflectApply(intrinsicHeadersAppend, headers, [
          approved.name,
          approved.value,
        ]);
      }
      const body = response.body;
      if (signalAborted(signal)) {
        cancelHttpResponse(response, signal);
        throw abortReason(signal);
      }
      return new intrinsicResponseConstructor(body, {
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
