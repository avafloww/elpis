import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_HEADERS,
  LLM_PROXY_LIMITS,
  LLM_PROXY_PATHS,
  LLM_PROXY_SAFE_RESPONSE_HEADERS,
  createNodeCredential,
  decodeLlmProxyCatalog,
  decodeLlmProxyError,
  decodeLlmResponseProvenance,
  formatNodeBearerAuthorization,
  newGatewayInstanceId,
  newLlmTargetGeneration,
  serializeLlmProxyCatalog,
  serializeLlmProxyRequest,
  type LlmProxyCatalog,
  type LlmProxyRequest,
} from '@elpis/gateway-protocol';
import {
  BoundedGatewayLlmProxyRateLimiter,
  createGatewayHttpService,
  type GatewayHttpService,
  type GatewayHttpServiceOptions,
  type GatewayLlmProxyApi,
  type GatewayLlmProxyRateLimiter,
} from '../src/index.js';
import {
  GatewayLlmAbort,
  raceLlmAbort,
  streamLlmExchange,
} from '../src/llm-proxy-http.js';

type Reply = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

function exchange(
  port: number,
  method: string,
  target: string,
  body = '',
  headers: string[] = [],
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const requestHeaders = ['Host', '127.0.0.1', ...headers];
    if (body.length > 0) {
      requestHeaders.push(
        'Content-Type',
        'application/json',
        'Content-Length',
        String(Buffer.byteLength(body)),
      );
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: target,
        headers: requestHeaders,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function partialBodyExchange(
  port: number,
  body: string,
  authorization: string,
  declaredLength = Buffer.byteLength(body),
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: LLM_PROXY_PATHS.request,
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
        'Content-Length': String(declaredLength),
      },
    });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        settled = true;
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
        request.destroy();
      });
    });
    request.on('error', (error) => {
      if (!settled) reject(error);
    });
    request.write(body.slice(0, 1));
  });
}

function chunkedExchange(
  port: number,
  body: string,
  authorization: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: LLM_PROXY_PATHS.request,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          'Transfer-Encoding': 'chunked',
          Connection: 'close',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function abortedExchange(
  port: number,
  body: string,
  authorization: string,
): Promise<{ status: number; body: Buffer; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: LLM_PROXY_PATHS.request,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let settled = false;
        const finish = (aborted: boolean): void => {
          if (settled) return;
          settled = true;
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
            aborted,
          });
        };
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => finish(false));
        response.on('aborted', () => finish(true));
        response.on('error', () => finish(true));
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function expectExchange(
  port: number,
  body: string,
  headers: string[],
): Promise<{ reply: Reply; continues: number }> {
  return new Promise((resolve, reject) => {
    let continues = 0;
    const request = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: LLM_PROXY_PATHS.request,
      headers: [
        'Host',
        '127.0.0.1',
        'Expect',
        '100-continue',
        'Content-Length',
        String(Buffer.byteLength(body)),
        ...headers,
      ],
    });
    request.on('continue', () => {
      continues += 1;
      request.end(body);
    });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () =>
        resolve({
          continues,
          reply: {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          },
        }),
      );
    });
    request.on('error', reject);
    request.flushHeaders();
  });
}

