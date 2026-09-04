import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  decodeLlmProxyCatalog,
  isLlmTargetGeneration,
  LLM_PROXY_FORMATS,
  newLlmTargetGeneration,
  serializeLlmProxyCatalog,
  type LlmProxyCatalog,
  type LlmProxyCatalogModel,
  type LlmProxyProviderType,
  type LlmProxyRoute,
  type LlmProxyToolTier,
  type LlmTargetGeneration,
} from '@elpis/gateway-protocol';
import { isGatewayInstanceId, type RandomBytes } from './credentials.js';

const MAX_SECRET_BYTES = 131072;
const MAX_ACCOUNT_TEXT_BYTES = 4096;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const OAUTH_PROVIDER_TYPES = new Set<LlmProxyProviderType>([
  'anthropic-oauth',
  'codex-oauth',
]);
const ACCOUNT_IDENTITY_KEYS = Object.freeze([
  'accountId',
  'email',
  'orgId',
  'orgName',
  'authorizedAt',
] as const);
const ACCOUNT_IDENTITY_KEY_SET = new Set<string>(ACCOUNT_IDENTITY_KEYS);

type OAuthProviderType = 'anthropic-oauth' | 'codex-oauth';
type AuthKind = 'api-key' | 'oauth';

type AuditSink = (
  input: {
    actorKind: string;
    action: string;
    targetKind: string;
    targetId: string;
    outcome: 'succeeded';
    detail: Record<string, unknown>;
  },
  at: number,
) => number;

