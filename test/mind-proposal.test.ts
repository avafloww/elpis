import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { formatMindFrontier } from '../src/agent.js';
import { createSandboxRegistry } from '../src/sandbox/registry.js';
import { snapshotWakeAdvisorState } from '../src/sandbox/wake-advisor.js';
import { runMigrations } from '../src/store/db.js';
import {
  MIND_PROPOSAL_STATUS_MIGRATION_CHECKSUM,
  migrateMindProposalStatus,
} from '../src/store/mind-proposal-migration.js';
import { MindService, MindStore } from '../src/store/mind.js';
import { noopLogger } from '../src/lib/log.js';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  return db;
}

function proposal(mind: MindStore, title = 'candidate') {
  return mind.create({ title, kind: 'task', status: 'proposal' });
}

test('0020 migration preserves the complete foreign-key closure and adds proposal guards', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE mind_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('task','project','idea','question','reminder')),
      status TEXT NOT NULL CHECK (status IN ('inbox','open','in_progress','waiting','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
      parent_id TEXT REFERENCES mind_items(id) ON DELETE SET NULL,
      due_at INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      archived_at INTEGER
    );
    CREATE INDEX mind_items_status_idx ON mind_items(status, priority);
    CREATE TABLE mind_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE mind_dependencies (
      item_id TEXT NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      depends_on_id TEXT NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (item_id, depends_on_id)
    );
    CREATE TABLE mind_reminders (
      id INTEGER PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES mind_items(id),
      scheduled_task_id INTEGER,
      fire_at INTEGER
    );
    CREATE TABLE mind_claims (
      item_id TEXT PRIMARY KEY REFERENCES mind_items(id),
      owner TEXT
    );
    CREATE TABLE worker_sessions (
      id TEXT PRIMARY KEY,
      mind_id TEXT NOT NULL REFERENCES mind_items(id)
    );
    CREATE TABLE worker_mailbox_messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
      body TEXT NOT NULL
    );
    CREATE TABLE persistent_sandboxes (
      id TEXT PRIMARY KEY REFERENCES mind_items(id),
      marker TEXT
    );
    INSERT INTO mind_items VALUES
      ('elm-00000001','kept','root body','task','open',3,NULL,123,'resident',10,20,NULL,NULL),
      ('elm-00000002','also kept','child body','task','waiting',2,'elm-00000001',NULL,'resident',11,21,NULL,NULL);
    INSERT INTO mind_events VALUES
      (7,'elm-00000001','item.created','resident','{"status":"open"}',10),
      (8,'elm-00000002','item.updated','resident','{"status":"waiting"}',21);
    INSERT INTO mind_dependencies VALUES ('elm-00000002','elm-00000001','resident',22);
    INSERT INTO mind_reminders VALUES (4,'elm-00000001',9,999);
    INSERT INTO mind_claims VALUES ('elm-00000002','worker:test');
    INSERT INTO worker_sessions VALUES ('wrk-test','elm-00000002');
    INSERT INTO worker_mailbox_messages VALUES (5,'wrk-test','kept mailbox');
    INSERT INTO persistent_sandboxes VALUES ('elm-00000001','kept sandbox');
  `);
  const snapshots = new Map(
    [
      'mind_items',
      'mind_events',
      'mind_dependencies',
      'mind_reminders',
      'mind_claims',
      'worker_sessions',
      'worker_mailbox_messages',
      'persistent_sandboxes',
    ].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ]),
  );

  db.exec('BEGIN IMMEDIATE');
  migrateMindProposalStatus(db);
  db.exec('COMMIT');

  for (const [table, before] of snapshots)
    assert.deepEqual(
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      before,
      table,
    );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.match(
    String(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'mind_items'",
          )
          .get() as { sql: string }
      ).sql,
    ),
    /'proposal'/,
  );
  assert.ok(
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = 'mind_items_status_idx'",
      )
      .get(),
  );

  db.prepare(
    "INSERT INTO mind_items VALUES ('elm-00000003','proposal','','task','proposal',2,NULL,NULL,'secretary',30,30,NULL,NULL)",
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO mind_dependencies VALUES ('elm-00000003','elm-00000001','test',31)",
        )
        .run(),
    /cannot have readiness dependencies/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE mind_items SET status = 'proposal' WHERE id = 'elm-00000002'",
        )
        .run(),
    /invalid proposal status transition/,
  );
  assert.throws(
    () =>
      db
        .prepare("UPDATE mind_items SET due_at = 50 WHERE id = 'elm-00000003'")
        .run(),
    /cannot have a due date/,
  );
  db.close();
});

test('proposal code migration checksum is source-bound and ledger receipts are immutable', () => {
  const source = readFileSync(
    new URL('../src/store/mind-proposal-migration.ts', import.meta.url),
    'utf8',
  );
  const normalized = source.replace(
    /MIND_PROPOSAL_STATUS_MIGRATION_CHECKSUM =\n  "[0-9a-f]{64}"/,
    `MIND_PROPOSAL_STATUS_MIGRATION_CHECKSUM =\n  "${'0'.repeat(64)}"`,
  );
  assert.equal(
    createHash('sha256').update(normalized).digest('hex'),
    MIND_PROPOSAL_STATUS_MIGRATION_CHECKSUM,
  );

  const db = database();
  const receipt = db
    .prepare(
      "SELECT checksum FROM elpis_migrations WHERE component = 'core' AND name = '0020-mind-proposal-status'",
    )
    .get() as { checksum: string };
  assert.equal(receipt.checksum, MIND_PROPOSAL_STATUS_MIGRATION_CHECKSUM);
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE elpis_migrations SET checksum = ? WHERE component = 'core' AND name = '0020-mind-proposal-status'",
        )
        .run('a'.repeat(64)),
    /immutable/,
  );
  db.close();
});

test('proposals are filterable but excluded from ready frontier and autowake state', () => {
  const db = database();
  const mind = new MindStore(db);
  const candidate = proposal(mind, 'never auto-act candidate');
  const active = mind.create({
    title: 'committed work',
    kind: 'task',
    status: 'open',
  });
  assert.deepEqual(
    mind.list({ statuses: ['proposal'] }).map((item) => item.id),
    [candidate.id],
  );
  assert.deepEqual(
    mind.ready().map((item) => item.id),
    [active.id],
  );
  assert.equal(
    mind.list({ ready: true }).some((item) => item.id === candidate.id),
    false,
  );
  assert.deepEqual(mind.stats(), {
    active: 1,
    ready: 1,
    blocked: 0,
    waiting: 0,
    overdue: 0,
    done: 0,
    inbox: 0,
  });
  const frontier = formatMindFrontier(mind);
  assert.match(frontier, /committed work/);
  assert.doesNotMatch(frontier, /never auto-act candidate/);
  const wake = snapshotWakeAdvisorState(
    { mind },
    {
      turnKind: 'internal',
      ranCode: false,
      continuedMindId: null,
      sendsThisTurn: 0,
    },
  );
  assert.deepEqual(
    wake.ready.map((item) => item.id),
    [active.id],
  );
  assert.equal(
    [...wake.ready, ...wake.inProgress, ...wake.waiting].some(
      (item) => item.id === candidate.id,
    ),
    false,
  );
  db.close();
});

test('proposal transitions are one-way and limited to inbox open or cancelled', () => {
  const db = database();
  const mind = new MindStore(db);
  for (const target of ['inbox', 'open', 'cancelled'] as const) {
    const item = proposal(mind, `${target} candidate`);
    assert.equal(mind.setStatus(item.id, target).status, target);
  }
  for (const target of ['in_progress', 'waiting', 'done'] as const) {
    const item = proposal(mind, `${target} candidate`);
    assert.throws(() => mind.setStatus(item.id, target), /can transition only/);
    assert.equal(mind.get(item.id)!.status, 'proposal');
  }
  const normal = mind.create({ title: 'normal', status: 'open' });
  assert.throws(
    () => mind.setStatus(normal.id, 'proposal'),
    /cannot transition to proposal/,
  );
  assert.equal(mind.get(normal.id)!.status, 'open');
  db.close();
});

test('proposal creation and updates reject scheduling dependencies and claims', () => {
  const db = database();
  const mind = new MindStore(db);
  const normal = mind.create({ title: 'normal', status: 'open' });
  assert.throws(
    () =>
      mind.create({
        title: 'scheduled',
        status: 'proposal',
        dueAt: Date.now() + 60_000,
      }),
    /cannot have a due date/,
  );
  assert.throws(
    () =>
      mind.create({
        title: 'blocked',
        status: 'proposal',
        dependsOn: [normal.id],
      }),
    /cannot have readiness dependencies/,
  );
  const candidate = proposal(mind);
  assert.throws(
    () => mind.update(candidate.id, { dueAt: Date.now() + 60_000 }),
    /cannot have a due date/,
  );
  assert.throws(
    () => mind.addDependency(candidate.id, normal.id),
    /cannot have readiness dependencies/,
  );
  assert.throws(
    () => mind.addDependency(normal.id, candidate.id),
    /cannot have readiness dependencies/,
  );
  assert.throws(
    () =>
      mind.claim(candidate.id, {
        owner: 'worker:test',
        principal: 'session:test',
      }),
    /proposal, not open work/,
  );
  db.close();
});

test('proposal reminders reject before creating scheduler work', () => {
  const db = database();
  let scheduled = 0;
  const mind = new MindService({
    db,
    logger: noopLogger,
    scheduler: {
      create(opts) {
        scheduled += 1;
        return {
          id: scheduled,
          name: opts.name,
          kind: 'custom' as const,
          channelId: opts.channelId ?? null,
          payload: opts.payload,
          nextRunAt: opts.nextRunAt,
          intervalMs: null,
          snoozeUntil: null,
          nagIntervalMs: null,
          nagCount: 0,
          doneAt: null,
          createdAt: Date.now(),
        };
      },
      delete() {
        return true;
      },
      update() {
        return null;
      },
    },
  });
  const candidate = mind.create({ title: 'candidate', status: 'proposal' });
  assert.throws(
    () => mind.addReminder(candidate.id, Date.now() + 60_000),
    /cannot have reminders/,
  );
  assert.equal(scheduled, 0);
  assert.equal(
    Number(
      (
        db.prepare('SELECT count(*) AS n FROM mind_reminders').get() as {
          n: number;
        }
      ).n,
    ),
    0,
  );
  db.close();
});

test('proposal tasks cannot create or resume persistent sandboxes', () => {
  const db = database();
  const mind = new MindStore(db);
  const registry = createSandboxRegistry({
    db,
    uuid: () => 'executor-test',
  });
  const candidate = proposal(mind);
  assert.throws(
    () => registry.ensureForMind(candidate.id),
    /proposal.*cannot receive/,
  );
  const normal = mind.create({ title: 'existing sandbox', status: 'open' });
  registry.ensureForMind(normal.id);
  db.exec('DROP TRIGGER mind_items_proposal_transition_guard');
  db.prepare("UPDATE mind_items SET status = 'proposal' WHERE id = ?").run(
    normal.id,
  );
  assert.throws(() => registry.beginRun(normal.id), /proposal.*cannot resume/);
  db.close();
});