async function fixture(
  t: Parameters<Parameters<typeof test>[1]>[0],
  options: Partial<GatewayHttpServiceOptions> = {},
): Promise<{
  service: GatewayHttpService;
  port: number;
  authorization: string;
  catalog: LlmProxyCatalog;
  request: LlmProxyRequest;
  calls: string[];
  llmProxy: GatewayLlmProxyApi;
}> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-llm-http-'));
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway');

  const node = createNodeCredential((size) => Buffer.alloc(size, 0x41));
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 0x42));
  const targetGeneration = newLlmTargetGeneration((size) =>
    Buffer.alloc(size, 0x43),
  );
  const payload = Buffer.from(
    JSON.stringify({ model: 'gpt-5.4-upstream', input: 'hello' }),
  );
  const request: LlmProxyRequest = {
    format: LLM_PROXY_FORMATS.request,
    requestId: 'egr1.DDDDDDDDDDDDDDDDDDDDDD',
    modelRef: 'resident/gpt-5.4',
    targetGeneration,
    route: 'responses',
    transport: { kind: 'none' },
    byteLength: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
    payload,
  };
  const catalog: LlmProxyCatalog = {
    format: LLM_PROXY_FORMATS.catalog,
    revision: 7,
    models: [
      {
        modelRef: request.modelRef,
        targetGeneration,
        providerType: 'openai-compatible',
        model: 'gpt-5.4-upstream',
        allowedRoutes: ['responses'],
        contextSize: 272_000,
        reasoningEffort: 'high',
        reasoningSummary: null,
        reasoningContext: null,
        toolTier: 'strong',
        externalThinking: false,
        toolContractVersion: 'elpis-run-v4',
        callTimeoutMs: 300_000,
        streamIdleTimeoutMs: 45_000,
      },
    ],
  };
  const calls: string[] = [];
  const llmProxy: GatewayLlmProxyApi = {
    authenticateNode(token: unknown) {
      calls.push('authenticate');
      if (token !== node.token) return null;
      return Object.freeze({ instanceId, credentialId: node.id });
    },
    catalogForInstance(candidate: string) {
      calls.push('catalog');
      assert.equal(candidate, instanceId);
      return catalog;
    },
    async dispatch(input: {
      instanceId: string;
      request: LlmProxyRequest;
      signal: AbortSignal;
    }) {
      calls.push('dispatch');
      assert.equal(input.instanceId, instanceId);
      assert.deepEqual(
        { ...input.request, payload: Buffer.from(input.request.payload) },
        request,
      );
      assert.notEqual(input.request.payload, request.payload);
      assert.equal(input.signal.aborted, false);
      return {
        status: 201,
        headers: [
          ['content-type', 'application/json'],
          ['set-cookie', 'provider-secret=forbidden'],
          ['x-request-id', 'upstream-request'],
        ] as const,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('{"ok":'));
            controller.enqueue(Buffer.from('true}'));
            controller.close();
          },
        }),
      };
    },
  };
  const service = createGatewayHttpService({
    publicRoot,
    listen: { host: '127.0.0.1', port: 0 },
    llmProxy,
    ...options,
  });
  t.after(async () => {
    await service.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const address = await service.start();
  return {
    service,
    port: address.port,
    authorization: formatNodeBearerAuthorization(node.token),
    catalog,
    request,
    calls,
    llmProxy,
  };
}

test('LLM HTTP routes reject aliases and authenticate before catalog or body work', async (t) => {
  const f = await fixture(t);

  const alias = await exchange(
    f.port,
    'GET',
    LLM_PROXY_PATHS.catalog + '?hidden=1',
  );
  assert.equal(alias.status, 404);
  assert.deepEqual(f.calls, []);

  const wrongMethod = await exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.catalog,
    '{"unread":"body"}',
    ['Authorization', f.authorization],
  );
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(f.calls, []);

  const unauthorized = await exchange(
    f.port,
    'GET',
    LLM_PROXY_PATHS.catalog,
    '',
    [
      'Authorization',
      'Bearer browser-session',
      'Origin',
      'https://gateway.example',
      'Cookie',
      '__Host-elpis-csrf=browser',
      'X-Elpis-Csrf',
      'browser',
    ],
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(decodeLlmProxyError(unauthorized.body).code, 'unauthorized');
  assert.deepEqual(f.calls, []);

  const accepted = await exchange(f.port, 'GET', LLM_PROXY_PATHS.catalog, '', [
    'Authorization',
    f.authorization,
  ]);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.toString(), serializeLlmProxyCatalog(f.catalog));
  assert.deepEqual(decodeLlmProxyCatalog(accepted.body), f.catalog);
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
});

