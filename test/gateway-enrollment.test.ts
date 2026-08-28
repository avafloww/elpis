import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_LIMITS,
  RESIDENT_CONTROL_PATHS,
  createEnrollmentCredential,
  decodeResidentEnrollmentRequest,
  serializeResidentEnrollmentResult,
  type ResidentEnrollmentResult,
} from '@elpis/gateway-protocol';
import {
  GatewayEnrollmentController,
  type GatewayEnrollmentFetch,
} from '../src/gateway-enrollment.js';
import { SecretRegistry } from '../src/lib/secrets.js';
import { openDatabase } from '../src/store/db.js';
import { GatewayResidentStore } from '../src/store/gateway-resident.js';

function randomBytes(): (size: number) => Buffer {
  let value = 0;
  return (size) => Buffer.alloc(size, ++value);
}
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-enrollment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = randomBytes();
  const db = openDatabase(dir);
  const store = new GatewayResidentStore(db, {
    now: () => 10,
    randomBytes: bytes,
  });
  const token = createEnrollmentCredential(bytes).token;
  return { dir, db, store, token };
}
function remote(token: string | null, url = 'https://gateway.example') {
  return { url, enrollmentToken: token };
}
function result(
  store: GatewayResidentStore,
  replayed = false,
): ResidentEnrollmentResult {
  const state = store.read();
  return {
    format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
    instanceId: state.instanceId as ResidentEnrollmentResult['instanceId'],
    credentialId: state.pendingCredentialId!,
    replayed,
  };
}
function response(
  value: ResidentEnrollmentResult,
  status = value.replayed ? 200 : 201,
): Response {
  return new Response(serializeResidentEnrollmentResult(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

// Fetch is called synchronously by start, after the candidate and redaction state exist.
test('enrolls once with canonical request and registers secrets before fetch', async (t) => {
  const f = fixture(t);
  const secrets = new SecretRegistry();
  let calls = 0;
  const fetch: GatewayEnrollmentFetch = async (url, init) => {
    calls += 1;
    assert.equal(controller.status.code, 'enrolling');
    assert.equal(f.store.read().phase, 'enrolling');
    for (const secret of f.store.secretValues())
      assert.equal(secrets.redact(secret), '[SECRET REDACTED]');
    assert.equal(
      url,
      'https://gateway.example' + RESIDENT_CONTROL_PATHS.enrollment,
    );
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.deepEqual(init.headers, {
      accept: 'application/json',
      'accept-encoding': 'identity',
      'content-type': 'application/json; charset=utf-8',
    });
    assert.deepEqual(
      decodeResidentEnrollmentRequest(init.body as string),
      f.store.enrollmentRequest(),
    );
    return response(result(f.store));
  };
  const controller = new GatewayEnrollmentController({
    store: f.store,
    secrets,
    remote: remote(f.token),
    displayName: 'Aster',
    fetch,
    timeoutMs: 100,
  });
  const attempt = controller.start();
  assert.deepEqual(controller.status, { code: 'enrolling' });
  assert.equal(f.store.read().phase, 'enrolling');
  assert.equal(calls, 1);
  assert.equal(controller.start(), attempt);
  const status = await attempt;
  assert.deepEqual(status, { code: 'enrolled' });
  assert.equal(Object.isFrozen(status), true);
  assert.equal(f.store.read().phase, 'active');
  assert.equal(calls, 1);
  f.db.close();
});

test('lost response leaves an exact candidate for restart replay', async (t) => {
  const f = fixture(t);
  let firstBody = '';
  const failed = new GatewayEnrollmentController({
    store: f.store,
    secrets: new SecretRegistry(),
    remote: remote(f.token),
    displayName: 'Aster',
    fetch: async (_url, init) => {
      firstBody = init.body as string;
      throw new Error(f.token);
    },
  });
  const failedStatus = await failed.start();
  assert.deepEqual(failedStatus, { code: 'network_error' });
  assert.equal(JSON.stringify(failedStatus).includes(f.token), false);
  const before = f.store.read();
  f.db.close();

  const reopenedDb = openDatabase(f.dir);
  const reopened = new GatewayResidentStore(reopenedDb, {
    now: () => 20,
    randomBytes: randomBytes(),
  });
  let calls = 0;
  const replay = new GatewayEnrollmentController({
    store: reopened,
    secrets: new SecretRegistry(),
    remote: remote(f.token),
    displayName: 'Changed after durable preparation',
    fetch: async (_url, init) => {
      calls += 1;
      assert.equal(init.body, firstBody);
      return response(result(reopened, true));
    },
  });
  assert.deepEqual(await replay.start(), { code: 'enrolled' });
  assert.equal(calls, 1);
  assert.equal(before.pendingCredentialId, reopened.read().activeCredentialId);
  reopenedDb.close();
});

test('wrong receipts, redirects, and noncanonical responses never activate', async (t) => {
  const cases: Array<
    [string, (store: GatewayResidentStore) => Promise<Response>]
  > = [
    [
      'wrong receipt',
      async (store) =>
        response({ ...result(store), credentialId: 'z'.repeat(22) }),
    ],
    [
      'redirect',
      async (store) => {
        const value = response(result(store));
        Object.defineProperty(value, 'redirected', { value: true });
        return value;
      },
    ],
    [
      'malformed',
      async () =>
        new Response('{', {
          status: 201,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    ],
    [
      'noncanonical',
      async (store) =>
        new Response(serializeResidentEnrollmentResult(result(store)) + '\n', {
          status: 201,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    ],
    [
      'encoded',
      async (store) =>
        new Response(serializeResidentEnrollmentResult(result(store)), {
          status: 201,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-encoding': 'gzip',
          },
        }),
    ],
    [
      'wrong content type',
      async (store) =>
        new Response(serializeResidentEnrollmentResult(result(store)), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'status/result mismatch',
      async (store) => response(result(store, true), 201),
    ],
  ];
  for (const [name, makeResponse] of cases) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      const controller = new GatewayEnrollmentController({
        store: f.store,
        secrets: new SecretRegistry(),
        remote: remote(f.token),
        displayName: 'Aster',
        fetch: async () => makeResponse(f.store),
      });
      assert.deepEqual(await controller.start(), { code: 'invalid_response' });
      assert.equal(f.store.read().phase, 'enrolling');
      f.db.close();
    });
  }
});

test('oversized and HTTP error bodies are not accepted or exposed', async (t) => {
  for (const [name, fetch, expected] of [
    [
      'oversized',
      async () =>
        new Response(new Uint8Array(RESIDENT_CONTROL_LIMITS.bodyBytes + 1), {
          status: 201,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      'invalid_response',
    ],
    [
      'http',
      async () =>
        new Response('synthetic-secret-in-error', {
          status: 503,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
      'http_error',
    ],
  ] as const) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      const controller = new GatewayEnrollmentController({
        store: f.store,
        secrets: new SecretRegistry(),
        remote: remote(f.token),
        displayName: 'Aster',
        fetch,
      });
      const outcome = await controller.start();
      assert.deepEqual(outcome, { code: expected });
      assert.equal(Object.isFrozen(outcome), true);
      assert.equal(JSON.stringify(outcome).includes(f.token), false);
      assert.equal(f.store.read().phase, 'enrolling');
      f.db.close();
    });
  }
});

test('timeout and stop abort one in-flight request without changing candidate', async (t) => {
  for (const [name, stop, expected] of [
    ['timeout', false, 'timeout'],
    ['stop', true, 'stopped'],
  ] as const) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      let signal: AbortSignal | undefined;
      const controller = new GatewayEnrollmentController({
        store: f.store,
        secrets: new SecretRegistry(),
        remote: remote(f.token),
        displayName: 'Aster',
        fetch: async (_url, init) => {
          signal = init.signal as AbortSignal;
          return new Promise<Response>(() => {});
        },
        timeoutMs: 10,
      });
      const attempt = controller.start();
      if (stop) controller.stop();
      assert.deepEqual(await attempt, { code: expected });
      assert.equal(signal?.aborted, true);
      assert.equal(f.store.read().phase, 'enrolling');
      f.db.close();
    });
  }
});

test('disabled, tokenless, conflict, and active states perform no fetch', async (t) => {
  await t.test('disabled and tokenless', async (t) => {
    for (const [remoteConfig, expected] of [
      [null, 'not_configured'],
      [remote(null), 'token_required'],
    ] as const) {
      const f = fixture(t);
      let calls = 0;
      const controller = new GatewayEnrollmentController({
        store: f.store,
        secrets: new SecretRegistry(),
        remote: remoteConfig,
        displayName: 'Aster',
        fetch: async () => {
          calls += 1;
          throw new Error('must not fetch');
        },
      });
      assert.deepEqual(await controller.start(), { code: expected });
      assert.equal(calls, 0);
      assert.equal(f.store.read().phase, 'idle');
      f.db.close();
    }
  });
  await t.test('persisted endpoint and token conflicts', async (t) => {
    const f = fixture(t);
    const first = new GatewayEnrollmentController({
      store: f.store,
      secrets: new SecretRegistry(),
      remote: remote(f.token),
      displayName: 'Aster',
      fetch: async () => {
        throw new Error('lost');
      },
    });
    await first.start();
    const before = f.store.read();
    let calls = 0;
    const other = createEnrollmentCredential(randomBytes()).token;
    for (const remoteConfig of [
      remote(f.token, 'https://other.example'),
      remote(other),
    ]) {
      const conflict = new GatewayEnrollmentController({
        store: f.store,
        secrets: new SecretRegistry(),
        remote: remoteConfig,
        displayName: 'Aster',
        fetch: async () => {
          calls += 1;
          throw new Error('must not fetch');
        },
      });
      assert.deepEqual(await conflict.start(), {
        code: 'configuration_conflict',
      });
      assert.deepEqual(f.store.read(), before);
    }
    assert.equal(calls, 0);
    f.db.close();
  });
  await t.test('active', async (t) => {
    const f = fixture(t);
    const enroll = new GatewayEnrollmentController({
      store: f.store,
      secrets: new SecretRegistry(),
      remote: remote(f.token),
      displayName: 'Aster',
      fetch: async () => response(result(f.store)),
    });
    await enroll.start();
    const registry = new SecretRegistry();
    let calls = 0;
    const active = new GatewayEnrollmentController({
      store: f.store,
      secrets: registry,
      remote: remote(null),
      displayName: 'Other',
      fetch: async () => {
        calls += 1;
        throw new Error('must not fetch');
      },
    });
    assert.deepEqual(await active.start(), { code: 'active' });
    assert.equal(calls, 0);
    assert.equal(
      registry.redact(f.store.activeNodeToken()),
      '[SECRET REDACTED]',
    );
    f.db.close();
  });
});
