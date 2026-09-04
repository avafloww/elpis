export const ANTHROPIC_CLAUDE_CODE_VERSION = '2.1.220';
export const ANTHROPIC_API_VERSION = '2023-06-01';
export const ANTHROPIC_OAUTH_BETAS = Object.freeze([
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
] as const);
export const ANTHROPIC_CLAUDE_CODE_USER_AGENT = `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION} (external, claude-desktop)`;

const MAX_ACCESS_TOKEN_LENGTH = 131_072;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

export interface AnthropicOAuthCredentialSource {
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<void>;
}

export interface AnthropicOAuthTransportOptions {
  readonly baseUrl: string | URL;
  readonly credentials: AnthropicOAuthCredentialSource;
  readonly fetch?: typeof globalThis.fetch;
  readonly dispatcher?: unknown;
  readonly unauthorized?: 'refresh-and-throw' | 'return-response';
}

export interface AnthropicOAuthTransportRequest {
  readonly body: Uint8Array;
  readonly stream: boolean;
  readonly signal?: AbortSignal;
}

export type AnthropicOAuthTransport = (
  request: AnthropicOAuthTransportRequest,
) => Promise<Response>;

export class AnthropicOAuthUnauthorizedError extends Error {
  readonly status = 401;

  constructor(readonly responseText: string) {
    super('Anthropic OAuth request was unauthorized');
    this.name = 'AnthropicOAuthUnauthorizedError';
  }
}

function configurationError(message: string): TypeError {
  return new TypeError(`Anthropic OAuth transport configuration ${message}`);
}

function canonicalBaseUrl(value: string | URL): string {
  if (typeof value !== 'string' && !(value instanceof URL))
    throw configurationError('requires an absolute base URL');
  let url: URL;
  try {
    url = new URL(typeof value === 'string' ? value : value.href);
  } catch {
    throw configurationError('requires an absolute base URL');
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.href !== `${url.origin}${url.pathname}`
  )
    throw configurationError('requires a credential-free HTTP(S) base URL');
  return url.href === `${url.origin}/`
    ? url.origin
    : url.href.replace(/\/+$/, '');
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException('The request was aborted', 'AbortError')
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function awaitWithAbort<T>(
  start: () => T | PromiseLike<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return await start();
  throwIfAborted(signal);
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

function accessToken(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_ACCESS_TOKEN_LENGTH ||
    !VISIBLE_ASCII.test(value)
  )
    throw new TypeError('Anthropic OAuth access token is invalid');
  return value;
}

export function createAnthropicOAuthTransport(
  options: AnthropicOAuthTransportOptions,
): AnthropicOAuthTransport {
  if (!options || typeof options !== 'object')
    throw configurationError('options are required');
  const target = `${canonicalBaseUrl(options.baseUrl)}/v1/messages?beta=true`;
  if (
    !options.credentials ||
    typeof options.credentials !== 'object' ||
    typeof options.credentials.getAccessToken !== 'function' ||
    typeof options.credentials.forceRefresh !== 'function'
  )
    throw configurationError('requires a credential source');
  const underlyingFetch = options.fetch ?? globalThis.fetch;
  if (typeof underlyingFetch !== 'function')
    throw configurationError('requires an underlying fetch function');
  const credentials = options.credentials;
  const dispatcher = options.dispatcher;
  const unauthorized = options.unauthorized ?? 'refresh-and-throw';
  if (
    unauthorized !== 'refresh-and-throw' &&
    unauthorized !== 'return-response'
  )
    throw configurationError('has an invalid unauthorized mode');

  return async (request: AnthropicOAuthTransportRequest) => {
    if (!request || typeof request !== 'object')
      throw new TypeError('Anthropic OAuth transport request is invalid');
    const requestBody = request.body;
    const stream = request.stream;
    const signal = request.signal;
    if (!(requestBody instanceof Uint8Array) || typeof stream !== 'boolean')
      throw new TypeError('Anthropic OAuth transport request is invalid');
    const body = new Uint8Array(requestBody);
    throwIfAborted(signal);
    const token = accessToken(
      await awaitWithAbort(() => credentials.getAccessToken(), signal),
    );
    throwIfAborted(signal);

    const init: FetchInitWithDispatcher = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': ANTHROPIC_API_VERSION,
        'anthropic-beta': ANTHROPIC_OAUTH_BETAS.join(','),
        'content-type': 'application/json',
        accept: stream ? 'text/event-stream' : 'application/json',
        'user-agent': ANTHROPIC_CLAUDE_CODE_USER_AGENT,
        'x-app': 'cli',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: body.slice(),
      signal,
      credentials: 'omit',
      redirect: 'error',
      referrer: '',
    };
    if (dispatcher !== undefined) init.dispatcher = dispatcher;
    throwIfAborted(signal);
    const response = await underlyingFetch(target, init);
    if (response.status !== 401 || unauthorized === 'return-response')
      return response;

    const responseText = await awaitWithAbort(
      () => response.text().catch(() => ''),
      signal,
    );
    throwIfAborted(signal);
    try {
      await awaitWithAbort(() => credentials.forceRefresh(), signal);
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal);
    }
    throwIfAborted(signal);
    throw new AnthropicOAuthUnauthorizedError(responseText);
  };
}