test('pre-aborted LLM races still observe the supplied operation', async () => {
  const controller = new AbortController();
  const reason = new GatewayLlmAbort('shutdown');
  controller.abort(reason);
  let rejectionObservers = 0;
  const operation = {
    then(_fulfilled: unknown, rejected: unknown) {
      if (typeof rejected === 'function') rejectionObservers += 1;
      return Promise.resolve();
    },
  } as unknown as Promise<never>;
  await assert.rejects(
    raceLlmAbort(operation, controller.signal),
    (error: unknown) => error === reason,
  );
  assert.equal(rejectionObservers, 1);
});

test('default LLM limiter is bounded and cannot evict a live peer bucket', () => {
  assert.throws(
    () => new BoundedGatewayLlmProxyRateLimiter({ maxEntries: 0 }),
    /maxEntries/,
  );
  const limiter = new BoundedGatewayLlmProxyRateLimiter({
    maxEntries: 1,
    windowMs: 10,
    requestsPerWindow: 1,
  });
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.1', route: 'request', now: 0 }),
    true,
  );
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.1', route: 'request', now: 1 }),
    false,
  );
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.2', route: 'request', now: 1 }),
    false,
  );
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.2', route: 'request', now: 10 }),
    true,
  );
  assert.equal(
    limiter.allow({ peerAddress: '', route: 'request', now: 10 }),
    false,
  );
  assert.equal(
    limiter.allow({
      peerAddress: '127.0.0.2',
      route: 'invalid' as 'request',
      now: 10,
    }),
    false,
  );
});

test('LLM HTTP rate admission uses the direct peer and precedes authentication', async (t) => {
  const attempts: Parameters<GatewayLlmProxyRateLimiter['allow']>[0][] = [];
  const limiter: GatewayLlmProxyRateLimiter = {
    allow(input) {
      attempts.push(input);
      return false;
    },
  };
  const f = await fixture(t, {
    llmRateLimiter: limiter,
    llmNow: () => 1234,
  });
  const reply = await exchange(f.port, 'GET', LLM_PROXY_PATHS.catalog, '', [
    'Authorization',
    f.authorization,
    'X-Forwarded-For',
    '203.0.113.77',
  ]);
  assert.equal(reply.status, 429);
  assert.equal(decodeLlmProxyError(reply.body).code, 'rate_limited');
  assert.deepEqual(f.calls, []);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0]?.route, 'catalog');
  assert.equal(attempts[0]?.now, 1234);
  assert.ok(
    ['127.0.0.1', '::ffff:127.0.0.1'].includes(attempts[0]!.peerAddress),
  );
});

test('LLM HTTP global concurrency refuses without queueing or authentication', async (t) => {
  const f = await fixture(t, { llmMaxConcurrent: 1 });
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let release!: (
    value: Awaited<ReturnType<GatewayLlmProxyApi['dispatch']>>,
  ) => void;
  f.llmProxy.dispatch = () => {
    f.calls.push('dispatch');
    start();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    ['Authorization', f.authorization],
  );
  await started;
  let firstReply: Reply;
  try {
    const refused = await exchange(f.port, 'GET', LLM_PROXY_PATHS.catalog, '', [
      'Authorization',
      f.authorization,
    ]);
    assert.equal(refused.status, 429);
    assert.equal(decodeLlmProxyError(refused.body).code, 'rate_limited');
    assert.deepEqual(f.calls, ['authenticate', 'catalog', 'dispatch']);
  } finally {
    release({ status: 204, headers: [], body: null });
    firstReply = await first;
  }
  assert.equal(firstReply.status, 204);
});

