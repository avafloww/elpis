import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { requestRestrictedRestart } from '../src/lib/restart-request.js';

async function server(
  handler: http.RequestListener,
): Promise<{ endpoint: string; close(): Promise<void> }> {
  const instance = http.createServer(handler);
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  const address = instance.address();
  if (!address || typeof address === 'string')
    throw new Error('missing test address');
  return {
    endpoint: `http://127.0.0.1:${address.port}/v1/restart`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test('restricted restart posts a bounded fixed-shape request', async () => {
  let seen: { method?: string; contentType?: string; body?: string } = {};
  const s = await server((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      seen = {
        method: request.method,
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      response.writeHead(202).end();
    });
  });
  try {
    await requestRestrictedRestart('x'.repeat(1500), {
      endpoint: s.endpoint,
      timeoutMs: 1000,
    });
  } finally {
    await s.close();
  }
  assert.equal(seen.method, 'POST');
  assert.equal(seen.contentType, 'application/json');
  const body = JSON.parse(seen.body ?? '{}');
  assert.equal(body.protocol, 1);
  assert.equal(body.reason.length, 1000);
  assert.equal(typeof body.at, 'string');
});

test('restricted restart requires an operator-configured HTTP(S) endpoint', async () => {
  await assert.rejects(
    requestRestrictedRestart(undefined, { endpoint: '' }),
    /ELPIS_RESTART_ENDPOINT is not configured/,
  );
  await assert.rejects(
    requestRestrictedRestart(undefined, { endpoint: 'unix:/run/restart.sock' }),
    /unsupported restart endpoint protocol/,
  );
  await assert.rejects(
    requestRestrictedRestart(undefined, {
      endpoint: 'https://user:secret@example.test/restart',
    }),
    /must not contain credentials/,
  );
});

test('restricted restart rejects broker failure and redirects', async () => {
  const failed = await server((_request, response) =>
    response.writeHead(503).end(),
  );
  try {
    await assert.rejects(
      requestRestrictedRestart(undefined, { endpoint: failed.endpoint }),
      /HTTP 503/,
    );
  } finally {
    await failed.close();
  }
  const redirected = await server((_request, response) =>
    response.writeHead(302, { location: 'https://example.com/' }).end(),
  );
  try {
    await assert.rejects(
      requestRestrictedRestart(undefined, { endpoint: redirected.endpoint }),
    );
  } finally {
    await redirected.close();
  }
});
