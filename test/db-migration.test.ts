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

test('migration v4→v5: seeded v4 db gains channels.guild_id and channel_mutes', () => {
  const dir = tmpDir();
  // Seed a database that looks like live v4: channels table without guild_id.
  const seed = new DatabaseSync(path.join(dir, 'elpis.db'));
  seed.exec(
    `CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  );
  seed.exec(
    `INSERT INTO channels VALUES ('100', 'general', '2026-01-01T00:00:00Z');`,
  );
  seed.exec('PRAGMA user_version = 4');
  seed.close();

  const db = openDatabase(dir);
  const cols = (
    db.prepare(`SELECT name FROM pragma_table_info('channels')`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  assert.ok(cols.includes('guild_id'));
  // existing row survives, guild_id NULL
  const row = db
    .prepare('SELECT id, name, guild_id FROM channels WHERE id = ?')
    .get('100') as { id: string; guild_id: string | null };
  assert.equal(row.guild_id, null);
  // channel_mutes exists and is writable
  db.prepare(
    `INSERT INTO channel_mutes (channel_id, type, set_by, reason, created_at) VALUES (?, 'mute', 'self', NULL, ?)`,
  ).run('100', new Date().toISOString());
  const v = (
    db.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  assert.ok(v >= 5);
  db.close();
});

test('migration v5→v6: seeded v5 db gains channels.parent_id, existing rows survive', () => {
  const dir = tmpDir();
  // Seed a database that looks like live v5: channels has guild_id but no parent_id.
  const seed = new DatabaseSync(path.join(dir, 'elpis.db'));
  seed.exec(
    `CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, guild_id TEXT);`,
  );
  seed.exec(
    `INSERT INTO channels (id, name, updated_at, guild_id) VALUES ('100', 'general', '2026-01-01T00:00:00Z', 'g1');`,
  );
  seed.exec('PRAGMA user_version = 5');
  seed.close();

  const db = openDatabase(dir);
  const cols = (
    db.prepare(`SELECT name FROM pragma_table_info('channels')`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  assert.ok(cols.includes('parent_id'));
  const row = db
    .prepare('SELECT name, guild_id, parent_id FROM channels WHERE id = ?')
    .get('100') as {
    name: string;
    guild_id: string | null;
    parent_id: string | null;
  };
  assert.equal(row.name, 'general');
  assert.equal(row.guild_id, 'g1');
  assert.equal(
    row.parent_id,
    null,
    'a pre-v6 row has no recorded parent until its channel is seen again',
  );
  const v = (
    db.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  assert.ok(v >= 6);
  db.close();
});

test('migration v6→v7: seeded v6 db gains token_density, existing rows survive', () => {
  const dir = tmpDir();
  const seed = new DatabaseSync(path.join(dir, 'elpis.db'));
  seed.exec(
    `CREATE TABLE channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL, guild_id TEXT, parent_id TEXT);`,
  );
  seed.exec(
    `INSERT INTO channels (id, name, updated_at) VALUES ('100', 'general', '2026-01-01T00:00:00Z');`,
  );
  seed.exec('PRAGMA user_version = 6');
  seed.close();

  const db = openDatabase(dir);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  assert.ok(tables.includes('token_density'), 'token_density table created');
  // channels row survives
  const row = db
    .prepare('SELECT name FROM channels WHERE id = ?')
    .get('100') as { name: string };
  assert.equal(row.name, 'general');
  // token_density is writable and round-trips
  db.prepare(
    `INSERT INTO token_density (model, ratio, samples, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('kimi-k3', 3.57, 42, new Date().toISOString());
  const d = db
    .prepare('SELECT ratio, samples FROM token_density WHERE model = ?')
    .get('kimi-k3') as { ratio: number; samples: number };
  assert.equal(d.ratio, 3.57);
  assert.equal(d.samples, 42);
  const v = (
    db.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  assert.ok(v >= 7);
  db.close();
});

test('migration through v22 preserves fleet history and creates native worker state', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  assert.ok(tables.includes('sandbox_executor_identity'));
  assert.ok(tables.includes('persistent_sandboxes'));
  assert.ok(!tables.includes('sandbox_aliases'));
  assert.ok(tables.includes('mind_id_migration_map'));
  assert.ok(tables.includes('fleet_mailbox_messages'));
  assert.ok(tables.includes('worker_sessions'));
  assert.ok(tables.includes('worker_mailbox_messages'));
  const triggers = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
  assert.ok(triggers.includes('sandbox_executor_identity_no_update'));
  assert.ok(!triggers.includes('persistent_sandboxes_identity_no_update'));
  const sandboxFk = db
    .prepare(
      "SELECT [table] AS target FROM pragma_foreign_key_list('persistent_sandboxes') WHERE [from] = 'id'",
    )
    .get() as { target: string };
  assert.equal(sandboxFk.target, 'mind_items');
  assert.ok(!triggers.includes('sandbox_aliases_no_delete'));
  const columns = (
    db
      .prepare("SELECT name FROM pragma_table_info('persistent_sandboxes')")
      .all() as { name: string }[]
  ).map((row) => row.name);
  assert.ok(columns.includes('cold_notice_pending'));
  assert.ok(columns.includes('retire_requested_at'));
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    24,
  );
  assert.deepEqual(
    (
      db
        .prepare(
          "SELECT component, name FROM elpis_migrations WHERE component = 'core'",
        )
        .all() as { component: string; name: string }[]
    ).map(({ component, name }) => ({ component, name })),
    [
      { component: 'core', name: '0013-legacy-through-v13' },
      { component: 'core', name: '0015-sandbox-retirement-deadline' },
      { component: 'core', name: '0016-mind-elm-identities' },
      { component: 'core', name: '0017-fleet-actor-sessions' },
      { component: 'core', name: '0018-fleet-actor-mailbox' },
      { component: 'core', name: '0019-native-workers' },
      { component: 'core', name: '0020-mind-proposal-status' },
      { component: 'core', name: '0021-worker-workspace-custody' },
      { component: 'core', name: '0022-secretary-sessions' },
      { component: 'core', name: '0023-secretary-conversation-turns' },
      { component: 'core', name: '0024-global-secretary-authority' },
    ],
  );
  db.close();
});

