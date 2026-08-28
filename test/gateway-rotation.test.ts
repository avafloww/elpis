import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_PATHS,
  createEnrollmentCredential,
  decodeResidentRotationActivationRequest,
  decodeResidentRotationRequest,
  formatNodeBearerAuthorization,
  serializeResidentRotationResult,
  type ResidentEnrollmentResult,
  type ResidentRotationResult,
} from '@elpis/gateway-protocol';
import {
  GatewayRotationController,
  type GatewayRotationFetch,
} from '../src/gateway-rotation.js';
import { SecretRegistry } from '../src/lib/secrets.js';
import { openDatabase } from '../src/store/db.js';
import { GatewayResidentStore } from '../src/store/gateway-resident.js';

function randomBytes(): (size: number) => Buffer {
  let value = 0;
  return (size) => Buffer.alloc(size, ++value);
}
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-rotation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = randomBytes();
  const db = openDatabase(dir);
  const store = new GatewayResidentStore(db, {
    now: () => 10,
    randomBytes: bytes,
  });
  const grant = createEnrollmentCredential(bytes).token;
  store.beginEnrollment({
    endpoint: 'https://gateway.example',
    grantToken: grant,
    displayName: 'Aster',
  });
  const enrolling = store.read();
  store.activateEnrollment({
    format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
    instanceId: enrolling.instanceId,
    credentialId: enrolling.pendingCredentialId,
    replayed: false,
  } as ResidentEnrollmentResult);
  return { dir, db, store };
}
function rotationResult(
  store: GatewayResidentStore,
  replayed = false,
): ResidentRotationResult {
  const state = store.read();
  return {
    format: RESIDENT_CONTROL_FORMATS.rotationResult,
    instanceId: state.instanceId as ResidentRotationResult['instanceId'],
    credentialId: state.pendingCredentialId!,
    previousCredentialId: state.activeCredentialId!,
    replayed,
  };
}
function response(
  value: ResidentRotationResult,
  status = value.replayed ? 200 : 201,
): Response {
  return new Response(serializeResidentRotationResult(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

test('explicit trigger proposes under old bearer then activates under pending bearer', async (t) => {
  const f = fixture(t);
  const oldToken = f.store.activeNodeToken();
  const secrets = new SecretRegistry();
  let pendingToken = '';
  let calls = 0;
  const fetch: GatewayRotationFetch = async (url, init) => {
    calls += 1;
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(f.store.activeNodeToken(), oldToken);
    for (const secret of f.store.secretValues())
      assert.equal(secrets.redact(secret), '[SECRET REDACTED]');
    if (calls === 1) {
      pendingToken = f.store.pendingNodeToken();
      assert.equal(
        url,
        'https://gateway.example' + RESIDENT_CONTROL_PATHS.rotation,
      );
      assert.deepEqual(init.headers, {
        accept: 'application/json',
        'accept-encoding': 'identity',
        authorization: formatNodeBearerAuthorization(oldToken),
        'content-type': 'application/json; charset=utf-8',
      });
      assert.deepEqual(
        decodeResidentRotationRequest(init.body as string),
        f.store.rotationRequest(),
      );
      return response(rotationResult(f.store));
    }
    assert.equal(f.store.read().rotationProposedAt, 10);
    assert.equal(
      url,
      'https://gateway.example' + RESIDENT_CONTROL_PATHS.rotationActivation,
    );
    assert.equal(
      (init.headers as Record<string, string>).authorization,
      formatNodeBearerAuthorization(pendingToken),
    );
    assert.deepEqual(
      decodeResidentRotationActivationRequest(init.body as string),
      {
        format: RESIDENT_CONTROL_FORMATS.rotationActivationRequest,
        requestId: f.store.rotationRequest().requestId,
      },
    );
    return response(rotationResult(f.store), 200);
  };
  const controller = new GatewayRotationController({
    store: f.store,
    secrets,
    fetch,
    mode: 'trigger',
    timeoutMs: 100,
  });
  const attempt = controller.start();
  assert.equal(controller.start(), attempt);
  assert.deepEqual(controller.status, { code: 'rotating' });
  assert.deepEqual(await attempt, { code: 'rotated' });
  assert.equal(calls, 2);
  assert.equal(f.store.read().phase, 'active');
  assert.equal(f.store.activeNodeToken(), pendingToken);
  assert.notEqual(pendingToken, oldToken);
  f.db.close();
});

test('resume replays proposal without checkpoint and skips it with checkpoint', async (t) => {
  await t.test('proposal replay', async (t) => {
    const f = fixture(t);
    f.store.beginRotation();
    const old = f.store.activeNodeToken();
    const body = JSON.stringify(f.store.rotationRequest());
    let calls = 0;
    const controller = new GatewayRotationController({
      store: f.store,
      secrets: new SecretRegistry(),
      mode: 'resume',
      fetch: async (url, init) => {
        calls += 1;
        if (calls === 1) {
          assert.equal(url.endsWith(RESIDENT_CONTROL_PATHS.rotation), true);
          assert.equal(init.body, body);
          assert.equal(
            (init.headers as Record<string, string>).authorization,
            formatNodeBearerAuthorization(old),
          );
          return response(rotationResult(f.store, true));
        }
        return response(rotationResult(f.store), 200);
      },
    });
    assert.deepEqual(await controller.start(), { code: 'rotated' });
    assert.equal(calls, 2);
    f.db.close();
  });

  await t.test('activation replay', async (t) => {
    const f = fixture(t);
    f.store.beginRotation();
    const pending = f.store.pendingNodeToken();
    f.store.markRotationProposed(rotationResult(f.store));
    let calls = 0;
    const controller = new GatewayRotationController({
      store: f.store,
      secrets: new SecretRegistry(),
      mode: 'resume',
      fetch: async (url, init) => {
        calls += 1;
        assert.equal(
          url.endsWith(RESIDENT_CONTROL_PATHS.rotationActivation),
          true,
        );
        assert.equal(
          (init.headers as Record<string, string>).authorization,
          formatNodeBearerAuthorization(pending),
        );
        return response(rotationResult(f.store, true), 200);
      },
    });
    assert.deepEqual(await controller.start(), { code: 'rotated' });
    assert.equal(calls, 1);
    assert.equal(f.store.activeNodeToken(), pending);
    f.db.close();
  });
});

test('trigger and resume modes never cross their allowed starting state', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const noFetch = async (): Promise<Response> => {
    calls += 1;
    throw new Error('must not fetch');
  };
  const resume = new GatewayRotationController({
    store: f.store,
    secrets: new SecretRegistry(),
    fetch: noFetch,
    mode: 'resume',
  });
  assert.deepEqual(await resume.start(), { code: 'invalid_state' });
  assert.equal(f.store.read().phase, 'active');

  f.store.beginRotation();
  const before = f.store.read();
  const trigger = new GatewayRotationController({
    store: f.store,
    secrets: new SecretRegistry(),
    fetch: noFetch,
    mode: 'trigger',
  });
  assert.deepEqual(await trigger.start(), { code: 'invalid_state' });
  assert.deepEqual(f.store.read(), before);
  assert.equal(calls, 0);
  f.db.close();
});

test('lost activation response preserves old local active and resumes activation only', async (t) => {
  const f = fixture(t);
  const old = f.store.activeNodeToken();
  let calls = 0;
  const first = new GatewayRotationController({
    store: f.store,
    secrets: new SecretRegistry(),
    mode: 'trigger',
    fetch: async () => {
      calls += 1;
      if (calls === 1) return response(rotationResult(f.store));
      throw new Error('lost activation response');
    },
  });
  assert.deepEqual(await first.start(), { code: 'network_error' });
  assert.equal(f.store.read().rotationProposedAt, 10);
  assert.equal(f.store.activeNodeToken(), old);
  const pending = f.store.pendingNodeToken();

  const resumed = new GatewayRotationController({
    store: f.store,
    secrets: new SecretRegistry(),
    mode: 'resume',
    fetch: async (url, init) => {
      assert.equal(
        url.endsWith(RESIDENT_CONTROL_PATHS.rotationActivation),
        true,
      );
      assert.equal(
        (init.headers as Record<string, string>).authorization,
        formatNodeBearerAuthorization(pending),
      );
      return response(rotationResult(f.store, true), 200);
    },
  });
  assert.deepEqual(await resumed.start(), { code: 'rotated' });
  assert.equal(f.store.activeNodeToken(), pending);
  f.db.close();
});

test('stop and timeout prevent late responses from mutating durable state', async (t) => {
  for (const [name, stop, expected] of [
    ['stop', true, 'stopped'],
    ['timeout', false, 'timeout'],
  ] as const) {
    await t.test(name, async (t) => {
      const f = fixture(t);
      let resolve!: (response: Response) => void;
      let signal!: AbortSignal;
      const delayed = new Promise<Response>((done) => {
        resolve = done;
      });
      const controller = new GatewayRotationController({
        store: f.store,
        secrets: new SecretRegistry(),
        mode: 'trigger',
        timeoutMs: 10,
        fetch: async (_url, init) => {
          signal = init.signal as AbortSignal;
          return delayed;
        },
      });
      const attempt = controller.start();
      const rotating = f.store.read();
      if (stop) controller.stop();
      assert.deepEqual(await attempt, { code: expected });
      assert.equal(signal.aborted, true);
      resolve(response(rotationResult(f.store)));
      await new Promise<void>((done) => setImmediate(done));
      assert.deepEqual(f.store.read(), rotating);
      f.db.close();
    });
  }
});

test('HTTP and canonical response failures preserve rotation and expose only bounded status', async (t) => {
  const cases = [
    {
      name: 'HTTP error',
      expected: 'http_error',
      respond: (_store: GatewayResidentStore) =>
        new Response('', { status: 500 }),
    },
    {
      name: 'wrong proposal status',
      expected: 'invalid_response',
      respond: (store: GatewayResidentStore) =>
        response(rotationResult(store), 200),
    },
    {
      name: 'noncanonical body',
      expected: 'invalid_response',
      respond: (store: GatewayResidentStore) =>
        new Response(
          serializeResidentRotationResult(rotationResult(store)) + '\n',
          {
            status: 201,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          },
        ),
    },
    {
      name: 'encoded body',
      expected: 'invalid_response',
      respond: (store: GatewayResidentStore) =>
        new Response(serializeResidentRotationResult(rotationResult(store)), {
          status: 201,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-encoding': 'gzip',
          },
        }),
    },
  ] as const;
  for (const item of cases) {
    await t.test(item.name, async (t) => {
      const f = fixture(t);
      const old = f.store.activeNodeToken();
      const controller = new GatewayRotationController({
        store: f.store,
        secrets: new SecretRegistry(),
        mode: 'trigger',
        fetch: async () => item.respond(f.store),
      });
      const result = await controller.start();
      assert.deepEqual(result, { code: item.expected });
      assert.equal(Object.isFrozen(result), true);
      assert.equal(f.store.read().phase, 'rotating');
      assert.equal(f.store.read().rotationProposedAt, null);
      assert.equal(f.store.activeNodeToken(), old);
      const evidence = JSON.stringify({ result, status: controller.status });
      assert.equal(evidence.includes('https://gateway.example'), false);
      for (const secret of f.store.secretValues())
        assert.equal(evidence.includes(secret), false);
      f.db.close();
    });
  }
});
