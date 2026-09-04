import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import { TextDecoder, TextEncoder } from 'node:util';
import { isRequestId } from './codec.js';
import type { RequestId } from './types.js';

/** Independent HTTP protocol. It deliberately does not extend the resident WebSocket protocol. */
export const LLM_PROXY_PROTOCOL = 'elpis-gateway-llm-v1' as const;

export const LLM_PROXY_PATHS = Object.freeze({
  catalog: '/api/v1/resident/llm/catalog',
  request: '/api/v1/resident/llm/request',
} as const);

export const LLM_PROXY_HEADERS = Object.freeze({
  provenance: 'x-elpis-llm-provenance',
} as const);

const intrinsicArrayIsArray = Array.isArray;
const intrinsicJsonParse = JSON.parse;
const intrinsicJsonStringify = JSON.stringify;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectKeys = Object.keys;
const intrinsicReflectApply = Reflect.apply;
const intrinsicSetHas = Set.prototype.has;

function setHas(set: Set<unknown>, value: unknown): boolean {
  return intrinsicReflectApply(intrinsicSetHas, set, [value]);
}

export const LLM_PROXY_FORMATS = Object.freeze({
  catalog: 'elpis-gateway-llm-catalog-v1',
  request: 'elpis-gateway-llm-request-v1',
  error: 'elpis-gateway-llm-error-v1',
  responseProvenance: 'elpis-gateway-llm-response-provenance-v1',
} as const);

export const LLM_PROXY_PROVIDER_TYPES = Object.freeze([
  'openai-compatible',
  'anthropic-oauth',
  'codex-oauth',
] as const);
export type LlmProxyProviderType = (typeof LLM_PROXY_PROVIDER_TYPES)[number];

export const LLM_PROXY_TOOL_TIERS = Object.freeze([
  'weak',
  'medium',
  'strong',
] as const);
export type LlmProxyToolTier = (typeof LLM_PROXY_TOOL_TIERS)[number];

/** Logical routes, never arbitrary URLs. A broker maps these to its pinned target. */
export const LLM_PROXY_ROUTES = Object.freeze([
  'responses',
  'chat/completions',
  'messages',
  'codex/responses',
  'codex/models',
  'models',
] as const);
export type LlmProxyRoute = (typeof LLM_PROXY_ROUTES)[number];
export const LLM_PROXY_GET_ROUTES = Object.freeze([
  'codex/models',
  'models',
] as const satisfies readonly LlmProxyRoute[]);

export const LLM_PROXY_ERROR_CODES = Object.freeze([
  'invalid_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'stale_target',
  'payload_too_large',
  'route_not_allowed',
  'upstream_unavailable',
  'upstream_timeout',
  'cancelled',
  'rate_limited',
  'internal_error',
] as const);
export type LlmProxyErrorCode = (typeof LLM_PROXY_ERROR_CODES)[number];

/** Response metadata safe to relay. Redirect, cookie, and authentication fields are absent. */
export const LLM_PROXY_SAFE_RESPONSE_HEADERS = Object.freeze([
  'anthropic-ratelimit-input-tokens-limit',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-input-tokens-reset',
  'anthropic-ratelimit-output-tokens-limit',
  'anthropic-ratelimit-output-tokens-remaining',
  'anthropic-ratelimit-output-tokens-reset',
  'anthropic-ratelimit-requests-limit',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'content-type',
  'openai-processing-ms',
  'openai-version',
  'request-id',
  'retry-after',
  'x-request-id',
  'x-ratelimit-limit-requests',
  'x-ratelimit-limit-tokens',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-requests',
  'x-ratelimit-reset-tokens',
] as const);
export type SafeLlmResponseHeader =
  (typeof LLM_PROXY_SAFE_RESPONSE_HEADERS)[number];

export const LLM_PROXY_LIMITS = Object.freeze({
  catalogBodyBytes: 256 * 1024,
  requestBodyBytes: 48 * 1024 * 1024,
  errorBodyBytes: 1024,
  payloadBytes: 32 * 1024 * 1024,
  responseBytes: 32 * 1024 * 1024,
  models: 256,
  modelRefBytes: 256,
  upstreamModelBytes: 512,
  reasoningBytes: 1024,
  toolContractVersionBytes: 128,
  transportIdBytes: 512,
  contextSize: 16 * 1024 * 1024,
  timeoutMs: 24 * 60 * 60 * 1000,
  provenanceHeaderBytes: 4 * 1024,
  responseHeaderValueBytes: 1024,
} as const);

