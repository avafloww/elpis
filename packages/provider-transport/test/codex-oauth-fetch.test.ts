import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCodexOAuthFetch,
  type CodexOAuthCredentialSource,
} from '../src/index.js';

const responsesUrl = 'https://chatgpt.com/backend-api/codex/responses';
const modelsUrl =
  'https://chatgpt.com/backend-api/codex/models?client_version=1.2.3';

function credentialSource() {
  let token = 'access-1';
  let reads = 0;
  let refreshes = 0;
  const source: CodexOAuthCredentialSource = {
    location: 'memory codex credential',
    read: () => {
      reads += 1;
      return { accountId: 'acct-1' };
    },
    getAccessToken: async () => token,
    forceRefresh: async () => {
      refreshes += 1;
      token = 'access-2';
    },
  };
  return {
    source,
    reads: () => reads,
    refreshes: () => refreshes,
  };
}

function requestOf(input: RequestInfo | URL, init?: RequestInit): Request {
  return input instanceof Request ? input : new Request(input, init);
}

test('injects exact Codex headers and replays the body once after 401', async () => {
  const credentials = credentialSource();
  const seen: Array<{
    headers: Headers;
    body: string;
    redirect: RequestRedirect;
  }> = [];
  const transport = createCodexOAuthFetch({
    credentials: credentials.source,
    sessionId: () => 'session-1',
    responsesLite: true,
    fetch: async (input, init) => {
      const request = requestOf(input, init);
      seen.push({
        headers: new Headers(request.headers),
        body: await request.text(),
        redirect: request.redirect,
      });
      return new Response('', { status: seen.length === 1 ? 401 : 200 });
    },
  });

  const response = await transport(responsesUrl, {
    method: 'POST',
    headers: {
      authorization: 'Bearer hostile',
      'chatgpt-account-id': 'hostile-account',
      'x-api-key': 'hostile-key',
      'x-safe': 'preserved',
    },
    body: '{"same":"bytes"}',
  });

  assert.equal(response.status, 200);
  assert.equal(credentials.refreshes(), 1);
  assert.equal(credentials.reads(), 2);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((entry) => entry.body),
    ['{"same":"bytes"}', '{"same":"bytes"}'],
  );
  assert.deepEqual(
    seen.map((entry) => entry.redirect),
    ['error', 'error'],
  );
  assert.equal(seen[0].headers.get('authorization'), 'Bearer access-1');
  assert.equal(seen[1].headers.get('authorization'), 'Bearer access-2');
  assert.equal(seen[1].headers.get('chatgpt-account-id'), 'acct-1');
  assert.equal(seen[1].headers.get('openai-beta'), 'responses=experimental');
  assert.equal(seen[1].headers.get('originator'), 'pi');
  assert.equal(seen[1].headers.get('version'), '0.144.1');
  assert.equal(seen[1].headers.get('session_id'), 'session-1');
  assert.equal(seen[1].headers.get('conversation_id'), 'session-1');
  assert.equal(seen[1].headers.get('x-client-request-id'), 'session-1');
  assert.equal(
    seen[1].headers.get('x-openai-internal-codex-responses-lite'),
    'true',
  );
  assert.equal(seen[1].headers.get('x-safe'), 'preserved');
  assert.equal(seen[1].headers.has('x-api-key'), false);
});

test('refuses hostile Codex targets before credential or network access', async () => {
  const credentials = credentialSource();
  let networkCalls = 0;
  const transport = createCodexOAuthFetch({
    credentials: credentials.source,
    sessionId: () => 'session-1',
    fetch: async () => {
      networkCalls += 1;
      return new Response();
    },
  });

  for (const target of [
    'https://example.com/backend-api/codex/responses',
    'https://user:pass@chatgpt.com/backend-api/codex/responses',
    'https://chatgpt.com:444/backend-api/codex/responses',
    'https://chatgpt.com/evil',
  ]) {
    await assert.rejects(
      () => transport(target, { method: 'POST' }),
      /refusing/,
    );
  }
  assert.equal(credentials.reads(), 0);
  assert.equal(networkCalls, 0);
});

test('allows canonical model discovery GET with exact session headers', async () => {
  const credentials = credentialSource();
  let request: Request | undefined;
  const transport = createCodexOAuthFetch({
    credentials: credentials.source,
    sessionId: () => 'discovery-session',
    fetch: async (input, init) => {
      request = requestOf(input, init);
      return new Response('{"models":[]}');
    },
  });

  const response = await transport(modelsUrl, { method: 'GET' });
  assert.equal(await response.text(), '{"models":[]}');
  assert.equal(request?.method, 'GET');
  assert.equal(request?.url, modelsUrl);
  assert.equal(request?.headers.get('authorization'), 'Bearer access-1');
  assert.equal(request?.headers.get('session_id'), 'discovery-session');
});