export interface GatewayProviderCredentialReceipt {
  readonly credentialId: string;
  readonly providerId: string;
  readonly providerType: LlmProxyProviderType;
  readonly authKind: AuthKind;
  readonly secretRevision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InstallApiKeyCredentialInput {
  readonly providerId: string;
  readonly accountRef: string;
  readonly apiKey: string;
}

export interface GatewayOAuthAccountIdentity {
  readonly accountId?: string | null;
  readonly email?: string | null;
  readonly orgId?: string | null;
  readonly orgName?: string | null;
  readonly authorizedAt?: number | null;
}

export interface InstallOAuthCredentialInput {
  readonly providerId: string;
  readonly providerType: OAuthProviderType;
  readonly accountRef: string;
  readonly accountIdentity: GatewayOAuthAccountIdentity;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export interface RefreshOAuthCredentialInput {
  readonly credentialId: string;
  readonly expectedSecretRevision: number;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export interface ConfigureProviderModelInput {
  readonly credentialId: string;
  readonly modelRef: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly allowedRoutes: readonly LlmProxyRoute[];
  readonly wireGrammar: Readonly<Record<string, string>>;
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

export interface ProviderModelInput {
  readonly modelRef: string;
}

export interface InstanceProviderModelInput extends ProviderModelInput {
  readonly instanceId: string;
}

export interface GatewayProviderTargetReceipt {
  readonly changed: boolean;
  readonly modelRef: string;
  readonly targetGeneration: LlmTargetGeneration;
  readonly revision: number;
}

export interface GatewayProviderGrantReceipt extends GatewayProviderTargetReceipt {
  readonly instanceId: string;
}

export interface GatewayProviderRevokeReceipt {
  readonly changed: boolean;
  readonly instanceId: string;
  readonly modelRef: string;
  readonly revision: number;
}

function exactInput(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string'))
    throw new Error(`${label} has invalid fields`);
  const actual = keys as string[];
  if (
    actual.length !== expectedKeys.length ||
    [...actual]
      .sort()
      .some((key, index) => key !== [...expectedKeys].sort()[index])
  )
    throw new Error(`${label} has invalid fields`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new Error(`${label} has invalid fields`);
  }
  return value as Record<string, unknown>;
}

function safeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} must be a nonnegative safe integer`);
  return value as number;
}

function boundedPlainText(
  value: unknown,
  label: string,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > maximum ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error(`${label} has invalid syntax`);
  return value;
}

function providerId(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ID_PATTERN.test(value))
    throw new Error('provider id has invalid syntax');
  return value;
}

function accountRef(value: unknown): string {
  return boundedPlainText(value, 'provider account reference', 256);
}

function secretBytes(value: unknown, label: string): Buffer {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    Buffer.byteLength(value, 'utf8') > MAX_SECRET_BYTES ||
    /[\s\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new Error(`${label} has invalid syntax`);
  return Buffer.from(value, 'utf8');
}

function credentialId(value: unknown): string {
  if (typeof value !== 'string' || !/^epc1\.[A-Za-z0-9_-]{22}$/.test(value))
    throw new Error('provider credential id has invalid syntax');
  const suffix = value.slice(5);
  if (Buffer.from(suffix, 'base64url').toString('base64url') !== suffix)
    throw new Error('provider credential id has invalid syntax');
  return value;
}

function newCredentialId(randomBytes: RandomBytes): string {
  const bytes = randomBytes(16);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== 16)
    throw new Error('provider credential random source returned invalid bytes');
  return `epc1.${bytes.toString('base64url')}`;
}

function canonicalAccountIdentity(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('provider account identity must be an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    throw new Error('provider account identity must be a plain object');
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== 'string') ||
    keys.some((key) => !ACCOUNT_IDENTITY_KEY_SET.has(key as string))
  )
    throw new Error('provider account identity has invalid fields');
  const source = value as Record<string, unknown>;
  const result: Record<string, string | number | null> = {};
  for (const key of ACCOUNT_IDENTITY_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || !('value' in descriptor))
      throw new Error('provider account identity has invalid fields');
    const candidate = descriptor.value;
    if (candidate === null) {
      result[key] = null;
    } else if (key === 'authorizedAt') {
      result[key] = safeInteger(candidate, 'provider authorization timestamp');
    } else {
      result[key] = boundedPlainText(
        candidate,
        `provider account ${key}`,
        MAX_ACCOUNT_TEXT_BYTES,
      );
    }
  }
  return JSON.stringify(result);
}

function oauthProviderType(value: unknown): OAuthProviderType {
  if (
    typeof value !== 'string' ||
    !OAUTH_PROVIDER_TYPES.has(value as LlmProxyProviderType)
  )
    throw new Error('OAuth provider type is invalid');
  return value as OAuthProviderType;
}

function receiptFromRow(
  row: Record<string, unknown> | undefined,
): GatewayProviderCredentialReceipt {
  if (!row) throw new Error('provider credential receipt is missing');
  const type = row.provider_type;
  if (
    typeof type !== 'string' ||
    (type !== 'openai-compatible' &&
      !OAUTH_PROVIDER_TYPES.has(type as LlmProxyProviderType))
  )
    throw new Error('provider credential receipt is invalid');
  const kind = row.auth_kind;
  if (kind !== 'api-key' && kind !== 'oauth')
    throw new Error('provider credential receipt is invalid');
  return Object.freeze({
    credentialId: credentialId(row.id),
    providerId: providerId(row.provider_id),
    providerType: type as LlmProxyProviderType,
    authKind: kind,
    secretRevision: safeInteger(
      row.oauth_secret_revision,
      'provider secret revision',
    ),
    createdAt: safeInteger(
      row.created_at,
      'provider credential created timestamp',
    ),
    updatedAt: safeInteger(
      row.updated_at,
      'provider credential updated timestamp',
    ),
  });
}

interface ProviderCredentialIdentity {
  readonly credentialId: string;
  readonly providerId: string;
  readonly providerType: LlmProxyProviderType;
  readonly accountRef: string;
  readonly accountIdentityJson: string;
}

interface ProviderHeadRow extends Record<string, unknown> {
  readonly target_seq: unknown;
  readonly target_generation: unknown;
  readonly enabled: unknown;
  readonly snapshot_sha256?: unknown;
}

const ZERO_TARGET_GENERATION =
  'egt1.AAAAAAAAAAAAAAAAAAAAAA' as LlmTargetGeneration;
const WIRE_GRAMMAR_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

function modelRef(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > 256 ||
    !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(value)
  )
    throw new Error('provider model reference has invalid syntax');
  return value;
}

function instanceId(value: unknown): string {
  if (!isGatewayInstanceId(value))
    throw new Error('gateway instance id has invalid syntax');
  return value;
}

function canonicalBaseUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 8 ||
    Buffer.byteLength(value, 'utf8') > 2048
  )
    throw new Error('provider base URL has invalid syntax');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('provider base URL has invalid syntax');
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.href !== value
  )
    throw new Error('provider base URL has invalid syntax');
  return value;
}

function canonicalWireGrammar(
  value: unknown,
  routes: readonly LlmProxyRoute[],
): string {
  const keys = [...routes].sort((left, right) => left.localeCompare(right));
  const input = exactInput(value, keys, 'provider wire grammar');
  const result: Record<string, string> = {};
  for (const route of keys) {
    const grammar = input[route];
    if (typeof grammar !== 'string' || !WIRE_GRAMMAR_PATTERN.test(grammar))
      throw new Error('provider wire grammar has invalid syntax');
    result[route] = grammar;
  }
  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') > 4096)
    throw new Error('provider wire grammar is too large');
  return encoded;
}

function catalogRevision(database: DatabaseSync): number {
  const row = database
    .prepare(
      'SELECT revision FROM gateway_provider_catalog WHERE singleton_id = 1',
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) throw new Error('provider catalog singleton is missing');
  return safeInteger(row.revision, 'provider catalog revision');
}

function providerType(value: unknown): LlmProxyProviderType {
  if (
    value !== 'openai-compatible' &&
    value !== 'anthropic-oauth' &&
    value !== 'codex-oauth'
  )
    throw new Error('provider type is invalid');
  return value;
}

function credentialIdentity(
  row: Record<string, unknown> | undefined,
): ProviderCredentialIdentity {
  if (!row) throw new Error('credential-not-found');
  const identityJson = row.account_identity_json;
  if (typeof identityJson !== 'string')
    throw new Error('stored provider credential identity is invalid');
  return Object.freeze({
    credentialId: credentialId(row.id),
    providerId: providerId(row.provider_id),
    providerType: providerType(row.provider_type),
    accountRef: accountRef(row.account_ref),
    accountIdentityJson: identityJson,
  });
}

function normalizeCatalogModel(
  input: Record<string, unknown>,
  type: LlmProxyProviderType,
  generation: LlmTargetGeneration,
): LlmProxyCatalogModel {
  const candidate = {
    format: LLM_PROXY_FORMATS.catalog,
    revision: 0,
    models: [
      {
        modelRef: input.modelRef,
        targetGeneration: generation,
        providerType: type,
        model: input.model,
        allowedRoutes: input.allowedRoutes,
        contextSize: input.contextSize,
        reasoningEffort: input.reasoningEffort,
        reasoningSummary: input.reasoningSummary,
        reasoningContext: input.reasoningContext,
        toolTier: input.toolTier,
        externalThinking: input.externalThinking,
        toolContractVersion: input.toolContractVersion,
        callTimeoutMs: input.callTimeoutMs,
        streamIdleTimeoutMs: input.streamIdleTimeoutMs,
      },
    ],
  } as LlmProxyCatalog;
  const model = decodeLlmProxyCatalog(serializeLlmProxyCatalog(candidate))
    .models[0];
  if (model.callTimeoutMs < 1 || model.streamIdleTimeoutMs < 1)
    throw new Error('provider timeouts must be positive');
  return model;
}

function targetSnapshotSha256(
  credential: ProviderCredentialIdentity,
  baseUrl: string,
  model: LlmProxyCatalogModel,
  wireGrammarJson: string,
): Buffer {
  const json = JSON.stringify({
    credentialId: credential.credentialId,
    providerId: credential.providerId,
    providerType: credential.providerType,
    accountRef: credential.accountRef,
    accountIdentity: JSON.parse(credential.accountIdentityJson) as unknown,
    baseUrl,
    model: model.model,
    allowedRoutes: model.allowedRoutes,
    wireGrammar: JSON.parse(wireGrammarJson) as unknown,
    contextSize: model.contextSize,
    reasoningEffort: model.reasoningEffort,
    reasoningSummary: model.reasoningSummary,
    reasoningContext: model.reasoningContext,
    toolTier: model.toolTier,
    externalThinking: model.externalThinking,
    toolContractVersion: model.toolContractVersion,
    callTimeoutMs: model.callTimeoutMs,
    streamIdleTimeoutMs: model.streamIdleTimeoutMs,
  });
  return createHash('sha256').update(json).digest();
}

function snapshotMatches(value: unknown, expected: Buffer): boolean {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) return false;
  return Buffer.from(value).equals(expected);
}

function targetGeneration(value: unknown): LlmTargetGeneration {
  if (!isLlmTargetGeneration(value))
    throw new Error('provider target generation is invalid');
  return value;
}

function targetReceipt(
  changed: boolean,
  ref: string,
  generation: LlmTargetGeneration,
  revision: number,
): GatewayProviderTargetReceipt {
  return Object.freeze({
    changed,
    modelRef: ref,
    targetGeneration: generation,
    revision,
  });
}

function grantReceipt(
  changed: boolean,
  resident: string,
  ref: string,
  generation: LlmTargetGeneration,
  revision: number,
): GatewayProviderGrantReceipt {
  return Object.freeze({
    changed,
    instanceId: resident,
    modelRef: ref,
    targetGeneration: generation,
    revision,
  });
}

function revokeReceipt(
  changed: boolean,
  resident: string,
  ref: string,
  revision: number,
): GatewayProviderRevokeReceipt {
  return Object.freeze({
    changed,
    instanceId: resident,
    modelRef: ref,
    revision,
  });
}

function catalogFromRows(
  revision: number,
  rows: readonly Record<string, unknown>[],
): LlmProxyCatalog {
  const models = rows.map((row) => {
    if (row.external_thinking !== 0 && row.external_thinking !== 1)
      throw new Error('stored provider catalog is invalid');
    return {
      modelRef: row.model_ref,
      targetGeneration: row.target_generation,
      providerType: row.provider_type,
      model: row.upstream_model,
      allowedRoutes: JSON.parse(String(row.allowed_routes_json)) as unknown,
      contextSize: row.context_size,
      reasoningEffort: row.reasoning_effort,
      reasoningSummary: row.reasoning_summary,
      reasoningContext: row.reasoning_context,
      toolTier: row.tool_tier,
      externalThinking: row.external_thinking === 1,
      toolContractVersion: row.tool_contract_version,
      callTimeoutMs: row.call_timeout_ms,
      streamIdleTimeoutMs: row.stream_idle_timeout_ms,
    };
  });
  return decodeLlmProxyCatalog(
    serializeLlmProxyCatalog({
      format: LLM_PROXY_FORMATS.catalog,
      revision,
      models,
    } as LlmProxyCatalog),
  );
}

function sanitizedInstallError(error: unknown): Error {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('gateway provider namespace type is immutable'))
    return new Error('gateway provider namespace type is immutable');
  return new Error('gateway provider credential installation failed');
}

export class GatewayProviderStore {
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #audit: AuditSink;
  readonly #harden: () => void;
  readonly #randomBytes: RandomBytes;

  constructor(
    database: DatabaseSync,
    now: () => number,
    audit: AuditSink,
    harden: () => void,
    randomBytes: RandomBytes = systemRandomBytes,
  ) {
    this.#database = database;
    this.#now = now;
    this.#audit = audit;
    this.#harden = harden;
    this.#randomBytes = randomBytes;
  }

  installApiKeyCredential(
    value: InstallApiKeyCredentialInput,
  ): GatewayProviderCredentialReceipt {
    const input = exactInput(
      value,
      ['providerId', 'accountRef', 'apiKey'],
      'API-key credential input',
    );
    return this.install({
      providerId: providerId(input.providerId),
      providerType: 'openai-compatible',
      accountRef: accountRef(input.accountRef),
      accountIdentityJson: '{}',
      authKind: 'api-key',
      apiKey: secretBytes(input.apiKey, 'provider API key'),
      oauthAccess: null,
      oauthRefresh: null,
      oauthExpires: null,
    });
  }

  installOAuthCredential(
    value: InstallOAuthCredentialInput,
  ): GatewayProviderCredentialReceipt {
    const input = exactInput(
      value,
      [
        'providerId',
        'providerType',
        'accountRef',
        'accountIdentity',
        'accessToken',
        'refreshToken',
        'expiresAt',
      ],
      'OAuth credential input',
    );
    return this.install({
      providerId: providerId(input.providerId),
      providerType: oauthProviderType(input.providerType),
      accountRef: accountRef(input.accountRef),
      accountIdentityJson: canonicalAccountIdentity(input.accountIdentity),
      authKind: 'oauth',
      apiKey: null,
      oauthAccess: secretBytes(
        input.accessToken,
        'provider OAuth access token',
      ),
      oauthRefresh: secretBytes(
        input.refreshToken,
        'provider OAuth refresh token',
      ),
      oauthExpires: safeInteger(input.expiresAt, 'provider OAuth expiry'),
    });
  }

  refreshOAuthCredential(
    value: RefreshOAuthCredentialInput,
  ): GatewayProviderCredentialReceipt {
    const input = exactInput(
      value,
      [
        'credentialId',
        'expectedSecretRevision',
        'accessToken',
        'refreshToken',
        'expiresAt',
      ],
      'OAuth refresh input',
    );
    const id = credentialId(input.credentialId);
    const expected = safeInteger(
      input.expectedSecretRevision,
      'expected OAuth secret revision',
    );
    const access = secretBytes(
      input.accessToken,
      'provider OAuth access token',
    );
    const refresh = secretBytes(
      input.refreshToken,
      'provider OAuth refresh token',
    );
    const expires = safeInteger(input.expiresAt, 'provider OAuth expiry');
    const at = safeInteger(this.#now(), 'provider credential timestamp');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database
        .prepare(
          `UPDATE gateway_provider_credentials
           SET oauth_access = ?, oauth_refresh = ?, oauth_expires = ?,
               oauth_secret_revision = oauth_secret_revision + 1, updated_at = ?
           WHERE id = ? AND auth_kind = 'oauth' AND oauth_secret_revision = ?
           RETURNING id, provider_id, provider_type, auth_kind,
                     oauth_secret_revision, created_at, updated_at`,
        )
        .get(access, refresh, expires, at, id, expected) as
        Record<string, unknown> | undefined;
      if (!row) throw new Error('oauth-refresh-conflict');
      const receipt = receiptFromRow(row);
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'provider.oauth.refresh',
          targetKind: 'provider-credential',
          targetId: receipt.credentialId,
          outcome: 'succeeded',
          detail: {
            providerId: receipt.providerId,
            providerType: receipt.providerType,
            authKind: receipt.authKind,
            secretRevision: receipt.secretRevision,
          },
        },
        at,
      );
      this.#harden();
      this.#database.exec('COMMIT');
      return receipt;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the refresh failure */
      }
      if (error instanceof Error && error.message === 'oauth-refresh-conflict')
        throw new Error('gateway provider OAuth refresh conflict');
      throw new Error('gateway provider OAuth refresh failed');
    }
  }

  configureModel(
    value: ConfigureProviderModelInput,
  ): GatewayProviderTargetReceipt {
    const input = exactInput(
      value,
      [
        'credentialId',
        'modelRef',
        'baseUrl',
        'model',
        'allowedRoutes',
        'wireGrammar',
        'contextSize',
        'reasoningEffort',
        'reasoningSummary',
        'reasoningContext',
        'toolTier',
        'externalThinking',
        'toolContractVersion',
        'callTimeoutMs',
        'streamIdleTimeoutMs',
      ],
      'provider model input',
    );
    const id = credentialId(input.credentialId);
    const baseUrl = canonicalBaseUrl(input.baseUrl);
    const at = safeInteger(this.#now(), 'provider model timestamp');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const credential = credentialIdentity(
        this.#database
          .prepare(
            `SELECT id, provider_id, provider_type, account_ref,
                    account_identity_json
             FROM gateway_provider_credentials WHERE id = ?`,
          )
          .get(id) as Record<string, unknown> | undefined,
      );
      const normalized = normalizeCatalogModel(
        input,
        credential.providerType,
        ZERO_TARGET_GENERATION,
      );
      if (normalized.modelRef.split('/', 1)[0] !== credential.providerId)
        throw new Error('credential-provider-mismatch');
      const wireGrammarJson = canonicalWireGrammar(
        input.wireGrammar,
        normalized.allowedRoutes,
      );
      const snapshotSha256 = targetSnapshotSha256(
        credential,
        baseUrl,
        normalized,
        wireGrammarJson,
      );
      const head = this.#database
        .prepare(
          `SELECT h.target_seq, h.target_generation, h.enabled,
                  t.snapshot_sha256
           FROM gateway_provider_model_heads AS h
           JOIN gateway_provider_targets AS t
             ON t.target_seq = h.target_seq
            AND t.model_ref = h.model_ref
            AND t.target_generation = h.target_generation
           WHERE h.model_ref = ?`,
        )
        .get(normalized.modelRef) as ProviderHeadRow | undefined;
      if (head) {
        if (head.enabled !== 0 && head.enabled !== 1)
          throw new Error('stored-model-head-invalid');
        if (
          head.enabled === 1 &&
          snapshotMatches(head.snapshot_sha256, snapshotSha256)
        ) {
          const receipt = targetReceipt(
            false,
            normalized.modelRef,
            targetGeneration(head.target_generation),
            catalogRevision(this.#database),
          );
          this.#database.exec('COMMIT');
          return receipt;
        }
      }

      const generation = newLlmTargetGeneration((size) =>
        this.#randomBytes(size),
      );
      const inserted = this.#database
        .prepare(
          `INSERT INTO gateway_provider_targets (
            target_generation, model_ref, provider_id, provider_type,
            credential_id, account_ref, account_identity_json, base_url,
            upstream_model, allowed_routes_json, wire_grammar_json, context_size,
            reasoning_effort, reasoning_summary, reasoning_context, tool_tier,
            external_thinking, tool_contract_version, call_timeout_ms,
            stream_idle_timeout_ms, snapshot_sha256, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          generation,
          normalized.modelRef,
          credential.providerId,
          credential.providerType,
          credential.credentialId,
          credential.accountRef,
          credential.accountIdentityJson,
          baseUrl,
          normalized.model,
          JSON.stringify(normalized.allowedRoutes),
          wireGrammarJson,
          normalized.contextSize,
          normalized.reasoningEffort,
          normalized.reasoningSummary,
          normalized.reasoningContext,
          normalized.toolTier,
          normalized.externalThinking ? 1 : 0,
          normalized.toolContractVersion,
          normalized.callTimeoutMs,
          normalized.streamIdleTimeoutMs,
          snapshotSha256,
          at,
        );
      const targetSeq = safeInteger(
        inserted.lastInsertRowid,
        'provider target sequence',
      );
      if (!head) {
        this.#database
          .prepare(
            `INSERT INTO gateway_provider_model_heads (
              model_ref, target_seq, target_generation, enabled,
              created_at, updated_at
            ) VALUES (?, ?, ?, 1, ?, ?)`,
          )
          .run(normalized.modelRef, targetSeq, generation, at, at);
      } else {
        const updated = this.#database
          .prepare(
            `UPDATE gateway_provider_model_heads
             SET target_seq = ?, target_generation = ?, enabled = 1, updated_at = ?
             WHERE model_ref = ?`,
          )
          .run(targetSeq, generation, at, normalized.modelRef);
        if (updated.changes !== 1) throw new Error('model-head-update-failed');
      }
      const revision = catalogRevision(this.#database);
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'provider.model.configure',
          targetKind: 'provider-model',
          targetId: normalized.modelRef,
          outcome: 'succeeded',
          detail: {
            modelRef: normalized.modelRef,
            targetGeneration: generation,
            providerType: credential.providerType,
          },
        },
        at,
      );
      this.#harden();
      this.#database.exec('COMMIT');
      return targetReceipt(true, normalized.modelRef, generation, revision);
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the configuration failure */
      }
      if (error instanceof Error && error.message === 'credential-not-found')
        throw new Error('gateway provider credential not found');
      throw new Error('gateway provider model configuration failed');
    }
  }

  disableModel(value: ProviderModelInput): GatewayProviderTargetReceipt {
    const input = exactInput(
      value,
      ['modelRef'],
      'provider model disable input',
    );
    const ref = modelRef(input.modelRef);
    const at = safeInteger(this.#now(), 'provider model timestamp');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const head = this.#database
        .prepare(
          `SELECT target_seq, target_generation, enabled
           FROM gateway_provider_model_heads WHERE model_ref = ?`,
        )
        .get(ref) as ProviderHeadRow | undefined;
      if (!head) throw new Error('model-not-found');
      const generation = targetGeneration(head.target_generation);
      if (head.enabled !== 0 && head.enabled !== 1)
        throw new Error('stored-model-head-invalid');
      if (head.enabled === 0) {
        const receipt = targetReceipt(
          false,
          ref,
          generation,
          catalogRevision(this.#database),
        );
        this.#database.exec('COMMIT');
        return receipt;
      }
      const updated = this.#database
        .prepare(
          `UPDATE gateway_provider_model_heads
           SET enabled = 0, updated_at = ? WHERE model_ref = ? AND enabled = 1`,
        )
        .run(at, ref);
      if (updated.changes !== 1) throw new Error('model-disable-failed');
      const revision = catalogRevision(this.#database);
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'provider.model.disable',
          targetKind: 'provider-model',
          targetId: ref,
          outcome: 'succeeded',
          detail: { modelRef: ref, targetGeneration: generation },
        },
        at,
      );
      this.#harden();
      this.#database.exec('COMMIT');
      return targetReceipt(true, ref, generation, revision);
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the disable failure */
      }
      if (error instanceof Error && error.message === 'model-not-found')
        throw new Error('gateway provider model not found');
      throw new Error('gateway provider model disable failed');
    }
  }

  grantModelToInstance(
    value: InstanceProviderModelInput,
  ): GatewayProviderGrantReceipt {
    const input = exactInput(
      value,
      ['instanceId', 'modelRef'],
      'provider model grant input',
    );
    const resident = instanceId(input.instanceId);
    const ref = modelRef(input.modelRef);
    const at = safeInteger(this.#now(), 'provider grant timestamp');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const live = this.#database
        .prepare(
          'SELECT 1 AS live FROM gateway_instances WHERE id = ? AND revoked_at IS NULL',
        )
        .get(resident);
      if (!live) throw new Error('instance-unavailable');
      const head = this.#database
        .prepare(
          `SELECT target_seq, target_generation, enabled
           FROM gateway_provider_model_heads
           WHERE model_ref = ? AND enabled = 1`,
        )
        .get(ref) as ProviderHeadRow | undefined;
      if (!head) throw new Error('model-unavailable');
      const generation = targetGeneration(head.target_generation);
      const targetSeq = safeInteger(
        head.target_seq,
        'provider target sequence',
      );
      const existing = this.#database
        .prepare(
          `SELECT target_seq, target_generation
           FROM gateway_instance_model_grants
           WHERE instance_id = ? AND model_ref = ?`,
        )
        .get(resident, ref) as Record<string, unknown> | undefined;
      if (existing) {
        if (
          safeInteger(existing.target_seq, 'provider grant target sequence') !==
            targetSeq ||
          targetGeneration(existing.target_generation) !== generation
        )
          throw new Error('stored-grant-invalid');
        const receipt = grantReceipt(
          false,
          resident,
          ref,
          generation,
          catalogRevision(this.#database),
        );
        this.#database.exec('COMMIT');
        return receipt;
      }
      this.#database
        .prepare(
          `INSERT INTO gateway_instance_model_grants (
            instance_id, model_ref, target_seq, target_generation, authorized_at
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(resident, ref, targetSeq, generation, at);
      try {
        this.catalogForInstance(resident);
      } catch {
        throw new Error('catalog-conflict');
      }
      const revision = catalogRevision(this.#database);
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'provider.instance-model.grant',
          targetKind: 'gateway-instance',
          targetId: resident,
          outcome: 'succeeded',
          detail: {
            instanceId: resident,
            modelRef: ref,
            targetGeneration: generation,
          },
        },
        at,
      );
      this.#harden();
      this.#database.exec('COMMIT');
      return grantReceipt(true, resident, ref, generation, revision);
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the grant failure */
      }
      if (error instanceof Error) {
        if (error.message === 'instance-unavailable')
          throw new Error('gateway provider grant instance unavailable');
        if (error.message === 'model-unavailable')
          throw new Error('gateway provider model unavailable');
        if (error.message === 'catalog-conflict')
          throw new Error('gateway provider grant conflicts with catalog');
      }
      throw new Error('gateway provider model grant failed');
    }
  }

  revokeModelFromInstance(
    value: InstanceProviderModelInput,
  ): GatewayProviderRevokeReceipt {
    const input = exactInput(
      value,
      ['instanceId', 'modelRef'],
      'provider model revoke input',
    );
    const resident = instanceId(input.instanceId);
    const ref = modelRef(input.modelRef);
    const at = safeInteger(this.#now(), 'provider grant timestamp');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const deleted = this.#database
        .prepare(
          `DELETE FROM gateway_instance_model_grants
           WHERE instance_id = ? AND model_ref = ?`,
        )
        .run(resident, ref);
      if (deleted.changes === 0) {
        const receipt = revokeReceipt(
          false,
          resident,
          ref,
          catalogRevision(this.#database),
        );
        this.#database.exec('COMMIT');
        return receipt;
      }
      if (deleted.changes !== 1) throw new Error('grant-delete-failed');
      const revision = catalogRevision(this.#database);
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'provider.instance-model.revoke',
          targetKind: 'gateway-instance',
          targetId: resident,
          outcome: 'succeeded',
          detail: { instanceId: resident, modelRef: ref },
        },
        at,
      );
      this.#harden();
      this.#database.exec('COMMIT');
      return revokeReceipt(true, resident, ref, revision);
    } catch {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the revoke failure */
      }
      throw new Error('gateway provider model revoke failed');
    }
  }

  catalogForInstance(value: string): LlmProxyCatalog {
    const resident = instanceId(value);
    const live = this.#database
      .prepare(
        'SELECT 1 AS live FROM gateway_instances WHERE id = ? AND revoked_at IS NULL',
      )
      .get(resident);
    if (!live) throw new Error('gateway provider catalog instance unavailable');
    const rows = this.#database
      .prepare(
        `SELECT
           t.model_ref, t.target_generation, t.provider_type,
           t.upstream_model, t.allowed_routes_json, t.context_size,
           t.reasoning_effort, t.reasoning_summary, t.reasoning_context,
           t.tool_tier, t.external_thinking, t.tool_contract_version,
           t.call_timeout_ms, t.stream_idle_timeout_ms
         FROM gateway_instance_model_grants AS g
         JOIN gateway_provider_model_heads AS h
           ON h.model_ref = g.model_ref
          AND h.target_seq = g.target_seq
          AND h.target_generation = g.target_generation
          AND h.enabled = 1
         JOIN gateway_provider_targets AS t
           ON t.model_ref = g.model_ref
          AND t.target_seq = g.target_seq
          AND t.target_generation = g.target_generation
         WHERE g.instance_id = ?`,
      )
      .all(resident) as unknown as Record<string, unknown>[];
    rows.sort((left, right) =>
      modelRef(left.model_ref).localeCompare(modelRef(right.model_ref)),
    );
    try {
      return catalogFromRows(catalogRevision(this.#database), rows);
    } catch {
      throw new Error('gateway provider catalog is invalid');
    }
  }

  private install(input: {
    providerId: string;
    providerType: LlmProxyProviderType;
    accountRef: string;
    accountIdentityJson: string;
    authKind: AuthKind;
    apiKey: Buffer | null;
    oauthAccess: Buffer | null;
    oauthRefresh: Buffer | null;
    oauthExpires: number | null;
  }): GatewayProviderCredentialReceipt {
    const id = newCredentialId(this.#randomBytes);
    const at = safeInteger(this.#now(), 'provider credential timestamp');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          `INSERT INTO gateway_provider_credentials (
            id, provider_id, provider_type, account_ref, account_identity_json,
            auth_kind, api_key, oauth_access, oauth_refresh, oauth_expires,
            oauth_secret_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          id,
          input.providerId,
          input.providerType,
          input.accountRef,
          input.accountIdentityJson,
          input.authKind,
          input.apiKey,
          input.oauthAccess,
          input.oauthRefresh,
          input.oauthExpires,
          at,
          at,
        );
      const receipt = receiptFromRow(
        this.#database
          .prepare(
            `SELECT id, provider_id, provider_type, auth_kind,
                    oauth_secret_revision, created_at, updated_at
             FROM gateway_provider_credentials WHERE id = ?`,
          )
          .get(id) as Record<string, unknown> | undefined,
      );
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'provider.credential.install',
          targetKind: 'provider-credential',
          targetId: receipt.credentialId,
          outcome: 'succeeded',
          detail: {
            providerId: receipt.providerId,
            providerType: receipt.providerType,
            authKind: receipt.authKind,
          },
        },
        at,
      );
      this.#harden();
      this.#database.exec('COMMIT');
      return receipt;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the installation failure */
      }
      throw sanitizedInstallError(error);
    }
  }
}
