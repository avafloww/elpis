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

test('current migration prefix preserves fleet history and creates resident state', () => {
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
    42,
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
      { component: 'core', name: '0025-gateway-resident-state' },
      {
        component: 'core',
        name: '0026-gateway-rotation-proposal-checkpoint',
      },
      { component: 'core', name: '0027-discord-person-settings' },
      { component: 'core', name: '0028-worker-completion-delivery' },
      { component: 'core', name: '0029-context-graph-dark-store' },
      { component: 'core', name: '0030-context-root-coordinator' },
      { component: 'core', name: '0031-context-shadow-projections' },
      { component: 'core', name: '0032-context-event-message-projections' },
      { component: 'core', name: '0033-context-system-layer-projections' },
      { component: 'core', name: '0034-context-local-branch-request-views' },
      { component: 'core', name: '0035-context-dark-ingress-admissions' },
      { component: 'core', name: '0036-context-dark-pending-branch-attempts' },
      { component: 'core', name: '0037-context-system-layer-approvals' },
      { component: 'core', name: '0038-context-system-layer-approval-sources' },
      { component: 'core', name: '0039-context-system-profiles' },
      {
        component: 'core',
        name: '0040-context-system-profile-request-view-bindings',
      },
      {
        component: 'core',
        name: '0041-context-dark-pending-profile-binding',
      },
      {
        component: 'core',
        name: '0042-context-scoped-runtime-contract-artifact',
      },
    ],
  );
  db.close();
});

