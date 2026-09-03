const SENSITIVE_REQUEST_HEADERS = [
  'authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'host',
  'proxy-authorization',
] as const;
const MAX_API_KEY_LENGTH = 131_072;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** Supplies the credential immediately before an allowed provider request. */
export type OpenAICompatibleApiKeySource = () => Promise<string>;

/** A fetch implementation accepted by the OpenAI SDK's fetch option. */
export type OpenAICompatibleFetch = typeof globalThis.fetch;

export interface OpenAICompatibleFetchOptions {
  /** Trusted, absolute provider root, for example https://api.openai.com/v1. */
  readonly baseUrl: string | URL;
  /** Called once for each allowed request and never for a refused request. */
  readonly apiKey: OpenAICompatibleApiKeySource;
  /** Defaults to the global fetch captured when this factory is called. */
  readonly fetch?: OpenAICompatibleFetch;
  /** Trusted undici dispatcher; caller-supplied dispatchers are discarded. */
  readonly dispatcher?: unknown;
}

type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

function configurationError(message: string): TypeError {
  return new TypeError(`OpenAI-compatible fetch configuration ${message}`);
}

function refusedRequest(): TypeError {
  return new TypeError('OpenAI-compatible fetch refused request');
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

function snapshotRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): Request {
  let stableInput = input;
  try {
    if (typeof input === 'string') {
      if (input !== new URL(input).href) throw refusedRequest();
    } else if (input instanceof URL) {
      stableInput = input.href;
    } else if (!(input instanceof Request)) {
      throw refusedRequest();
    }
    return new Request(stableInput, {
      ...init,
      credentials: 'omit',
      redirect: 'error',
      referrer: '',
    });
  } catch {
    throw refusedRequest();
  }
}

function validateRequest(request: Request, allowedUrls: Set<string>): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw refusedRequest();
  }
  if (
    request.method !== 'POST' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    request.url !== url.href ||
    !allowedUrls.has(request.url)
  )
    throw refusedRequest();
}

function validateApiKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_API_KEY_LENGTH ||
    !VISIBLE_ASCII.test(value)
  )
    throw new TypeError('OpenAI-compatible API key is invalid');
  return value;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException('The request was aborted', 'AbortError')
  );
}

async function releaseRequestBody(request: Request): Promise<void> {
  if (!request.body || request.bodyUsed) return;
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      request.body.cancel().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 100);
        timer.unref();
      }),
    ]);
  } catch {
    // Releasing owned input must never replace the primary request failure.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function awaitWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
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
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Create the fetch beneath the OpenAI SDK. Request shaping and response parsing
 * remain with the SDK; this layer owns route pinning and transport credentials.
 */
export function createOpenAICompatibleFetch(
  options: OpenAICompatibleFetchOptions,
): OpenAICompatibleFetch {
  if (!options || typeof options !== 'object')
    throw configurationError('options are required');
  const root = canonicalBaseUrl(options.baseUrl);
  const allowedUrls = new Set([
    `${root}/chat/completions`,
    `${root}/responses`,
  ]);
  const apiKeySource = options.apiKey;
  if (typeof apiKeySource !== 'function')
    throw configurationError('requires an API-key source');
  const underlyingFetch = options.fetch ?? globalThis.fetch;
  if (typeof underlyingFetch !== 'function')
    throw configurationError('requires an underlying fetch function');
  const dispatcher = options.dispatcher;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let request: Request | null = null;
    let handedOff = false;
    try {
      request = snapshotRequest(input, init);
      validateRequest(request, allowedUrls);
      const headers = new Headers(request.headers);
      for (const name of SENSITIVE_REQUEST_HEADERS) headers.delete(name);
      if (request.signal.aborted) throw abortReason(request.signal);

      const suppliedKey = await awaitWithAbort(
        Promise.resolve()
          .then(apiKeySource)
          .catch(() => {
            throw new Error('OpenAI-compatible API key source failed');
          }),
        request.signal,
      );
      if (request.signal.aborted) throw abortReason(request.signal);
      headers.set('authorization', `Bearer ${validateApiKey(suppliedKey)}`);

      const outbound = new Request(request, { headers });
      handedOff = true;
      if (dispatcher === undefined) return underlyingFetch(outbound);
      const fetchInit: FetchInitWithDispatcher = { dispatcher };
      return underlyingFetch(outbound, fetchInit);
    } catch (error) {
      if (request && !handedOff) await releaseRequestBody(request);
      throw error;
    }
  };
}
