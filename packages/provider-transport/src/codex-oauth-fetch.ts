const SENSITIVE_OBSERVER_HEADERS = [
  'authorization',
  'chatgpt-account-id',
  'x-api-key',
  'api-key',
  'cookie',
  'host',
  'proxy-authorization',
] as const;
const MAX_HEADER_VALUE_LENGTH = 131_072;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite';
export const CODEX_OAUTH_CLIENT_VERSION = '0.144.1';

export interface CodexOAuthIdentity {
  readonly accountId?: string;
}

export interface CodexOAuthCredentialSource {
  readonly location: string;
  read(): CodexOAuthIdentity | undefined;
  getAccessToken(): Promise<string>;
  forceRefresh(): Promise<void>;
}

export interface CodexOAuthObservedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly expectsStream: boolean;
}

export interface CodexOAuthObservedExchange {
  readonly request: CodexOAuthObservedRequest;
  readonly response: Response;
  readonly attempt: 1 | 2;
}

export type CodexOAuthObserver = (
  exchange: CodexOAuthObservedExchange,
) => void | Promise<void>;

export interface CodexOAuthFetchOptions {
  readonly credentials: CodexOAuthCredentialSource;
  readonly sessionId: () => string;
  readonly responsesLite?: boolean;
  readonly preserveTransportHeaders?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly dispatcher?: unknown;
  readonly observe?: CodexOAuthObserver;
}

type FetchInitWithDispatcher = RequestInit & { dispatcher?: unknown };

interface RequestSnapshot {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly wireBody: string | Uint8Array | undefined;
  readonly hasBody: boolean;
  readonly signal: AbortSignal;
  readonly cache: RequestCache;
  readonly integrity: string;
  readonly keepalive: boolean;
  readonly mode: RequestMode;
  readonly referrerPolicy: ReferrerPolicy;
}

function configurationError(message: string): TypeError {
  return new TypeError(`Codex OAuth fetch configuration ${message}`);
}

function refusedRequest(): TypeError {
  return new TypeError('refusing Codex OAuth credential request');
}

function headerValue(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_HEADER_VALUE_LENGTH ||
    !VISIBLE_ASCII.test(value)
  )
    throw new TypeError(`Codex OAuth ${name} is invalid`);
  return value;
}

