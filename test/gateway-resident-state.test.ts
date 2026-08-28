import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RESIDENT_CONTROL_FORMATS,
  createEnrollmentCredential,
  type ResidentEnrollmentResult,
  type ResidentRotationResult,
} from '@elpis/gateway-protocol';
import { openDatabase } from '../src/store/db.js';
import {
  GatewayResidentStateError,
  GatewayResidentStore,
  type GatewayResidentSnapshot,
} from '../src/store/gateway-resident.js';

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-resident-state-'));
}

function bytes(): (size: number) => Buffer {
  let n = 0;
  return (size) => Buffer.alloc(size, ++n);
}

function stateError(code: GatewayResidentStateError['code']) {
  return (error: unknown): boolean =>
    error instanceof GatewayResidentStateError && error.code === code;
}

function assertPublic(value: unknown, secrets: readonly string[]): void {
  const encoded = JSON.stringify(value);
  for (const secret of secrets) assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('enrollmentGrant'), false);
  assert.equal(encoded.includes('CredentialToken'), false);
}

function enrollmentResult(
  state: GatewayResidentSnapshot,
): ResidentEnrollmentResult {
  return {
    format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
    instanceId: state.instanceId as ResidentEnrollmentResult['instanceId'],
    credentialId: state.pendingCredentialId!,
    replayed: false,
  };
}

function rotationResult(state: GatewayResidentSnapshot): ResidentRotationResult {
  return {
    format: RESIDENT_CONTROL_FORMATS.rotationResult,
    instanceId: state.instanceId as ResidentRotationResult['instanceId'],
    credentialId: state.pendingCredentialId!,
    previousCredentialId: state.activeCredentialId!,
    replayed: false,
  };
}

function enroll(
  store: GatewayResidentStore,
  random: (size: number) => Buffer,
): { active: GatewayResidentSnapshot; activeToken: string } {
  const grant = createEnrollmentCredential(random).token;
  const pending = store.beginEnrollment({
    endpoint: 'https://gateway.example',
    grantToken: grant,
    displayName: 'Resident',
  });
  const candidateToken = store.secretValues().find((value) =>
    value.startsWith('egc1.'),
  )!;
  store.activateEnrollment(enrollmentResult(pending));
  return { active: store.read(), activeToken: candidateToken };
}

test('enrollment candidate survives restart while public state remains secret-free', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 10;
  const random = bytes();
  const db = openDatabase(dir);
  const store = new GatewayResidentStore(db, {
    now: () => now,
    randomBytes: random,
  });
  const identity = store.read().instanceId;
  const grant = createEnrollmentCredential(random).token;
  const input = {
    endpoint: 'https://gateway.example',
    grantToken: grant,
    displayName: 'Resident',
  };
  const first = store.beginEnrollment(input);
  const firstSecrets = store.secretValues();
  const pendingToken = firstSecrets.find((value) => value.startsWith('egc1.'))!;
  assert.deepEqual(Object.keys(first), [
    'instanceId',
    'phase',
    'endpoint',
    'displayName',
    'requestId',
    'activeCredentialId',
    'pendingCredentialId',
    'createdAt',
    'updatedAt',
    'enrollmentStartedAt',
    'activatedAt',
    'rotationStartedAt',
  ]);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(firstSecrets), true);
  assert.deepEqual(firstSecrets, [grant, pendingToken]);
  assertPublic(first, firstSecrets);
  const request = store.enrollmentRequest();
  assert.equal(Object.isFrozen(request), true);
  assert.equal(request.grantToken, grant);
  assert.equal(request.credentialId, first.pendingCredentialId);
  assert.equal(request.instanceId, identity);
  assert.throws(() => store.activeNodeToken(), stateError('invalid_state'));
  assert.throws(() => store.pendingNodeToken(), stateError('invalid_state'));

  db.close();
  const reopenedDb = openDatabase(dir);
  const reopened = new GatewayResidentStore(reopenedDb, {
    now: () => now,
    randomBytes: random,
  });
  assert.equal(reopened.read().instanceId, identity);
  assert.deepEqual(reopened.beginEnrollment(input), first);
  assert.deepEqual(reopened.enrollmentRequest(), request);
  assert.deepEqual(reopened.secretValues(), firstSecrets);
  assert.throws(
    () => reopened.beginEnrollment({ ...input, displayName: 'Other' }),
    stateError('conflict'),
  );
  assert.throws(
    () =>
      reopened.activateEnrollment({
        instanceId: identity,
        credentialId: first.pendingCredentialId,
      }),
    stateError('invalid_input'),
  );
  assert.throws(
    () =>
      reopened.activateEnrollment({
        ...enrollmentResult(first),
        message: grant,
      }),
    (error) =>
      stateError('invalid_input')(error) && !String(error).includes(grant),
  );

  reopenedDb.exec(`CREATE TEMP TRIGGER fail_resident_activation
    BEFORE UPDATE ON gateway_resident_state WHEN NEW.phase='active'
    BEGIN SELECT RAISE(ABORT, 'injected activation failure'); END;`);
  assert.throws(
    () => reopened.activateEnrollment(enrollmentResult(first)),
    /injected activation failure/,
  );
  assert.deepEqual(reopened.read(), first);
  assert.deepEqual(reopened.secretValues(), firstSecrets);
  reopenedDb.exec('DROP TRIGGER fail_resident_activation');

  const receipt = reopened.activateEnrollment(enrollmentResult(first));
  assert.deepEqual(receipt, {
    instanceId: identity,
    credentialId: first.pendingCredentialId,
  });
  assert.equal(Object.isFrozen(receipt), true);
  assertPublic(receipt, firstSecrets);
  const active = reopened.read();
  assert.equal(active.phase, 'active');
  assert.equal(active.activeCredentialId, first.pendingCredentialId);
  assert.equal(active.pendingCredentialId, null);
  assert.deepEqual(reopened.secretValues(), [pendingToken]);
  assert.equal(reopened.activeNodeToken(), pendingToken);
  assert.throws(() => reopened.pendingNodeToken(), stateError('invalid_state'));
  assertPublic(active, [grant, pendingToken]);
  reopenedDb.close();
});

