import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_CLAUDE_CODE_VERSION,
  AnthropicOAuthUnauthorizedError,
  createAnthropicOAuthTransport,
  type AnthropicOAuthCredentialSource,
} from '../src/anthropic-oauth-transport.js';

const endpoint = 'https://api.anthropic.test/v1/messages?beta=true';
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function credentialSource(): {
  source: AnthropicOAuthCredentialSource;
  tokens(): number;
  refreshes(): number;
} {
  let tokens = 0;
  let refreshes = 0;
  return {
    source: {
      getAccessToken: async () => {
        tokens += 1;
        return `access-${tokens}`;
      },
      forceRefresh: async () => {
        refreshes += 1;
      },
    },
    tokens: () => tokens,
    refreshes: () => refreshes,
  };
}

test('sends exact final bytes with fixed Claude Code headers and trusted dispatcher', async () => {
  const credentials = credentialSource();
  const dispatcher = { kind: 'trusted' };
  const signal = new AbortController().signal;
  const body = bytes('{"system":"cch=abcde","text":"héllo"}');
  let seenUrl = '';
  let seenInit: (RequestInit & { dispatcher?: unknown }) | undefined;
  const providerResponse = new Response('raw-sse', { status: 200 });
  const transport = createAnthropicOAuthTransport({
    baseUrl: 'https://api.anthropic.test/',
    credentials: credentials.source,
    dispatcher,
    fetch: async (input, init) => {
      seenUrl = input.toString();
      seenInit = init;
      return providerResponse;
    },
  });

  const returned = await transport({ body, stream: true, signal });
  assert.equal(returned, providerResponse);
  assert.equal(returned.bodyUsed, false);
  assert.equal(seenUrl, endpoint);
  assert.equal(seenInit?.method, 'POST');
  assert.equal(seenInit?.signal, signal);
  assert.equal(seenInit?.dispatcher, dispatcher);
  assert.deepEqual(new Uint8Array(seenInit?.body as Uint8Array), body);
  const headers = new Headers(seenInit?.headers);
  assert.equal(headers.get('authorization'), 'Bearer access-1');
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(
    headers.get('anthropic-beta'),
    'oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14',
  );
  assert.equal(headers.get('content-type'), 'application/json');
  assert.equal(headers.get('accept'), 'text/event-stream');
  assert.equal(
    headers.get('user-agent'),
    `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION} (external, claude-desktop)`,
  );
  assert.equal(headers.get('x-app'), 'cli');
  assert.equal(
    headers.get('anthropic-dangerous-direct-browser-access'),
    'true',
  );
});

test('refuses unsafe configured roots before credential or network effects', () => {
  const credentials = credentialSource();
  let networkCalls = 0;
  for (const baseUrl of [
    'https://user:pass@api.anthropic.test',
    'https://api.anthropic.test?steal=1',
    'https://api.anthropic.test/#fragment',
    'ftp://api.anthropic.test',
  ]) {
    assert.throws(
      () =>
        createAnthropicOAuthTransport({
          baseUrl,
          credentials: credentials.source,
          fetch: async () => {
            networkCalls += 1;
            return new Response();
          },
        }),
      /configuration/,
    );
  }
  assert.equal(credentials.tokens(), 0);
  assert.equal(networkCalls, 0);
});

test('snapshots mutable base URL and body bytes before token lookup', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const root = new URL('https://api.anthropic.test');
  const body = bytes('first-body');
  let wireBody = new Uint8Array();
  let wireUrl = '';
  let wireHeaders = new Headers();
  const transport = createAnthropicOAuthTransport({
    baseUrl: root,
    credentials: {
      getAccessToken: async () => {
        await gate;
        return 'access-1';
      },
      forceRefresh: async () => undefined,
    },
    fetch: async (input, init) => {
      wireUrl = input.toString();
      wireBody = new Uint8Array(init?.body as Uint8Array);
      wireHeaders = new Headers(init?.headers);
      return new Response();
    },
  });

  const pending = transport({ body, stream: false });
  root.href = 'https://example.com/steal';
  body.fill(0x78);
  release();
  await pending;
  assert.equal(wireUrl, endpoint);
  assert.equal(new TextDecoder().decode(wireBody), 'first-body');
  assert.equal(wireHeaders.get('accept'), 'application/json');
});