test('LLM HTTP never sends 100 Continue before node auth and body admission', async (t) => {
  const f = await fixture(t);
  const body = serializeLlmProxyRequest(f.request);

  const unauthorized = await expectExchange(f.port, body, [
    'Content-Type',
    'application/json',
    'Authorization',
    'Bearer browser-session',
  ]);
  assert.equal(unauthorized.continues, 0);
  assert.equal(unauthorized.reply.status, 401);
  assert.equal(
    decodeLlmProxyError(unauthorized.reply.body).code,
    'unauthorized',
  );
  assert.deepEqual(f.calls, []);

  const wrongType = await expectExchange(f.port, body, [
    'Content-Type',
    'text/plain',
    'Authorization',
    f.authorization,
  ]);
  assert.equal(wrongType.continues, 0);
  assert.equal(wrongType.reply.status, 415);
  assert.equal(
    decodeLlmProxyError(wrongType.reply.body).code,
    'invalid_request',
  );
  assert.deepEqual(f.calls, ['authenticate']);
  f.calls.length = 0;

  const accepted = await expectExchange(f.port, body, [
    'Content-Type',
    'application/json',
    'Authorization',
    f.authorization,
  ]);
  assert.equal(accepted.continues, 1);
  assert.equal(accepted.reply.status, 201);
  assert.equal(accepted.reply.body.toString(), '{"ok":true}');
  assert.deepEqual(f.calls, ['authenticate', 'catalog', 'dispatch']);
});

test('LLM HTTP authorization failures never dispatch and include only validated request IDs', async (t) => {
  const f = await fixture(t);
  const send = async (request: LlmProxyRequest) =>
    exchange(
      f.port,
      'POST',
      LLM_PROXY_PATHS.request,
      serializeLlmProxyRequest(request),
      ['Authorization', f.authorization],
    );

  const stale = await send({
    ...f.request,
    targetGeneration: newLlmTargetGeneration((size) =>
      Buffer.alloc(size, 0x44),
    ),
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(decodeLlmProxyError(stale.body), {
    format: LLM_PROXY_FORMATS.error,
    code: 'stale_target',
    requestId: f.request.requestId,
  });
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
  f.calls.length = 0;

  const deniedRoute = await send({
    ...f.request,
    route: 'chat/completions',
  });
  assert.equal(deniedRoute.status, 403);
  assert.equal(decodeLlmProxyError(deniedRoute.body).code, 'route_not_allowed');
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
  f.calls.length = 0;

  const wrongPayload = Buffer.from(
    JSON.stringify({ model: 'other-upstream', input: 'hello' }),
  );
  const forbidden = await send({
    ...f.request,
    payload: wrongPayload,
    byteLength: wrongPayload.byteLength,
    sha256: createHash('sha256').update(wrongPayload).digest('hex'),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(decodeLlmProxyError(forbidden.body).code, 'forbidden');
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
  f.calls.length = 0;

  const malformed = await exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    '{',
    ['Authorization', f.authorization],
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(decodeLlmProxyError(malformed.body), {
    format: LLM_PROXY_FORMATS.error,
    code: 'invalid_request',
  });
  assert.deepEqual(f.calls, ['authenticate']);
});

test('LLM HTTP call timeout settles when the dispatcher ignores abort', async (t) => {
  const f = await fixture(t);
  const mutableModel = f.catalog.models[0] as { callTimeoutMs: number };
  mutableModel.callTimeoutMs = 25;
  let release:
    | ((value: Awaited<ReturnType<GatewayLlmProxyApi['dispatch']>>) => void)
    | undefined;
  let aborts = 0;
  f.llmProxy.dispatch = ({ signal }) =>
    new Promise((resolve) => {
      release = resolve;
      signal.addEventListener('abort', () => {
        aborts += 1;
      });
    });

  const pending = exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    ['Authorization', f.authorization],
  );
  let reply: Reply;
  try {
    reply = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error('LLM call timeout did not settle the response')),
          500,
        );
        timer.unref();
      }),
    ]);
  } finally {
    release?.({ status: 204, headers: [], body: null });
    await pending.catch(() => undefined);
  }
  assert.equal(reply.status, 504);
  assert.deepEqual(decodeLlmProxyError(reply.body), {
    format: LLM_PROXY_FORMATS.error,
    code: 'upstream_timeout',
    requestId: f.request.requestId,
  });
  assert.equal(aborts, 1);
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
});

