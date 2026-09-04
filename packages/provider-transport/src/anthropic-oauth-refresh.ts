import type { OAuthCredentials } from './oauth.js';

// Claude Code's public OAuth client id. It is shipped in every Claude Code
// build and is intentionally pinned here with the rest of the refresh wire
// contract.
export const ANTHROPIC_OAUTH_CLIENT_ID = Buffer.from(
  'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl',
  'base64',
).toString('utf8');

const ANTHROPIC_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const ANTHROPIC_BOOTSTRAP_URL =
  'https://api.anthropic.com/api/claude_cli/bootstrap';
const ANTHROPIC_BOOTSTRAP_MODEL = 'claude-opus-4-8';
const ANTHROPIC_REFRESH_BETA = 'oauth-2025-04-20';
const ANTHROPIC_REFRESH_USER_AGENT =
  'anthropic-sdk-typescript/0.94.0 userOAuthProvider';
const ANTHROPIC_REFRESH_TIMEOUT_MS = 30_000;
const ANTHROPIC_RESPONSE_MAX_BYTES = 1_048_576;
const ANTHROPIC_EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1_000;
const MAX_OAUTH_SECRET_LENGTH = 131_072;
const MAX_OAUTH_IDENTITY_LENGTH = 4_096;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const TIMEOUT = Symbol('Anthropic refresh timeout');
const RESPONSE_TOO_LARGE = Symbol('Anthropic refresh response too large');

export interface AnthropicTokenRefreshOptions {
  /** Injectable transport; provider endpoints and client metadata stay fixed. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injectable epoch-millisecond clock used to derive the safe expiry. */
  readonly now?: () => number;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  account?: unknown;
}

interface AnthropicIdentity {
  accountId?: string;
  email?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OAUTH_SECRET_LENGTH &&
    VISIBLE_ASCII.test(value)
  );
}

function invalidResponse(): Error {
  return new Error('Anthropic token refresh returned an invalid response');
}

function observeCleanup(cleanup: Promise<unknown>): void {
  void cleanup.catch(() => undefined);
}

function cancelBody(
  body: ReadableStream<Uint8Array> | null,
  reason: unknown,
): void {
  if (!body) return;
  try {
    observeCleanup(body.cancel(reason));
  } catch {
    // Cleanup is best effort and must never replace the sanitized result.
  }
}

function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
): void {
  try {
    observeCleanup(reader.cancel(reason));
  } catch {
    // Cleanup is best effort and must never replace the sanitized result.
  }
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
    // Both branches remain installed after a timeout so a late rejection from
    // an injected fetch/body implementation is still observed.
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
    Number(declaredLength) > ANTHROPIC_RESPONSE_MAX_BYTES
  ) {
    cancelBody(response.body, RESPONSE_TOO_LARGE);
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
      if (total > ANTHROPIC_RESPONSE_MAX_BYTES) {
        cancelReader(reader, RESPONSE_TOO_LARGE);
        throw RESPONSE_TOO_LARGE;
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error !== RESPONSE_TOO_LARGE) cancelReader(reader, error);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A hostile/non-settling stream must not mask the bounded outcome.
    }
  }
}

function optionalIdentity(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_OAUTH_IDENTITY_LENGTH)
    throw invalidResponse();
  return value;
}

function identityFromToken(data: TokenResponse): AnthropicIdentity {
  if (data.account === undefined) return {};
  if (!isRecord(data.account)) throw invalidResponse();
  return {
    accountId: optionalIdentity(data.account, 'uuid'),
    email: optionalIdentity(data.account, 'email_address'),
  };
}

function identityFromBootstrap(parsed: unknown): AnthropicIdentity {
  if (!isRecord(parsed)) throw invalidResponse();
  const account = parsed.oauth_account;
  if (account === undefined) return {};
  if (!isRecord(account)) throw invalidResponse();
  return {
    accountId: optionalIdentity(account, 'account_uuid'),
    email: optionalIdentity(account, 'account_email'),
  };
}

