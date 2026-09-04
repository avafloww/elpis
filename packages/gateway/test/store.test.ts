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
        ...GATEWAY_MIGRATIONS.slice(1),
      ]),
    /checksum drift/,
  );
  assert.throws(
    () =>
      runGatewayMigrations(database, [
        { name: '000-before', sql: 'SELECT 1;' },
        ...GATEWAY_MIGRATIONS,
      ]),
    /not an exact prefix/,
  );
  database.close();
});

test('a v2 database advances by exact prefix without rewriting earlier migrations', () => {
  const database = new DatabaseSync(':memory:');
  assert.deepEqual(
    runGatewayMigrations(database, GATEWAY_MIGRATIONS.slice(0, 2), () => 10)
      .applied,
    ['001-initial', '002-credentials'],
  );
  assert.deepEqual(
    runGatewayMigrations(database, GATEWAY_MIGRATIONS, () => 20),
    {
      existing: ['001-initial', '002-credentials'],
      applied: ['003-provider-store'],
    },
  );
  assert.equal(
    (database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    3,
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

test('provider schema keeps credentials and targets immutable while OAuth refresh stays catalog-invisible', () => {
  const database = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
  });
  runGatewayMigrations(database, GATEWAY_MIGRATIONS, () => 10);
  const apiCredentialId = `epc1.${'A'.repeat(22)}`;
  const oauthCredentialId = `epc1.${'B'.repeat(22)}`;
  const insertCredential = database.prepare(
    `INSERT INTO gateway_provider_credentials (
      id, provider_id, provider_type, account_ref, account_identity_json,
      auth_kind, api_key, oauth_access, oauth_refresh, oauth_expires,
      oauth_secret_revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertCredential.run(
    apiCredentialId,
    'provider',
    'openai-compatible',
    'default',
    '{}',
    'api-key',
    Buffer.from('synthetic-api-key'),
    null,
    null,
    null,
    0,
    10,
    10,
  );
  insertCredential.run(
    oauthCredentialId,
    'codex',
    'codex-oauth',
    'account',
    '{"accountId":"synthetic-account"}',
    'oauth',
    null,
    Buffer.from('synthetic-access-1'),
    Buffer.from('synthetic-refresh-1'),
    100,
    0,
    10,
    10,
  );
  assert.throws(
    () =>
      insertCredential.run(
        `epc1.${'E'.repeat(22)}`,
        'codex',
        'codex-oauth',
        'duplicate-identity',
        '{"accountId":"one","accountId":"two"}',
        'oauth',
        null,
        Buffer.from('synthetic-access'),
        Buffer.from('synthetic-refresh'),
        100,
        0,
        10,
        10,
      ),
    /identity/,
  );
  assert.throws(
    () =>
      insertCredential.run(
        `epc1.${'F'.repeat(22)}`,
        'codex',
        'codex-oauth',
        'fractional-state',
        '{}',
        'oauth',
        null,
        Buffer.from('synthetic-access'),
        Buffer.from('synthetic-refresh'),
        1.5,
        0.5,
        10,
        10,
      ),
    /constraint|integer/i,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE gateway_provider_catalog SET revision = revision + 1, updated_at = 'poison'",
        )
        .run(),
    /revision/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          'UPDATE gateway_provider_credentials SET api_key = ? WHERE id = ?',
        )
        .run(Buffer.from('replacement'), apiCredentialId),
    /immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          'INSERT OR REPLACE INTO gateway_provider_credentials SELECT * FROM gateway_provider_credentials WHERE id = ?',
        )
        .run(apiCredentialId),
    /already exists/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          'UPDATE gateway_provider_credentials SET account_identity_json = ?, oauth_secret_revision = 1 WHERE id = ?',
        )
        .run('{"accountId":"other"}', oauthCredentialId),
    /immutable/,
  );
  database
    .prepare(
      `UPDATE gateway_provider_credentials
       SET oauth_access = ?, oauth_refresh = ?, oauth_expires = ?,
           oauth_secret_revision = oauth_secret_revision + 1, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      Buffer.from('synthetic-access-2'),
      Buffer.from('synthetic-refresh-2'),
      200,
      20,
      oauthCredentialId,
    );
  assert.equal(
    (
      database
        .prepare(
          'SELECT oauth_secret_revision AS revision FROM gateway_provider_credentials WHERE id = ?',
        )
        .get(oauthCredentialId) as { revision: number }
    ).revision,
    1,
  );
  assert.equal(
    (
      database
        .prepare(
          'SELECT revision FROM gateway_provider_catalog WHERE singleton_id = 1',
        )
        .get() as { revision: number }
    ).revision,
    0,
  );

  const generation = `egt1.${'A'.repeat(22)}`;
  const inserted = database
    .prepare(
      `INSERT INTO gateway_provider_targets (
        target_generation, model_ref, provider_id, provider_type,
        credential_id, account_ref, account_identity_json, base_url,
        upstream_model, allowed_routes_json, wire_grammar_json, context_size,
        reasoning_effort, reasoning_summary, reasoning_context, tool_tier,
        external_thinking, tool_contract_version, call_timeout_ms,
        stream_idle_timeout_ms, snapshot_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      generation,
      'provider/model',
      'provider',
      'openai-compatible',
      apiCredentialId,
      'default',
      '{}',
      'https://provider.example/v1',
      'model-v1',
      '["responses"]',
      '{"responses":"responses-v1"}',
      1000,
      null,
      null,
      null,
      'strong',
      0,
      'v1',
      1000,
      1000,
      Buffer.alloc(32, 1),
      30,
    );
  const targetSeq = Number(inserted.lastInsertRowid);
  assert.throws(
    () =>
      database
        .prepare(
          'UPDATE gateway_provider_targets SET upstream_model = ? WHERE target_seq = ?',
        )
        .run('changed', targetSeq),
    /immutable/,
  );
  assert.throws(
    () =>
      database
        .prepare('DELETE FROM gateway_provider_targets WHERE target_seq = ?')
        .run(targetSeq),
    /retained/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          'INSERT OR REPLACE INTO gateway_provider_targets SELECT * FROM gateway_provider_targets WHERE target_seq = ?',
        )
        .run(targetSeq),
    /already exists/,
  );
  assert.throws(
    () =>
      database.exec(
        `INSERT OR REPLACE INTO gateway_provider_catalog
         (singleton_id, revision, updated_at)
         SELECT singleton_id, revision, updated_at FROM gateway_provider_catalog`,
      ),
    /already exists/,
  );
  database.close();
});

test('provider heads and grants advance monotonically and never carry authority forward', () => {
  const database = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
  });
  runGatewayMigrations(database, GATEWAY_MIGRATIONS, () => 10);
  database
    .prepare(
      'INSERT INTO gateway_instances (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    )
    .run('instance-a', 'Aster', 10, 10);
  const credentialId = `epc1.${'C'.repeat(22)}`;
  database
    .prepare(
      `INSERT INTO gateway_provider_credentials (
        id, provider_id, provider_type, account_ref, account_identity_json,
        auth_kind, api_key, oauth_access, oauth_refresh, oauth_expires,
        oauth_secret_revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      credentialId,
      'provider',
      'openai-compatible',
      'default',
      '{}',
      'api-key',
      Buffer.from('synthetic-api-key'),
      null,
      null,
      null,
      0,
      10,
      10,
    );
  const insertTarget = database.prepare(
    `INSERT INTO gateway_provider_targets (
      target_generation, model_ref, provider_id, provider_type,
      credential_id, account_ref, account_identity_json, base_url,
      upstream_model, allowed_routes_json, wire_grammar_json, context_size,
      reasoning_effort, reasoning_summary, reasoning_context, tool_tier,
      external_thinking, tool_contract_version, call_timeout_ms,
      stream_idle_timeout_ms, snapshot_sha256, created_at
    ) VALUES (?, 'provider/model', 'provider', 'openai-compatible', ?,
      'default', '{}', 'https://provider.example/v1', ?, '["responses"]',
      '{"responses":"responses-v1"}', 1000, NULL, NULL, NULL, 'strong', 0,
      'v1', 1000, 1000, ?, ?)`,
  );
  const generation1 = `egt1.${'C'.repeat(22)}`;
  const generation2 = `egt1.${'D'.repeat(22)}`;
  const target1 = Number(
    insertTarget.run(
      generation1,
      credentialId,
      'model-v1',
      Buffer.alloc(32, 1),
      20,
    ).lastInsertRowid,
  );
  const target2 = Number(
    insertTarget.run(
      generation2,
      credentialId,
      'model-v2',
      Buffer.alloc(32, 2),
      30,
    ).lastInsertRowid,
  );
  database
    .prepare(
      `INSERT INTO gateway_provider_model_heads (
        model_ref, target_seq, target_generation, enabled, created_at, updated_at
      ) VALUES ('provider/model', ?, ?, 1, 20, 20)`,
    )
    .run(target1, generation1);
  database
    .prepare(
      `INSERT INTO gateway_instance_model_grants (
        instance_id, model_ref, target_seq, target_generation, authorized_at
      ) VALUES ('instance-a', 'provider/model', ?, ?, 20)`,
    )
    .run(target1, generation1);
  assert.equal(
    (
      database
        .prepare(
          'SELECT revision FROM gateway_provider_catalog WHERE singleton_id = 1',
        )
        .get() as { revision: number }
    ).revision,
    2,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO gateway_instance_model_grants (
            instance_id, model_ref, target_seq, target_generation, authorized_at
          ) VALUES ('instance-a', 'provider/model', ?, ?, 20)`,
        )
        .run(target2, generation2),
    /active head|UNIQUE/,
  );
  database
    .prepare(
      `UPDATE gateway_provider_model_heads
       SET target_seq = ?, target_generation = ?, updated_at = 30
       WHERE model_ref = 'provider/model'`,
    )
    .run(target2, generation2);
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM gateway_instance_model_grants WHERE model_ref = 'provider/model'",
        )
        .get() as { count: number }
    ).count,
    0,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT OR REPLACE INTO gateway_provider_model_heads (
            model_ref, target_seq, target_generation, enabled, created_at, updated_at
          ) VALUES ('provider/model', ?, ?, 1, 20, 31)`,
        )
        .run(target1, generation1),
    /already exists/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `UPDATE gateway_provider_model_heads
           SET target_seq = ?, target_generation = ?, updated_at = 40
           WHERE model_ref = 'provider/model'`,
        )
        .run(target1, generation1),
    /advance/,
  );
  database
    .prepare(
      `INSERT INTO gateway_instance_model_grants (
        instance_id, model_ref, target_seq, target_generation, authorized_at
      ) VALUES ('instance-a', 'provider/model', ?, ?, 35)`,
    )
    .run(target2, generation2);
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT OR REPLACE INTO gateway_instance_model_grants (
            instance_id, model_ref, target_seq, target_generation, authorized_at
          ) VALUES ('instance-a', 'provider/model', ?, ?, 36)`,
        )
        .run(target2, generation2),
    /already exists/,
  );
  database
    .prepare('UPDATE gateway_instances SET revoked_at = 40 WHERE id = ?')
    .run('instance-a');
  assert.equal(
    (
      database
        .prepare(
          "SELECT count(*) AS count FROM gateway_instance_model_grants WHERE instance_id = 'instance-a'",
        )
        .get() as { count: number }
    ).count,
    0,
  );
  assert.throws(
    () =>
      database
        .prepare('UPDATE gateway_instances SET revoked_at = NULL WHERE id = ?')
        .run('instance-a'),
    /revocation/,
  );
  database
    .prepare(
      "UPDATE gateway_provider_model_heads SET enabled = 0, updated_at = 40 WHERE model_ref = 'provider/model'",
    )
    .run();
  assert.throws(
    () =>
      database
        .prepare(
          "UPDATE gateway_provider_model_heads SET enabled = 1, updated_at = 50 WHERE model_ref = 'provider/model'",
        )
        .run(),
    /newer target/,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO gateway_instance_model_grants (
            instance_id, model_ref, target_seq, target_generation, authorized_at
          ) VALUES ('instance-a', 'provider/model', ?, ?, 50)`,
        )
        .run(target2, generation2),
    /active head|revoked/,
  );
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
});
