// openai-codex.ts — ChatGPT Codex device-code OAuth (login + refresh).
//
// This mirrors the headless flow used by OpenAI Codex and OMP: request a
// device/user code, let the operator approve it at auth.openai.com, poll for a
// short-lived authorization code + server-generated PKCE verifier, then
// exchange that pair for the normal access/refresh token family. Inference is
// implemented separately in ../codex-client.ts.

import type { OAuthCredentials } from './store.js';

export const OPENAI_CODEX_CREDENTIAL_KEY = 'openai-codex';
export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_DEVICE_AUTH_URL = 'https://auth.openai.com/codex/device';
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
export const OPENAI_CODEX_CLIENT_VERSION = '0.144.1';

const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEVICE_USERCODE_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
const DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
const DEVICE_MAX_WAIT_MS = 15 * 60 * 1000;
const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';
const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile';

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface JwtPayload {
  [JWT_AUTH_CLAIM]?: { chatgpt_account_id?: string; chatgpt_plan_type?: string };
  [JWT_PROFILE_CLAIM]?: { email?: string };
  [key: string]: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decode a JWT payload without validating its signature. The token endpoint
 * is trusted and these claims are attribution/routing metadata, not an auth
 * decision; the backend still validates the bearer token itself. */
export function decodeCodexJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
}

export function codexTokenIdentity(accessToken: string, idToken?: string): {
  accountId?: string;
  email?: string;
  planType?: string;
} {
  const access = decodeCodexJwt(accessToken);
  const id = idToken ? decodeCodexJwt(idToken) : null;
  const auth = access?.[JWT_AUTH_CLAIM];
  const idAuth = id?.[JWT_AUTH_CLAIM];
  const accountId = auth?.chatgpt_account_id;
  const email = access?.[JWT_PROFILE_CLAIM]?.email?.trim().toLowerCase();
  const planType = (auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type)?.trim().toLowerCase();
  return {
    accountId: typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined,
    email: email || undefined,
    planType: planType || undefined,
  };
}

function endpointError(status: number, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return String(status);
  try {
    const body = JSON.parse(trimmed) as Record<string, unknown>;
    const value = body.error_description ?? body.error ?? body.message;
    if (typeof value === 'string' && value.trim()) return `${status} ${value.trim()}`;
  } catch {
 // Plain-text response — use it below.
  }
  return `${status} ${trimmed}`;
}

