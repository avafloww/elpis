// Unit tests for src/db.ts — agent.db open + idempotent migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../src/store/db.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-db-'));
}

function tableNames(db: {
  prepare: (s: string) => { all: () => unknown[] };
}): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

test('openDatabase creates elpis.db with the expected tables', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  assert.ok(fs.existsSync(path.join(dir, 'elpis.db')), 'elpis.db file exists');
  const names = tableNames(db);
  assert.ok(names.includes('channels'), 'channels table');
  assert.ok(names.includes('feedback'), 'feedback table');
  assert.ok(names.includes('message_index'), 'message_index table');
  assert.ok(names.includes('scheduled_tasks'), 'scheduled_tasks table');
  assert.ok(names.includes('token_density'), 'token_density table');
  assert.ok(names.includes('oauth_credentials'), 'oauth_credentials table');
  assert.ok(
    names.includes('sandbox_executor_identity'),
    'sandbox_executor_identity table',
  );
  assert.ok(
    names.includes('persistent_sandboxes'),
    'persistent_sandboxes table',
  );
  assert.ok(
    !names.includes('sandbox_aliases'),
    'legacy sandbox_aliases table removed',
  );
  db.close();
});

test('runMigrations is idempotent and sets user_version', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const v1 = (
    db.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  assert.equal(v1, 37, 'user_version bumped to 37');
  // Re-running does not throw and leaves the current version unchanged.
  runMigrations(db);
  const v2 = (
    db.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  assert.equal(v2, 37);
  db.close();
});

test('reopening an existing agent.db is a no-op that preserves data', () => {
  const dir = tmpDir();
  const db1 = openDatabase(dir);
  db1
    .prepare(
      "INSERT INTO channels (id, name, updated_at) VALUES ('c1','general','2026-07-13T00:00:00Z')",
    )
    .run();
  db1.close();
  const db2 = openDatabase(dir);
  const row = db2.prepare("SELECT name FROM channels WHERE id='c1'").get() as
    { name: string } | undefined;
  assert.equal(row?.name, 'general');
  db2.close();
});

test('fresh v4 database creates fleet tables (idempotent)', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  assert.ok(tables.includes('fleet_sessions'));
  assert.ok(tables.includes('fleet_worktrees'));
  assert.ok(tables.includes('fleet_mailbox_messages'));
  assert.ok(tables.includes('worker_sessions'));
  assert.ok(tables.includes('worker_mailbox_messages'));
  assert.ok(tables.includes('worker_workspace_artifacts'));
  assert.ok(tables.includes('context_system_layer_projections'));
  assert.ok(tables.includes('context_system_layer_approvals'));
  runMigrations(db); // second run: no throw
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    37,
  );
  db.close();
});

