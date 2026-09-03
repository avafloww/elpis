/** Stored OAuth grant. `expires` is an absolute epoch-millisecond deadline. */
export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  /** Epoch milliseconds when the interactive login seeded this grant family. */
  authorizedAt?: number;
}

/**
 * Refresh returns a fresh credential slice. The manager validates it and merges
 * it over the stored grant so provider-omitted identity fields survive.
 */
export type OAuthRefreshFn = (
  refreshToken: string,
) => Promise<OAuthCredentials>;

export interface OAuthCredentialStorage {
  readonly location: string;
  read(): OAuthCredentials | undefined;
  write(credentials: OAuthCredentials): void;
  /** Atomically replace `expected`; false means another writer won. */
  compareAndWrite(
    expected: OAuthCredentials,
    replacement: OAuthCredentials,
  ): boolean;
}

export interface OAuthCredentialManagerOptions {
  readonly storage: OAuthCredentialStorage;
  readonly refresh: OAuthRefreshFn;
  readonly now?: () => number;
  readonly refreshSkewMs?: number;
}

export const DEFAULT_OAUTH_REFRESH_SKEW_MS = 60_000;
const MAX_OAUTH_SECRET_LENGTH = 131_072;
const MAX_OAUTH_IDENTITY_LENGTH = 4_096;
const CREDENTIAL_FIELDS = new Set([
  'access',
  'refresh',
  'expires',
  'accountId',
  'email',
  'orgId',
  'orgName',
  'authorizedAt',
]);

export class OAuthCredentialValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthCredentialValidationError';
  }
}

function invalidCredential(message: string): never {
  throw new OAuthCredentialValidationError(`OAuth credential ${message}`);
}

function requiredSecret(
  record: Record<string, unknown>,
  key: 'access' | 'refresh',
): string {
  const value = record[key];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_OAUTH_SECRET_LENGTH
  )
    invalidCredential(`${key} must be a non-empty bounded string`);
  return value;
}

function optionalIdentity(
  record: Record<string, unknown>,
  key: 'accountId' | 'email' | 'orgId' | 'orgName',
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_OAUTH_IDENTITY_LENGTH)
    invalidCredential(`${key} must be a bounded string when present`);
  return value;
}

function epochMilliseconds(
  value: unknown,
  key: 'expires' | 'authorizedAt',
  optional = false,
): number | undefined {
  if (optional && value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    invalidCredential(`${key} must be non-negative epoch milliseconds`);
  return value as number;
}

export function validateOAuthCredentials(value: unknown): OAuthCredentials {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalidCredential('must be an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    invalidCredential('must be a plain object');
  const record = value as Record<string, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !CREDENTIAL_FIELDS.has(key))
      invalidCredential('has an unknown field');
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
      invalidCredential('fields must be enumerable data properties');
  }
  if (
    !Object.hasOwn(record, 'access') ||
    !Object.hasOwn(record, 'refresh') ||
    !Object.hasOwn(record, 'expires')
  )
    invalidCredential('is missing a required field');

  const credentials: OAuthCredentials = {
    access: requiredSecret(record, 'access'),
    refresh: requiredSecret(record, 'refresh'),
    expires: epochMilliseconds(record.expires, 'expires') as number,
  };
  const accountId = optionalIdentity(record, 'accountId');
  const email = optionalIdentity(record, 'email');
  const orgId = optionalIdentity(record, 'orgId');
  const orgName = optionalIdentity(record, 'orgName');
  const authorizedAt = epochMilliseconds(
    record.authorizedAt,
    'authorizedAt',
    true,
  );
  if (accountId !== undefined) credentials.accountId = accountId;
  if (email !== undefined) credentials.email = email;
  if (orgId !== undefined) credentials.orgId = orgId;
  if (orgName !== undefined) credentials.orgName = orgName;
  if (authorizedAt !== undefined) credentials.authorizedAt = authorizedAt;
  return credentials;
}

export function oauthCredentialsEqual(
  left: OAuthCredentials,
  right: OAuthCredentials,
): boolean {
  return (
    left.access === right.access &&
    left.refresh === right.refresh &&
    left.expires === right.expires &&
    left.accountId === right.accountId &&
    left.email === right.email &&
    left.orgId === right.orgId &&
    left.orgName === right.orgName &&
    left.authorizedAt === right.authorizedAt
  );
}

export class OAuthCredentialManager {
  readonly #storage: OAuthCredentialStorage;
  readonly #refreshFn: OAuthRefreshFn;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;
  #refreshing: Promise<OAuthCredentials> | null = null;

  constructor(options: OAuthCredentialManagerOptions) {
    if (!options || typeof options !== 'object')
      throw new TypeError('OAuth credential manager options are required');
    if (!options.storage || typeof options.storage !== 'object')
      throw new TypeError('OAuth credential storage is required');
    if (
      typeof options.storage.location !== 'string' ||
      options.storage.location.length === 0 ||
      typeof options.storage.read !== 'function' ||
      typeof options.storage.write !== 'function' ||
      typeof options.storage.compareAndWrite !== 'function'
    )
      throw new TypeError('OAuth credential storage is invalid');
    if (typeof options.refresh !== 'function')
      throw new TypeError('OAuth refresh function is required');
    if (options.now !== undefined && typeof options.now !== 'function')
      throw new TypeError('OAuth clock must be a function');
    const refreshSkewMs =
      options.refreshSkewMs ?? DEFAULT_OAUTH_REFRESH_SKEW_MS;
    if (!Number.isSafeInteger(refreshSkewMs) || refreshSkewMs < 0)
      throw new TypeError('OAuth refresh skew must be a non-negative integer');

    this.#storage = options.storage;
    this.#refreshFn = options.refresh;
    this.#now = options.now ?? Date.now;
    this.#refreshSkewMs = refreshSkewMs;
  }

  get location(): string {
    return this.#storage.location;
  }

  read(): OAuthCredentials | undefined {
    const credentials = this.#storage.read();
    return credentials === undefined
      ? undefined
      : validateOAuthCredentials(credentials);
  }

  write(credentials: OAuthCredentials): void {
    this.#storage.write(validateOAuthCredentials(credentials));
  }

  isLoggedIn(): boolean {
    return this.read() !== undefined;
  }

  async forceRefresh(): Promise<void> {
    const credentials = this.read();
    if (credentials) await this.#refresh(credentials);
  }

  async getAccessToken(): Promise<string> {
    const credentials = this.read();
    if (!credentials) {
      throw new Error(
        `no OAuth credential in ${this.location} — run the login flow first (npm run oauth-login)`,
      );
    }
    if (this.#now() < credentials.expires - this.#refreshSkewMs)
      return credentials.access;
    return (await this.#refresh(credentials)).access;
  }

  async #refresh(current: OAuthCredentials): Promise<OAuthCredentials> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const fresh = validateOAuthCredentials(
        await this.#refreshFn(current.refresh),
      );
      const merged = validateOAuthCredentials({ ...current, ...fresh });
      if (this.#storage.compareAndWrite(current, merged)) return merged;
      const replacement = this.read();
      if (replacement) return replacement;
      throw new Error(
        `OAuth credential in ${this.location} changed while refresh was in flight`,
      );
    })();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }
}