async function exchangeAuthorizationCode(
  authorizationCode: string,
  verifier: string,
  fetchFn: FetchFn,
): Promise<OAuthCredentials> {
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code: authorizationCode,
      code_verifier: verifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI Codex token exchange failed: ${endpointError(response.status, text)}`);
  let data: TokenResponse;
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error('OpenAI Codex token endpoint returned invalid JSON');
  }
  if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) {
    throw new Error('OpenAI Codex token response missing access_token, refresh_token, or expires_in');
  }
  const identity = codexTokenIdentity(data.access_token, data.id_token);
  if (!identity.accountId) {
    throw new Error('OpenAI Codex token did not contain a ChatGPT account id');
  }
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + (data.expires_in as number) * 1000,
    accountId: identity.accountId,
    email: identity.email,
    orgId: identity.accountId,
    orgName: identity.planType,
    authorizedAt: Date.now(),
  };
}

export interface CodexDeviceLoginOptions {
  fetchFn?: FetchFn;
  sleepFn?: SleepFn;
  signal?: AbortSignal;
  maxWaitMs?: number;
  /** Called once the URL + code are ready for the operator. */
  onCode?: (url: string, code: string) => void;
  onProgress?: (message: string) => void;
}

/** Run the complete headless device-code login. 403/404 from the polling route
 * mean "authorization pending"; any other non-2xx response is terminal. */
export async function loginOpenAICodexDevice(options: CodexDeviceLoginOptions = {}): Promise<OAuthCredentials> {
  const fetchFn = options.fetchFn ?? fetch;
  const wait = options.sleepFn ?? sleep;
  options.onProgress?.('Initiating device authorization…');
  const initResponse = await fetchFn(DEVICE_USERCODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const initText = await initResponse.text();
  if (!initResponse.ok) {
    throw new Error(`OpenAI Codex device authorization failed: ${endpointError(initResponse.status, initText)}`);
  }
  let init: { device_auth_id?: string; user_code?: string; interval?: number | string };
  try {
    init = JSON.parse(initText) as typeof init;
  } catch {
    throw new Error('OpenAI Codex device authorization returned invalid JSON');
  }
  if (!init.device_auth_id || !init.user_code) {
    throw new Error('OpenAI Codex device authorization response missing device_auth_id or user_code');
  }

  const serverInterval = typeof init.interval === 'number'
    ? init.interval
    : Number.parseInt(String(init.interval ?? '5'), 10);
  const pollIntervalMs = (Number.isFinite(serverInterval) && serverInterval > 0 ? serverInterval : 5) * 1000
    + DEVICE_POLL_SAFETY_MARGIN_MS;
  options.onCode?.(OPENAI_CODEX_DEVICE_AUTH_URL, init.user_code);
  options.onProgress?.(`Waiting for browser authorization (code: ${init.user_code})…`);

  const maxWaitMs = options.maxWaitMs ?? DEVICE_MAX_WAIT_MS;
  let waitedMs = 0;
  let firstPoll = true;
  while (waitedMs < maxWaitMs) {
 // Match Codex/OMP: do not make the first operator-visible status sit for a
 // long server interval, then honor the full interval + safety margin.
    const interval = firstPoll ? Math.min(pollIntervalMs, 5_000) : pollIntervalMs;
    firstPoll = false;
    const waitMs = Math.min(interval, maxWaitMs - waitedMs);
    await wait(waitMs);
    waitedMs += waitMs;
    if (options.signal?.aborted) throw new Error('OpenAI Codex device authorization cancelled');
    const pollResponse = await fetchFn(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: init.device_auth_id, user_code: init.user_code }),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });
    if (pollResponse.status === 403 || pollResponse.status === 404) continue;
    const pollText = await pollResponse.text();
    if (!pollResponse.ok) {
      throw new Error(`OpenAI Codex device token polling failed: ${endpointError(pollResponse.status, pollText)}`);
    }
    let result: { authorization_code?: string; code_verifier?: string };
    try {
      result = JSON.parse(pollText) as typeof result;
    } catch {
      throw new Error('OpenAI Codex device token polling returned invalid JSON');
    }
    if (!result.authorization_code || !result.code_verifier) {
      throw new Error('OpenAI Codex device token response missing authorization_code or code_verifier');
    }
    options.onProgress?.('Exchanging authorization code for tokens…');
    return exchangeAuthorizationCode(result.authorization_code, result.code_verifier, fetchFn);
  }
  throw new Error('OpenAI Codex device authorization timed out — login was not completed within 15 minutes');
}

/** Refresh a Codex access token. Identity/workspace fields omitted by refresh
 * survive because OAuthStore merges this slice over the stored credential. */
export async function refreshOpenAICodexToken(
  refreshToken: string,
  fetchFn: FetchFn = fetch,
): Promise<OAuthCredentials> {
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`OpenAI Codex token refresh failed: ${endpointError(response.status, text)}`);
  let data: TokenResponse;
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error('OpenAI Codex token refresh returned invalid JSON');
  }
  if (!data.access_token || !Number.isFinite(data.expires_in)) {
    throw new Error('OpenAI Codex refresh response missing access_token or expires_in');
  }
  const identity = codexTokenIdentity(data.access_token);
  return {
    access: data.access_token,
    refresh: data.refresh_token || refreshToken,
    expires: Date.now() + (data.expires_in as number) * 1000,
 // Omit absent identity fields entirely: OAuthStore's shallow merge then
 // preserves the login-fixed workspace instead of `undefined` erasing it.
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    ...(identity.email ? { email: identity.email } : {}),
  };
}
