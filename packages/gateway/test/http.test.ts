import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { IncomingMessage } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  assertBrowserOrigin,
  assertCsrf,
  createCsrfToken,
  createGatewayHttpService,
  csrfCookie,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  HttpBoundaryError,
  parseCanonicalPublicOrigin,
  readBoundedRequestBody,
} from '../src/index.js';

function requestHeaders(headers: Array<[string, string]>): IncomingMessage {
  return {
    rawHeaders: headers.flat(),
  } as unknown as IncomingMessage;
}

function denied(run: () => void): void {
  assert.throws(
    run,
    (error: unknown) =>
      error instanceof HttpBoundaryError && error.statusCode === 403,
  );
}

test('canonical public origins reject non-origin components', () => {
  assert.equal(
    parseCanonicalPublicOrigin('https://Gateway.Example:443/'),
    'https://gateway.example',
  );
  for (const value of [
    'http://gateway.example',
    'https://user@gateway.example',
    'https://gateway.example/path',
    'https://gateway.example?query=1',
    'https://gateway.example#fragment',
  ])
    assert.throws(() => parseCanonicalPublicOrigin(value));
});

test('configured and designated pre-setup Origin rules fail closed', () => {
  const exact = requestHeaders([['Origin', 'https://gateway.example']]);
  assert.doesNotThrow(() =>
    assertBrowserOrigin(exact, { publicUrl: 'https://gateway.example' }),
  );
  denied(() =>
    assertBrowserOrigin(requestHeaders([]), {
      publicUrl: 'https://gateway.example',
    }),
  );
  denied(() =>
    assertBrowserOrigin(requestHeaders([['Origin', 'https://other.example']]), {
      publicUrl: 'https://gateway.example',
    }),
  );
  denied(() => assertBrowserOrigin(exact, { publicUrl: null }));

  const setup = requestHeaders([
    ['Origin', 'https://gateway.example'],
    ['Host', 'gateway.example'],
    ['X-Forwarded-Host', 'other.example'],
  ]);
  assert.doesNotThrow(() =>
    assertBrowserOrigin(setup, {
      publicUrl: null,
      setupCandidatePublicUrl: 'https://gateway.example',
    }),
  );
  denied(() =>
    assertBrowserOrigin(
      requestHeaders([
        ['Origin', 'https://gateway.example'],
        ['Host', 'internal:8790'],
        ['X-Forwarded-Host', 'gateway.example'],
      ]),
      { publicUrl: null, setupCandidatePublicUrl: 'https://gateway.example' },
    ),
  );
  denied(() =>
    assertBrowserOrigin(setup, {
      publicUrl: null,
      setupCandidatePublicUrl: 'https://gateway.example/',
    }),
  );
});

test('CSRF uses exact cookie/header grammar and comparison', () => {
  const token = createCsrfToken(() => Buffer.alloc(32, 7));
  assert.equal(token.length, 43);
  assert.ok(
    csrfCookie(token).endsWith('; Path=/; Secure; HttpOnly; SameSite=Strict'),
  );
  assert.doesNotThrow(() =>
    assertCsrf(
      requestHeaders([
        ['Cookie', `other=1; ${CSRF_COOKIE_NAME}=${token}`],
        [CSRF_HEADER_NAME, token],
      ]),
    ),
  );
  for (const headers of [
    [['Cookie', `${CSRF_COOKIE_NAME}=${token}`]] as Array<[string, string]>,
    [
      ['Cookie', `${CSRF_COOKIE_NAME}=${token}`],
      [CSRF_HEADER_NAME, token.slice(0, -1) + 'A'],
    ] as Array<[string, string]>,
    [
      ['Cookie', `${CSRF_COOKIE_NAME}=${token}; ${CSRF_COOKIE_NAME}=${token}`],
      [CSRF_HEADER_NAME, token],
    ] as Array<[string, string]>,
  ])
    denied(() => assertCsrf(requestHeaders(headers)));
});