test('migration v27→current grandfathers delivery but leaves every legacy cleanup pending', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    DROP TRIGGER context_dark_pending_branch_effect_guard;
    DROP TRIGGER context_dark_pending_branch_capsule_guard;
    DROP TRIGGER context_dark_pending_branch_transition_guard;
    DROP TRIGGER context_dark_pending_branch_request_messages_sealed;
    DROP TRIGGER context_dark_pending_branch_system_layers_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_events_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_shares_sealed;
    DROP TABLE context_dark_pending_branch_abandonments;
    DROP TABLE context_dark_pending_branch_attempts;
    DROP TABLE context_dark_ingress_admissions;
    DROP TABLE context_dark_ingress_generations;
    DROP TRIGGER context_bound_request_view_system_layers_sealed;
    DROP TRIGGER context_bound_request_view_messages_sealed;
    DROP TRIGGER context_bound_request_view_manifest_events_sealed;
    DROP TRIGGER context_bound_request_view_manifest_shares_sealed;
    DROP TABLE context_system_profile_request_view_bindings;
    DROP TABLE context_local_branch_request_messages;
    DROP TABLE context_local_branch_request_system_layers;
    DROP TABLE context_local_branch_request_views;
    DROP TABLE context_system_profile_advances;
    DROP TABLE context_system_profiles;
    DROP TABLE context_system_layer_approvals;
    DROP TABLE context_system_layer_projections;

    DROP TABLE context_event_message_projections;
    DROP TABLE context_shadow_request_observations;
    DROP TABLE context_shadow_projection_plans;
    DROP TABLE context_branch_recoveries;
    DROP TABLE context_root_coordinator;
    DROP TABLE context_branch_starts;
    DROP INDEX context_branches_single_running_idx;
    DROP TABLE context_manifest_shares;
    DROP TABLE context_manifest_events;
    DROP TABLE context_capsule_edges;
    DROP TABLE context_legacy_import_receipts;
    DROP TABLE context_effects;
    DROP TABLE context_continuation_advances;
    DROP TABLE context_continuation_head;
    DROP TABLE context_graph_activation;
    DROP TABLE context_share_grants;
    DROP TABLE context_capsules;
    DROP TABLE context_manifests;
    DROP TABLE context_branches;
    DROP TABLE context_world_events;
    DROP INDEX worker_sessions_completion_pending_idx;
    DROP INDEX worker_sessions_cleanup_pending_idx;
    ALTER TABLE worker_sessions DROP COLUMN completion_notified_at;
    ALTER TABLE worker_sessions DROP COLUMN runtime_cleanup_completed_at;
    ALTER TABLE worker_sessions DROP COLUMN runtime_cleanup_error;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_identity_conflict;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_no_delete;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_no_update;
    DROP TABLE context_scoped_runtime_contract_artifacts;
    DROP TRIGGER elpis_migrations_no_delete;
    DELETE FROM elpis_migrations
      WHERE component = 'core'
        AND name IN ('0028-worker-completion-delivery', '0029-context-graph-dark-store', '0030-context-root-coordinator', '0031-context-shadow-projections', '0032-context-event-message-projections', '0033-context-system-layer-projections', '0034-context-local-branch-request-views', '0035-context-dark-ingress-admissions', '0036-context-dark-pending-branch-attempts', '0037-context-system-layer-approvals', '0038-context-system-layer-approval-sources', '0039-context-system-profiles', '0040-context-system-profile-request-view-bindings', '0041-context-dark-pending-profile-binding', '0042-context-scoped-runtime-contract-artifact');
    PRAGMA user_version = 27;
  `);
  const insert = db.prepare(
    `INSERT INTO worker_sessions
     (id,slug,status,model_ref,mind_id,runtime,control_token_digest,created_at,updated_at)
     VALUES (?,?,?,?,?,'kubernetes',?,?,?)`,
  );
  insert.run(
    'wrk-finished1',
    'finished-worker',
    'finished',
    'provider/model',
    'elm-finished1',
    '1'.repeat(64),
    100,
    200,
  );
  insert.run(
    'wrk-dismissed',
    'dismissed-worker',
    'dismissed',
    'provider/model',
    'elm-dismissed',
    '5'.repeat(64),
    100,
    205,
  );
  insert.run(
    'wrk-failed001',
    'failed-worker',
    'failed',
    'provider/model',
    'elm-failed001',
    '2'.repeat(64),
    100,
    210,
  );
  insert.run(
    'wrk-failedfin',
    'failed-finish-worker',
    'failed',
    'provider/model',
    'elm-failedfin',
    '4'.repeat(64),
    100,
    215,
  );
  db.prepare(
    `INSERT INTO worker_mailbox_messages
     (session_id,direction,kind,message_key,sender,body,created_at)
     VALUES (?,'worker_to_dispatcher','finish','finish-1',?,'durable report',205)`,
  ).run('wrk-failedfin', 'worker:failed-finish-worker');
  insert.run(
    'wrk-running01',
    'running-worker',
    'running',
    'provider/model',
    'elm-running01',
    '3'.repeat(64),
    100,
    220,
  );

  runMigrations(db);

  const rows = (
    db
      .prepare(
        `SELECT id, status, completion_notified_at, runtime_cleanup_completed_at,
                runtime_cleanup_error
         FROM worker_sessions ORDER BY id`,
      )
      .all() as {
      id: string;
      status: string;
      completion_notified_at: number | null;
      runtime_cleanup_completed_at: number | null;
      runtime_cleanup_error: string | null;
    }[]
  ).map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      id: 'wrk-dismissed',
      status: 'dismissed',
      completion_notified_at: null,
      runtime_cleanup_completed_at: null,
      runtime_cleanup_error: null,
    },
    {
      id: 'wrk-failed001',
      status: 'failed',
      completion_notified_at: 210,
      runtime_cleanup_completed_at: null,
      runtime_cleanup_error: null,
    },
    {
      id: 'wrk-failedfin',
      status: 'failed',
      completion_notified_at: null,
      runtime_cleanup_completed_at: null,
      runtime_cleanup_error: null,
    },
    {
      id: 'wrk-finished1',
      status: 'finished',
      completion_notified_at: 200,
      runtime_cleanup_completed_at: null,
      runtime_cleanup_error: null,
    },
    {
      id: 'wrk-running01',
      status: 'running',
      completion_notified_at: null,
      runtime_cleanup_completed_at: null,
      runtime_cleanup_error: null,
    },
  ]);
  runMigrations(db);
  assert.equal(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM pragma_table_info('worker_sessions')
           WHERE name IN ('completion_notified_at','runtime_cleanup_completed_at','runtime_cleanup_error')`,
        )
        .get() as { n: number }
    ).n,
    3,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
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
    42,
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
      '0025-gateway-resident-state',
      '0026-gateway-rotation-proposal-checkpoint',
      '0027-discord-person-settings',
      '0028-worker-completion-delivery',
      '0029-context-graph-dark-store',
      '0030-context-root-coordinator',
      '0031-context-shadow-projections',
      '0032-context-event-message-projections',
      '0033-context-system-layer-projections',
      '0034-context-local-branch-request-views',
      '0035-context-dark-ingress-admissions',
      '0036-context-dark-pending-branch-attempts',
      '0037-context-system-layer-approvals',
      '0038-context-system-layer-approval-sources',
      '0039-context-system-profiles',
      '0040-context-system-profile-request-view-bindings',
      '0041-context-dark-pending-profile-binding',
      '0042-context-scoped-runtime-contract-artifact',
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
    29,
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
  assert.equal(version, 42);
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