export type LlmTargetGeneration = `egt1.${string}`;

export interface LlmProxyNoTransportMetadata {
  readonly kind: 'none';
}
export interface LlmProxyCodexTransportMetadata {
  readonly kind: 'codex';
  /** Gateway derives session_id, conversation_id, and x-client-request-id from this one value. */
  readonly sessionId: string;
}
export type LlmProxyTransportMetadata =
  LlmProxyNoTransportMetadata | LlmProxyCodexTransportMetadata;

/** In-memory request. The JSON wire representation carries payload as canonical base64. */
export interface LlmProxyRequest {
  readonly format: typeof LLM_PROXY_FORMATS.request;
  readonly requestId: RequestId;
  readonly modelRef: string;
  readonly targetGeneration: LlmTargetGeneration;
  readonly route: LlmProxyRoute;
  readonly transport: LlmProxyTransportMetadata;
  readonly byteLength: number;
  /** Lowercase hexadecimal SHA-256 of payload. */
  readonly sha256: string;
  /** An owned copy is returned by the decoder. */
  readonly payload: Uint8Array;
}

export interface LlmProxyCatalogModel {
  readonly modelRef: string;
  readonly targetGeneration: LlmTargetGeneration;
  readonly providerType: LlmProxyProviderType;
  /** Actual provider-facing model name; this is not an endpoint URL. */
  readonly model: string;
  readonly allowedRoutes: readonly LlmProxyRoute[];
  readonly contextSize: number | null;
  readonly reasoningEffort: string | null;
  readonly reasoningSummary: string | null;
  readonly reasoningContext: string | null;
  readonly toolTier: LlmProxyToolTier | null;
  readonly externalThinking: boolean;
  readonly toolContractVersion: string;
  readonly callTimeoutMs: number;
  readonly streamIdleTimeoutMs: number;
}
export interface LlmProxyCatalog {
  readonly format: typeof LLM_PROXY_FORMATS.catalog;
  readonly revision: number;
  readonly models: readonly LlmProxyCatalogModel[];
}

export interface LlmProxyErrorEnvelope {
  readonly format: typeof LLM_PROXY_FORMATS.error;
  readonly code: LlmProxyErrorCode;
  readonly requestId?: RequestId;
}
export interface LlmProxyStaleTargetEnvelope extends LlmProxyErrorEnvelope {
  readonly code: 'stale_target';
}
export type LlmProxyError = LlmProxyErrorEnvelope;

export type LlmProxyAuthorizationFailureCode =
  'not_found' | 'stale_target' | 'route_not_allowed' | 'forbidden';
export type LlmProxyAuthorizationResult =
  | {
      readonly ok: true;
      readonly model: LlmProxyCatalogModel;
    }
  | {
      readonly ok: false;
      readonly code: LlmProxyAuthorizationFailureCode;
    };

export interface LlmSafeResponseHeader {
  readonly name: SafeLlmResponseHeader;
  readonly value: string;
}
export interface LlmResponseProvenance {
  readonly format: typeof LLM_PROXY_FORMATS.responseProvenance;
  readonly requestId: RequestId;
  readonly modelRef: string;
  readonly targetGeneration: LlmTargetGeneration;
  readonly route: LlmProxyRoute;
  readonly status: number;
  /** Safe upstream headers known before the raw response body begins streaming. */
  readonly headers: readonly LlmSafeResponseHeader[];
}

/** Input-independent so codec errors can be logged without reflecting secrets or bodies. */
export class LlmProxyCodecError extends Error {
  readonly code = 'invalid_request' as const;
  constructor() {
    super('invalid gateway LLM proxy input');
    this.name = 'LlmProxyCodecError';
  }
}

const utf8 = new TextEncoder();
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const generationPattern = /^egt1\.[A-Za-z0-9_-]{22}$/;
const modelRefPattern = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
// v1 excludes ':' because free-form model tags are indistinguishable from URI schemes.
const upstreamModelPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const credentialShapedUpstreamModel =
  /^(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|api[_-]?key[:=_-]|(?:bearer|token|key)[:=_-]|xox[baprs]-|gh[pousr]_|github_pat_|AKIA[0-9A-Z]{16})/i;
