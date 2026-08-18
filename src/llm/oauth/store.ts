// store.ts — provider-agnostic OAuth credential store + lazy refresh.
//
// Credentials for a subscription-OAuth provider (`anthropic-oauth` or
// `codex-oauth`) live in elpis.db's `oauth_credentials`
// table, one row per provider key. Keeping them in the DB (rather than a disk
// file) means one generic table serves every OAuth provider_type and the
// secrets sit alongside the rest of the agent's structured state.
//
// The store is the ONLY place credentials are read, refreshed, and persisted.
// A wire client calls `getAccessToken` before each request; the store returns
// the current access token, transparently refreshing (and re-persisting the
// rotated refresh token) when it is within REFRESH_SKEW_MS of expiry. Refreshes
// are single-flighted so a burst of concurrent requests triggers at most one
// token exchange.

import type { DatabaseSync } from 'node:sqlite';

/** One provider's stored OAuth grant. `expires` is an absolute epoch-ms
 * deadline (already skew-adjusted by the login/refresh code). Identity fields
 * are best-effort — captured for logging/attribution, never load-bearing. */
export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  /** Epoch-ms of the interactive login that seeded this grant family. The grant
 * dies ~30 days after this regardless of refresh health (see
 * ANTHROPIC_OAUTH_GRANT_TTL_MS); used only to warn before the deadline. */
  authorizedAt?: number;
}

/** How a provider refreshes an access token from a refresh token. Returns a
 * fresh credential slice; the store merges it over the stored record so
 * provider-omitted fields (e.g. org, fixed at login) survive. */
export type RefreshFn = (refreshToken: string) => Promise<OAuthCredentials>;

/** Refresh when the access token is within this window of expiry. The
 * login/refresh code already subtracts a 5-minute safety margin from
 * `expires`, so this is an additional pre-emptive cushion. */
const REFRESH_SKEW_MS = 60_000;

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

function rowToCreds(r: Row): OAuthCredentials {
  return {
    access: r.access,
    refresh: r.refresh,
    expires: r.expires,
    accountId: r.account_id ?? undefined,
    email: r.email ?? undefined,
    orgId: r.org_id ?? undefined,
    orgName: r.org_name ?? undefined,
    authorizedAt: r.authorized_at ?? undefined,
  };
}

export class OAuthStore {
 #db: DatabaseSync;
 #provider: string;
 #refreshFn: RefreshFn;
  /** In-flight refresh, so concurrent getAccessToken() calls single-flight. */
 #refreshing: Promise<OAuthCredentials> | null = null;

  constructor(db: DatabaseSync, provider: string, refreshFn: RefreshFn) {
    this.#db = db;
    this.#provider = provider;
    this.#refreshFn = refreshFn;
  }

  /** Human-readable location, for log/CLI messages. */
  get location(): string {
    return `elpis.db oauth_credentials[provider=${this.#provider}]`;
  }

  /** Read the stored credential. undefined = no row (not logged in). */
  read(): OAuthCredentials | undefined {
    const row = this.#db
      .prepare('SELECT access, refresh, expires, account_id, email, org_id, org_name, authorized_at FROM oauth_credentials WHERE provider = ?')
      .get(this.#provider) as Row | undefined;
    return row ? rowToCreds(row) : undefined;
  }

  /** Persist a credential (upsert on provider). */
  write(creds: OAuthCredentials): void {
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
        creds.access,
        creds.refresh,
        creds.expires,
        creds.accountId ?? null,
        creds.email ?? null,
        creds.orgId ?? null,
        creds.orgName ?? null,
        creds.authorizedAt ?? null,
        Date.now(),
      );
  }

  /** True when a credential exists. */
  isLoggedIn(): boolean {
    return this.read() !== undefined;
  }

  /** Force a refresh now (single-flighted), regardless of expiry. Used to
 * recover from a 401 when the access token died before its stored deadline.
 * No-op when there is no stored credential. */
  async forceRefresh(): Promise<void> {
    const creds = this.read();
    if (creds) await this.#refresh(creds);
  }

  /** Return a currently-valid access token, refreshing if near expiry.
 * Throws if there is no stored credential (operator must log in first). */
  async getAccessToken(): Promise<string> {
    const creds = this.read();
    if (!creds) {
      throw new Error(`no OAuth credential in ${this.location} — run the login flow first (npm run oauth-login)`);
    }
    if (Date.now() < creds.expires - REFRESH_SKEW_MS) return creds.access;
    return (await this.#refresh(creds)).access;
  }

  async #refresh(current: OAuthCredentials): Promise<OAuthCredentials> {
    if (this.#refreshing) return this.#refreshing;
    this.#refreshing = (async () => {
      const fresh = await this.#refreshFn(current.refresh);
 // Merge over the stored record: provider refresh responses deliberately
 // omit fields fixed at login (e.g. org, authorizedAt), and rotate the
 // refresh token, so a shallow merge keeps identity while advancing tokens.
      const merged: OAuthCredentials = { ...current, ...fresh };
      this.write(merged);
      return merged;
    })();
    try {
      return await this.#refreshing;
    } finally {
      this.#refreshing = null;
    }
  }
}
