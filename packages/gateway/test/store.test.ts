import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  GATEWAY_APPLICATION_ID,
  GATEWAY_MIGRATIONS,
  createNodeCredential,
  newGatewayInstanceId,
  openGatewayStore,
  runGatewayMigrations,
} from '../src/index.js';

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-gateway-store-'));
}

function mode(file: string): number {
  return fs.statSync(file).mode & 0o777;
}

test('secure open creates one healthy Gateway database with hardened files', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  const store = openGatewayStore(directory, { now: () => now });
  assert.equal(mode(directory), 0o700);
  assert.equal(mode(store.databasePath), 0o600);
  for (const suffix of ['-wal', '-shm']) {
    const file = `${store.databasePath}${suffix}`;
    if (fs.existsSync(file)) assert.equal(mode(file), 0o600);
  }
  assert.deepEqual(store.config(), {
    publicUrl: null,
    setupCompletedAt: null,
    revision: 0,
    createdAt: store.config().createdAt,
    updatedAt: store.config().updatedAt,
  });
  now = 2000;
  assert.deepEqual(
    store.setPublicUrl('https://gateway.example.com/', 'req-1'),
    {
      publicUrl: 'https://gateway.example.com',
      setupCompletedAt: 2000,
      revision: 1,
      createdAt: store.config().createdAt,
      updatedAt: 2000,
    },
  );
  now = 3000;
  assert.equal(
    store.setPublicUrl('https://other.example.com').setupCompletedAt,
    2000,
  );
  assert.equal(store.config().revision, 2);
  assert.deepEqual(
    store.audit().map((event) => [event.action, event.at, event.detail]),
    [
      ['gateway.configure', 3000, { publicUrl: 'https://other.example.com' }],
      ['gateway.configure', 2000, { publicUrl: 'https://gateway.example.com' }],
    ],
  );
  store.close();
});

test('instance summaries are bounded, deterministic, immutable, and verifier-free', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 100;
  const store = openGatewayStore(directory, { now: () => now });

  const instanceB = newGatewayInstanceId((size) => Buffer.alloc(size, 2));
  const nodeB = createNodeCredential((size) => Buffer.alloc(size, 3));
  const grantB = store.credentials.createEnrollmentGrant();
  store.credentials.enroll({
    grantToken: grantB.token,
    instanceId: instanceB,
    displayName: 'Resident B',
    credentialId: nodeB.id,
    credentialVerifier: nodeB.verifier,
  });

  const instanceA = newGatewayInstanceId((size) => Buffer.alloc(size, 1));
  const nodeA = createNodeCredential((size) => Buffer.alloc(size, 4));
  const grantA = store.credentials.createEnrollmentGrant();
  store.credentials.enroll({
    grantToken: grantA.token,
    instanceId: instanceA,
    displayName: 'Resident A',
    credentialId: nodeA.id,
    credentialVerifier: nodeA.verifier,
  });

  now = 250;
  assert.deepEqual(store.credentials.authenticateNode(nodeB.token), {
    instanceId: instanceB,
    credentialId: nodeB.id,
  });

  const summaries = store.instances();
  assert.deepEqual(summaries, [
    {
      id: instanceA,
      displayName: 'Resident A',
      createdAt: 100,
      updatedAt: 100,
      revokedAt: null,
      activeCredentialId: nodeA.id,
      activeSince: 100,
      lastUsedAt: null,
    },
    {
      id: instanceB,
      displayName: 'Resident B',
      createdAt: 100,
      updatedAt: 100,
      revokedAt: null,
      activeCredentialId: nodeB.id,
      activeSince: 100,
      lastUsedAt: 250,
    },
  ]);
  assert.deepEqual(store.instances(1), [summaries[0]]);
  assert.equal(Object.isFrozen(summaries), true);
  assert.equal(summaries.every(Object.isFrozen), true);
  assert.throws(() => (summaries as unknown as unknown[]).push({}), TypeError);
  assert.throws(
    () =>
      ((summaries[0] as unknown as { displayName: string }).displayName =
        'Changed'),
    TypeError,
  );

  for (const invalid of [0, 1001, 1.5, NaN, Infinity, '1'])
    assert.throws(
      () => store.instances(invalid as unknown as number),
      /instance limit/,
    );

  const json = JSON.stringify(summaries);
  assert.deepEqual(Object.keys(JSON.parse(json)[0]), [
    'id',
    'displayName',
    'createdAt',
    'updatedAt',
    'revokedAt',
    'activeCredentialId',
    'activeSince',
    'lastUsedAt',
  ]);
  for (const forbidden of [
    grantA.token,
    grantB.token,
    nodeA.token,
    nodeB.token,
    grantA.token.split('.')[2],
    grantB.token.split('.')[2],
    nodeA.token.split('.')[2],
    nodeB.token.split('.')[2],
    nodeA.verifier.toString('hex'),
    nodeB.verifier.toString('hex'),
    'verifier',
  ])
    assert.equal(json.includes(forbidden), false);
  store.close();
});

