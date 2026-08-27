import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  GatewayClientError,
  createGatewayClient,
  validateEnrollmentGrant,
  validateEnrollmentRevoke,
  validateGatewayState,
} from '../client/api.ts';

const ID = 'Abcdefghijklmnopqrstu_';
const INSTANCE_ID = 'egi1.Abcdefghijklmnopqrstu_';
const SECRET = 'A'.repeat(43);

function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function state(complete = true) {
  return {
    format: 'elpis-gateway-state-v1',
    setup: {
      complete,
      publicUrl: complete ? 'https://gateway.example' : null,
      revision: complete ? 1 : 0,
    },
    instances: [],
  };
}

function csrf(character: string) {
  return json({ csrfToken: character.repeat(43) });
}

function grant(id = ID, tokenId = id) {
  return {
    format: 'elpis-gateway-enrollment-v1',
    grant: { id, expiresAt: 1234 },
    bootstrapYaml:
      'gateway:\n' +
      '  url: "https://gateway.example"\n' +
      '  enrollment_token: "ege1.' +
      tokenId +
      '.' +
      SECRET +
      '"\n',
  };
}

function revoke() {
  return {
    format: 'elpis-gateway-enrollment-revoke-v1',
    grant: { id: ID, replayed: false },
  };
}

test('fixed client paths and options use a fresh CSRF token per mutation', async () => {
  const responses = [
    csrf('A'),
    json(state()),
    csrf('B'),
    json(grant(), 201),
    csrf('C'),
    json(revoke()),
  ];
  const calls: Array<{ path: string; options: RequestInit }> = [];
  const fake = (async (path: string | URL | Request, options?: RequestInit) => {
    calls.push({ path: String(path), options: structuredClone(options ?? {}) });
    const response = responses.shift();
    assert.ok(response);
    return response;
  }) as typeof fetch;
  const client = createGatewayClient(fake);

  await client.setup('https://gateway.example');
  await client.createEnrollmentGrant();
  await client.revokeEnrollmentGrant(ID);

  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/csrf',
      '/api/v1/setup',
      '/api/csrf',
      '/api/v1/enrollment-grants',
      '/api/csrf',
      '/api/v1/enrollment-grants/' + ID,
    ],
  );
  for (const index of [0, 2, 4]) {
    assert.deepEqual(calls[index].options, {
      method: 'GET',
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  }
  for (const [index, method, token, body] of [
    [1, 'PUT', 'A'.repeat(43), '{"publicUrl":"https://gateway.example"}'],
    [3, 'POST', 'B'.repeat(43), '{}'],
    [5, 'DELETE', 'C'.repeat(43), '{}'],
  ] as const) {
    assert.deepEqual(calls[index].options, {
      method,
      mode: 'same-origin',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-elpis-csrf': token,
      },
      body,
    });
  }
});

test('an ambiguous mutation failure is never retried', async () => {
  let calls = 0;
  const fake = (async () => {
    calls += 1;
    if (calls === 1) return csrf('A');
    throw new TypeError('connection lost');
  }) as typeof fetch;
  await assert.rejects(
    createGatewayClient(fake).createEnrollmentGrant(),
    (error) => {
      assert.ok(error instanceof GatewayClientError);
      assert.equal(error.status, 0);
      assert.equal(error.stableCode, 'request_failed');
      assert.equal(error.message, 'request_failed');
      return true;
    },
  );
  assert.equal(calls, 2);
});

test('state validator owns and deeply freezes an exact wire', () => {
  const wire = state() as ReturnType<typeof state> & { instances: unknown[] };
  wire.instances = [
    {
      id: INSTANCE_ID,
      displayName: 'Aster',
      createdAt: 10,
      updatedAt: 12,
      revokedAt: 13,
      activeCredentialId: ID,
      activeSince: 11,
      lastUsedAt: 12,
    },
  ];
  const result = validateGatewayState(wire);
  assert.notEqual(result, wire);
  assert.notEqual(result.setup, wire.setup);
  assert.notEqual(result.instances[0], wire.instances[0]);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.setup));
  assert.ok(Object.isFrozen(result.instances));
  assert.ok(Object.isFrozen(result.instances[0]));

  for (const malformed of [
    { ...state(), extra: true },
    { ...state(), setup: { ...state().setup, revision: 1.5 } },
    {
      ...state(false),
      setup: { complete: false, publicUrl: null, revision: 1 },
    },
    { ...state(), instances: [{ id: 'bad' }] },
    { ...state(), instances: null },
  ]) {
    assert.throws(() => validateGatewayState(malformed), GatewayClientError);
  }
});

test('grant and revoke validators reject secret and shape attacks', () => {
  const valid = validateEnrollmentGrant(grant());
  assert.ok(Object.isFrozen(valid.grant));
  assert.equal(Object.hasOwn(valid.grant, 'token'), false);
  assert.ok(Object.isFrozen(validateEnrollmentRevoke(revoke()).grant));

  const withoutNewline = grant();
  withoutNewline.bootstrapYaml = withoutNewline.bootstrapYaml.slice(0, -1);
  const mismatch = grant(ID, 'Z'.repeat(22));
  const multiple = grant();
  multiple.bootstrapYaml = multiple.bootstrapYaml.replace(
    'https://gateway.example',
    'https://ege1.' + ID + '.' + SECRET + '.example',
  );
  const outside = { ...grant(), token: 'ege1.' + ID + '.' + SECRET };
  const huge = grant();
  huge.bootstrapYaml = 'x'.repeat(4097);
  for (const malformed of [withoutNewline, mismatch, multiple, outside, huge])
    assert.throws(() => validateEnrollmentGrant(malformed), GatewayClientError);

  assert.throws(
    () =>
      validateEnrollmentRevoke({
        ...revoke(),
        grant: { ...revoke().grant, extra: 1 },
      }),
    GatewayClientError,
  );
});

test('response boundary rejects wrong media, oversized bodies, and malformed errors', async () => {
  for (const response of [
    new Response('{}', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }),
    json(state(), 200, { 'content-length': String(1024 * 1024 + 1) }),
    new Response(' '.repeat(1024 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
    json({ error: 'Not Stable' }, 400),
    json({ error: 'invalid_request', detail: 'secret' }, 400),
  ]) {
    const client = createGatewayClient((async () => response) as typeof fetch);
    await assert.rejects(client.getState(), (error) => {
      assert.ok(error instanceof GatewayClientError);
      assert.equal(error.stableCode, 'invalid_response');
      assert.equal(error.message, 'invalid_response');
      return true;
    });
  }
});

test('browser source has no persistence, logging, or configurable base surface', () => {
  const root = path.resolve(import.meta.dirname, '../client');
  const source = [
    ...fs
      .readdirSync(root)
      .filter((name) => /\.(?:ts|tsx|css)$/.test(name))
      .map((name) => path.join(root, name)),
    path.resolve(root, '../build-client.mjs'),
    path.resolve(root, '../package.json'),
    path.resolve(root, '../public/index.html'),
  ]
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const forbidden = [
    ['local', 'Storage'],
    ['session', 'Storage'],
    ['indexed', 'DB'],
    ['console', '.log'],
    ['encode', 'URIComponent'],
    ['base', 'URL'],
  ].map((parts) => parts.join(''));
  for (const item of forbidden)
    assert.equal(source.includes(item), false, item);
});
