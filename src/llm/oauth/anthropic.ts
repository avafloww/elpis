// anthropic.ts — Claude Pro/Max subscription OAuth (login + refresh).
//
// Mirrors Claude Code's OAuth flow so a subscription can drive inference
// directly (see src/llm/anthropic-client.ts for the request-shaping half).
// Ported from oh-my-pi's registry/oauth/anthropic.ts, trimmed to the two
// operations the harness needs: an interactive authorization-code login and a
// refresh-token refresh.
//
// WHY claude.ai and not platform.claude.com: the console authorize endpoint
// issues console tokens (org:create_api_key only) that CANNOT do inference. The
// claude.ai endpoint grants `user:inference`, the scope that makes a
// subscription token usable for //messages.
//
// Grant lifetime: the access token lives ~8h and rotates on refresh, but the
// whole grant family dies ~30 days after the interactive login regardless of
// refresh health (ANTHROPIC_OAUTH_GRANT_TTL_MS) — matching Claude Code's
// monthly re-login. Only a fresh login recovers it.

import { generatePkce, randomState, type Pkce } from './pkce.js';
import type { OAuthCredentials } from './store.js';

// Claude Code's public OAuth client id (base64 to keep it out of plain grep,
// matching upstream; it is not a secret — it ships in every Claude Code build).
const CLIENT_ID = Buffer.from('OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl', 'base64').toString('utf8');
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const BOOTSTRAP_URL = 'https://api.anthropic.com/api/claude_cli/bootstrap';
/** Manual (headless) redirect: claude.ai renders the code for the operator to
 * copy, so login works without a loopback server or reachable browser host. */
export const ANTHROPIC_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
// Scopes required for direct OAuth-token inference (`user:inference`) plus
// account/session management. Byte-identical to Claude Code's request.
const SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
/** Refresh sends these; the initial code exchange omits them (matches CC). */
const REFRESH_BETA = 'oauth-2025-04-20';
const REFRESH_USER_AGENT = 'anthropic-sdk-typescript/0.94.0 userOAuthProvider';
const BOOTSTRAP_MODEL = 'claude-opus-4-8';

/** Absolute lifetime of an Anthropic OAuth grant family, anchored at the
 * interactive login. ~30 days; refresh does not extend it. Display heuristic. */
export const ANTHROPIC_OAUTH_GRANT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string; name?: string };
}

interface AnthropicBootstrapResponse {
  oauth_account?: {
    account_uuid?: string;
    account_email?: string;
    organization_uuid?: string;
    organization_name?: string;
  };
}

interface AnthropicIdentity {
  accountId?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
}

function nonEmpty(v: string | undefined): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

async function postJson(body: Record<string, string>, extraHeaders?: Record<string, string>): Promise<AnthropicTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`anthropic oauth token endpoint ${res.status}: ${text}`);
  try {
    return JSON.parse(text) as AnthropicTokenResponse;
  } catch {
    throw new Error(`anthropic oauth token endpoint returned invalid JSON: ${text}`);
  }
}

/** Best-effort identity from the `/api/claude_cli/bootstrap` endpoint, used only
 * when the token response omits account/org. Failures are swallowed. */
async function fetchBootstrapIdentity(accessToken: string): Promise<AnthropicIdentity> {
  const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(BOOTSTRAP_MODEL)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${accessToken}`,
      'anthropic-beta': REFRESH_BETA,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`bootstrap ${res.status}`);
  const data = (await res.json()) as AnthropicBootstrapResponse;
  return {
    accountId: nonEmpty(data.oauth_account?.account_uuid),
    email: nonEmpty(data.oauth_account?.account_email),
    orgId: nonEmpty(data.oauth_account?.organization_uuid),
    orgName: nonEmpty(data.oauth_account?.organization_name),
  };
}

function identityFromToken(data: AnthropicTokenResponse): AnthropicIdentity {
  return {
    accountId: nonEmpty(data.account?.uuid),
    email: nonEmpty(data.account?.email_address),
    orgId: nonEmpty(data.organization?.uuid),
    orgName: nonEmpty(data.organization?.name),
  };
}

async function resolveIdentity(data: AnthropicTokenResponse, includeOrg: boolean): Promise<AnthropicIdentity> {
  const id = identityFromToken(data);
  const orgSatisfied = !includeOrg || id.orgId !== undefined;
  if (id.accountId && id.email && orgSatisfied) return id;
  try {
    const boot = await fetchBootstrapIdentity(data.access_token);
    return {
      accountId: id.accountId ?? boot.accountId,
      email: id.email ?? boot.email,
      orgId: id.orgId ?? boot.orgId,
      orgName: id.orgName ?? boot.orgName,
    };
  } catch {
    return id;
  }
}

/** 5-minute safety margin baked into the stored deadline, matching upstream. */
function expiresAt(expiresIn: number): number {
  return Date.now() + expiresIn * 1000 - 5 * 60 * 1000;
}

export interface AnthropicLoginStart {
  /** The URL the operator opens in a browser to approve access. */
  url: string;
  /** PKCE + CSRF state to hand back to {@link exchangeAnthropicCode}. */
  pkce: Pkce;
  state: string;
}

/** Begin an interactive login: build the authorize URL + PKCE material. The
 * operator opens `url`, approves, and pastes the resulting `code#state` value
 * into {@link exchangeAnthropicCode}. */
export function startAnthropicLogin(): AnthropicLoginStart {
  const pkce = generatePkce();
  const state = randomState();
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, pkce, state };
}

/** Exchange the pasted authorization code for tokens. The manual redirect
 * returns the value as `code#state`; either the bare code or the combined
 * form is accepted (the fragment's state wins when present, matching CC). */
export async function exchangeAnthropicCode(pasted: string, pkce: Pkce, state: string): Promise<OAuthCredentials> {
  let code = pasted.trim();
  let exchangeState = state;
  const hash = code.indexOf('#');
  if (hash >= 0) {
    const fragmentState = code.slice(hash + 1);
    code = code.slice(0, hash);
    if (fragmentState.length > 0) exchangeState = fragmentState;
  }
  const data = await postJson({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    code,
    state: exchangeState,
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    code_verifier: pkce.verifier,
  });
  const id = await resolveIdentity(data, true);
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: expiresAt(data.expires_in),
    authorizedAt: Date.now(),
    ...id,
  };
}

/** Refresh an access token. The org is fixed at login and deliberately not
 * re-resolved here (the store merges this over the stored record, preserving
 * org/authorizedAt). */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
  const data = await postJson(
    { grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: refreshToken },
    { 'anthropic-beta': REFRESH_BETA, 'User-Agent': REFRESH_USER_AGENT },
  );
  const id = await resolveIdentity(data, false);
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: expiresAt(data.expires_in),
    accountId: id.accountId,
    email: id.email,
  };
}