test('audit and migration receipts are append-only', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = openGatewayStore(directory, { now: () => 50 });
  store.appendAudit({
    actorKind: 'gateway',
    action: 'test.event',
    targetKind: 'gateway',
    outcome: 'succeeded',
    detail: { value: 1 },
  });
  const file = store.databasePath;
  store.close();
  const database = new DatabaseSync(file);
  assert.throws(
    () => database.exec("UPDATE gateway_audit_events SET outcome = 'failed'"),
    /immutable/,
  );
  assert.throws(
    () => database.exec('DELETE FROM gateway_audit_events'),
    /append-only/,
  );
  assert.throws(
    () => database.exec('UPDATE gateway_migrations SET applied_at = 1'),
    /immutable/,
  );
  assert.throws(
    () => database.exec('DELETE FROM gateway_migrations'),
    /append-only/,
  );
  database.close();
});

test('migration history is an exact immutable prefix', () => {
  const database = new DatabaseSync(':memory:');
  const first = runGatewayMigrations(database, GATEWAY_MIGRATIONS, () => 10);
  assert.deepEqual(
    first.applied,
    GATEWAY_MIGRATIONS.map((migration) => migration.name),
  );
  assert.deepEqual(
    runGatewayMigrations(database, GATEWAY_MIGRATIONS, () => 20),
    {
      existing: GATEWAY_MIGRATIONS.map((migration) => migration.name),
      applied: [],
    },
  );
  assert.throws(
    () =>
      runGatewayMigrations(database, [
        { name: '001-initial', sql: `${GATEWAY_MIGRATIONS[0].sql}\nSELECT 1;` },
        GATEWAY_MIGRATIONS[1],
      ]),
    /checksum drift/,
  );
  assert.throws(
    () =>
      runGatewayMigrations(database, [
        { name: '000-before', sql: 'SELECT 1;' },
        GATEWAY_MIGRATIONS[0],
      ]),
    /not an exact prefix/,
  );
  database.close();
});

test('a v1 database advances by exact prefix without rewriting migration 001', () => {
  const database = new DatabaseSync(':memory:');
  assert.deepEqual(
    runGatewayMigrations(database, [GATEWAY_MIGRATIONS[0]], () => 10).applied,
    ['001-initial'],
  );
  assert.deepEqual(
    runGatewayMigrations(database, GATEWAY_MIGRATIONS, () => 20),
    {
      existing: ['001-initial'],
      applied: ['002-credentials'],
    },
  );
  assert.equal(
    (database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    2,
  );
  database.close();
});

test('open rejects wrong, corrupt, and symlinked database files', (t) => {
  const wrong = fixture();
  const corrupt = fixture();
  const linked = fixture();
  t.after(() => {
    for (const directory of [wrong, corrupt, linked])
      fs.rmSync(directory, { recursive: true, force: true });
  });

  const wrongFile = path.join(wrong, 'gateway.db');
  const database = new DatabaseSync(wrongFile);
  database.exec('CREATE TABLE foreign_state (id INTEGER PRIMARY KEY)');
  database.close();
  assert.throws(() => openGatewayStore(wrong), /does not belong/);
  const verifyWrong = new DatabaseSync(wrongFile);
  assert.equal(
    (
      verifyWrong.prepare('PRAGMA journal_mode').get() as {
        journal_mode: string;
      }
    ).journal_mode,
    'delete',
  );
  assert.equal(
    (
      verifyWrong
        .prepare(
          "SELECT count(*) AS count FROM sqlite_schema WHERE name = 'gateway_migrations'",
        )
        .get() as { count: number }
    ).count,
    0,
  );
  verifyWrong.close();

  fs.writeFileSync(path.join(corrupt, 'gateway.db'), Buffer.from('not sqlite'));
  assert.throws(() => openGatewayStore(corrupt), /could not open/);

  const target = path.join(linked, 'target.db');
  fs.writeFileSync(target, '');
  fs.symlinkSync(target, path.join(linked, 'gateway.db'));
  assert.throws(() => openGatewayStore(linked), /regular file/);
});

test('a claimed database resumes after a failed first migration', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'gateway.db');
  const database = new DatabaseSync(file);
  database.exec(`PRAGMA application_id = ${GATEWAY_APPLICATION_ID}`);
  assert.throws(() =>
    runGatewayMigrations(database, [
      {
        name: '001-initial',
        sql: 'CREATE TABLE transient_state (id INTEGER); SELECT missing_function();',
      },
    ]),
  );
  database.close();

  const store = openGatewayStore(directory);
  assert.equal(store.config().revision, 0);
  store.close();
});

test('public URL and bounded audit inputs fail closed', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = openGatewayStore(directory);
  for (const value of [
    'http://gateway.example.com',
    'https://user:pass@gateway.example.com',
    'https://gateway.example.com/path',
    'https://gateway.example.com/?query=1',
  ])
    assert.throws(() => store.setPublicUrl(value));
  assert.equal(
    store.setPublicUrl('http://localhost:8790').publicUrl,
    'http://localhost:8790',
  );
  assert.throws(() =>
    store.appendAudit({
      actorKind: 'gateway',
      action: 'test.event',
      targetKind: 'gateway',
      outcome: 'succeeded',
      detail: { oversized: 'x'.repeat(5000) },
    }),
  );
  assert.throws(() => store.audit(0));
  store.close();
});