test('LLM HTTP rejects encoded, chunked, and oversized framing before catalog', async (t) => {
  const f = await fixture(t);
  const body = serializeLlmProxyRequest(f.request);
  const encoded = await exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    body,
    ['Authorization', f.authorization, 'Content-Encoding', 'gzip'],
  );
  assert.equal(encoded.status, 400);
  assert.equal(decodeLlmProxyError(encoded.body).code, 'invalid_request');

  const chunked = await chunkedExchange(f.port, body, f.authorization);
  assert.equal(chunked.status, 400);
  assert.equal(decodeLlmProxyError(chunked.body).code, 'invalid_request');

  const oversized = await partialBodyExchange(
    f.port,
    '{',
    f.authorization,
    LLM_PROXY_LIMITS.requestBodyBytes + 1,
  );
  assert.equal(oversized.status, 413);
  assert.equal(decodeLlmProxyError(oversized.body).code, 'payload_too_large');
  assert.deepEqual(f.calls, ['authenticate', 'authenticate', 'authenticate']);
});

test('LLM HTTP body timeout returns a canonical 408 before catalog or dispatch', async (t) => {
  const f = await fixture(t, { bodyTimeoutMs: 25 });
  const reply = await Promise.race([
    partialBodyExchange(
      f.port,
      serializeLlmProxyRequest(f.request),
      f.authorization,
    ),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('LLM partial body timeout did not settle')),
        500,
      );
      timer.unref();
    }),
  ]);
  assert.equal(reply.status, 408);
  assert.equal(reply.headers.connection, 'close');
  assert.deepEqual(decodeLlmProxyError(reply.body), {
    format: LLM_PROXY_FORMATS.error,
    code: 'invalid_request',
  });
  assert.deepEqual(f.calls, ['authenticate']);
});

test('LLM HTTP stream idle timeout settles before the first response byte', async (t) => {
  const f = await fixture(t);
  const mutableModel = f.catalog.models[0] as {
    callTimeoutMs: number;
    streamIdleTimeoutMs: number;
  };
  mutableModel.callTimeoutMs = 0;
  mutableModel.streamIdleTimeoutMs = 25;
  let close: (() => void) | undefined;
  let aborts = 0;
  f.llmProxy.dispatch = async ({ signal }) => {
    signal.addEventListener('abort', () => {
      aborts += 1;
    });
    return {
      status: 200,
      headers: [['content-type', 'text/event-stream']],
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          close = () => {
            try {
              controller.close();
            } catch {
              // The HTTP boundary may already have cancelled the source.
            }
          };
        },
      }),
    };
  };
  const pending = exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    ['Authorization', f.authorization],
  );
  let reply: Reply;
  try {
    reply = await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error('LLM first-chunk idle timeout did not settle')),
          500,
        );
        timer.unref();
      }),
    ]);
  } finally {
    close?.();
    await pending.catch(() => undefined);
  }
  assert.equal(reply.status, 504);
  assert.deepEqual(decodeLlmProxyError(reply.body), {
    format: LLM_PROXY_FORMATS.error,
    code: 'upstream_timeout',
    requestId: f.request.requestId,
  });
  assert.equal(aborts, 1);
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
});

test('LLM HTTP stream idle timeout destroys after delivered bytes without JSON', async (t) => {
  const f = await fixture(t);
  const mutableModel = f.catalog.models[0] as {
    callTimeoutMs: number;
    streamIdleTimeoutMs: number;
  };
  mutableModel.callTimeoutMs = 0;
  mutableModel.streamIdleTimeoutMs = 25;
  let aborts = 0;
  let cancels = 0;
  f.llmProxy.dispatch = async ({ signal }) => {
    signal.addEventListener('abort', () => {
      aborts += 1;
    });
    return {
      status: 200,
      headers: [],
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('first'));
        },
        cancel() {
          cancels += 1;
        },
      }),
    };
  };
  const reply = await Promise.race([
    abortedExchange(
      f.port,
      serializeLlmProxyRequest(f.request),
      f.authorization,
    ),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error('post-commit stream idle timeout did not settle')),
        500,
      );
      timer.unref();
    }),
  ]);
  assert.equal(reply.status, 200);
  assert.equal(reply.aborted, true);
  assert.equal(reply.body.toString(), 'first');
  assert.equal(aborts, 1);
  assert.equal(cancels, 1);
});

