import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  GatewayCredentialError,
  createEnrollmentCredential,
  createNodeCredential,
  isGatewayInstanceId,
  newGatewayInstanceId,
  openGatewayStore,
  parseEnrollmentCredential,
  parseNodeCredential,
} from '../src/index.js';

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-gateway-credentials-'));
}

function secret(token: string): string {
  return token.split('.')[2];
}

function expectCode(operation: () => unknown, code: string): void {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof GatewayCredentialError);
    assert.equal(error.code, code);
    return true;
  });
}

test('credential grammars are exact and derive verifier-only material', () => {
  const bytes = (size: number): Buffer => Buffer.alloc(size, 0x5a);
  const instanceId = newGatewayInstanceId(bytes);
  const enrollment = createEnrollmentCredential(bytes);
  const node = createNodeCredential(bytes);
  assert.equal(isGatewayInstanceId(instanceId), true);
  assert.equal(isGatewayInstanceId(`${instanceId}x`), false);
  assert.equal(parseEnrollmentCredential(enrollment.token)?.id, enrollment.id);
  assert.deepEqual(
    parseEnrollmentCredential(enrollment.token)?.verifier,
    enrollment.verifier,
  );
  assert.equal(parseEnrollmentCredential(node.token), null);
  assert.equal(parseNodeCredential(node.token)?.id, node.id);
  assert.equal(parseNodeCredential(`${node.token}.extra`), null);
  assert.throws(
    () => newGatewayInstanceId(() => Buffer.alloc(15)),
    /exactly 16/,
  );
});

test('enrollment is atomic and an exact lost-response retry survives expiry', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const store = openGatewayStore(directory, { now: () => now });
  const grant = store.credentials.createEnrollmentGrant(1000, 'grant-request');
  const instanceId = newGatewayInstanceId();
  const node = createNodeCredential();
  const request = {
    grantToken: grant.token,
    instanceId,
    displayName: 'Resident One',
    credentialId: node.id,
    credentialVerifier: node.verifier,
    requestId: 'enroll-request',
  };
  assert.deepEqual(store.credentials.enroll(request), {
    instanceId,
    credentialId: node.id,
    replayed: false,
  });
  assert.deepEqual(store.credentials.authenticateNode(node.token), {
    instanceId,
    credentialId: node.id,
  });

  now = 3000;
  assert.deepEqual(store.credentials.enroll(request), {
    instanceId,
    credentialId: node.id,
    replayed: true,
  });
  const conflicting = createNodeCredential();
  expectCode(
    () =>
      store.credentials.enroll({
        ...request,
        credentialId: conflicting.id,
        credentialVerifier: conflicting.verifier,
      }),
    'conflict',
  );
  const other = createNodeCredential();
  assert.equal(
    store.credentials.authenticateNode(
      `egc1.${node.id}.${secret(other.token)}`,
    ),
    null,
  );
  assert.equal(
    store.credentials.authenticateNode(
      `egc1.${other.id}.${secret(node.token)}`,
    ),
    null,
  );
  const audit = JSON.stringify(store.audit());
  for (const forbidden of [
    grant.token,
    node.token,
    secret(grant.token),
    secret(node.token),
  ])
    assert.equal(audit.includes(forbidden), false);

  const databasePath = store.databasePath;
  store.close();
  const databaseBytes = fs.readFileSync(databasePath).toString('latin1');
  for (const forbidden of [
    grant.token,
    node.token,
    secret(grant.token),
    secret(node.token),
  ])
    assert.equal(databaseBytes.includes(forbidden), false);
});

test('expired and revoked enrollment grants fail without partial instances', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 10_000;
  const store = openGatewayStore(directory, { now: () => now });
  const expired = store.credentials.createEnrollmentGrant(1000);
  const expiredNode = createNodeCredential();
  now = expired.expiresAt;
  expectCode(
    () =>
      store.credentials.enroll({
        grantToken: expired.token,
        instanceId: newGatewayInstanceId(),
        displayName: 'Expired',
        credentialId: expiredNode.id,
        credentialVerifier: expiredNode.verifier,
      }),
    'expired',
  );

  now += 1;
  const revoked = store.credentials.createEnrollmentGrant(1000);
  assert.equal(
    store.credentials.revokeEnrollmentGrant(revoked.id).replayed,
    false,
  );
  assert.equal(
    store.credentials.revokeEnrollmentGrant(revoked.id).replayed,
    true,
  );
  const revokedNode = createNodeCredential();
  expectCode(
    () =>
      store.credentials.enroll({
        grantToken: revoked.token,
        instanceId: newGatewayInstanceId(),
        displayName: 'Revoked',
        credentialId: revokedNode.id,
        credentialVerifier: revokedNode.verifier,
      }),
    'revoked',
  );
  store.close();
});

