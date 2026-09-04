import { randomBytes as systemRandomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LlmProxyProviderType } from '@elpis/gateway-protocol';
import type { RandomBytes } from './credentials.js';

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