test('rotation keeps old auth until exact activation then deletes its DB secret', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = 100;
  const random = bytes();
  let db = openDatabase(dir);
  let store = new GatewayResidentStore(db, {
    now: () => now,
    randomBytes: random,
  });
  const enrolled = enroll(store, random);
  const oldToken = enrolled.activeToken;
  const oldId = enrolled.active.activeCredentialId!;
  now = 200;
  const rotating = store.beginRotation();
  const secrets = store.secretValues();
  const pendingToken = secrets.find((value) => value !== oldToken)!;
  assert.equal(store.activeNodeToken(), oldToken);
  assert.equal(store.pendingNodeToken(), pendingToken);
  assert.deepEqual(store.beginRotation(), rotating);
  assertPublic(rotating, secrets);
  const request = store.rotationRequest();
  assert.equal(request.credentialId, rotating.pendingCredentialId);
  assert.equal(Object.isFrozen(request), true);
  db.close();

  db = openDatabase(dir);
  store = new GatewayResidentStore(db, {
    now: () => ++now,
    randomBytes: random,
  });
  assert.deepEqual(store.read(), rotating);
  assert.deepEqual(store.rotationRequest(), request);
  assert.equal(store.activeNodeToken(), oldToken);
  assert.equal(store.pendingNodeToken(), pendingToken);
  assert.throws(
    () =>
      store.activateRotation({
        ...rotationResult(rotating),
        previousCredentialId: 'z'.repeat(22),
      }),
    stateError('conflict'),
  );
  assert.throws(
    () =>
      store.activateRotation({
        ...rotationResult(rotating),
        replayed: 'false',
      }),
    stateError('invalid_input'),
  );
  assert.equal(store.activeNodeToken(), oldToken);

  const receipt = store.activateRotation(rotationResult(rotating));
  assert.deepEqual(receipt, {
    instanceId: rotating.instanceId,
    credentialId: rotating.pendingCredentialId,
    previousCredentialId: oldId,
  });
  assertPublic(receipt, secrets);
  const active = store.read();
  assert.equal(active.phase, 'active');
  assert.equal(active.activeCredentialId, rotating.pendingCredentialId);
  assert.equal(active.pendingCredentialId, null);
  assert.equal(store.activeNodeToken(), pendingToken);
  assert.deepEqual(store.secretValues(), [pendingToken]);
  const rowText = JSON.stringify(
    db.prepare('SELECT * FROM gateway_resident_state').get(),
  );
  assert.equal(rowText.includes(oldToken), false);
  db.close();
});

test('input validation, SQL guards, and read-time validation fail closed', (t) => {
  const dir = fixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const random = bytes();
  const db = openDatabase(dir);
  const store = new GatewayResidentStore(db, {
    now: () => 1,
    randomBytes: random,
  });
  const grant = createEnrollmentCredential(random).token;
  for (const endpoint of [
    'http://gateway.example',
    'https://gateway.example/',
    'https://gateway.example/path',
    'https://user@gateway.example',
    'https://gateway.example?query=1',
  ])
    assert.throws(
      () =>
        store.beginEnrollment({
          endpoint,
          grantToken: grant,
          displayName: 'Resident',
        }),
      stateError('invalid_input'),
    );
  assert.throws(
    () =>
      store.beginEnrollment({
        endpoint: 'https://gateway.example',
        grantToken: grant,
        displayName: '\ud800',
      }),
    stateError('invalid_input'),
  );
  assert.throws(
    () =>
      store.beginEnrollment(
        Object.defineProperty(
          {
            endpoint: 'https://gateway.example',
            displayName: 'Resident',
          },
          'grantToken',
          {
            enumerable: true,
            get() {
              throw new Error(grant);
            },
          },
        ) as never,
      ),
    (error) => stateError('invalid_input')(error) && !String(error).includes(grant),
  );
  assert.throws(
    () => db.prepare("UPDATE gateway_resident_state SET instance_id='bad'").run(),
    /immutable/,
  );
  assert.throws(
    () => db.prepare("UPDATE gateway_resident_state SET phase='active'").run(),
    /gateway resident/,
  );
  store.beginEnrollment({
    endpoint: 'https://gateway.example',
    grantToken: grant,
    displayName: 'One',
  });
  const secrets = store.secretValues();
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE gateway_resident_state SET endpoint='https://two.example'",
        )
        .run(),
    /binding is immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM gateway_resident_state').run(),
    /identity is immutable/,
  );
  assert.throws(
    () => db.prepare("UPDATE gateway_resident_state SET request_id='nope'").run(),
    /(candidate is immutable|CHECK constraint failed)/,
  );
  db.exec('DROP TRIGGER gateway_resident_state_binding_no_update');
  db.exec('PRAGMA ignore_check_constraints=ON');
  db.prepare("UPDATE gateway_resident_state SET endpoint='http://bad.example'").run();
  let caught: unknown;
  try {
    store.read();
  } catch (error) {
    caught = error;
  }
  assert.ok(stateError('corrupt_state')(caught));
  for (const secret of secrets) assert.equal(String(caught).includes(secret), false);
  db.close();
});