const visibleAscii = /^[\x21-\x7e]+$/;
const headerValuePattern = /^[\x09\x20-\x7e]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const routeSet = new Set<string>(LLM_PROXY_ROUTES);
const getRouteSet = new Set<string>(LLM_PROXY_GET_ROUTES);
const providerTypeSet = new Set<string>(LLM_PROXY_PROVIDER_TYPES);
const toolTierSet = new Set<string>(LLM_PROXY_TOOL_TIERS);
const errorCodeSet = new Set<string>(LLM_PROXY_ERROR_CODES);
const safeResponseHeaderSet = new Set<string>(LLM_PROXY_SAFE_RESPONSE_HEADERS);
type JsonRecord = Record<string, unknown>;
export type LlmProxyBody = string | Uint8Array;
export type LlmGenerationRandomBytes = (size: number) => Uint8Array;

function invalid(): never {
  throw new LlmProxyCodecError();
}
function guarded<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LlmProxyCodecError) throw error;
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
function exactFormat(value: unknown, format: string): void {
  if (value !== format) invalid();
}
function bytesIn(value: string, minimum: number, maximum: number): string {
  const bytes = utf8.encode(value);
  if (
    bytes.byteLength < minimum ||
    bytes.byteLength > maximum ||
    fatalUtf8.decode(bytes) !== value
  )
    invalid();
  return value;
}
function plainText(value: unknown, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) invalid();
  return bytesIn(value, minimum, maximum);
}
function nullableText(value: unknown, maximum: number): string | null {
  if (value === null) return null;
  return plainText(value, 0, maximum);
}
function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  )
    invalid();
  return value as number;
}
function requestIdValue(value: unknown): RequestId {
  if (!isRequestId(value)) invalid();
  return value;
}
function modelRefValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !modelRefPattern.test(value) ||
    utf8.encode(value).byteLength > LLM_PROXY_LIMITS.modelRefBytes
  )
    invalid();
  return value;
}
function upstreamModelValue(value: unknown): string {
  const model = plainText(value, 1, LLM_PROXY_LIMITS.upstreamModelBytes);
  if (!upstreamModelPattern.test(model)) invalid();
  if (credentialShapedUpstreamModel.test(model)) invalid();
  return model;
}
function generationValue(value: unknown): LlmTargetGeneration {
  if (!isLlmTargetGeneration(value)) invalid();
  return value;
}
function routeValue(value: unknown): LlmProxyRoute {
  if (typeof value !== 'string' || !setHas(routeSet, value)) invalid();
  return value as LlmProxyRoute;
}
function bodyText(body: LlmProxyBody, maximum: number): string {
  if (typeof body === 'string') {
    const bytes = utf8.encode(body);
    if (bytes.byteLength > maximum || fatalUtf8.decode(bytes) !== body)
      invalid();
    return body;
  }
  if (!(body instanceof Uint8Array) || body.byteLength > maximum) invalid();
  return fatalUtf8.decode(body);
}
function jsonWithoutHooks(value: unknown, depth = 0): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  )
    return value;
  if (depth >= 32 || typeof value !== 'object') invalid();
  if (intrinsicArrayIsArray(value)) {
    const output: unknown[] = [];
    intrinsicObjectDefineProperty(output, 'toJSON', {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
    for (let index = 0; index < value.length; index += 1)
      output[index] = jsonWithoutHooks(value[index], depth + 1);
    return output;
  }
  const output = intrinsicObjectCreate(null) as Record<string, unknown>;
  const keys = intrinsicObjectKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (key === 'toJSON') invalid();
    intrinsicObjectDefineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: jsonWithoutHooks(
        (value as Record<string, unknown>)[key],
        depth + 1,
      ),
      writable: false,
    });
  }
  return output;
}

function serializeBounded(value: unknown, maximum: number): string {
  const encoded = intrinsicJsonStringify(jsonWithoutHooks(value));
  if (typeof encoded !== 'string' || utf8.encode(encoded).byteLength > maximum)
    invalid();
  return encoded;
}

