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
import {
  copyBootstrapOnRequest,
  createMutationGuard,
  downloadBootstrapOnRequest,
  enrollmentReducer,
} from '../client/enrollment-modal.tsx';
import {
  formatExpiryCountdown,
  gatewayErrorMessage,
  setupDefaultOrigin,
} from '../client/presentation.ts';
import {
  ALL_INSTANCES_SELECTION,
  gatewayIdentityState,
  gatewayInstanceStatus,
  reconcileGatewaySelection,
} from '../client/selection.ts';

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

test('setup defaults to the exact browser origin and submits canonical input', async () => {
  assert.equal(
    setupDefaultOrigin('https://gateway.example:8443'),
    'https://gateway.example:8443',
  );
  const requests: string[] = [];
  const responses = [csrf('A'), json(state())];
  const fake = (async (
    input: string | URL | Request,
    options?: RequestInit,
  ) => {
    requests.push(String(input) + ':' + String(options?.body ?? ''));
    const response = responses.shift();
    assert.ok(response);
    return response;
  }) as typeof fetch;
  const result = await createGatewayClient(fake).setup(
    'https://gateway.example',
  );
  assert.equal(result.setup.complete, true);
  assert.deepEqual(requests, [
    '/api/csrf:',
    '/api/v1/setup:{"publicUrl":"https://gateway.example"}',
  ]);
});

test('enrollment reducer requires explicit generate and clears held response on close', () => {
  const response = validateEnrollmentGrant(grant());
  const idle = { phase: 'idle' } as const;
  assert.equal(enrollmentReducer(idle, { type: 'generated', response }), idle);

  const generating = enrollmentReducer(idle, { type: 'generate' });
  assert.equal(generating.phase, 'generating');
  const ready = enrollmentReducer(generating, { type: 'generated', response });
  assert.equal(ready.phase, 'ready');
  assert.equal('response' in ready, true);

  const closed = enrollmentReducer(ready, { type: 'close' });
  assert.deepEqual(closed, { phase: 'idle' });
  assert.equal('response' in closed, false);
});

test('mutation admission suppresses duplicates while pending', () => {
  const guard = createMutationGuard();
  assert.equal(guard.begin(), true);
  assert.equal(guard.begin(), false);
  guard.finish();
  assert.equal(guard.begin(), true);
});

test('explicit revoke transition clears the response exactly once', () => {
  const response = validateEnrollmentGrant(grant());
  let view = enrollmentReducer({ phase: 'idle' }, { type: 'generate' });
  view = enrollmentReducer(view, { type: 'generated', response });
  view = enrollmentReducer(view, { type: 'revoke' });
  assert.equal(view.phase, 'revoking');
  view = enrollmentReducer(view, { type: 'revoked', replayed: false });
  assert.deepEqual(view, { phase: 'revoked', replayed: false });
  assert.equal('response' in view, false);
  assert.equal(
    enrollmentReducer(view, { type: 'revoked', replayed: false }),
    view,
  );
});

test('copy and download expose contents only on direct invocation and revoke object URL', async () => {
  const value = grant().bootstrapYaml;
  const copied: string[] = [];
  await copyBootstrapOnRequest(value, {
    async writeText(input) {
      copied.push(input);
    },
  });
  assert.deepEqual(copied, [value]);

  const actions: string[] = [];
  let downloadedBlob: Blob | undefined;
  downloadBootstrapOnRequest(value, {
    createObjectURL(blob) {
      downloadedBlob = blob;
      actions.push('create');
      return 'blob:safe-object';
    },
    click(objectUrl, filename) {
      assert.equal(objectUrl, 'blob:safe-object');
      assert.equal(filename, 'elpis-gateway-enrollment.yaml');
      actions.push('click');
    },
    revokeObjectURL(objectUrl) {
      assert.equal(objectUrl, 'blob:safe-object');
      actions.push('revoke');
    },
  });
  assert.deepEqual(actions, ['create', 'click', 'revoke']);
  assert.equal(await downloadedBlob?.text(), value);
});

test('download revokes its object URL when the click fails', () => {
  const actions: string[] = [];
  assert.throws(() =>
    downloadBootstrapOnRequest('safe', {
      createObjectURL() {
        actions.push('create');
        return 'blob:safe-object';
      },
      click() {
        actions.push('click');
        throw new Error('blocked');
      },
      revokeObjectURL() {
        actions.push('revoke');
      },
    }),
  );
  assert.deepEqual(actions, ['create', 'click', 'revoke']);
});