test('migration v29→v30 rejects an ambiguous pre-coordinator running branch', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  db.exec(`
    DROP TRIGGER context_branches_coordinated_return_guard;
    DROP TRIGGER context_continuation_head_advance_guard;
    DROP TRIGGER context_dark_pending_branch_effect_guard;
    DROP TRIGGER context_dark_pending_branch_capsule_guard;
    DROP TRIGGER context_dark_pending_branch_transition_guard;
    DROP TRIGGER context_dark_pending_branch_request_messages_sealed;
    DROP TRIGGER context_dark_pending_branch_system_layers_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_events_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_shares_sealed;
    DROP TABLE context_dark_pending_branch_abandonments;
    DROP TABLE context_dark_pending_branch_attempts;
    DROP TABLE context_dark_ingress_admissions;
    DROP TABLE context_dark_ingress_generations;
    DROP TRIGGER context_bound_request_view_system_layers_sealed;
    DROP TRIGGER context_bound_request_view_messages_sealed;
    DROP TRIGGER context_bound_request_view_manifest_events_sealed;
    DROP TRIGGER context_bound_request_view_manifest_shares_sealed;
    DROP TABLE context_system_profile_request_view_bindings;
    DROP TABLE context_local_branch_request_messages;
    DROP TABLE context_local_branch_request_system_layers;
    DROP TABLE context_local_branch_request_views;
    DROP TABLE context_system_profile_advances;
    DROP TABLE context_system_profiles;
    DROP TABLE context_system_layer_approvals;
    DROP TABLE context_system_layer_projections;

    DROP TABLE context_event_message_projections;
    DROP TABLE context_shadow_request_observations;
    DROP TABLE context_shadow_projection_plans;
    DROP TABLE context_branch_recoveries;
    DROP TABLE context_root_coordinator;
    DROP TABLE context_branch_starts;
    DROP INDEX context_branches_single_running_idx;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_identity_conflict;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_no_delete;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_no_update;
    DROP TABLE context_scoped_runtime_contract_artifacts;
    DROP TRIGGER elpis_migrations_no_delete;
    DELETE FROM elpis_migrations
      WHERE component = 'core' AND name IN ('0030-context-root-coordinator', '0031-context-shadow-projections', '0032-context-event-message-projections', '0033-context-system-layer-projections', '0034-context-local-branch-request-views', '0035-context-dark-ingress-admissions', '0036-context-dark-pending-branch-attempts', '0037-context-system-layer-approvals', '0038-context-system-layer-approval-sources', '0039-context-system-profiles', '0040-context-system-profile-request-view-bindings', '0041-context-dark-pending-profile-binding', '0042-context-scoped-runtime-contract-artifact');
    PRAGMA user_version = 29;
    INSERT INTO context_branches(
      branch_id, world_id, parent_branch_id, status, authority_epoch,
      started_at, ended_at
    ) VALUES ('branch:ambiguous', 'world:internal', NULL, 'running', 1, 10, NULL);
  `);

  assert.throws(
    () => runMigrations(db),
    /CHECK constraint failed: running_count = 0/,
  );
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    29,
  );
  assert.equal(
    (
      db
        .prepare(
          `SELECT count(*) AS n FROM elpis_migrations
           WHERE component = 'core' AND name = '0030-context-root-coordinator'`,
        )
        .get() as { n: number }
    ).n,
    0,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migration v37→v38 rejects contradictory approval source provenance', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const ledgerTriggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='elpis_migrations' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  for (const trigger of ledgerTriggers) {
    db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);
  }
  db.exec(`
    DROP TRIGGER context_system_layer_approvals_lineage_guard;
    CREATE TRIGGER context_system_layer_approvals_lineage_guard
      BEFORE INSERT ON context_system_layer_approvals BEGIN SELECT 1; END;
  `);
  db.prepare(
    `INSERT INTO context_system_layer_projections(
       layer_id, layer_kind, visibility, world_id, renderer_generation,
       policy_generation, source_kind, source_hash, content_text,
       content_hash, content_bytes, created_at
     ) VALUES (?, 'identity', 'integrated_self', NULL, 1, 1, ?, ?, ?, ?, ?, 1)`,
  ).run(
    'system-layer:wrong-source-upgrade',
    'synthetic_fixture',
    'a'.repeat(64),
    'content',
    'b'.repeat(64),
    7,
  );
  db.prepare(
    `INSERT INTO context_system_layer_approvals(
       approval_id, layer_id, approval_role, basis_kind, basis_ref,
       basis_hash, approval_generation, approved_at
     ) VALUES (?, ?, 'identity', 'soul_snapshot', ?, ?, 1, 2)`,
  ).run(
    'system-layer-approval:wrong-source-upgrade',
    'system-layer:wrong-source-upgrade',
    'fixture:wrong-source-upgrade',
    'a'.repeat(64),
  );
  db.exec(`
    DROP TRIGGER context_bound_request_view_system_layers_sealed;
    DROP TRIGGER context_bound_request_view_messages_sealed;
    DROP TRIGGER context_bound_request_view_manifest_events_sealed;
    DROP TRIGGER context_bound_request_view_manifest_shares_sealed;
    DROP TABLE context_system_profile_request_view_bindings;
    DROP TABLE context_system_profile_advances;
    DROP TABLE context_system_profiles;
    DELETE FROM elpis_migrations
      WHERE component = 'core'
        AND name IN (
          '0038-context-system-layer-approval-sources',
          '0039-context-system-profiles',
          '0040-context-system-profile-request-view-bindings',
          '0041-context-dark-pending-profile-binding',
          '0042-context-scoped-runtime-contract-artifact'
        );
    PRAGMA user_version = 37;
  `);
  for (const trigger of ledgerTriggers) db.exec(trigger.sql);

  assert.throws(
    () => runMigrations(db),
    /CHECK constraint failed: valid = 1/,
  );
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    37,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT count(*) AS n FROM elpis_migrations WHERE component='core' AND name='0038-context-system-layer-approval-sources'",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migration v38→v39 rejects approvals that predate their layers', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const ledgerTriggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='elpis_migrations' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  for (const trigger of ledgerTriggers) {
    db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);
  }
  db.exec(`
    DROP TRIGGER context_bound_request_view_system_layers_sealed;
    DROP TRIGGER context_bound_request_view_messages_sealed;
    DROP TRIGGER context_bound_request_view_manifest_events_sealed;
    DROP TRIGGER context_bound_request_view_manifest_shares_sealed;
    DROP TABLE context_system_profile_request_view_bindings;
    DROP TABLE context_system_profile_advances;
    DROP TABLE context_system_profiles;
    DROP TRIGGER context_system_layer_approvals_chronology_guard;
  `);
  db.prepare(
    `INSERT INTO context_system_layer_projections(
       layer_id, layer_kind, visibility, world_id, renderer_generation,
       policy_generation, source_kind, source_hash, content_text,
       content_hash, content_bytes, created_at
     ) VALUES (?, 'identity', 'integrated_self', NULL, 1, 1,
       'soul_snapshot', ?, 'content', ?, 7, 100)`,
  ).run(
    'system-layer:backdated-approval-upgrade',
    'a'.repeat(64),
    'b'.repeat(64),
  );
  db.prepare(
    `INSERT INTO context_system_layer_approvals(
       approval_id, layer_id, approval_role, basis_kind, basis_ref,
       basis_hash, approval_generation, approved_at
     ) VALUES (?, ?, 'identity', 'soul_snapshot', ?, ?, 1, 1)`,
  ).run(
    'system-layer-approval:backdated-upgrade',
    'system-layer:backdated-approval-upgrade',
    'fixture:backdated-upgrade',
    'a'.repeat(64),
  );
  db.exec(`
    DELETE FROM elpis_migrations
      WHERE component = 'core' AND name IN ('0039-context-system-profiles', '0040-context-system-profile-request-view-bindings', '0041-context-dark-pending-profile-binding', '0042-context-scoped-runtime-contract-artifact');
    PRAGMA user_version = 38;
  `);
  for (const trigger of ledgerTriggers) db.exec(trigger.sql);

  assert.throws(
    () => runMigrations(db),
    /CHECK constraint failed: valid = 1/,
  );
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    38,
  );
  assert.equal(
    (
      db.prepare(
        "SELECT count(*) AS n FROM elpis_migrations WHERE component='core' AND name='0039-context-system-profiles'",
      ).get() as { n: number }
    ).n,
    0,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('migration v34→v35 establishes an immutable no-backfill ingress watermark', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  db.prepare(
    `INSERT INTO context_world_events(
       event_id, world_id, event_kind, payload_json, payload_hash,
       occurred_at, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'event:before-dark-ingress-generation',
    'world:signal:before-generation',
    'inbound:signal',
    '{}',
    '0'.repeat(64),
    1,
    1,
  );
  const ledgerTriggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='elpis_migrations' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  for (const trigger of ledgerTriggers) {
    db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);
  }
  db.exec(`
    DROP TRIGGER context_dark_pending_branch_effect_guard;
    DROP TRIGGER context_dark_pending_branch_capsule_guard;
    DROP TRIGGER context_dark_pending_branch_transition_guard;
    DROP TRIGGER context_dark_pending_branch_request_messages_sealed;
    DROP TRIGGER context_dark_pending_branch_system_layers_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_events_sealed;
    DROP TRIGGER context_dark_pending_branch_manifest_shares_sealed;
    DROP TABLE context_dark_pending_branch_abandonments;
    DROP TABLE context_dark_pending_branch_attempts;
    DROP TABLE context_dark_ingress_admissions;
    DROP TABLE context_dark_ingress_generations;
    DROP TRIGGER context_bound_request_view_system_layers_sealed;
    DROP TRIGGER context_bound_request_view_messages_sealed;
    DROP TRIGGER context_bound_request_view_manifest_events_sealed;
    DROP TRIGGER context_bound_request_view_manifest_shares_sealed;
    DROP TABLE context_system_profile_request_view_bindings;
    DROP TABLE context_system_profile_advances;
    DROP TABLE context_system_profiles;
    DROP TABLE context_system_layer_approvals;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_identity_conflict;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_no_delete;
    DROP TRIGGER context_scoped_runtime_contract_artifacts_no_update;
    DROP TABLE context_scoped_runtime_contract_artifacts;
    DELETE FROM elpis_migrations
      WHERE component = 'core' AND name IN ('0035-context-dark-ingress-admissions', '0036-context-dark-pending-branch-attempts', '0037-context-system-layer-approvals', '0038-context-system-layer-approval-sources', '0039-context-system-profiles', '0040-context-system-profile-request-view-bindings', '0041-context-dark-pending-profile-binding', '0042-context-scoped-runtime-contract-artifact');
    PRAGMA user_version = 34;
  `);
  for (const trigger of ledgerTriggers) db.exec(trigger.sql);

  runMigrations(db);
  assert.deepEqual(
    {
      ...(db
        .prepare(
          `SELECT queue_generation, first_admissible_sequence, activation_epoch
           FROM context_dark_ingress_generations`,
        )
        .get() as Record<string, number>),
    },
    {
      queue_generation: 1,
      first_admissible_sequence: 2,
      activation_epoch: 0,
    },
  );
  const insertAdmission = db.prepare(
    `INSERT INTO context_dark_ingress_admissions(
       event_id, world_id, source_sequence, activation_epoch,
       queue_generation, wake_class, message_renderer_generation,
       admitted_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  assert.throws(
    () =>
      insertAdmission.run(
        'event:before-dark-ingress-generation',
        'world:signal:before-generation',
        1,
        0,
        1,
        'text_user_turn',
        1,
        1,
      ),
    /context dark ingress admission lineage is invalid/,
  );
  db.prepare(
    `INSERT INTO context_world_events(
       event_id, world_id, event_kind, payload_json, payload_hash,
       occurred_at, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'event:after-dark-ingress-generation',
    'world:signal:after-generation',
    'inbound:signal',
    '{}',
    '1'.repeat(64),
    2,
    2,
  );
  insertAdmission.run(
    'event:after-dark-ingress-generation',
    'world:signal:after-generation',
    2,
    0,
    1,
    'text_user_turn',
    1,
    2,
  );
  assert.equal(
    (
      db
        .prepare('SELECT count(*) AS n FROM context_dark_ingress_admissions')
        .get() as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    42,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