export function isLlmTargetGeneration(
  value: unknown,
): value is LlmTargetGeneration {
  if (typeof value !== 'string' || !generationPattern.test(value)) return false;
  const suffix = value.slice('egt1.'.length);
  const decoded = Buffer.from(suffix, 'base64url');
  return decoded.byteLength === 16 && decoded.toString('base64url') === suffix;
}
export function newLlmTargetGeneration(
  randomBytes: LlmGenerationRandomBytes = systemRandomBytes,
): LlmTargetGeneration {
  return guarded(() => {
    if (typeof randomBytes !== 'function') invalid();
    const bytes = randomBytes(16);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) invalid();
    return `egt1.${Buffer.from(bytes).toString('base64url')}` as LlmTargetGeneration;
  });
}

function normalizeTransport(value: unknown): LlmProxyTransportMetadata {
  const input = record(value);
  if (input.kind === 'none') {
    exact(input, ['kind']);
    return Object.freeze({ kind: 'none' });
  }
  if (input.kind !== 'codex') invalid();
  exact(input, ['kind', 'sessionId']);
  if (
    typeof input.sessionId !== 'string' ||
    !visibleAscii.test(input.sessionId)
  )
    invalid();
  return Object.freeze({
    kind: 'codex',
    sessionId: bytesIn(input.sessionId, 1, LLM_PROXY_LIMITS.transportIdBytes),
  });
}

function payloadDigest(payload: Uint8Array): string {
  return createHash('sha256').update(payload).digest('hex');
}
function normalizeMemoryRequest(value: unknown): LlmProxyRequest {
  const input = record(value);
  exact(input, [
    'format',
    'requestId',
    'modelRef',
    'targetGeneration',
    'route',
    'transport',
    'byteLength',
    'sha256',
    'payload',
  ]);
  exactFormat(input.format, LLM_PROXY_FORMATS.request);
  if (!(input.payload instanceof Uint8Array)) invalid();
  const payload = new Uint8Array(input.payload);
  if (payload.byteLength > LLM_PROXY_LIMITS.payloadBytes) invalid();
  const byteLength = boundedInteger(
    input.byteLength,
    0,
    LLM_PROXY_LIMITS.payloadBytes,
  );
  if (
    byteLength !== payload.byteLength ||
    typeof input.sha256 !== 'string' ||
    !sha256Pattern.test(input.sha256)
  )
    invalid();
  if (payloadDigest(payload) !== input.sha256) invalid();
  const route = routeValue(input.route);
  if (setHas(getRouteSet, route) && payload.byteLength !== 0) invalid();
  const transport = normalizeTransport(input.transport);
  const codexRoute =
    route === 'codex/responses' ||
    route === 'codex/models' ||
    route === 'models';
  if ((transport.kind === 'codex') !== codexRoute) invalid();
  return Object.freeze({
    format: LLM_PROXY_FORMATS.request,
    requestId: requestIdValue(input.requestId),
    modelRef: modelRefValue(input.modelRef),
    targetGeneration: generationValue(input.targetGeneration),
    route,
    transport,
    byteLength,
    sha256: input.sha256,
    payload,
  });
}
function requestWire(request: LlmProxyRequest): JsonRecord {
  return {
    format: request.format,
    requestId: request.requestId,
    modelRef: request.modelRef,
    targetGeneration: request.targetGeneration,
    route: request.route,
    transport: request.transport,
    byteLength: request.byteLength,
    sha256: request.sha256,
    payload: Buffer.from(request.payload).toString('base64'),
  };
}
function decodeWirePayload(
  value: unknown,
  byteLength: number,
  sha256: unknown,
): Uint8Array {
  if (
    typeof value !== 'string' ||
    typeof sha256 !== 'string' ||
    !sha256Pattern.test(sha256)
  )
    invalid();
  // This length check precedes allocation and also bounds deliberately malformed base64.
  if (value.length > Math.ceil(LLM_PROXY_LIMITS.payloadBytes / 3) * 4)
    invalid();
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.byteLength !== byteLength ||
    decoded.byteLength > LLM_PROXY_LIMITS.payloadBytes ||
    decoded.toString('base64') !== value ||
    payloadDigest(decoded) !== sha256
  )
    invalid();
  return new Uint8Array(decoded);
}

