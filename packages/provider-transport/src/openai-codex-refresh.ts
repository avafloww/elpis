import type { OAuthCredentials } from './oauth.js';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_TOKEN_REFRESH_TIMEOUT_MS = 15_000;
const OPENAI_CODEX_TOKEN_RESPONSE_MAX_BYTES = 1_048_576;

const JWT_AUTH_CLAIM = 'https://api.openai.com/auth';
const JWT_PROFILE_CLAIM = 'https://api.openai.com/profile';
const MAX_OAUTH_SECRET_LENGTH = 131_072;
const MAX_OAUTH_IDENTITY_LENGTH = 4_096;
const TIMEOUT = Symbol('OpenAI Codex refresh timeout');
const RESPONSE_TOO_LARGE = Symbol('OpenAI Codex refresh response too large');

export interface CodexJwtPayload {
  [JWT_AUTH_CLAIM]?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
  [JWT_PROFILE_CLAIM]?: { email?: string };
  [key: string]: unknown;
}

export interface CodexTokenIdentity {
  accountId?: string;
  email?: string;
  planType?: string;
}

export interface OpenAICodexTokenRefreshOptions {
  /** Injectable transport; the token endpoint itself is deliberately fixed. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable epoch-millisecond clock used to derive the expiry deadline. */
  readonly now?: () => number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decode a JWT payload without validating its signature. The trusted token
 * endpoint supplies these attribution/routing claims; they are not used to
 * decide whether the bearer token is authentic. */
export function decodeCodexJwt(token: string): CodexJwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(
      Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'),
    ) as CodexJwtPayload;
  } catch {
    return null;
  }
}

function claimRecord(
  payload: CodexJwtPayload | null,
  key: string,
): Record<string, unknown> | undefined {
  const value = payload?.[key];
  return isRecord(value) ? value : undefined;
}

function normalizedClaim(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim().toLowerCase() || undefined;
}

export function codexTokenIdentity(
  accessToken: string,
  idToken?: string,
): CodexTokenIdentity {
  const access = decodeCodexJwt(accessToken);
  const id = idToken ? decodeCodexJwt(idToken) : null;
  const auth = claimRecord(access, JWT_AUTH_CLAIM);
  const idAuth = claimRecord(id, JWT_AUTH_CLAIM);
  const profile = claimRecord(access, JWT_PROFILE_CLAIM);
  const accountId = auth?.chatgpt_account_id;
  return {
    accountId:
      typeof accountId === 'string' && accountId.length > 0
        ? accountId
        : undefined,
    email: normalizedClaim(profile?.email),
    planType: normalizedClaim(
      auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type,
    ),
  };
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OAUTH_SECRET_LENGTH
  );
}

function invalidResponse(): Error {
  return new Error('OpenAI Codex token refresh returned an invalid response');
}

async function awaitWithTimeout<T>(
  start: () => T | PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw TIMEOUT;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(TIMEOUT));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    let started: Promise<T>;
    try {
      started = Promise.resolve(start());
    } catch (error) {
      finish(() => reject(error));
      return;
    }
    started.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function readBoundedResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    /^\d+$/.test(declaredLength) &&
    Number(declaredLength) > OPENAI_CODEX_TOKEN_RESPONSE_MAX_BYTES
  ) {
    void response.body?.cancel(RESPONSE_TOO_LARGE).catch(() => undefined);
    throw RESPONSE_TOO_LARGE;
  }

  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const part = await awaitWithTimeout(() => reader.read(), signal);
      if (part.done) break;
      total += part.value.byteLength;
      if (total > OPENAI_CODEX_TOKEN_RESPONSE_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        throw RESPONSE_TOO_LARGE;
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error === TIMEOUT) void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Refresh a ChatGPT Codex OAuth grant through the pinned public client. */
export async function refreshOpenAICodexToken(
  refreshToken: string,
  options: OpenAICodexTokenRefreshOptions = {},
): Promise<OAuthCredentials> {
  if (!validSecret(refreshToken))
    throw new TypeError('OpenAI Codex refresh token is invalid');
  if (!options || typeof options !== 'object')
    throw new TypeError('OpenAI Codex token refresh options are invalid');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  if (typeof fetchFn !== 'function' || typeof now !== 'function')
    throw new TypeError('OpenAI Codex token refresh options are invalid');

  let signal: AbortSignal;
  try {
    signal = AbortSignal.timeout(OPENAI_CODEX_TOKEN_REFRESH_TIMEOUT_MS);
  } catch {
    throw new Error('OpenAI Codex token refresh request failed');
  }

  let response: Response;
  try {
    response = await awaitWithTimeout(
      () =>
        fetchFn(OPENAI_CODEX_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: OPENAI_CODEX_CLIENT_ID,
          }),
          redirect: 'error',
          signal,
        }),
      signal,
    );
  } catch (error) {
    if (error === TIMEOUT || signal.aborted)
      throw new Error('OpenAI Codex token refresh timed out');
    throw new Error('OpenAI Codex token refresh request failed');
  }

  let text: string;
  try {
    text = await readBoundedResponse(response, signal);
  } catch (error) {
    if (error === TIMEOUT || signal.aborted)
      throw new Error('OpenAI Codex token refresh timed out');
    if (error === RESPONSE_TOO_LARGE)
      throw new Error('OpenAI Codex token refresh response was too large');
    throw new Error('OpenAI Codex token refresh response could not be read');
  }

  if (!response.ok)
    throw new Error(
      'OpenAI Codex token refresh failed with HTTP status ' + response.status,
    );

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('OpenAI Codex token refresh returned invalid JSON');
  }
  if (!isRecord(parsed)) throw invalidResponse();
  const data = parsed as TokenResponse;
  if (!validSecret(data.access_token)) throw invalidResponse();
  if (
    !Number.isSafeInteger(data.expires_in) ||
    (data.expires_in as number) <= 0
  )
    throw invalidResponse();
  if (data.refresh_token !== undefined && !validSecret(data.refresh_token))
    throw invalidResponse();

  let currentTime: number;
  try {
    currentTime = now();
  } catch {
    throw new Error('OpenAI Codex token refresh clock failed');
  }
  if (!Number.isSafeInteger(currentTime) || currentTime < 0)
    throw invalidResponse();
  const expires = currentTime + (data.expires_in as number) * 1_000;
  if (!Number.isSafeInteger(expires) || expires < currentTime)
    throw invalidResponse();

  const identity = codexTokenIdentity(data.access_token);
  if (
    (identity.accountId !== undefined &&
      identity.accountId.length > MAX_OAUTH_IDENTITY_LENGTH) ||
    (identity.email !== undefined &&
      identity.email.length > MAX_OAUTH_IDENTITY_LENGTH)
  )
    throw invalidResponse();

  return {
    access: data.access_token,
    refresh: (data.refresh_token as string | undefined) ?? refreshToken,
    expires,
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
    ...(identity.email ? { email: identity.email } : {}),
  };
}
