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

function parseRequestUrl(input: RequestInfo | URL): {
  url: URL;
  suppliedHref: string;
} {
  let suppliedHref: string;
  if (typeof input === 'string') suppliedHref = input;
  else if (input instanceof URL) suppliedHref = input.href;
  else if (input instanceof Request) suppliedHref = input.url;
  else throw refusedRequest();

  try {
    return { url: new URL(suppliedHref), suppliedHref };
  } catch {
    throw refusedRequest();
  }
}

function requirePost(input: RequestInfo | URL, init?: RequestInit): 'POST' {
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (typeof method !== 'string' || !/^post$/i.test(method))
    throw refusedRequest();
  return 'POST';
}

function copyHeaders(input: RequestInfo | URL, init?: RequestInit): Headers {
  try {
    return new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
  } catch {
    throw refusedRequest();
  }
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
    const { url, suppliedHref } = parseRequestUrl(input);
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.search !== '' ||
      url.hash !== '' ||
      suppliedHref !== url.href ||
      !allowedUrls.has(suppliedHref)
    )
      throw refusedRequest();

    const method = requirePost(input, init);
    const headers = copyHeaders(input, init);
    for (const name of SENSITIVE_REQUEST_HEADERS) headers.delete(name);

    const outboundInit: FetchInitWithDispatcher = {
      ...init,
      method,
      headers,
      redirect: 'error',
    };
    delete outboundInit.dispatcher;
    if (dispatcher !== undefined) outboundInit.dispatcher = dispatcher;

    let suppliedKey: unknown;
    try {
      suppliedKey = await apiKeySource();
    } catch {
      throw new Error('OpenAI-compatible API key source failed');
    }
    headers.set('authorization', `Bearer ${validateApiKey(suppliedKey)}`);

    return underlyingFetch(input, outboundInit);
  };
}