test('already-aborted requests do not start token or network effects', async () => {
  const credentials = credentialSource();
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  let networkCalls = 0;
  const transport = createAnthropicOAuthTransport({
    baseUrl: 'https://api.anthropic.test',
    credentials: credentials.source,
    fetch: async () => {
      networkCalls += 1;
      return new Response();
    },
  });

  await assert.rejects(
    () =>
      transport({
        body: bytes('{}'),
        stream: false,
        signal: controller.signal,
      }),
    { name: 'AbortError' },
  );
  assert.equal(credentials.tokens(), 0);
  assert.equal(networkCalls, 0);
});

test('abort after token settlement prevents network dispatch', async () => {
  const controller = new AbortController();
  let releaseToken!: (token: string) => void;
  let tokenStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    tokenStarted = resolve;
  });
  const token = new Promise<string>((resolve) => {
    releaseToken = resolve;
  });
  let networkCalls = 0;
  const transport = createAnthropicOAuthTransport({
    baseUrl: 'https://api.anthropic.test',
    credentials: {
      getAccessToken: () => {
        tokenStarted();
        return token;
      },
      forceRefresh: async () => undefined,
    },
    fetch: async () => {
      networkCalls += 1;
      return new Response();
    },
  });

  const pending = transport({
    body: bytes('{}'),
    stream: false,
    signal: controller.signal,
  });
  await started;
  releaseToken('access-1');
  queueMicrotask(() =>
    controller.abort(new DOMException('cancelled', 'AbortError')),
  );
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(networkCalls, 0);
});

test('401 refreshes once without replay and throws typed retriable signal', async () => {
  const credentials = credentialSource();
  let networkCalls = 0;
  const transport = createAnthropicOAuthTransport({
    baseUrl: 'https://api.anthropic.test',
    credentials: credentials.source,
    fetch: async () => {
      networkCalls += 1;
      return new Response('expired', { status: 401 });
    },
  });

  await assert.rejects(
    () => transport({ body: bytes('{}'), stream: false }),
    (error: unknown) =>
      error instanceof AnthropicOAuthUnauthorizedError &&
      error.responseText === 'expired',
  );
  assert.equal(networkCalls, 1);
  assert.equal(credentials.tokens(), 1);
  assert.equal(credentials.refreshes(), 1);
});

test('return-response unauthorized mode preserves the exact 401 without refreshing', async () => {
  const credentials = credentialSource();
  const response = new Response(new Uint8Array([0x72, 0x61, 0x77]), {
    status: 401,
    headers: { 'x-request-id': 'raw-401' },
  });
  const transport = createAnthropicOAuthTransport({
    baseUrl: 'https://api.anthropic.test',
    credentials: credentials.source,
    unauthorized: 'return-response',
    fetch: async () => response,
  });

  const returned = await transport({ body: bytes('{}'), stream: false });
  assert.equal(returned, response);
  assert.equal(returned.status, 401);
  assert.deepEqual(
    new Uint8Array(await returned.arrayBuffer()),
    new Uint8Array([0x72, 0x61, 0x77]),
  );
  assert.equal(credentials.tokens(), 1);
  assert.equal(credentials.refreshes(), 0);
});

test('an aborting 401 response does not start refresh', async () => {
  const controller = new AbortController();
  const credentials = credentialSource();
  let networkCalls = 0;
  const transport = createAnthropicOAuthTransport({
    baseUrl: 'https://api.anthropic.test',
    credentials: credentials.source,
    fetch: async () => {
      networkCalls += 1;
      controller.abort(new DOMException('cancelled', 'AbortError'));
      return new Response('expired', { status: 401 });
    },
  });

  await assert.rejects(
    () =>
      transport({
        body: bytes('{}'),
        stream: false,
        signal: controller.signal,
      }),
    { name: 'AbortError' },
  );
  assert.equal(networkCalls, 1);
  assert.equal(credentials.refreshes(), 0);
});

test('returns non-401 error responses raw and unconsumed', async () => {
  const credentials = credentialSource();
  const providerResponse = new Response('forbidden', { status: 403 });
  const transport = createAnthropicOAuthTransport({
    baseUrl: 'https://api.anthropic.test',
    credentials: credentials.source,
    fetch: async () => providerResponse,
  });

  const returned = await transport({ body: bytes('{}'), stream: false });
  assert.equal(returned, providerResponse);
  assert.equal(returned.bodyUsed, false);
  assert.equal(await returned.text(), 'forbidden');
  assert.equal(credentials.refreshes(), 0);
});