test('true v3→v4 upgrade path preserves data and creates fleet tables', () => {
  const dir = tmpDir();
  // Create a genuine v3 database with all v1-v3 DDL
  const v3db = new DatabaseSync(path.join(dir, 'elpis.db'));

  // Create v0→v1 tables
  v3db.exec(`
    CREATE TABLE channels (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE feedback (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      verdict            TEXT NOT NULL,
      reacted_at         TEXT NOT NULL,
      emoji              TEXT NOT NULL,
      reactor_id         TEXT NOT NULL,
      reactor_name       TEXT,
      is_owner           INTEGER NOT NULL,
      discord_message_id TEXT NOT NULL,
      channel_id         TEXT NOT NULL,
      channel_name       TEXT,
      message_content    TEXT NOT NULL
    );
    CREATE TABLE message_index (
      discord_message_id TEXT PRIMARY KEY,
      channel_id         TEXT NOT NULL,
      transcript_file    TEXT NOT NULL,
      send_channel       TEXT NOT NULL,
      send_text          TEXT NOT NULL,
      source             TEXT NOT NULL,
      indexed_at         TEXT NOT NULL
    );
  `);

  // Create v1→v2 scheduled_tasks table
  v3db.exec(`
    CREATE TABLE scheduled_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      kind        TEXT NOT NULL,
      channel_id  TEXT,
      payload     TEXT NOT NULL,
      next_run_at INTEGER NOT NULL,
      interval_ms INTEGER,
      snooze_until INTEGER,
      done_at     INTEGER,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  // Add v2→v3 nagging columns
  v3db.exec(`
    ALTER TABLE scheduled_tasks ADD COLUMN nag_interval_ms INTEGER;
    ALTER TABLE scheduled_tasks ADD COLUMN parent_id INTEGER;
    ALTER TABLE scheduled_tasks ADD COLUMN nag_count INTEGER NOT NULL DEFAULT 0;
  `);

  // Insert test data
  const now = new Date().toISOString();
  v3db
    .prepare('INSERT INTO channels (id, name, updated_at) VALUES (?, ?, ?)')
    .run('ch-123', 'general', now);
  v3db
    .prepare(
      'INSERT INTO scheduled_tasks (name, kind, payload, next_run_at, interval_ms) VALUES (?, ?, ?, ?, ?)',
    )
    .run('reminder-x', 'reminder', '{"msg":"test"}', 1000000, 60000);

  // Set v3 schema version and close
  v3db.exec('PRAGMA user_version = 3');
  v3db.close();

  // Reopen via production path
  const upgradedDb = openDatabase(dir);

  // Assert schema version upgraded to the current level
  const finalVersion = (
    upgradedDb.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  assert.equal(finalVersion, 37, 'user_version upgraded to 37');

  // Assert fleet tables exist
  const tableNames = (
    upgradedDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(
    tableNames.includes('fleet_sessions'),
    'fleet_sessions table created',
  );
  assert.ok(
    tableNames.includes('fleet_worktrees'),
    'fleet_worktrees table created',
  );

  // Assert pre-existing data survived
  const channelRow = upgradedDb
    .prepare("SELECT name FROM channels WHERE id='ch-123'")
    .get() as { name: string } | undefined;
  assert.equal(channelRow?.name, 'general', 'channels data preserved');

  const taskRow = upgradedDb
    .prepare(
      "SELECT kind, payload FROM scheduled_tasks WHERE name='reminder-x'",
    )
    .get() as { kind: string; payload: string } | undefined;
  assert.equal(taskRow?.kind, 'reminder', 'scheduled_tasks kind preserved');
  assert.equal(
    taskRow?.payload,
    '{"msg":"test"}',
    'scheduled_tasks payload preserved',
  );

  upgradedDb.close();
});

test('system layer approvals require exact scoped lineage and remain immutable', () => {
  const db = openDatabase(tmpDir());
  const insertLayer = db.prepare(`
    INSERT INTO context_system_layer_projections(
      layer_id, layer_kind, visibility, world_id, renderer_generation,
      policy_generation, source_kind, source_hash, content_text,
      content_hash, content_bytes, created_at
    ) VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, 100)
  `);
  const insert = (
    id: string,
    kind: string,
    visibility: string,
    worldId: string | null,
    sourceKind: string,
    hash: string,
  ) => {
    const content = `content:${id}`;
    insertLayer.run(
      id,
      kind,
      visibility,
      worldId,
      sourceKind,
      hash,
      content,
      hash,
      Buffer.byteLength(content),
    );
  };
  const contractHash = 'a'.repeat(64);
  const identityHash = 'b'.repeat(64);
  const policyHash = 'c'.repeat(64);
  const candidateHash = 'd'.repeat(64);
  const legacyHash = 'e'.repeat(64);
  insert(
    'layer:contract',
    'runtime_contract',
    'global_contract',
    null,
    'scoped_contract',
    contractHash,
  );
  insert(
    'layer:identity',
    'identity',
    'integrated_self',
    null,
    'soul',
    identityHash,
  );
  insert(
    'layer:policy',
    'world_policy',
    'world',
    'world:test-a',
    'routing',
    policyHash,
  );
  insert(
    'layer:candidate',
    'identity',
    'integrated_self_candidate',
    null,
    'soul',
    candidateHash,
  );
  insert(
    'layer:legacy',
    'runtime_contract',
    'legacy_mixed',
    null,
    'legacy_prompt',
    legacyHash,
  );

  const approve = db.prepare(`
    INSERT INTO context_system_layer_approvals(
      approval_id, layer_id, approval_role, basis_kind, basis_ref,
      basis_hash, approval_generation, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, 200)
  `);
  approve.run(
    'approval:contract',
    'layer:contract',
    'scoped_runtime_contract',
    'authored_scoped_contract',
    'fixture:contract',
    contractHash,
  );
  approve.run(
    'approval:identity',
    'layer:identity',
    'identity',
    'soul_snapshot',
    'fixture:soul',
    identityHash,
  );
  approve.run(
    'approval:policy',
    'layer:policy',
    'world_policy',
    'routing_policy',
    'fixture:routing',
    policyHash,
  );

  assert.throws(() =>
    approve.run(
      'approval:candidate',
      'layer:candidate',
      'identity',
      'soul_snapshot',
      'fixture:candidate',
      candidateHash,
    ),
  );
  assert.throws(() =>
    approve.run(
      'approval:legacy',
      'layer:legacy',
      'scoped_runtime_contract',
      'authored_scoped_contract',
      'fixture:legacy',
      legacyHash,
    ),
  );
  assert.throws(() =>
    approve.run(
      'approval:wrong-role',
      'layer:identity',
      'integrated_self',
      'accepted_self_delta',
      'fixture:wrong-role',
      identityHash,
    ),
  );
  assert.throws(() =>
    approve.run(
      'approval:wrong-hash',
      'layer:policy',
      'world_policy',
      'routing_policy',
      'fixture:wrong-hash',
      'f'.repeat(64),
    ),
  );
  const replaceApproval = db.prepare(`
    INSERT OR REPLACE INTO context_system_layer_approvals(
      approval_id, layer_id, approval_role, basis_kind, basis_ref,
      basis_hash, approval_generation, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `);
  assert.throws(() =>
    replaceApproval.run(
      'approval:identity',
      'layer:identity',
      'identity',
      'soul_snapshot',
      'fixture:changed',
      identityHash,
      300,
    ),
  );
  assert.throws(() =>
    replaceApproval.run(
      'approval:identity-alias',
      'layer:identity',
      'identity',
      'soul_snapshot',
      'fixture:alias',
      identityHash,
      300,
    ),
  );
  assert.deepEqual(
    {
      ...(db
        .prepare(
          "SELECT approval_id, basis_ref, approved_at FROM context_system_layer_approvals WHERE layer_id = 'layer:identity'",
        )
        .get() as Record<string, unknown>),
    },
    {
      approval_id: 'approval:identity',
      basis_ref: 'fixture:soul',
      approved_at: 200,
    },
  );
  assert.equal(
    (
      db.prepare('SELECT COUNT(*) AS count FROM context_system_layer_approvals')
        .get() as { count: number }
    ).count,
    3,
  );
  assert.throws(() =>
    db
      .prepare(
        "UPDATE context_system_layer_approvals SET basis_ref = 'changed' WHERE approval_id = 'approval:identity'",
      )
      .run(),
  );
  assert.throws(() =>
    db
      .prepare(
        "DELETE FROM context_system_layer_approvals WHERE approval_id = 'approval:identity'",
      )
      .run(),
  );
  db.close();
});