test('LLM HTTP observes a dispatcher rejection after its timeout response', async (t) => {
  const f = await fixture(t);
  (f.catalog.models[0] as { callTimeoutMs: number }).callTimeoutMs = 25;
  f.llmProxy.dispatch = ({ signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        const timer = setTimeout(() => reject(new Error('late rejection')), 25);
        timer.unref();
      });
    });
  const reply = await exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    ['Authorization', f.authorization],
  );
  assert.equal(reply.status, 504);
  assert.equal(decodeLlmProxyError(reply.body).code, 'upstream_timeout');
  await new Promise((resolve) => setTimeout(resolve, 75));
});

test('LLM HTTP client disconnect aborts one dispatch without a late response', async (t) => {
  const f = await fixture(t);
  (f.catalog.models[0] as { callTimeoutMs: number }).callTimeoutMs = 0;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let abort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    abort = resolve;
  });
  let aborts = 0;
  f.llmProxy.dispatch = ({ signal }) => {
    start();
    signal.addEventListener('abort', () => {
      aborts += 1;
      abort();
    });
    return new Promise(() => undefined);
  };

  let responses = 0;
  const client = http.request({
    host: '127.0.0.1',
    port: f.port,
    method: 'POST',
    path: LLM_PROXY_PATHS.request,
    headers: {
      Authorization: f.authorization,
      'Content-Type': 'application/json',
    },
  });
  client.on('response', () => {
    responses += 1;
  });
  client.on('error', () => undefined);
  client.end(serializeLlmProxyRequest(f.request));
  await started;
  client.destroy();
  await Promise.race([
    aborted,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('client disconnect did not abort dispatch')),
        500,
      );
      timer.unref();
    }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborts, 1);
  assert.equal(responses, 0);
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
});

test('LLM HTTP service stop aborts dispatch and returns canonical cancellation', async (t) => {
  const f = await fixture(t);
  (f.catalog.models[0] as { callTimeoutMs: number }).callTimeoutMs = 0;
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  let aborts = 0;
  f.llmProxy.dispatch = ({ signal }) => {
    start();
    signal.addEventListener('abort', () => {
      aborts += 1;
    });
    return new Promise(() => undefined);
  };
  const pending = exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    ['Authorization', f.authorization],
  );
  await started;
  const stopping = f.service.stop();
  const reply = await Promise.race([
    pending,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('service stop did not settle LLM request')),
        500,
      );
      timer.unref();
    }),
  ]);
  await Promise.race([
    stopping,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('service stop retained cancelled LLM socket')),
        500,
      );
      timer.unref();
    }),
  ]);
  assert.equal(reply.status, 503);
  assert.deepEqual(decodeLlmProxyError(reply.body), {
    format: LLM_PROXY_FORMATS.error,
    code: 'cancelled',
    requestId: f.request.requestId,
  });
  assert.equal(aborts, 1);
  assert.deepEqual(f.calls, ['authenticate', 'catalog']);
});