export function decodeLlmProxyRequest(body: LlmProxyBody): LlmProxyRequest {
  return guarded(() => {
    const text = bodyText(body, LLM_PROXY_LIMITS.requestBodyBytes);
    const input = record(intrinsicJsonParse(text) as unknown);
    exact(input, [
      'format',
      'requestId',
      'modelRef',
      'targetGeneration',
      'route',
      'transport',
      'byteLength',
      'sha256',
      'payload',
    ]);
    exactFormat(input.format, LLM_PROXY_FORMATS.request);
    const byteLength = boundedInteger(
      input.byteLength,
      0,
      LLM_PROXY_LIMITS.payloadBytes,
    );
    const normalized = normalizeMemoryRequest({
      ...input,
      byteLength,
      payload: decodeWirePayload(input.payload, byteLength, input.sha256),
    });
    if (
      serializeBounded(
        requestWire(normalized),
        LLM_PROXY_LIMITS.requestBodyBytes,
      ) !== text
    )
      invalid();
    return normalized;
  });
}
export function serializeLlmProxyRequest(value: LlmProxyRequest): string {
  return guarded(() =>
    serializeBounded(
      requestWire(normalizeMemoryRequest(value)),
      LLM_PROXY_LIMITS.requestBodyBytes,
    ),
  );
}

function normalizeRoutes(value: unknown): readonly LlmProxyRoute[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > LLM_PROXY_ROUTES.length
  )
    invalid();
  const routes = value.map(routeValue);
  for (let i = 1; i < routes.length; i += 1) {
    if (routes[i - 1].localeCompare(routes[i]) >= 0) invalid();
  }
  return Object.freeze(routes);
}
function normalizeCatalogModel(value: unknown): LlmProxyCatalogModel {
  const input = record(value);
  exact(input, [
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
  ]);
  if (
    typeof input.providerType !== 'string' ||
    !setHas(providerTypeSet, input.providerType)
  )
    invalid();
  if (
    input.toolTier !== null &&
    (typeof input.toolTier !== 'string' || !setHas(toolTierSet, input.toolTier))
  )
    invalid();
  if (typeof input.externalThinking !== 'boolean') invalid();
  if (input.externalThinking && input.providerType !== 'codex-oauth') invalid();
  const providerType = input.providerType as LlmProxyProviderType;
  const allowedRoutes = normalizeRoutes(input.allowedRoutes);
  const routeAllowed = (route: LlmProxyRoute): boolean =>
    providerType === 'openai-compatible'
      ? route === 'responses' || route === 'chat/completions'
      : providerType === 'anthropic-oauth'
        ? route === 'messages'
        : route === 'codex/responses' ||
          route === 'codex/models' ||
          route === 'models';
  if (allowedRoutes.some((route) => !routeAllowed(route))) invalid();
  const contextSize =
    input.contextSize === null
      ? null
      : boundedInteger(input.contextSize, 1, LLM_PROXY_LIMITS.contextSize);
  return Object.freeze({
    modelRef: modelRefValue(input.modelRef),
    targetGeneration: generationValue(input.targetGeneration),
    providerType,
    model: upstreamModelValue(input.model),
    allowedRoutes,
    contextSize,
    reasoningEffort: nullableText(
      input.reasoningEffort,
      LLM_PROXY_LIMITS.reasoningBytes,
    ),
    reasoningSummary: nullableText(
      input.reasoningSummary,
      LLM_PROXY_LIMITS.reasoningBytes,
    ),
    reasoningContext: nullableText(
      input.reasoningContext,
      LLM_PROXY_LIMITS.reasoningBytes,
    ),
    toolTier: input.toolTier as LlmProxyToolTier | null,
    externalThinking: input.externalThinking,
    toolContractVersion: plainText(
      input.toolContractVersion,
      1,
      LLM_PROXY_LIMITS.toolContractVersionBytes,
    ),
    callTimeoutMs: boundedInteger(
      input.callTimeoutMs,
      0,
      LLM_PROXY_LIMITS.timeoutMs,
    ),
    streamIdleTimeoutMs: boundedInteger(
      input.streamIdleTimeoutMs,
      0,
      LLM_PROXY_LIMITS.timeoutMs,
    ),
  });
}
function normalizeCatalog(value: unknown): LlmProxyCatalog {
  const input = record(value);
  exact(input, ['format', 'revision', 'models']);
  exactFormat(input.format, LLM_PROXY_FORMATS.catalog);
  if (
    !Array.isArray(input.models) ||
    input.models.length > LLM_PROXY_LIMITS.models
  )
    invalid();
  const models = input.models.map(normalizeCatalogModel);
  const providerTypes = new Map<string, LlmProxyProviderType>();
  const toolTiers = new Set<LlmProxyToolTier>();
  for (let i = 0; i < models.length; i += 1) {
    if (i > 0 && models[i - 1].modelRef.localeCompare(models[i].modelRef) >= 0)
      invalid();
    const providerId = models[i].modelRef.split('/', 1)[0];
    const priorType = providerTypes.get(providerId);
    if (priorType !== undefined && priorType !== models[i].providerType)
      invalid();
    providerTypes.set(providerId, models[i].providerType);
    const tier = models[i].toolTier;
    if (tier !== null) {
      if (setHas(toolTiers, tier)) invalid();
      toolTiers.add(tier);
    }
  }
  return Object.freeze({
    format: LLM_PROXY_FORMATS.catalog,
    revision: boundedInteger(input.revision, 0, Number.MAX_SAFE_INTEGER),
    models: Object.freeze(models),
  });
}
export function decodeLlmProxyCatalog(body: LlmProxyBody): LlmProxyCatalog {
  return guarded(() => {
    const text = bodyText(body, LLM_PROXY_LIMITS.catalogBodyBytes);
    const normalized = normalizeCatalog(
      record(intrinsicJsonParse(text) as unknown),
    );
    if (
      serializeBounded(normalized, LLM_PROXY_LIMITS.catalogBodyBytes) !== text
    )
      invalid();
    return normalized;
  });
}
export function serializeLlmProxyCatalog(value: LlmProxyCatalog): string {
  return guarded(() =>
    serializeBounded(
      normalizeCatalog(value),
      LLM_PROXY_LIMITS.catalogBodyBytes,
    ),
  );
}