test('observer receives exact body and clone without transport secrets', async () => {
  const credentials = credentialSource();
  const observations: Array<{
    body: Uint8Array;
    headers: Headers;
    responseText: string;
  }> = [];
  const providerResponse = new Response('provider-body', {
    status: 207,
    headers: { 'x-provider': 'preserved' },
  });
  const transport = createCodexOAuthFetch({
    credentials: credentials.source,
    sessionId: () => 'observed-session',
    fetch: async () => providerResponse,
    observe: async ({ request, response }) => {
      observations.push({
        body: request.body,
        headers: request.headers,
        responseText: await response.text(),
      });
    },
  });

  const returned = await transport(responsesUrl, {
    method: 'POST',
    body: 'observer-bytes',
  });
  assert.equal(returned, providerResponse);
  assert.equal(returned.bodyUsed, false);
  assert.equal(await returned.text(), 'provider-body');
  assert.equal(observations.length, 1);
  assert.equal(
    new TextDecoder().decode(observations[0].body),
    'observer-bytes',
  );
  assert.equal(observations[0].responseText, 'provider-body');
  assert.equal(observations[0].headers.get('session_id'), 'observed-session');
  assert.equal(observations[0].headers.has('authorization'), false);
  assert.equal(observations[0].headers.has('chatgpt-account-id'), false);
});

test('uses only the trusted dispatcher and preserves recorded transport headers', async () => {
  const credentials = credentialSource();
  const dispatcher = { kind: 'trusted' };
  let seenInit: (RequestInit & { dispatcher?: unknown }) | undefined;
  const transport = createCodexOAuthFetch({
    credentials: credentials.source,
    sessionId: () => 'new-session',
    responsesLite: false,
    preserveTransportHeaders: true,
    dispatcher,
    fetch: async (_input, init) => {
      seenInit = init;
      return new Response();
    },
  });

  await transport(responsesUrl, {
    method: 'POST',
    headers: {
      version: 'recorded-version',
      session_id: 'recorded-session',
      'x-openai-internal-codex-responses-lite': 'true',
    },
    body: '{}',
    ...({ dispatcher: { kind: 'hostile' } } as object),
  });

  const headers = new Headers(seenInit?.headers);
  assert.equal(seenInit?.dispatcher, dispatcher);
  assert.equal(headers.get('version'), 'recorded-version');
  assert.equal(headers.get('session_id'), 'recorded-session');
  assert.equal(headers.get('x-openai-internal-codex-responses-lite'), 'true');
  assert.equal(headers.get('authorization'), 'Bearer access-1');
});

test('aborting credential lookup prevents the network effect', async () => {
  const controller = new AbortController();
  let networkCalls = 0;
  const transport = createCodexOAuthFetch({
    credentials: {
      location: 'pending credential',
      read: () => ({ accountId: 'acct-1' }),
      getAccessToken: async () => new Promise<string>(() => undefined),
      forceRefresh: async () => undefined,
    },
    sessionId: () => 'session-1',
    fetch: async () => {
      networkCalls += 1;
      return new Response();
    },
  });

  const pending = transport(responsesUrl, {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
  });
  await Promise.resolve();
  await Promise.resolve();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(networkCalls, 0);
});

test('snapshots a mutable URL before asynchronous credential lookup', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observedUrl = '';
  const target = new URL(responsesUrl);
  const transport = createCodexOAuthFetch({
    credentials: {
      location: 'gated credential',
      read: () => ({ accountId: 'acct-1' }),
      getAccessToken: async () => {
        await gate;
        return 'access-1';
      },
      forceRefresh: async () => undefined,
    },
    sessionId: () => 'session-1',
    fetch: async (input) => {
      observedUrl = input.toString();
      return new Response();
    },
  });

  const pending = transport(target, { method: 'POST', body: '{}' });
  target.href = 'https://example.com/steal';
  release();
  await pending;
  assert.equal(observedUrl, responsesUrl);
});

test('retries at most once when the refreshed credential also gets 401', async () => {
  const credentials = credentialSource();
  let calls = 0;
  const transport = createCodexOAuthFetch({
    credentials: credentials.source,
    sessionId: () => 'session-1',
    fetch: async () => {
      calls += 1;
      return new Response('', { status: 401 });
    },
  });

  const response = await transport(responsesUrl, {
    method: 'POST',
    body: '{}',
  });
  assert.equal(response.status, 401);
  assert.equal(calls, 2);
  assert.equal(credentials.refreshes(), 1);
});

test('cancels a transferred request body after refusing its target', async () => {
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('payload'));
    },
    cancel() {
      cancellations += 1;
    },
  });
  const request = new Request(
    'https://example.com/backend-api/codex/responses',
    {
      method: 'POST',
      body,
      ...({ duplex: 'half' } as object),
    },
  );
  const credentials = credentialSource();
  const transport = createCodexOAuthFetch({
    credentials: credentials.source,
    sessionId: () => 'session-1',
    fetch: async () => new Response(),
  });

  await assert.rejects(() => transport(request), /refusing/);
  assert.equal(request.bodyUsed, true);
  assert.equal(cancellations, 1);
  assert.equal(credentials.reads(), 0);
});