test('LLM HTTP rejects informational finals and bodies on body-forbidden statuses', async () => {
  const makeResponse = () => {
    let ended = false;
    const response = {
      destroyed: false,
      headersSent: false,
      statusCode: 200,
      setHeader() {},
      write() {
        return true;
      },
      end() {
        ended = true;
      },
    } as unknown as http.ServerResponse;
    return { response, ended: () => ended };
  };
  const request = {
    format: LLM_PROXY_FORMATS.request,
    requestId: 'egr1.DDDDDDDDDDDDDDDDDDDDDD',
    modelRef: 'resident/gpt-5.4',
    targetGeneration: newLlmTargetGeneration((size) =>
      Buffer.alloc(size, 0x43),
    ),
    route: 'responses',
    transport: { kind: 'none' },
    byteLength: 2,
    sha256: createHash('sha256').update('{}').digest('hex'),
    payload: Buffer.from('{}'),
  } as const satisfies LlmProxyRequest;

  for (const status of [100, 199]) {
    const target = makeResponse();
    await assert.rejects(
      streamLlmExchange(
        target.response,
        { status, headers: [], body: null },
        request,
        new AbortController(),
        0,
      ),
    );
    assert.equal(target.ended(), false);
  }
  for (const status of [204, 205, 304]) {
    const target = makeResponse();
    await assert.rejects(
      streamLlmExchange(
        target.response,
        {
          status,
          headers: [],
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Buffer.from('forbidden'));
              controller.close();
            },
          }),
        },
        request,
        new AbortController(),
        0,
      ),
    );
    assert.equal(target.ended(), false);
  }
  const valid = makeResponse();
  await streamLlmExchange(
    valid.response,
    { status: 204, headers: [], body: null },
    request,
    new AbortController(),
    0,
  );
  assert.equal(valid.response.statusCode, 204);
  assert.equal(valid.ended(), true);
});

test('LLM HTTP rejects accessor and oversized response metadata without executing it', async (t) => {
  const f = await fixture(t);
  const request = () =>
    exchange(
      f.port,
      'POST',
      LLM_PROXY_PATHS.request,
      serializeLlmProxyRequest(f.request),
      ['Authorization', f.authorization],
    );

  let statusReads = 0;
  f.llmProxy.dispatch = async () => {
    const result = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperties(result, {
      status: {
        enumerable: true,
        get() {
          statusReads += 1;
          return 200;
        },
      },
      headers: { enumerable: true, value: [] },
      body: { enumerable: true, value: null },
    });
    return result as unknown as Awaited<
      ReturnType<GatewayLlmProxyApi['dispatch']>
    >;
  };
  const accessor = await request();
  assert.equal(accessor.status, 500);
  assert.equal(decodeLlmProxyError(accessor.body).code, 'internal_error');
  assert.equal(statusReads, 0);
  f.calls.length = 0;

  let iteratorReads = 0;
  f.llmProxy.dispatch = async () => {
    const headers = Object.create(null) as Record<PropertyKey, unknown>;
    Object.defineProperty(headers, Symbol.iterator, {
      get() {
        iteratorReads += 1;
        throw new Error('iterator getter executed');
      },
    });
    return {
      status: 200,
      headers: headers as unknown as readonly (readonly [string, string])[],
      body: null,
    };
  };
  const iterator = await request();
  assert.equal(iterator.status, 500);
  assert.equal(decodeLlmProxyError(iterator.body).code, 'internal_error');
  assert.equal(iteratorReads, 0);
  f.calls.length = 0;

  f.llmProxy.dispatch = async () => ({
    status: 200,
    headers: Array.from(
      { length: LLM_PROXY_SAFE_RESPONSE_HEADERS.length + 1 },
      (_value, index) => ['x-unsafe-' + index, 'value'] as const,
    ),
    body: null,
  });
  const oversized = await request();
  assert.equal(oversized.status, 500);
  assert.equal(decodeLlmProxyError(oversized.body).code, 'internal_error');
});

test('LLM HTTP does not pull upstream while downstream waits for drain', async (t) => {
  const f = await fixture(t);
  const prototype = http.ServerResponse.prototype as unknown as {
    write: (...args: unknown[]) => boolean;
  };
  const originalWrite = prototype.write;
  let held: http.ServerResponse | undefined;
  let hold!: () => void;
  const holding = new Promise<void>((resolve) => {
    hold = resolve;
  });
  prototype.write = function (this: http.ServerResponse, ...args: unknown[]) {
    const actual = originalWrite.apply(this, args);
    if (held === undefined && this.hasHeader(LLM_PROXY_HEADERS.provenance)) {
      held = this;
      hold();
      return false;
    }
    return actual;
  };
  t.after(() => {
    prototype.write = originalWrite;
  });

  let pulls = 0;
  f.llmProxy.dispatch = async () => ({
    status: 200,
    headers: [],
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(Buffer.from(String(pulls)));
        if (pulls === 3) controller.close();
      },
    }),
  });
  const pending = exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    ['Authorization', f.authorization],
  );
  await holding;
  const atSaturation = pulls;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pulls, atSaturation);
  assert.ok(atSaturation <= 2);
  held!.emit('drain');
  const reply = await pending;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.toString(), '123');
  assert.equal(pulls, 3);
});

