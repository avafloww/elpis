import { DatabaseSync } from 'node:sqlite';
import {
  LLM_PROXY_FORMATS,
  authorizeLlmProxyRequest,
  type LlmProxyCatalogModel,
  type LlmProxyRequest,
} from '@elpis/gateway-protocol';
import { createOpenAICompatibleFetch } from '@elpis/provider-transport';
import type {
  AuthenticatedNode,
  GatewayCredentialStore,
} from './credential-store.js';
import type {
  GatewayLlmProxyApi,
  GatewayLlmProxyExchange,
} from './llm-proxy-http.js';
import type { GatewayProviderStore } from './provider-store.js';

export const GATEWAY_LLM_WIRE_GRAMMARS = Object.freeze({
  responses: 'openai-compatible-responses-v1',
  'chat/completions': 'openai-compatible-chat-completions-v1',
} as const);

type BrokerFetch = typeof globalThis.fetch;

type AuthorizedRow = Record<string, unknown>;

export interface CreateGatewayLlmProxyApiOptions {
  readonly database: DatabaseSync;
  readonly credentials: GatewayCredentialStore;
  readonly providers: GatewayProviderStore;
  readonly fetch?: BrokerFetch;
  readonly dispatcher?: unknown;
}

const fatalUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function refused(): never {
  throw new Error('gateway LLM dispatch refused');
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException('The request was aborted', 'AbortError')
  );
}

function text(value: unknown): string {
  if (typeof value !== 'string') refused();
  return value;
}

function nullableText(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') refused();
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value)) refused();
  return value as number;
}

function secret(value: unknown): string {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) refused();
  try {
    return fatalUtf8.decode(value);
  } catch {
    refused();
  }
}

function arraysEqual(left: readonly string[], right: unknown): boolean {
  return (
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function modelMatchesRow(
  model: LlmProxyCatalogModel,
  row: AuthorizedRow,
): boolean {
  let routes: unknown;
  try {
    routes = JSON.parse(text(row.allowed_routes_json)) as unknown;
  } catch {
    return false;
  }
  return (
    model.modelRef === row.model_ref &&
    model.targetGeneration === row.target_generation &&
    model.providerType === row.provider_type &&
    model.model === row.upstream_model &&
    arraysEqual(model.allowedRoutes, routes) &&
    model.contextSize === row.context_size &&
    model.reasoningEffort === row.reasoning_effort &&
    model.reasoningSummary === row.reasoning_summary &&
    model.reasoningContext === row.reasoning_context &&
    model.toolTier === row.tool_tier &&
    model.externalThinking === (row.external_thinking === 1) &&
    model.toolContractVersion === row.tool_contract_version &&
    model.callTimeoutMs === row.call_timeout_ms &&
    model.streamIdleTimeoutMs === row.stream_idle_timeout_ms
  );
}

function assertOpenAiGrammar(
  row: AuthorizedRow,
  model: LlmProxyCatalogModel,
): void {
  let grammar: unknown;
  try {
    grammar = JSON.parse(text(row.wire_grammar_json)) as unknown;
  } catch {
    refused();
  }
  if (grammar === null || typeof grammar !== 'object' || Array.isArray(grammar))
    refused();
  const record = grammar as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) =>
    left.localeCompare(right),
  );
  const routes = [...model.allowedRoutes].sort((left, right) =>
    left.localeCompare(right),
  );
  if (!arraysEqual(routes, keys)) refused();
  for (const route of routes) {
    if (
      (route !== 'responses' && route !== 'chat/completions') ||
      record[route] !== GATEWAY_LLM_WIRE_GRAMMARS[route]
    )
      refused();
  }
}