test('rotation keeps old active until new possession then revokes old atomically', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 100;
  const store = openGatewayStore(directory, { now: () => now });
  const grant = store.credentials.createEnrollmentGrant();
  const instanceId = newGatewayInstanceId();
  const oldNode = createNodeCredential();
  store.credentials.enroll({
    grantToken: grant.token,
    instanceId,
    displayName: 'Rotating Resident',
    credentialId: oldNode.id,
    credentialVerifier: oldNode.verifier,
  });

  now = 200;
  const newNode = createNodeCredential();
  assert.deepEqual(
    store.credentials.proposeRotation(
      oldNode.token,
      newNode.id,
      newNode.verifier,
      'rotate-propose',
    ),
    {
      instanceId,
      credentialId: newNode.id,
      previousCredentialId: oldNode.id,
      replayed: false,
    },
  );
  assert.equal(
    store.credentials.proposeRotation(
      oldNode.token,
      newNode.id,
      newNode.verifier,
    ).replayed,
    true,
  );
  assert.deepEqual(store.credentials.authenticateNode(oldNode.token), {
    instanceId,
    credentialId: oldNode.id,
  });
  assert.equal(store.credentials.authenticateNode(newNode.token), null);
  const third = createNodeCredential();
  expectCode(
    () =>
      store.credentials.proposeRotation(
        oldNode.token,
        third.id,
        third.verifier,
      ),
    'conflict',
  );

  now = 300;
  assert.equal(
    store.credentials.activateRotation(newNode.token).replayed,
    false,
  );
  assert.equal(
    store.credentials.activateRotation(newNode.token).replayed,
    true,
  );
  assert.equal(store.credentials.authenticateNode(oldNode.token), null);
  assert.deepEqual(store.credentials.authenticateNode(newNode.token), {
    instanceId,
    credentialId: newNode.id,
  });
  store.close();
});

test('SQLite forbids duplicate active credentials, identity rewrites, and resurrection', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = openGatewayStore(directory);
  const grant = store.credentials.createEnrollmentGrant();
  const instanceId = newGatewayInstanceId();
  const node = createNodeCredential();
  store.credentials.enroll({
    grantToken: grant.token,
    instanceId,
    displayName: 'Guarded Resident',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const databasePath = store.databasePath;
  store.close();

  const database = new DatabaseSync(databasePath);
  const duplicate = createNodeCredential();
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO gateway_node_credentials
            (id, instance_id, verifier, state, created_at, activated_at)
           VALUES (?, ?, ?, 'active', 1, 1)`,
        )
        .run(duplicate.id, instanceId, duplicate.verifier),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          'UPDATE gateway_node_credentials SET verifier = ? WHERE id = ?',
        )
        .run(duplicate.verifier, node.id),
    /identity is immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          'UPDATE gateway_enrollment_grants SET consumed_credential_id = consumed_credential_id WHERE id = ?',
        )
        .run(grant.id),
    /binding is immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare('DELETE FROM gateway_node_credentials WHERE id = ?')
        .run(node.id),
    /retained/,
  );
  database.close();

  const reopened = openGatewayStore(directory);
  reopened.credentials.revokeCredential(node.id);
  reopened.close();
  const afterRevoke = new DatabaseSync(databasePath);
  assert.throws(
    () =>
      afterRevoke
        .prepare(
          "UPDATE gateway_node_credentials SET state = 'active', revoked_at = NULL WHERE id = ?",
        )
        .run(node.id),
    /cannot move backward/,
  );
  afterRevoke.close();
});

test('credential revocation is isolated to its resident binding', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = openGatewayStore(directory);
  const enrolled = [1, 2].map((number) => {
    const grant = store.credentials.createEnrollmentGrant();
    const node = createNodeCredential();
    const instanceId = newGatewayInstanceId();
    store.credentials.enroll({
      grantToken: grant.token,
      instanceId,
      displayName: `Resident ${number}`,
      credentialId: node.id,
      credentialVerifier: node.verifier,
    });
    return { node, instanceId };
  });

  assert.equal(
    store.credentials.revokeCredential(enrolled[0].node.id).replayed,
    false,
  );
  assert.equal(
    store.credentials.revokeCredential(enrolled[0].node.id).replayed,
    true,
  );
  assert.equal(
    store.credentials.authenticateNode(enrolled[0].node.token),
    null,
  );
  assert.deepEqual(store.credentials.authenticateNode(enrolled[1].node.token), {
    instanceId: enrolled[1].instanceId,
    credentialId: enrolled[1].node.id,
  });
  store.close();
});