test('migration v12→v15 adds cold notices and backfills retirement deadlines', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE mind_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 2,
      parent_id INTEGER,
      due_at INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      archived_at INTEGER
    );
    INSERT INTO mind_items (id, title, body, kind, status, priority, created_by, created_at, updated_at)
    VALUES (1, 'work', '', 'task', 'open', 2, 'test', 100, 100);
    CREATE TABLE persistent_sandboxes (
      id TEXT PRIMARY KEY,
      mind_id INTEGER NOT NULL UNIQUE,
      executor_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      lifecycle TEXT NOT NULL,
      reminder_latched INTEGER NOT NULL DEFAULT 0,
      retire_requested INTEGER NOT NULL DEFAULT 0,
      active_run_id TEXT,
      next_run_seq INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      retired_at INTEGER
    );
    INSERT INTO persistent_sandboxes
      (id, mind_id, executor_id, generation, lifecycle, reminder_latched, retire_requested, active_run_id, next_run_seq, created_at, updated_at, retired_at)
    VALUES ('s1', 1, 'e1', 1, 'ready', 0, 1, NULL, 1, 100, 1234, NULL);
    PRAGMA user_version = 12;
  `);
  runMigrations(db);
  const columns = (
    db
      .prepare("SELECT name FROM pragma_table_info('persistent_sandboxes')")
      .all() as { name: string }[]
  ).map((row) => row.name);
  assert.ok(columns.includes('cold_notice_pending'));
  assert.ok(columns.includes('retire_requested_at'));
  const migratedSandbox = db
    .prepare('SELECT id, retire_requested_at FROM persistent_sandboxes')
    .get() as { id: string; retire_requested_at: number };
  assert.match(migratedSandbox.id, /^elm-[0-9a-z]{8}$/);
  assert.equal(migratedSandbox.retire_requested_at, 1234);
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    24,
  );
  assert.deepEqual(
    (
      db
        .prepare(
          "SELECT name FROM elpis_migrations WHERE component = 'core' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name),
    [
      '0013-legacy-through-v13',
      '0015-sandbox-retirement-deadline',
      '0016-mind-elm-identities',
      '0017-fleet-actor-sessions',
      '0018-fleet-actor-mailbox',
      '0019-native-workers',
      '0020-mind-proposal-status',
      '0021-worker-workspace-custody',
      '0022-secretary-sessions',
      '0023-secretary-conversation-turns',
      '0024-global-secretary-authority',
    ],
  );
  runMigrations(db);
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM pragma_table_info('persistent_sandboxes') WHERE name = 'cold_notice_pending'",
        )
        .get() as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM pragma_table_info('persistent_sandboxes') WHERE name = 'retire_requested_at'",
        )
        .get() as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM elpis_migrations WHERE component = 'core'",
        )
        .get() as { n: number }
    ).n,
    11,
  );
  db.close();
});

test('migration v16→v23 preserves legacy fleet sessions and creates empty worker state', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  db.prepare(
    `INSERT INTO fleet_sessions (
    id, name, cwd, status, model, effort, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('fleet-legacy', 'legacy', '/tmp', 'idle', 'opus', 'high', 1, 1);
  db.close();

  const reopened = openDatabase(dir);
  const row = reopened
    .prepare(
      'SELECT model, model_ref, mind_id, runtime, control_token_digest FROM fleet_sessions WHERE id = ?',
    )
    .get('fleet-legacy') as {
    model: string;
    model_ref: string | null;
    mind_id: string | null;
    runtime: string;
    control_token_digest: string | null;
  };
  assert.deepEqual(
    { ...row },
    {
      model: 'opus',
      model_ref: null,
      mind_id: null,
      runtime: 'claude-sdk',
      control_token_digest: null,
    },
  );
  const version = (
    reopened.prepare('PRAGMA user_version').get() as { user_version: number }
  ).user_version;
  assert.equal(version, 24);
  assert.equal(
    (
      reopened
        .prepare('SELECT COUNT(*) AS n FROM fleet_mailbox_messages')
        .get() as { n: number }
    ).n,
    0,
  );
  assert.throws(
    () =>
      reopened
        .prepare('UPDATE fleet_sessions SET mind_id = ? WHERE id = ?')
        .run('elm-missing0', 'fleet-legacy'),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () =>
      reopened
        .prepare('UPDATE fleet_sessions SET runtime = ? WHERE id = ?')
        .run('host', 'fleet-legacy'),
    /CHECK constraint failed/,
  );
  reopened.close();
});