test('LLM HTTP response ceiling errors before commitment and destroys after bytes', async (t) => {
  const f = await fixture(t);
  const requestBody = serializeLlmProxyRequest(f.request);

  f.llmProxy.dispatch = async () => {
    f.calls.push('dispatch');
    return {
      status: 200,
      headers: [],
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.alloc(LLM_PROXY_LIMITS.responseBytes + 1));
          controller.close();
        },
      }),
    };
  };
  const before = await exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    requestBody,
    ['Authorization', f.authorization],
  );
  assert.equal(before.status, 502);
  assert.deepEqual(decodeLlmProxyError(before.body), {
    format: LLM_PROXY_FORMATS.error,
    code: 'upstream_unavailable',
    requestId: f.request.requestId,
  });
  assert.deepEqual(f.calls, ['authenticate', 'catalog', 'dispatch']);
  f.calls.length = 0;

  f.llmProxy.dispatch = async () => {
    f.calls.push('dispatch');
    return {
      status: 201,
      headers: [],
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from('first'));
          const timer = setTimeout(() => {
            controller.enqueue(Buffer.alloc(LLM_PROXY_LIMITS.responseBytes));
            controller.close();
          }, 25);
          timer.unref();
        },
      }),
    };
  };
  const after = await abortedExchange(f.port, requestBody, f.authorization);
  assert.equal(after.status, 201);
  assert.equal(after.aborted, true);
  assert.equal(after.body.toString(), 'first');
  assert.deepEqual(f.calls, ['authenticate', 'catalog', 'dispatch']);
});

test('LLM HTTP preserves raw upstream error status and body with provenance', async (t) => {
  const f = await fixture(t);
  f.llmProxy.dispatch = async () => ({
    status: 429,
    headers: [['retry-after', '9']],
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('provider throttled'));
        controller.close();
      },
    }),
  });
  const reply = await exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    ['Authorization', f.authorization],
  );
  assert.equal(reply.status, 429);
  assert.equal(reply.body.toString(), 'provider throttled');
  assert.equal(
    decodeLlmResponseProvenance(reply.headers[LLM_PROXY_HEADERS.provenance])
      .status,
    429,
  );
});

test('LLM HTTP request authorizes canonical payload and streams raw response with safe provenance', async (t) => {
  const f = await fixture(t);
  const reply = await exchange(
    f.port,
    'POST',
    LLM_PROXY_PATHS.request,
    serializeLlmProxyRequest(f.request),
    [
      'Authorization',
      f.authorization,
      'Origin',
      'https://attacker.invalid',
      'Cookie',
      'session=ignored',
      'X-Elpis-Csrf',
      'ignored',
    ],
  );

  assert.equal(reply.status, 201);
  assert.equal(reply.body.toString(), '{"ok":true}');
  assert.equal(reply.headers['set-cookie'], undefined);
  assert.equal(reply.headers['x-request-id'], undefined);
  const provenance = decodeLlmResponseProvenance(
    reply.headers[LLM_PROXY_HEADERS.provenance],
  );
  assert.deepEqual(provenance, {
    format: LLM_PROXY_FORMATS.responseProvenance,
    requestId: f.request.requestId,
    modelRef: f.request.modelRef,
    targetGeneration: f.request.targetGeneration,
    route: f.request.route,
    status: 201,
    headers: [
      { name: 'content-type', value: 'application/json' },
      { name: 'x-request-id', value: 'upstream-request' },
    ],
  });
  assert.deepEqual(f.calls, ['authenticate', 'catalog', 'dispatch']);
});