function authorizationFailure(
  code: LlmProxyAuthorizationFailureCode,
): LlmProxyAuthorizationResult {
  return Object.freeze({ ok: false, code });
}

function canonicalPayloadModel(payload: Uint8Array): string {
  const text = fatalUtf8.decode(payload);
  const parsed = record(intrinsicJsonParse(text) as unknown);
  if (
    intrinsicJsonStringify(jsonWithoutHooks(parsed)) !== text ||
    typeof parsed.model !== 'string'
  )
    invalid();
  return parsed.model;
}

/** Mandatory authorization after node auth and catalog resolution, before upstream dispatch. */
export function authorizeLlmProxyRequest(
  catalog: LlmProxyCatalog,
  request: LlmProxyRequest,
): LlmProxyAuthorizationResult {
  return guarded(() => {
    const normalizedCatalog = normalizeCatalog(catalog);
    const normalizedRequest = normalizeMemoryRequest(request);
    const model = normalizedCatalog.models.find(
      (candidate) => candidate.modelRef === normalizedRequest.modelRef,
    );
    if (!model) return authorizationFailure('not_found');
    if (model.targetGeneration !== normalizedRequest.targetGeneration)
      return authorizationFailure('stale_target');
    if (!model.allowedRoutes.includes(normalizedRequest.route))
      return authorizationFailure('route_not_allowed');
    if (
      !setHas(getRouteSet, normalizedRequest.route) &&
      canonicalPayloadModel(normalizedRequest.payload) !== model.model
    )
      return authorizationFailure('forbidden');
    return Object.freeze({ ok: true, model });
  });
}

