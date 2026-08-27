import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createGatewayHttpService,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  GatewayApiError,
  MAX_API_RESPONSE_BYTES,
  type BrowserApi,
  type GatewayHttpService,
} from '../src/index.js';

const TOKEN = 'A'.repeat(43);
const ORIGIN = 'https://gateway.example';

async function start(
  t: TestContext,
  api: BrowserApi,
  getPublicUrl: () => string | null = () => ORIGIN,
): Promise<{ service: GatewayHttpService; port: number }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-gateway-api-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'index');
  const service = createGatewayHttpService({
    publicRoot: root,
    api,
    getPublicUrl,
    listen: { host: '127.0.0.1', port: 0 },
  });
  t.after(async () => {
    await service.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service, port: (await service.start()).port };
}

function mutationHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    origin: ORIGIN,
    cookie: CSRF_COOKIE_NAME + '=' + TOKEN,
    [CSRF_HEADER_NAME]: TOKEN,
    'content-type': 'application/json',
    ...extra,
  };
}

function request(
  port: number,
  options: http.RequestOptions,
  body?: Buffer | string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: '127.0.0.1', port, ...options },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on('end', () =>
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

test('ordinary mutations authorize before body handling', async (t) => {
  let handled = false;
  const { port } = await start(t, {
    match: () => ({
      policy: 'mutation',
      handle: () => {
        handled = true;
        return { status: 200, body: { ok: true } };
      },
    }),
  });
  const denied = await request(
    port,
    {
      method: 'POST',
      path: '/api/v1/write',
      headers: { 'content-length': '1' },
    },
    '{',
  );
  assert.equal(denied.status, 403);
  assert.equal(handled, false);

  const duplicateType = await request(
    port,
    {
      method: 'POST',
      path: '/api/v1/write',
      headers: {
        ...mutationHeaders(),
        'content-type': ['application/json', 'application/json'],
        'content-length': '2',
      },
    },
    '{}',
  );
  assert.equal(duplicateType.status, 415);
  assert.equal(handled, false);
});

test('setup parses and freezes an owned body before its candidate guard', async (t) => {
  const calls: string[] = [];
  let received: unknown;
  const { port } = await start(
    t,
    {
      match: () => ({
        policy: 'setup-mutation',
        candidatePublicUrl: (body) => {
          calls.push('candidate');
          assert.ok(Object.isFrozen(body));
          assert.ok(Object.isFrozen(body.nested));
          if (typeof body.publicUrl !== 'string')
            throw new GatewayApiError(400, 'invalid_request');
          return body.publicUrl;
        },
        handle: (body, publicUrl) => {
          calls.push('handle');
          received = body;
          return { status: 201, body: { configured: publicUrl === null } };
        },
      }),
    },
    () => null,
  );
  const json = JSON.stringify({ publicUrl: ORIGIN, nested: ['value'] });
  const denied = await request(
    port,
    {
      method: 'POST',
      path: '/api/v1/setup',
      headers: {
        ...mutationHeaders({
          origin: 'https://other.example',
          host: 'gateway.example',
        }),
        'content-length': String(Buffer.byteLength(json)),
      },
    },
    json,
  );
  assert.equal(denied.status, 403);
  assert.deepEqual(calls, ['candidate']);

  calls.length = 0;
  const invalidBody = JSON.stringify({ publicUrl: 1, nested: [] });
  const invalid = await request(
    port,
    {
      method: 'POST',
      path: '/api/v1/setup',
      headers: {
        ...mutationHeaders({ host: 'gateway.example' }),
        'content-length': String(Buffer.byteLength(invalidBody)),
      },
    },
    invalidBody,
  );
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.toString(), '{"error":"invalid_request"}');
  assert.deepEqual(calls, ['candidate']);

  calls.length = 0;
  const accepted = await request(
    port,
    {
      method: 'POST',
      path: '/api/v1/setup',
      headers: {
        ...mutationHeaders({ host: 'gateway.example' }),
        'content-length': String(Buffer.byteLength(json)),
      },
    },
    json,
  );
  assert.equal(accepted.status, 201);
  assert.deepEqual(JSON.parse(accepted.body.toString()), { configured: true });
  assert.deepEqual(calls, ['candidate', 'handle']);
  assert.ok(received !== null && typeof received === 'object');
});

test('read routes support GET and bodyless HEAD with exact API targets', async (t) => {
  let handles = 0;
  const matched: string[] = [];
  const { port } = await start(t, {
    match: (method, pathname) => {
      matched.push(method + ' ' + pathname);
      if (pathname !== '/api/v1/info') return null;
      return {
        policy: 'read',
        handle: (body, publicUrl) => {
          assert.equal(body, null);
          assert.equal(publicUrl, ORIGIN);
          handles += 1;
          return { status: 200, body: { answer: 42 } };
        },
      };
    },
  });
  const get = await request(port, { method: 'GET', path: '/api/v1/info' });
  const head = await request(port, { method: 'HEAD', path: '/api/v1/info' });
  assert.equal(get.status, 200);
  assert.equal(get.body.toString(), '{"answer":42}');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
  assert.equal(handles, 2);

  for (const target of [
    '/api/v1/unknown',
    '/api/v1/info?alias=1',
    '/api/v1/%69nfo',
  ])
    assert.equal(
      (await request(port, { method: 'GET', path: target })).status,
      404,
    );
  assert.equal(
    (await request(port, { method: 'POST', path: '/api/v1/info' })).status,
    405,
  );
  assert.ok(
    !matched.some((value) => value.includes('?') || value.includes('%')),
  );
});

test('API errors and invalid responses use generic bounded framing', async (t) => {
  const { port } = await start(t, {
    match: (_method, pathname) => ({
      policy: 'read',
      handle: () => {
        if (pathname.endsWith('/business'))
          throw new GatewayApiError(409, 'state_conflict');
        if (pathname.endsWith('/unexpected')) throw new Error('private detail');
        if (pathname.endsWith('/oversized'))
          return {
            status: 200,
            body: { value: 'x'.repeat(MAX_API_RESPONSE_BYTES) },
          };
        if (pathname.endsWith('/invalid'))
          return { status: 200, body: { value: Number.NaN } };
        if (pathname.endsWith('/no-content'))
          return { status: 204, body: {} } as never;
        return { status: 200, body: { ok: true } };
      },
    }),
  });
  const business = await request(port, {
    method: 'GET',
    path: '/api/v1/business',
  });
  assert.equal(business.status, 409);
  assert.equal(business.body.toString(), '{"error":"state_conflict"}');
  for (const target of ['unexpected', 'oversized', 'invalid', 'no-content']) {
    const result = await request(port, {
      method: 'GET',
      path: '/api/v1/' + target,
    });
    assert.equal(result.status, 500);
    assert.equal(result.body.toString(), '{"error":"internal_error"}');
    assert.doesNotMatch(result.body.toString(), /private detail/);
  }
});

test('JSON decoder rejects invalid UTF-8 and non-object documents', async (t) => {
  let handled = false;
  const { port } = await start(t, {
    match: () => ({
      policy: 'mutation',
      handle: () => {
        handled = true;
        return { status: 200, body: { ok: true } };
      },
    }),
  });
  for (const body of [
    Buffer.from([0xff]),
    Buffer.from('[]'),
    Buffer.alloc(0),
  ]) {
    const result = await request(
      port,
      {
        method: 'POST',
        path: '/api/v1/write',
        headers: {
          ...mutationHeaders(),
          'content-length': String(body.length),
        },
      },
      body,
    );
    assert.equal(result.status, 400);
  }
  assert.equal(handled, false);
});