function authorize(
  database: DatabaseSync,
  instanceId: string,
  request: LlmProxyRequest,
  model: LlmProxyCatalogModel,
): AuthorizedRow {
  const protocol = authorizeLlmProxyRequest(
    { format: LLM_PROXY_FORMATS.catalog, revision: 0, models: [model] },
    request,
  );
  if (!protocol.ok) refused();
  const row = database
    .prepare(
      `SELECT
         t.model_ref, t.target_generation, t.provider_type, t.base_url,
         t.upstream_model, t.allowed_routes_json, t.wire_grammar_json,
         t.context_size, t.reasoning_effort, t.reasoning_summary,
         t.reasoning_context, t.tool_tier, t.external_thinking,
         t.tool_contract_version, t.call_timeout_ms, t.stream_idle_timeout_ms,
         c.auth_kind, c.api_key
       FROM gateway_instances AS i
       JOIN gateway_instance_model_grants AS g
         ON g.instance_id = i.id
       JOIN gateway_provider_model_heads AS h
         ON h.model_ref = g.model_ref
        AND h.target_seq = g.target_seq
        AND h.target_generation = g.target_generation
        AND h.enabled = 1
       JOIN gateway_provider_targets AS t
         ON t.model_ref = g.model_ref
        AND t.target_seq = g.target_seq
        AND t.target_generation = g.target_generation
       JOIN gateway_provider_credentials AS c
         ON c.id = t.credential_id
        AND c.provider_id = t.provider_id
        AND c.provider_type = t.provider_type
        AND c.account_ref = t.account_ref
        AND c.account_identity_json = t.account_identity_json
       WHERE i.id = ? AND i.revoked_at IS NULL
         AND g.model_ref = ? AND g.target_generation = ?`,
    )
    .get(instanceId, request.modelRef, request.targetGeneration) as
    AuthorizedRow | undefined;
  if (!row || !modelMatchesRow(model, row)) refused();
  return row;
}

class GatewayLlmBroker implements GatewayLlmProxyApi {
  readonly #database: DatabaseSync;
  readonly #credentials: GatewayCredentialStore;
  readonly #providers: GatewayProviderStore;
  readonly #fetch: BrokerFetch;
  readonly #dispatcher: unknown;

  constructor(options: CreateGatewayLlmProxyApiOptions) {
    this.#database = options.database;
    this.#credentials = options.credentials;
    this.#providers = options.providers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#dispatcher = options.dispatcher;
  }

  authenticateNode(token: unknown): AuthenticatedNode | null {
    return this.#credentials.authenticateNode(token);
  }

  catalogForInstance(instanceId: string) {
    return this.#providers.catalogForInstance(instanceId);
  }

  async dispatch(input: {
    readonly instanceId: string;
    readonly request: LlmProxyRequest;
    readonly model: LlmProxyCatalogModel;
    readonly signal: AbortSignal;
  }): Promise<GatewayLlmProxyExchange> {
    const { instanceId, request, model, signal } = input;
    if (!(signal instanceof AbortSignal)) refused();
    if (signal.aborted) throw abortReason(signal);
    const payload = request.payload.slice();
    let row: AuthorizedRow;
    try {
      row = authorize(this.#database, instanceId, request, model);
      if (
        row.provider_type !== 'openai-compatible' ||
        row.auth_kind !== 'api-key' ||
        request.transport.kind !== 'none'
      )
        refused();
      assertOpenAiGrammar(row, model);
    } catch {
      refused();
    }
    if (signal.aborted) throw abortReason(signal);
    const baseUrl = text(row.base_url);
    const apiKey = secret(row.api_key);
    const route = request.route;
    if (route !== 'responses' && route !== 'chat/completions') refused();
    const target = `${baseUrl.replace(/\/+$/, '')}/${route}`;
    try {
      const providerFetch = createOpenAICompatibleFetch({
        baseUrl,
        apiKey: async () => apiKey,
        fetch: this.#fetch,
        dispatcher: this.#dispatcher,
      });
      const response = await providerFetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(payload),
        signal,
      });
      const headers: (readonly [string, string])[] = [];
      response.headers.forEach((value, name) => {
        headers.push(Object.freeze([name, value] as const));
      });
      return Object.freeze({
        status: response.status,
        headers: Object.freeze(headers),
        body: response.body,
      });
    } catch {
      if (signal.aborted) throw abortReason(signal);
      throw new Error('gateway LLM provider dispatch failed');
    }
  }
}

export function createGatewayLlmProxyApi(
  options: CreateGatewayLlmProxyApiOptions,
): GatewayLlmProxyApi {
  return new GatewayLlmBroker(options);
}