function normalizeError(value: unknown): LlmProxyErrorEnvelope {
  const input = record(value);
  exact(
    input,
    input.requestId === undefined
      ? ['format', 'code']
      : ['format', 'code', 'requestId'],
  );
  exactFormat(input.format, LLM_PROXY_FORMATS.error);
  if (typeof input.code !== 'string' || !setHas(errorCodeSet, input.code))
    invalid();
  if (input.requestId === undefined)
    return Object.freeze({
      format: LLM_PROXY_FORMATS.error,
      code: input.code as LlmProxyErrorCode,
    });
  return Object.freeze({
    format: LLM_PROXY_FORMATS.error,
    code: input.code as LlmProxyErrorCode,
    requestId: requestIdValue(input.requestId),
  });
}
export function decodeLlmProxyError(body: LlmProxyBody): LlmProxyErrorEnvelope {
  return guarded(() => {
    const text = bodyText(body, LLM_PROXY_LIMITS.errorBodyBytes);
    const normalized = normalizeError(
      record(intrinsicJsonParse(text) as unknown),
    );
    if (serializeBounded(normalized, LLM_PROXY_LIMITS.errorBodyBytes) !== text)
      invalid();
    return normalized;
  });
}
export function serializeLlmProxyError(value: LlmProxyErrorEnvelope): string {
  return guarded(() =>
    serializeBounded(normalizeError(value), LLM_PROXY_LIMITS.errorBodyBytes),
  );
}
export function decodeLlmProxyStaleTarget(
  body: LlmProxyBody,
): LlmProxyStaleTargetEnvelope {
  return guarded(() => {
    const decoded = decodeLlmProxyError(body);
    if (decoded.code !== 'stale_target') invalid();
    return decoded as LlmProxyStaleTargetEnvelope;
  });
}

export function isSafeLlmResponseHeader(
  value: unknown,
): value is SafeLlmResponseHeader {
  return typeof value === 'string' && setHas(safeResponseHeaderSet, value);
}
function normalizeResponseHeaders(
  value: unknown,
): readonly LlmSafeResponseHeader[] {
  if (
    !Array.isArray(value) ||
    value.length > LLM_PROXY_SAFE_RESPONSE_HEADERS.length
  )
    invalid();
  const headers = value.map((candidate) => {
    const input = record(candidate);
    exact(input, ['name', 'value']);
    if (!isSafeLlmResponseHeader(input.name) || typeof input.value !== 'string')
      invalid();
    if (!headerValuePattern.test(input.value)) invalid();
    bytesIn(input.value, 1, LLM_PROXY_LIMITS.responseHeaderValueBytes);
    return Object.freeze({ name: input.name, value: input.value });
  });
  for (let i = 1; i < headers.length; i += 1) {
    if (headers[i - 1].name.localeCompare(headers[i].name) >= 0) invalid();
  }
  return Object.freeze(headers);
}
function normalizeProvenance(value: unknown): LlmResponseProvenance {
  const input = record(value);
  exact(input, [
    'format',
    'requestId',
    'modelRef',
    'targetGeneration',
    'route',
    'status',
    'headers',
  ]);
  exactFormat(input.format, LLM_PROXY_FORMATS.responseProvenance);
  return Object.freeze({
    format: LLM_PROXY_FORMATS.responseProvenance,
    requestId: requestIdValue(input.requestId),
    modelRef: modelRefValue(input.modelRef),
    targetGeneration: generationValue(input.targetGeneration),
    route: routeValue(input.route),
    status: boundedInteger(input.status, 100, 599),
    headers: normalizeResponseHeaders(input.headers),
  });
}

/** Encodes strict response metadata only. The raw upstream body remains the HTTP body. */
export function encodeLlmResponseProvenance(
  value: LlmResponseProvenance,
): string {
  return guarded(() => {
    const json = serializeBounded(
      normalizeProvenance(value),
      LLM_PROXY_LIMITS.provenanceHeaderBytes,
    );
    const encoded = Buffer.from(json, 'utf8').toString('base64url');
    if (encoded.length > LLM_PROXY_LIMITS.provenanceHeaderBytes) invalid();
    return encoded;
  });
}
export function decodeLlmResponseProvenance(
  value: unknown,
): LlmResponseProvenance {
  return guarded(() => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > LLM_PROXY_LIMITS.provenanceHeaderBytes ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    )
      invalid();
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.toString('base64url') !== value) invalid();
    const decoded = normalizeProvenance(
      record(intrinsicJsonParse(fatalUtf8.decode(bytes)) as unknown),
    );
    // Require the one canonical field order and representation emitted above.
    if (encodeLlmResponseProvenance(decoded) !== value) invalid();
    return decoded;
  });
}

export function isLlmProxyCodecError(
  value: unknown,
): value is LlmProxyCodecError {
  return value instanceof LlmProxyCodecError;
}