test('presentation errors and countdowns are bounded and body-free', () => {
  const secretBody = 'raw body with credential';
  assert.equal(
    gatewayErrorMessage(new Error(secretBody)).includes(secretBody),
    false,
  );
  assert.equal(
    gatewayErrorMessage(new GatewayClientError(418, 'unknown_code')).includes(
      'unknown_code',
    ),
    false,
  );
  assert.equal(formatExpiryCountdown(1000, 1000), 'Expired');
  assert.equal(
    formatExpiryCountdown(Number.MAX_SAFE_INTEGER, 0),
    'Expires in more than 24h',
  );
});

test('bootstrap response is confined to validator and dedicated dialog workflow', () => {
  const root = path.resolve(import.meta.dirname, '../client');
  const referringFiles = fs
    .readdirSync(root)
    .filter((name) => /\.tsx?$/.test(name))
    .filter((name) =>
      fs.readFileSync(path.join(root, name), 'utf8').includes('bootstrapYaml'),
    )
    .sort();
  assert.deepEqual(referringFiles, ['api.ts', 'enrollment-modal.tsx']);

  const production = fs
    .readdirSync(root)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
    .join('\n');
  for (const forbidden of [
    /document\.title/,
    /location\.(?:hash|search)/,
    /URLSearchParams/,
    /setAttribute\(\s*['"]data-/,
    /setAttribute\(\s*['"]aria-label/,
  ])
    assert.doesNotMatch(production, forbidden);
});

test('Gateway selection reconciles only an absent enrolled resident', () => {
  const resident = { id: INSTANCE_ID };
  const selected = { kind: 'resident', instanceId: INSTANCE_ID } as const;
  assert.equal(reconcileGatewaySelection(selected, [resident]), selected);
  assert.equal(
    reconcileGatewaySelection(selected, []),
    ALL_INSTANCES_SELECTION,
  );
  assert.equal(
    reconcileGatewaySelection(ALL_INSTANCES_SELECTION, [resident]),
    ALL_INSTANCES_SELECTION,
  );
});

test('Gateway instance labels report revocation and null active credential truthfully', () => {
  assert.deepEqual(
    gatewayInstanceStatus({ revokedAt: null, activeCredentialId: null }),
    { tone: 'inactive', label: 'Credential inactive' },
  );
  assert.deepEqual(
    gatewayInstanceStatus({ revokedAt: null, activeCredentialId: ID }),
    { tone: 'active', label: 'Credential active' },
  );
  assert.deepEqual(
    gatewayInstanceStatus({ revokedAt: 20, activeCredentialId: ID }),
    { tone: 'revoked', label: 'Revoked' },
  );
});

test('identity projection carries only bounded picker fields', () => {
  const wire = state() as ReturnType<typeof state> & { instances: unknown[] };
  wire.instances = [
    {
      id: INSTANCE_ID,
      displayName: 'Aster',
      createdAt: 10,
      updatedAt: 12,
      revokedAt: null,
      activeCredentialId: null,
      activeSince: null,
      lastUsedAt: null,
    },
  ];
  const projected = gatewayIdentityState(validateGatewayState(wire));
  assert.deepEqual(projected, {
    setupComplete: true,
    publicUrl: 'https://gateway.example',
    residents: [
      {
        instanceId: INSTANCE_ID,
        displayName: 'Aster',
        status: { tone: 'inactive', label: 'Credential inactive' },
      },
    ],
  });
  assert.deepEqual(Object.keys(projected.residents[0]).sort(), [
    'displayName',
    'instanceId',
    'status',
  ]);
});

test('identity shell has no resident console, relay, or persistence surface', () => {
  const root = path.resolve(import.meta.dirname, '../client');
  const source = ['identity-dock.tsx', 'selection.ts', 'main.tsx']
    .map((name) => fs.readFileSync(path.join(root, name), 'utf8'))
    .join('\n');
  for (const forbidden of [
    /use-console/,
    /console\/client/,
    /WebSocket/i,
    /iframe/i,
    /gateway-protocol/,
    /localStorage/,
    /sessionStorage/,
    /indexedDB/,
    /serviceWorker/,
    /document\.(?:cookie|title)/,
    /location\.(?:hash|search)/,
    /history\./,
  ])
    assert.doesNotMatch(source, forbidden);
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, 'identity-dock.tsx'), 'utf8'),
    /bootstrap|verifier|grant|token/i,
  );
});
