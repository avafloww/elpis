import { DatabaseSync } from 'node:sqlite';
import {
  LLM_PROXY_FORMATS,
  authorizeLlmProxyRequest,
  type LlmProxyCatalogModel,
  type LlmProxyRequest,
} from '@elpis/gateway-protocol';
import {
  createAnthropicOAuthTransport,
  createCodexOAuthFetch,
  createOpenAICompatibleFetch,
  refreshAnthropicToken,
  refreshOpenAICodexToken,
  validateOAuthCredentials,
  type OAuthCredentials,
} from '@elpis/provider-transport';
import type {
  AuthenticatedNode,
  GatewayCredentialStore,
} from './credential-store.js';
import type {
  GatewayLlmProxyApi,
  GatewayLlmProxyExchange,
} from './llm-proxy-http.js';
import { GATEWAY_LLM_WIRE_GRAMMARS } from './llm-target-policy.js';
import type { GatewayProviderStore } from './provider-store.js';

export { GATEWAY_LLM_WIRE_GRAMMARS } from './llm-target-policy.js';

type BrokerFetch = typeof globalThis.fetch;

type AuthorizedRow = Record<string, unknown>;

export interface CreateGatewayLlmProxyApiOptions {
  readonly database: DatabaseSync;
  readonly credentials: GatewayCredentialStore;
  readonly providers: GatewayProviderStore;
  readonly now?: () => number;
  readonly fetch?: BrokerFetch;
  readonly dispatcher?: unknown;
}

export interface GatewayLlmBrokerApi extends GatewayLlmProxyApi {
  drain(): Promise<void>;
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

async function awaitWithAbort<T>(
  start: () => T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(abortReason(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let operation: Promise<T>;
    try {
      operation = Promise.resolve(start());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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
         c.id AS credential_id, c.auth_kind, c.api_key,
         c.oauth_access, c.oauth_refresh, c.oauth_expires,
         c.oauth_secret_revision, c.account_identity_json
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

function assertAnthropicGrammar(
  row: AuthorizedRow,
  model: LlmProxyCatalogModel,
): void {
  let grammar: unknown;
  try {
    grammar = JSON.parse(text(row.wire_grammar_json)) as unknown;
  } catch {
    refused();
  }
  if (
    model.allowedRoutes.length !== 1 ||
    model.allowedRoutes[0] !== 'messages' ||
    grammar === null ||
    typeof grammar !== 'object' ||
    Array.isArray(grammar)
  )
    refused();
  const record = grammar as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    record.messages !== GATEWAY_LLM_WIRE_GRAMMARS.messages
  )
    refused();
}

function assertCodexGrammar(
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
    const expected =
      route === 'codex/responses'
        ? GATEWAY_LLM_WIRE_GRAMMARS.codexResponses
        : route === 'codex/models'
          ? GATEWAY_LLM_WIRE_GRAMMARS.codexModels
          : route === 'models'
            ? GATEWAY_LLM_WIRE_GRAMMARS.models
            : null;
    if (expected === null || record[route] !== expected) refused();
  }
}

function identityFields(value: unknown): Partial<OAuthCredentials> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(value)) as unknown;
  } catch {
    refused();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    refused();
  const record = parsed as Record<string, unknown>;
  const result: Partial<OAuthCredentials> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (key === 'authorizedAt') {
      if (!Number.isSafeInteger(value) || (value as number) < 0) refused();
      result.authorizedAt = value as number;
    } else if (
      key === 'accountId' ||
      key === 'email' ||
      key === 'orgId' ||
      key === 'orgName'
    ) {
      if (typeof value !== 'string') refused();
      result[key] = value;
    } else {
      refused();
    }
  }
  return result;
}

function oauthCredentialsFromRow(row: AuthorizedRow): OAuthCredentials {
  if (row.auth_kind !== 'oauth') refused();
  return {
    access: secret(row.oauth_access),
    refresh: secret(row.oauth_refresh),
    expires: integer(row.oauth_expires),
    ...identityFields(row.account_identity_json),
  };
}

const OAUTH_REFRESH_SKEW_MS = 60_000;
type OAuthProviderType = 'anthropic-oauth' | 'codex-oauth';

interface OAuthSnapshot {
  readonly credentialId: string;
  readonly providerType: OAuthProviderType;
  readonly secretRevision: number;
  readonly credentials: OAuthCredentials;
}

function oauthSnapshotFromRow(
  row: AuthorizedRow,
  providerType: OAuthProviderType,
): OAuthSnapshot {
  if (row.provider_type !== providerType) refused();
  return Object.freeze({
    credentialId: text(row.credential_id),
    providerType,
    secretRevision: integer(row.oauth_secret_revision),
    credentials: Object.freeze(oauthCredentialsFromRow(row)),
  });
}

class DispatchOAuthCredentialSource {
  readonly location = 'gateway dispatch OAuth credential';
  #current: OAuthSnapshot;
  readonly #now: () => number;
  readonly #refresh: (snapshot: OAuthSnapshot) => Promise<OAuthSnapshot>;