async function fetchBootstrapIdentity(
  accessToken: string,
  fetchFn: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<AnthropicIdentity> {
  const target =
    ANTHROPIC_BOOTSTRAP_URL +
    '?entrypoint=cli&model=' +
    encodeURIComponent(ANTHROPIC_BOOTSTRAP_MODEL);
  const response = await awaitWithTimeout(
    () =>
      fetchFn(target, {
        method: 'GET',
        headers: {
          Accept: 'application/json, text/plain, */*',
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': ANTHROPIC_REFRESH_BETA,
        },
        redirect: 'error',
        signal,
      }),
    signal,
  );
  const text = await readBoundedResponse(response, signal);
  if (response.status !== 200) throw invalidResponse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidResponse();
  }
  return identityFromBootstrap(parsed);
}

/** Refresh an Anthropic subscription OAuth grant through the pinned public
 * client. Interactive authorization and PKCE intentionally remain resident. */
export async function refreshAnthropicToken(
  refreshToken: string,
  options: AnthropicTokenRefreshOptions = {},
): Promise<OAuthCredentials> {
  if (!validSecret(refreshToken))
    throw new TypeError('Anthropic refresh token is invalid');
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('Anthropic token refresh options are invalid');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  if (typeof fetchFn !== 'function' || typeof now !== 'function')
    throw new TypeError('Anthropic token refresh options are invalid');

  let signal: AbortSignal;
  try {
    signal = AbortSignal.timeout(ANTHROPIC_REFRESH_TIMEOUT_MS);
  } catch {
    throw new Error('Anthropic token refresh request failed');
  }

  let response: Response;
  try {
    response = await awaitWithTimeout(
      () =>
        fetchFn(ANTHROPIC_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-beta': ANTHROPIC_REFRESH_BETA,
            'User-Agent': ANTHROPIC_REFRESH_USER_AGENT,
          },
          body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: ANTHROPIC_OAUTH_CLIENT_ID,
            refresh_token: refreshToken,
          }),
          redirect: 'error',
          signal,
        }),
      signal,
    );
  } catch (error) {
    if (error === TIMEOUT || signal.aborted)
      throw new Error('Anthropic token refresh timed out');
    throw new Error('Anthropic token refresh request failed');
  }

  let text: string;
  try {
    text = await readBoundedResponse(response, signal);
  } catch (error) {
    if (error === TIMEOUT || signal.aborted)
      throw new Error('Anthropic token refresh timed out');
    if (error === RESPONSE_TOO_LARGE)
      throw new Error('Anthropic token refresh response was too large');
    throw new Error('Anthropic token refresh response could not be read');
  }
  if (response.status !== 200)
    throw new Error('Anthropic token refresh failed');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Anthropic token refresh returned invalid JSON');
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

  let identity = identityFromToken(data);
  if (!identity.accountId || !identity.email) {
    try {
      const bootstrap = await fetchBootstrapIdentity(
        data.access_token,
        fetchFn,
        signal,
      );
      identity = {
        accountId: identity.accountId ?? bootstrap.accountId,
        email: identity.email ?? bootstrap.email,
      };
    } catch {
      // Identity enrichment is deliberately best effort, matching login.
    }
  }

  let currentTime: number;
  try {
    currentTime = now();
  } catch {
    throw new Error('Anthropic token refresh clock failed');
  }
  if (!Number.isSafeInteger(currentTime) || currentTime < 0)
    throw invalidResponse();
  const lifetimeMs = (data.expires_in as number) * 1_000;
  const expires = currentTime + lifetimeMs - ANTHROPIC_EXPIRY_SAFETY_MARGIN_MS;
  if (
    !Number.isSafeInteger(lifetimeMs) ||
    !Number.isSafeInteger(expires) ||
    expires < 0
  )
    throw invalidResponse();

  return {
    access: data.access_token,
    refresh: (data.refresh_token as string | undefined) ?? refreshToken,
    expires,
    accountId: identity.accountId,
    email: identity.email,
  };
}
