// store.ts — resident SQLite adapter for shared OAuth credential lifecycle.

import type { DatabaseSync } from 'node:sqlite';
import {
  OAuthCredentialManager,
  type OAuthCredentialStorage,
  type OAuthCredentials,
  type OAuthRefreshFn,
} from '@elpis/provider-transport';

export type { OAuthCredentials } from '@elpis/provider-transport';
export type RefreshFn = OAuthRefreshFn;

interface Row {
  access: string;
  refresh: string;
  expires: number;
  account_id: string | null;
  email: string | null;
  org_id: string | null;
  org_name: string | null;
  authorized_at: number | null;
}

function rowToCredentials(row: Row): OAuthCredentials {
  return {
    access: row.access,
    refresh: row.refresh,
    expires: row.expires,
    accountId: row.account_id ?? undefined,
    email: row.email ?? undefined,
    orgId: row.org_id ?? undefined,
    orgName: row.org_name ?? undefined,
    authorizedAt: row.authorized_at ?? undefined,
  };
}

class SqliteOAuthCredentialStorage implements OAuthCredentialStorage {
  readonly #db: DatabaseSync;
  readonly #provider: string;

  constructor(db: DatabaseSync, provider: string) {
    this.#db = db;
    this.#provider = provider;
  }

  get location(): string {
    return `elpis.db oauth_credentials[provider=${this.#provider}]`;
  }

  read(): OAuthCredentials | undefined {
    const row = this.#db
      .prepare(
        'SELECT access, refresh, expires, account_id, email, org_id, org_name, authorized_at FROM oauth_credentials WHERE provider = ?',
      )
      .get(this.#provider) as Row | undefined;
    return row ? rowToCredentials(row) : undefined;
  }

  write(credentials: OAuthCredentials): void {
    this.#db
      .prepare(
        `INSERT INTO oauth_credentials (provider, access, refresh, expires, account_id, email, org_id, org_name, authorized_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
           access = excluded.access, refresh = excluded.refresh, expires = excluded.expires,
           account_id = excluded.account_id, email = excluded.email, org_id = excluded.org_id,
           org_name = excluded.org_name, authorized_at = excluded.authorized_at, updated_at = excluded.updated_at`,
      )
      .run(
        this.#provider,
        credentials.access,
        credentials.refresh,
        credentials.expires,
        credentials.accountId ?? null,
        credentials.email ?? null,
        credentials.orgId ?? null,
        credentials.orgName ?? null,
        credentials.authorizedAt ?? null,
        Date.now(),
      );
  }

  compareAndWrite(
    expected: OAuthCredentials,
    replacement: OAuthCredentials,
  ): boolean {
    const result = this.#db
      .prepare(
        `UPDATE oauth_credentials SET
           access = ?, refresh = ?, expires = ?, account_id = ?, email = ?,
           org_id = ?, org_name = ?, authorized_at = ?, updated_at = ?
         WHERE provider = ? AND access = ? AND refresh = ? AND expires = ?
           AND account_id IS ? AND email IS ? AND org_id IS ? AND org_name IS ?
           AND authorized_at IS ?`,
      )
      .run(
        replacement.access,
        replacement.refresh,
        replacement.expires,
        replacement.accountId ?? null,
        replacement.email ?? null,
        replacement.orgId ?? null,
        replacement.orgName ?? null,
        replacement.authorizedAt ?? null,
        Date.now(),
        this.#provider,
        expected.access,
        expected.refresh,
        expected.expires,
        expected.accountId ?? null,
        expected.email ?? null,
        expected.orgId ?? null,
        expected.orgName ?? null,
        expected.authorizedAt ?? null,
      );
    return result.changes === 1;
  }
}

export class OAuthStore {
  readonly #manager: OAuthCredentialManager;

  constructor(db: DatabaseSync, provider: string, refresh: RefreshFn) {
    this.#manager = new OAuthCredentialManager({
      storage: new SqliteOAuthCredentialStorage(db, provider),
      refresh,
    });
  }

  get location(): string {
    return this.#manager.location;
  }

  read(): OAuthCredentials | undefined {
    return this.#manager.read();
  }

  write(credentials: OAuthCredentials): void {
    this.#manager.write(credentials);
  }

  isLoggedIn(): boolean {
    return this.#manager.isLoggedIn();
  }

  forceRefresh(): Promise<void> {
    return this.#manager.forceRefresh();
  }

  getAccessToken(): Promise<string> {
    return this.#manager.getAccessToken();
  }
}