  constructor(
    snapshot: OAuthSnapshot,
    now: () => number,
    refresh: (snapshot: OAuthSnapshot) => Promise<OAuthSnapshot>,
  ) {
    this.#current = snapshot;
    this.#now = now;
    this.#refresh = refresh;
  }

  read(): { readonly accountId?: string } {
    const { accountId } = this.#current.credentials;
    return accountId === undefined ? {} : { accountId };
  }

  async getAccessToken(): Promise<string> {
    if (
      this.#now() >=
      this.#current.credentials.expires - OAUTH_REFRESH_SKEW_MS
    )
      this.#current = await this.#refresh(this.#current);
    return this.#current.credentials.access;
  }

  async forceRefresh(): Promise<void> {
    this.#current = await this.#refresh(this.#current);
  }
}

function streamFromPayload(payload: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8.decode(payload)) as unknown;
  } catch {
    refused();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    refused();
  const stream = (parsed as Record<string, unknown>).stream;
  if (typeof stream !== 'boolean') refused();
  return stream;
}

function exchangeFromResponse(response: Response): GatewayLlmProxyExchange {
  const headers: (readonly [string, string])[] = [];
  response.headers.forEach((value, name) => {
    headers.push(Object.freeze([name, value] as const));
  });
  return Object.freeze({
    status: response.status,
    headers: Object.freeze(headers),
    body: response.body,
  });
}

function cancelResponseBody(response: Response): void {
  try {
    const cleanup = response.body?.cancel();
    if (cleanup) void cleanup.catch(() => undefined);
  } catch {
    // Retrying must not depend on best-effort cleanup of the rejected response.
  }
}

class GatewayLlmBroker implements GatewayLlmProxyApi {
  readonly #database: DatabaseSync;
  readonly #credentials: GatewayCredentialStore;
  readonly #providers: GatewayProviderStore;
  readonly #now: () => number;
  readonly #fetch: BrokerFetch;
  readonly #dispatcher: unknown;
  readonly #refreshes = new Map<string, Promise<OAuthSnapshot>>();
  readonly #activeDispatches = new Set<Promise<GatewayLlmProxyExchange>>();
  #draining = false;

  constructor(options: CreateGatewayLlmProxyApiOptions) {
    this.#database = options.database;
    this.#credentials = options.credentials;
    this.#providers = options.providers;
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#dispatcher = options.dispatcher;
  }