function snapshotInput(input: RequestInfo | URL, init?: RequestInit): Request {
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

function validateTarget(request: Request): void {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    throw refusedRequest();
  }
  const pathAllowed =
    url.pathname.startsWith('/backend-api/codex/') ||
    url.pathname === '/backend-api/models';
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'chatgpt.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !pathAllowed ||
    (request.method !== 'GET' && request.method !== 'POST')
  )
    throw refusedRequest();
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
      }),
    ]);
  } catch {
    // Cleanup must not replace the target-refusal error.
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

async function requestSnapshot(
  request: Request,
  sourceBody: BodyInit | null | undefined,
): Promise<RequestSnapshot> {
  const hasBody = request.body !== null;
  const body = hasBody
    ? new Uint8Array(await request.arrayBuffer())
    : new Uint8Array();
  return {
    url: request.url,
    method: request.method,
    headers: new Headers(request.headers),
    body,
    wireBody: !hasBody
      ? undefined
      : typeof sourceBody === 'string'
        ? sourceBody
        : body.slice(),
    hasBody,
    signal: request.signal,
    cache: request.cache,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    referrerPolicy: request.referrerPolicy,
  };
}

function requestInitFromSnapshot(
  snapshot: RequestSnapshot,
  headers: Headers,
  dispatcher: unknown,
): FetchInitWithDispatcher {
  const init: FetchInitWithDispatcher = {
    method: snapshot.method,
    headers,
    body:
      snapshot.wireBody instanceof Uint8Array
        ? snapshot.wireBody.slice()
        : snapshot.wireBody,
    signal: snapshot.signal,
    cache: snapshot.cache,
    credentials: 'omit',
    integrity: snapshot.integrity,
    keepalive: snapshot.keepalive,
    mode: snapshot.mode,
    redirect: 'error',
    referrer: '',
    referrerPolicy: snapshot.referrerPolicy,
  };
  if (dispatcher !== undefined) init.dispatcher = dispatcher;
  return init;
}

function observedHeaders(headers: Headers): Headers {
  const safe = new Headers(headers);
  for (const name of SENSITIVE_OBSERVER_HEADERS) safe.delete(name);
  return safe;
}

function requestExpectsStream(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      stream?: unknown;
    };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

export function createCodexOAuthFetch(
  options: CodexOAuthFetchOptions,
): typeof globalThis.fetch {
  if (!options || typeof options !== 'object')
    throw configurationError('options are required');
  if (
    !options.credentials ||
    typeof options.credentials !== 'object' ||
    typeof options.credentials.location !== 'string' ||
    options.credentials.location.length === 0 ||
    typeof options.credentials.read !== 'function' ||
    typeof options.credentials.getAccessToken !== 'function' ||
    typeof options.credentials.forceRefresh !== 'function'
  )
    throw configurationError('requires a credential source');
  if (typeof options.sessionId !== 'function')
    throw configurationError('requires a session-id source');
  if (options.observe !== undefined && typeof options.observe !== 'function')
    throw configurationError('observer must be a function');
  const underlyingFetch = options.fetch ?? globalThis.fetch;
  if (typeof underlyingFetch !== 'function')
    throw configurationError('requires an underlying fetch function');
  const responsesLite = options.responsesLite ?? false;
  const preserveTransportHeaders = options.preserveTransportHeaders ?? false;
  const dispatcher = options.dispatcher;
  const observe = options.observe;

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const owned = snapshotInput(input, init);
    try {
      validateTarget(owned);
    } catch (error) {
      await releaseRequestBody(owned);
      throw error;
    }
    const snapshot = await requestSnapshot(owned, init?.body);
    const session = headerValue(options.sessionId(), 'session id');
    const expectsStream = requestExpectsStream(snapshot.body);

    const send = async (attempt: 1 | 2): Promise<Response> => {
      const token = headerValue(
        await awaitWithAbort(
          Promise.resolve().then(() => options.credentials.getAccessToken()),
          snapshot.signal,
        ),
        'access token',
      );
      const accountId = headerValue(
        options.credentials.read()?.accountId,
        `credential in ${options.credentials.location} account id`,
      );
      const headers = new Headers(snapshot.headers);
      headers.delete('x-api-key');
      headers.set('authorization', `Bearer ${token}`);
      headers.set('chatgpt-account-id', accountId);
      const setTransport = (name: string, value: string): void => {
        if (!preserveTransportHeaders || !headers.has(name))
          headers.set(name, value);
      };
      setTransport('openai-beta', 'responses=experimental');
      setTransport('originator', 'pi');
      setTransport('version', CODEX_OAUTH_CLIENT_VERSION);
      setTransport('user-agent', 'elpis/0.1.0');
      setTransport('session_id', session);
      setTransport('conversation_id', session);
      setTransport('x-client-request-id', session);
      if (responsesLite) setTransport(RESPONSES_LITE_HEADER, 'true');
      else if (!preserveTransportHeaders) headers.delete(RESPONSES_LITE_HEADER);
      setTransport('accept', 'application/json');

      const response = await underlyingFetch(
        snapshot.url,
        requestInitFromSnapshot(snapshot, headers, dispatcher),
      );
      if (observe) {
        await observe({
          request: {
            url: snapshot.url,
            method: snapshot.method,
            headers: observedHeaders(headers),
            body: snapshot.body.slice(),
            expectsStream,
          },
          response: response.clone(),
          attempt,
        });
      }
      return response;
    };

    let response = await send(1);
    if (response.status === 401) {
      await response.body?.cancel().catch(() => undefined);
      await awaitWithAbort(
        Promise.resolve().then(() => options.credentials.forceRefresh()),
        snapshot.signal,
      );
      response = await send(2);
    }
    return response;
  };
}