test('bounded body rejects unsupported framing and over-limit input', async () => {
  const incoming = (
    body: string,
    headers: Array<[string, string]>,
  ): IncomingMessage => {
    const stream = Readable.from([
      Buffer.from(body),
    ]) as unknown as IncomingMessage;
    Object.assign(stream, { rawHeaders: headers.flat() });
    return stream;
  };
  assert.equal(
    (
      await readBoundedRequestBody(incoming('abc', [['Content-Length', '3']]), {
        maxBytes: 3,
      })
    ).toString(),
    'abc',
  );
  await assert.rejects(
    readBoundedRequestBody(incoming('abcd', [['Content-Length', '4']]), {
      maxBytes: 3,
    }),
    (error: unknown) =>
      error instanceof HttpBoundaryError && error.statusCode === 413,
  );
  await assert.rejects(
    readBoundedRequestBody(incoming('abc', [['Transfer-Encoding', 'chunked']])),
    HttpBoundaryError,
  );
  await assert.rejects(
    readBoundedRequestBody(
      incoming('abc', [
        ['Content-Length', '3'],
        ['Content-Length', '3'],
      ]),
    ),
    HttpBoundaryError,
  );
});

function rawGet(
  port: number,
  requestPath: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: '127.0.0.1', port, path: requestPath },
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
  });
}

test('service health, readiness, static safety, HEAD, bind, and stop', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-gateway-http-'));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>gateway</h1>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'export {};');
  fs.writeFileSync(path.join(root, '.secret'), 'secret');
  fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'linked'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let ready = true;
  const service = createGatewayHttpService({
    publicRoot: root,
    listen: { host: '127.0.0.1', port: 0 },
    getPublicUrl: () => 'https://gateway.example',
    checkReady: () => ready,
  });
  t.after(() => service.stop());
  const address = await service.start();
  assert.ok(address.port > 0);
  assert.equal((await rawGet(address.port, '/healthz')).status, 200);
  assert.equal((await rawGet(address.port, '/readyz')).status, 200);
  ready = false;
  const unavailable = await rawGet(address.port, '/readyz');
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(
    unavailable.body.toString(),
    /public|setup|gateway.example/,
  );
  assert.equal((await rawGet(address.port, '/')).status, 200);
  assert.equal((await rawGet(address.port, '/clean-route')).status, 200);
  assert.equal((await rawGet(address.port, '/missing.js')).status, 404);
  assert.equal((await rawGet(address.port, '/.secret')).status, 404);
  assert.equal((await rawGet(address.port, '/%2e%2e/secret')).status, 404);
  assert.equal((await rawGet(address.port, '/linked')).status, 404);

  const head = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/assets/app.js',
        method: 'HEAD',
      },
      resolve,
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.headers['cache-control'], 'private, max-age=300');
  assert.equal(Number(head.headers['content-length']), 'export {};'.length);
  head.resume();

  const csrf = await rawGet(address.port, '/api/csrf');
  assert.equal(csrf.status, 200);
  assert.match(String(csrf.headers['set-cookie']), /Secure/);
  assert.equal((await rawGet(address.port, '/api/csrf?alias=1')).status, 404);
  assert.equal(
    (await rawGet(address.port, '/api/v1/unconfigured')).status,
    404,
  );
  const noOrigin = await fetch(`http://127.0.0.1:${address.port}/api/future`, {
    method: 'POST',
    body: '',
    headers: { 'content-length': '0' },
  });
  assert.equal(noOrigin.status, 403);

  await service.stop();
  assert.equal(service.listening, false);
});
test('stop bounds a half-open active connection', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-gateway-stop-'));
  fs.writeFileSync(path.join(root, 'index.html'), 'ok');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createGatewayHttpService({
    publicRoot: root,
    listen: { host: '127.0.0.1', port: 0 },
    checkReady: () => true,
    shutdownGraceMs: 25,
  });
  const address = await service.start();
  const socket = net.connect(address.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write('GET / HTTP/1.1\r\nHost: gateway.example\r\n');
  const started = Date.now();
  await service.stop();
  assert.ok(Date.now() - started < 1_000);
  assert.equal(service.listening, false);
});