  #readOAuthSnapshot(
    credentialId: string,
    providerType: OAuthProviderType,
  ): OAuthSnapshot {
    const row = this.#database
      .prepare(
        `SELECT id AS credential_id, auth_kind, provider_type, oauth_access,
                oauth_refresh, oauth_expires, oauth_secret_revision,
                account_identity_json
         FROM gateway_provider_credentials
         WHERE id = ? AND provider_type = ? AND auth_kind = 'oauth'`,
      )
      .get(credentialId, providerType) as AuthorizedRow | undefined;
    if (!row) refused();
    return oauthSnapshotFromRow(row, providerType);
  }

  #refreshOAuth(snapshot: OAuthSnapshot): Promise<OAuthSnapshot> {
    const existing = this.#refreshes.get(snapshot.credentialId);
    if (existing) return existing;
    if (this.#draining)
      return Promise.reject(new Error('gateway LLM broker is draining'));
    const latest = this.#readOAuthSnapshot(
      snapshot.credentialId,
      snapshot.providerType,
    );
    if (latest.secretRevision !== snapshot.secretRevision)
      return Promise.resolve(latest);

    let tracked!: Promise<OAuthSnapshot>;
    const refresh = (async () => {
      const fresh =
        snapshot.providerType === 'anthropic-oauth'
          ? await refreshAnthropicToken(snapshot.credentials.refresh, {
              fetch: this.#fetch,
              now: this.#now,
            })
          : await refreshOpenAICodexToken(snapshot.credentials.refresh, {
              fetch: this.#fetch,
              now: this.#now,
            });
      const credentials = validateOAuthCredentials({
        ...snapshot.credentials,
        ...fresh,
      });
      try {
        const receipt = this.#providers.refreshOAuthCredential({
          credentialId: snapshot.credentialId,
          expectedSecretRevision: snapshot.secretRevision,
          accessToken: credentials.access,
          refreshToken: credentials.refresh,
          expiresAt: credentials.expires,
        });
        return Object.freeze({
          ...snapshot,
          secretRevision: receipt.secretRevision,
          credentials: Object.freeze(credentials),
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'gateway provider OAuth refresh conflict'
        )
          return this.#readOAuthSnapshot(
            snapshot.credentialId,
            snapshot.providerType,
          );
        throw new Error('gateway OAuth credential update failed');
      }
    })();
    tracked = refresh.finally(() => {
      if (this.#refreshes.get(snapshot.credentialId) === tracked)
        this.#refreshes.delete(snapshot.credentialId);
    });
    this.#refreshes.set(snapshot.credentialId, tracked);
    void tracked.catch(() => undefined);
    return tracked;
  }

  #oauthSource(
    row: AuthorizedRow,
    providerType: OAuthProviderType,
  ): DispatchOAuthCredentialSource {
    return new DispatchOAuthCredentialSource(
      oauthSnapshotFromRow(row, providerType),
      this.#now,
      (snapshot) => this.#refreshOAuth(snapshot),
    );
  }

  authenticateNode(token: unknown): AuthenticatedNode | null {
    return this.#credentials.authenticateNode(token);
  }

  catalogForInstance(instanceId: string) {
    return this.#providers.catalogForInstance(instanceId);
  }

  dispatch(input: {
    readonly instanceId: string;
    readonly request: LlmProxyRequest;
    readonly model: LlmProxyCatalogModel;
    readonly signal: AbortSignal;
  }): Promise<GatewayLlmProxyExchange> {
    if (this.#draining)
      return Promise.reject(new Error('gateway LLM broker is draining'));
    const operation = this.#dispatch(input);
    this.#activeDispatches.add(operation);
    void operation.then(
      () => this.#activeDispatches.delete(operation),
      () => this.#activeDispatches.delete(operation),
    );
    return operation;
  }

  async drain(): Promise<void> {
    this.#draining = true;
    while (this.#activeDispatches.size > 0 || this.#refreshes.size > 0) {
      await Promise.allSettled([
        ...this.#activeDispatches,
        ...this.#refreshes.values(),
      ]);
    }
  }

  async #dispatch(input: {
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
      if (row.provider_type === 'openai-compatible') {
        if (row.auth_kind !== 'api-key' || request.transport.kind !== 'none')
          refused();
        assertOpenAiGrammar(row, model);
      } else if (row.provider_type === 'anthropic-oauth') {
        if (
          row.auth_kind !== 'oauth' ||
          request.transport.kind !== 'none' ||
          request.route !== 'messages'
        )
          refused();
        assertAnthropicGrammar(row, model);
      } else if (row.provider_type === 'codex-oauth') {
        if (
          row.auth_kind !== 'oauth' ||
          request.transport.kind !== 'codex' ||
          row.base_url !== 'https://chatgpt.com/backend-api'
        )
          refused();
        assertCodexGrammar(row, model);
      } else {
        refused();
      }
    } catch {
      refused();
    }
    if (signal.aborted) throw abortReason(signal);
    const baseUrl = text(row.base_url);
    try {
      if (row.provider_type === 'openai-compatible') {
        const route = request.route;
        if (route !== 'responses' && route !== 'chat/completions') refused();
        const apiKey = secret(row.api_key);
        const providerFetch = createOpenAICompatibleFetch({
          baseUrl,
          apiKey: async () => apiKey,
          fetch: this.#fetch,
          dispatcher: this.#dispatcher,
        });
        return exchangeFromResponse(
          await providerFetch(`${baseUrl.replace(/\/+$/, '')}/${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(payload),
            signal,
          }),
        );
      }
      if (row.provider_type === 'anthropic-oauth') {
        const credentials = this.#oauthSource(row, 'anthropic-oauth');
        const transport = createAnthropicOAuthTransport({
          baseUrl,
          credentials,
          unauthorized: 'return-response',
          fetch: this.#fetch,
          dispatcher: this.#dispatcher,
        });
        const transportRequest = {
          body: payload,
          stream: streamFromPayload(payload),
          signal,
        };
        const first = await transport(transportRequest);
        if (first.status !== 401) return exchangeFromResponse(first);
        try {
          await awaitWithAbort(() => credentials.forceRefresh(), signal);
        } catch {
          if (signal.aborted) throw abortReason(signal);
          return exchangeFromResponse(first);
        }
        cancelResponseBody(first);
        return exchangeFromResponse(await transport(transportRequest));
      }
      if (request.transport.kind !== 'codex') refused();
      const sessionId = request.transport.sessionId;
      const route = request.route;
      const target =
        route === 'codex/responses'
          ? 'https://chatgpt.com/backend-api/codex/responses'
          : route === 'codex/models'
            ? 'https://chatgpt.com/backend-api/codex/models'
            : route === 'models'
              ? 'https://chatgpt.com/backend-api/models'
              : null;
      if (target === null) refused();
      const providerFetch = createCodexOAuthFetch({
        credentials: this.#oauthSource(row, 'codex-oauth'),
        sessionId: () => sessionId,
        preserveTransportHeaders: false,
        fetch: this.#fetch,
        dispatcher: this.#dispatcher,
      });
      return exchangeFromResponse(
        await providerFetch(target, {
          method: route === 'codex/responses' ? 'POST' : 'GET',
          headers:
            route === 'codex/responses'
              ? { 'content-type': 'application/json' }
              : undefined,
          body: route === 'codex/responses' ? Buffer.from(payload) : undefined,
          signal,
        }),
      );
    } catch {
      if (signal.aborted) throw abortReason(signal);
      throw new Error('gateway LLM provider dispatch failed');
    }
  }
}

export function createGatewayLlmProxyApi(
  options: CreateGatewayLlmProxyApiOptions,
): GatewayLlmBrokerApi {
  return new GatewayLlmBroker(options);
}
