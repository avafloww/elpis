import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  createGatewayBrowserApi,
  createGatewayHttpService,
  createNodeCredential,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  newGatewayInstanceId,
  openGatewayStore,
  type GatewayStore,
} from '../src/index.js';

const TOKEN = 'A'.repeat(43);
const FIRST = 'https://gateway.example';
const SECOND = 'https://replacement.example';

interface Fixture {
  store: GatewayStore;
  port: number;
}

async function fixture(t: TestContext): Promise<Fixture> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-routes-'),
  );
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'index');
  let now = 100;
  const store = openGatewayStore(path.join(directory, 'data'), {
    now: () => now++,
  });
  const service = createGatewayHttpService({
    publicRoot,
    store,
    api: createGatewayBrowserApi(store),
    listen: { host: '127.0.0.1', port: 0 },
  });
  t.after(async () => {
    await service.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, port: (await service.start()).port };
}

function request(
  port: number,
  method: string,
  requestPath: string,
  headers: http.OutgoingHttpHeaders = {},
  body?: string,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
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

function setupHeaders(
  origin: string,
  host = new URL(origin).host,
): Record<string, string> {
  return {
    origin,
    host,
    cookie: CSRF_COOKIE_NAME + '=' + TOKEN,
    [CSRF_HEADER_NAME]: TOKEN,
    'content-type': 'application/json',
  };
}

function putSetup(
  port: number,
  body: string,
  headers: Record<string, string> = setupHeaders(FIRST),
) {
  return request(
    port,
    'PUT',
    '/api/v1/setup',
    {
      ...headers,
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  );
}

function json(response: { body: Buffer }): unknown {
  return JSON.parse(response.body.toString('utf8'));
}

test('state exposes the exact pre-setup wire and HEAD representation', async (t) => {
  const { port } = await fixture(t);
  const get = await request(port, 'GET', '/api/v1/state');
  assert.equal(get.status, 200);
  assert.equal(get.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(json(get), {
    format: 'elpis-gateway-state-v1',
    setup: { complete: false, publicUrl: null, revision: 0 },
    instances: [],
  });

  const head = await request(port, 'HEAD', '/api/v1/state');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], get.headers['content-length']);
});

test('pre-setup authorization failures cannot change config or audit', async (t) => {
  const { store, port } = await fixture(t);
  const body = JSON.stringify({ publicUrl: FIRST });
  const initialConfig = store.config();
  const deniedHeaders: Record<string, string>[] = [
    {
      host: 'gateway.example',
      'content-type': 'application/json',
    },
    setupHeaders('https://wrong.example', 'gateway.example'),
    setupHeaders(FIRST, 'wrong.example'),
    {
      ...setupHeaders(FIRST),
      [CSRF_HEADER_NAME]: 'B'.repeat(43),
    },
  ];
  for (const headers of deniedHeaders) {
    const response = await putSetup(port, body, headers);
    assert.equal(response.status, 403);
    assert.deepEqual(store.config(), initialConfig);
    assert.deepEqual(store.audit(), []);
  }
});

test('setup rejects malformed, extra, noncanonical, HTTP, and path URLs', async (t) => {
  const { store, port } = await fixture(t);
  const initialConfig = store.config();
  const bodies = [
    '{',
    '{}',
    '{"publicUrl":1}',
    '{"publicUrl":"https://gateway.example","extra":true}',
    '{"publicUrl":"HTTPS://gateway.example"}',
    '{"publicUrl":"https://gateway.example/"}',
    '{"publicUrl":"http://gateway.example"}',
    '{"publicUrl":"http://localhost"}',
    '{"publicUrl":"https://gateway.example/path"}',
    '{"publicUrl":"https://gateway.example?query=1"}',
  ];
  for (const body of bodies) {
    const response = await putSetup(port, body);
    assert.equal(response.status, 400, body);
    assert.deepEqual(store.config(), initialConfig);
    assert.deepEqual(store.audit(), []);
  }
});

test('canonical setup succeeds and replacement authorizes against old origin', async (t) => {
  const { store, port } = await fixture(t);
  const first = await putSetup(port, JSON.stringify({ publicUrl: FIRST }));
  assert.equal(first.status, 200);
  assert.deepEqual(json(first), {
    format: 'elpis-gateway-state-v1',
    setup: { complete: true, publicUrl: FIRST, revision: 1 },
    instances: [],
  });

  const candidateDenied = await putSetup(
    port,
    JSON.stringify({ publicUrl: SECOND }),
    setupHeaders(SECOND),
  );
  assert.equal(candidateDenied.status, 403);
  assert.equal(store.config().publicUrl, FIRST);
  assert.equal(store.config().revision, 1);
  assert.equal(store.audit().length, 1);

  const oldAccepted = await putSetup(
    port,
    JSON.stringify({ publicUrl: SECOND }),
    setupHeaders(FIRST),
  );
  assert.equal(oldAccepted.status, 200);
  assert.deepEqual((json(oldAccepted) as { setup: unknown }).setup, {
    complete: true,
    publicUrl: SECOND,
    revision: 2,
  });
  assert.equal(store.audit().length, 2);
});

test('known paths yield core 405s while unknown API paths yield 404', async (t) => {
  const { port } = await fixture(t);
  assert.equal((await request(port, 'POST', '/api/v1/state')).status, 405);
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE'])
    assert.equal(
      (await request(port, method, '/api/v1/setup')).status,
      405,
      method,
    );
  assert.equal((await request(port, 'GET', '/api/v1/unknown')).status, 404);
});

test('state copies only public instance summary fields', async (t) => {
  const { store, port } = await fixture(t);
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 1));
  const node = createNodeCredential((size) => Buffer.alloc(size, 2));
  const grant = store.credentials.createEnrollmentGrant();
  store.credentials.enroll({
    grantToken: grant.token,
    instanceId,
    displayName: 'Aster',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });

  const response = await request(port, 'GET', '/api/v1/state');
  assert.equal(response.status, 200);
  const body = response.body.toString('utf8');
  const state = JSON.parse(body) as { instances: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(state.instances[0]!), [
    'id',
    'displayName',
    'createdAt',
    'updatedAt',
    'revokedAt',
    'activeCredentialId',
    'activeSince',
    'lastUsedAt',
  ]);
  assert.deepEqual(state.instances[0], store.instances()[0]);
  for (const secret of [
    grant.token,
    node.token,
    grant.token.split('.')[2]!,
    node.token.split('.')[2]!,
    node.verifier.toString('hex'),
    'verifier',
  ])
    assert.equal(body.includes(secret), false);
});
