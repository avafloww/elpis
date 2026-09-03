import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { createServer } from 'node:http';
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

function cancellableRequest(url = responseUrl): {
  request: Request;
  cancelled: () => number;
} {
  let cancelCount = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('payload'));
    },
    cancel() {
      cancelCount += 1;
    },
  });
  const request = new Request(url, {
    method: 'POST',
    body,
    ...({ duplex: 'half' } as object),
  });
  return { request, cancelled: () => cancelCount };
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
      assert.notEqual(input, request);
      assert.equal(input instanceof Request, true);
      const received = new Request(input);
      assert.equal(received.url, chatUrl);
      assert.equal(received.method, 'POST');
      assert.equal(received.redirect, 'error');
      assert.equal(init, undefined);
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

test('takes immutable custody of a mutable URL before credential lookup', async () => {
  let releaseKey!: () => void;
  const keyGate = new Promise<void>((resolve) => {
    releaseKey = resolve;
  });
  const target = new URL(responseUrl);
  let observedUrl: string | undefined;
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      await keyGate;
      return 'configured-key';
    },
    fetch: asFetch(async (input) => {
      observedUrl = new Request(input).url;
      return new Response();
    }),
  });

  const pending = pinned(target, { method: 'POST' });
  target.href = 'https://attacker.invalid/steal';
  releaseKey();
  await pending;
  assert.equal(observedUrl, responseUrl);
});

test('rejects a Request with a deceptive URL getter before side effects', async () => {
  const body = cancellableRequest('https://attacker.invalid/steal');
  const deceptive = body.request;
  Object.defineProperty(deceptive, 'url', {
    get: () => responseUrl,
  });
  let keys = 0;
  let calls = 0;
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      keys += 1;
      return 'configured-key';
    },
    fetch: asFetch(async () => {
      calls += 1;
      return new Response();
    }),
  });

  await assert.rejects(
    () => pinned(deceptive),
    /OpenAI-compatible fetch refused request/,
  );
  assert.equal(keys, 0);
  assert.equal(calls, 0);
  assert.equal(body.cancelled(), 1);
});

test('rejects an already-aborted request before credential lookup', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  let keys = 0;
  let calls = 0;
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      keys += 1;
      return 'configured-key';
    },
    fetch: asFetch(async () => {
      calls += 1;
      return new Response();
    }),
  });

  await assert.rejects(
    () => pinned(responseUrl, { method: 'POST', signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(keys, 0);
  assert.equal(calls, 0);
});

test('abort cancels a pending key lookup and removes its listener', async () => {
  const controller = new AbortController();
  let keys = 0;
  let calls = 0;
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      keys += 1;
      return new Promise<string>(() => undefined);
    },
    fetch: asFetch(async () => {
      calls += 1;
      return new Response();
    }),
  });

  const pending = pinned(responseUrl, {
    method: 'POST',
    signal: controller.signal,
  });
  await Promise.resolve();
  assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  const outcome = await Promise.race([
    pending.then(
      () => 'resolved',
      (error: unknown) =>
        error instanceof DOMException && error.name === 'AbortError'
          ? 'aborted'
          : 'other-error',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 30)),
  ]);
  assert.equal(outcome, 'aborted');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(keys, 1);
  assert.equal(calls, 0);
});

test('abort during key lookup cancels a transferred request body', async () => {
  const controller = new AbortController();
  const body = cancellableRequest();
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => new Promise<string>(() => undefined),
    fetch: asFetch(async () => new Response()),
  });

  const pending = pinned(body.request, { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(body.request.bodyUsed, true);
  assert.equal(body.cancelled(), 1);
});

test('key-source failure cancels a transferred request body', async () => {
  const body = cancellableRequest();
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      throw new Error('source secret');
    },
    fetch: asFetch(async () => new Response()),
  });

  await assert.rejects(() => pinned(body.request), /API key source failed/);
  assert.equal(body.request.bodyUsed, true);
  assert.equal(body.cancelled(), 1);
});

test('invalid key cancels a transferred request body', async () => {
  const body = cancellableRequest();
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'invalid key with spaces',
    fetch: asFetch(async () => new Response()),
  });

  await assert.rejects(() => pinned(body.request), /API key is invalid/);
  assert.equal(body.request.bodyUsed, true);
  assert.equal(body.cancelled(), 1);
});

test('locks a Request body before asynchronous credential lookup', async () => {
  let releaseKey!: () => void;
  const keyGate = new Promise<void>((resolve) => {
    releaseKey = resolve;
  });
  const original = new Request(responseUrl, {
    method: 'POST',
    body: 'payload',
  });
  let observedBody = '';
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => {
      await keyGate;
      return 'configured-key';
    },
    fetch: asFetch(async (input) => {
      observedBody = await new Request(input).text();
      return new Response();
    }),
  });

  const pending = pinned(original);
  await Promise.resolve();
  assert.equal(original.bodyUsed, true);
  await assert.rejects(() => original.text(), TypeError);
  releaseKey();
  await pending;
  assert.equal(observedBody, 'payload');
});

test('forwards only standard Request state plus trusted dispatcher', async () => {
  const dispatcher = { fixture: 'trusted dispatcher' };
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'configured-key',
    dispatcher,
    fetch: asFetch(async (input, init) => {
      assert.equal(input instanceof Request, true);
      assert.deepEqual(Object.keys(init ?? {}), ['dispatcher']);
      assert.equal(init?.dispatcher, dispatcher);
      return new Response();
    }),
  });

  await pinned(responseUrl, {
    method: 'POST',
    body: 'payload',
    ...({
      dispatcher: { fixture: 'caller dispatcher' },
      agent: { attacker: true },
      lookup: () => 'attacker.invalid',
      proxy: 'http://attacker.invalid',
    } as object),
  });
});

test('passes the exact AbortSignal and propagates abort rejection', async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | null | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'key',
    fetch: asFetch(async (input) => {
      const request = new Request(input);
      observedSignal = request.signal;
      markStarted();
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
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
  await started;
  controller.abort(new DOMException('cancelled', 'AbortError'));

  await assert.rejects(pending, { name: 'AbortError' });
  assert.notEqual(observedSignal, undefined);
  assert.equal(observedSignal?.aborted, true);
});

test('owns sensitive headers and dispatcher while preserving safe headers', async () => {
  const dispatcher = { fixture: 'trusted dispatcher' };
  const pinned = createOpenAICompatibleFetch({
    baseUrl,
    apiKey: async () => 'configured-key',
    dispatcher,
    fetch: asFetch(async (input, init) => {
      const request = new Request(input);
      const headers = request.headers;
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
      assert.equal(request.redirect, 'error');
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
    fetch: asFetch(async (input, init) => {
      assert.equal(input instanceof Request, true);
      assert.equal(init, undefined);
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
      seen.push(new Request(input).url);
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

test('default fetch refuses redirects without reaching the redirect target', async () => {
  let redirected = 0;
  const server = createServer((request, response) => {
    if (request.url === '/v1/responses') {
      response.writeHead(302, { location: '/stolen' });
      response.end();
      return;
    }
    redirected += 1;
    response.writeHead(204);
    response.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  try {
    const localBase = `http://127.0.0.1:${address.port}/v1`;
    const pinned = createOpenAICompatibleFetch({
      baseUrl: localBase,
      apiKey: async () => 'configured-key',
    });
    await assert.rejects(
      () => pinned(`${localBase}/responses`, { method: 'POST' }),
      TypeError,
    );
    assert.equal(redirected, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
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
