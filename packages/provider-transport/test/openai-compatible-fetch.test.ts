import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAICompatibleFetch } from '../src/index.js';

const baseUrl = 'https://provider.invalid/v1';
const chatUrl = `${baseUrl}/chat/completions`;
const responseUrl = `${baseUrl}/responses`;
const bytes = new Uint8Array([0, 255, 1, 128, 13, 10, 42]);

type FetchInit = RequestInit & { dispatcher?: unknown };

function asFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: FetchInit,
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return implementation as typeof globalThis.fetch;
}

test('preserves exact request bytes and exact provider response', async () => {
  const providerResponse = new Response('provider bytes', {
    status: 207,
    headers: { 'x-provider': 'untouched' },
  });
  let calls = 0;
  const request = new Request(chatUrl, { method: 'POST', body: bytes });
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'key:with!compatible-punctuation',
    fetch: asFetch(async (input, init) => {
      calls += 1;
      assert.equal(input, request);
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      const received = new Request(input, init);
      assert.deepEqual(new Uint8Array(await received.arrayBuffer()), bytes);
      return providerResponse;
    }),
  });

  const returned = await pinned(request);
  assert.equal(returned, providerResponse);
  assert.equal(returned.bodyUsed, false);
  assert.equal(returned.status, 207);
  assert.equal(returned.headers.get('x-provider'), 'untouched');
  assert.equal(calls, 1);
});

test('passes the exact AbortSignal and propagates abort rejection', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'key',
    fetch: asFetch(async (_input, init) => {
      observedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          { once: true },
        );
      });
    }),
  });

  const pending = pinned(responseUrl, {
    method: 'POST',
    body: '{}',
    signal: controller.signal,
  });
  await Promise.resolve();
  controller.abort(new DOMException('cancelled', 'AbortError'));

  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(observedSignal, controller.signal);
});

test('owns sensitive headers and dispatcher while preserving safe headers', async () => {
  const dispatcher = { fixture: 'trusted dispatcher' };
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'configured-key',
    dispatcher,
    fetch: asFetch(async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer configured-key');
      for (const name of [
        'x-api-key',
        'api-key',
        'cookie',
        'host',
        'proxy-authorization',
      ])
        assert.equal(headers.get(name), null);
      assert.equal(headers.get('content-type'), 'application/json');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.dispatcher, dispatcher);
      return new Response();
    }),
  });

  await pinned(chatUrl, {
    method: 'POST',
    headers: {
      authorization: 'Bearer caller-secret',
      'x-api-key': 'caller-secret',
      'api-key': 'caller-secret',
      cookie: 'caller-secret',
      host: 'attacker.invalid',
      'proxy-authorization': 'caller-secret',
      'content-type': 'application/json',
    },
    ...({ dispatcher: { fixture: 'caller dispatcher' } } as object),
  });
});

test('drops caller dispatcher when none is configured', async () => {
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'key',
    fetch: asFetch(async (_input, init) => {
      assert.equal(Object.hasOwn(init ?? {}, 'dispatcher'), false);
      return new Response();
    }),
  });
  await pinned(responseUrl, {
    method: 'POST',
    ...({ dispatcher: { fixture: 'caller dispatcher' } } as object),
  });
});

test('refuses non-exact routes before credential or network effects', async () => {
  let keys = 0;
  let calls = 0;
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      keys += 1;
      return 'key';
    },
    fetch: asFetch(async () => {
      calls += 1;
      return new Response();
    }),
  });
  const refused: Array<[string, string]> = [
    ['GET', chatUrl],
    ['POST', baseUrl],
    ['POST', `${chatUrl}/extra`],
    ['POST', `${baseUrl}/x/../chat/completions`],
    ['POST', `${baseUrl}/%63hat/completions`],
    ['POST', `${responseUrl}?api_key=url-secret`],
    ['POST', `${responseUrl}#url-secret`],
    ['POST', 'https://provider.invalid.evil/v1/responses'],
    ['POST', 'https://provider.invalid@evil.invalid/v1/responses'],
    ['POST', 'https://user:url-secret@provider.invalid/v1/responses'],
    ['POST', 'http://provider.invalid/v1/responses'],
  ];

  for (const [method, url] of refused) {
    await assert.rejects(
      () => pinned(url, { method }),
      (error: unknown) =>
        error instanceof TypeError &&
        /refused request/.test(error.message) &&
        !error.message.includes('url-secret'),
    );
  }
  assert.equal(keys, 0);
  assert.equal(calls, 0);
});

test('permits only the two exact POST routes under a normalized base URL', async () => {
  const seen: string[] = [];
  const pinned = createOpenAICompatibleFetch({
    baseUrl: `${baseUrl}/`,
    apiKey: async () => 'key',
    fetch: asFetch(async (input) => {
      seen.push(String(input));
      return new Response();
    }),
  });
  await pinned(chatUrl, { method: 'post' });
  await pinned(responseUrl, { method: 'POST' });
  assert.deepEqual(seen, [chatUrl, responseUrl]);
});

test('rejects malformed keys and key-source failures without leaking values', async () => {
  for (const value of [
    '',
    '   ',
    'secret\r\nInjected: yes',
    'secret\0nul',
    42,
    'x'.repeat(131_073),
  ] as unknown[]) {
    let calls = 0;
    const pinned = createOpenAICompatibleFetch({
      baseUrl,
      apiKey: async () => value as string,
      fetch: asFetch(async () => {
        calls += 1;
        return new Response();
      }),
    });
    await assert.rejects(
      () => pinned(chatUrl, { method: 'POST' }),
      (error: unknown) =>
        error instanceof TypeError &&
        /API key is invalid/.test(error.message) &&
        (String(value).length === 0 || !error.message.includes(String(value))),
    );
    assert.equal(calls, 0);
  }

  const sourceSecret = 'source-error-secret';
  const failedSource = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      throw new Error(sourceSecret);
    },
    fetch: asFetch(async () => new Response()),
  });
  await assert.rejects(
    () => failedSource(chatUrl, { method: 'POST' }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes(sourceSecret),
  );
});

test('rejects unsafe base URL configuration without leaking values', () => {
  for (const configured of [
    'not a URL containing config-secret',
    'ftp://provider.invalid/v1',
    'https://user:config-secret@provider.invalid/v1',
    'https://provider.invalid/v1?key=config-secret',
    'https://provider.invalid/v1#config-secret',
  ]) {
    assert.throws(
      () =>
        createOpenAICompatibleFetch({
          baseUrl: configured,
          apiKey: async () => 'key',
        }),
      (error: unknown) =>
        error instanceof TypeError && !error.message.includes('config-secret'),
    );
  }
});
