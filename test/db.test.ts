// Unit tests for src/db.ts — agent.db open + idempotent migrations.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase, runMigrations } from "../src/store/db.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "harness-db-"));
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

test("openDatabase creates elpis.db with the expected tables", () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  assert.ok(fs.existsSync(path.join(dir, "elpis.db")), "elpis.db file exists");
  const names = tableNames(db);
  assert.ok(names.includes("channels"), "channels table");
  assert.ok(names.includes("feedback"), "feedback table");
  assert.ok(names.includes("message_index"), "message_index table");
  assert.ok(names.includes("scheduled_tasks"), "scheduled_tasks table");
  assert.ok(names.includes("token_density"), "token_density table");
  assert.ok(names.includes("oauth_credentials"), "oauth_credentials table");
  assert.ok(
    names.includes("sandbox_executor_identity"),
    "sandbox_executor_identity table",
  );
  assert.ok(
    names.includes("persistent_sandboxes"),
    "persistent_sandboxes table",
  );
  assert.ok(
    !names.includes("sandbox_aliases"),
    "legacy sandbox_aliases table removed",
  );
  db.close();
});

test("runMigrations is idempotent and sets user_version", () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const v1 = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  assert.equal(v1, 20, "user_version bumped to 20");
  // Re-running does not throw and leaves the current version unchanged.
  runMigrations(db);
  const v2 = (
    db.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  assert.equal(v2, 20);
  db.close();
});

test("reopening an existing agent.db is a no-op that preserves data", () => {
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
  assert.equal(row?.name, "general");
  db2.close();
});

test("fresh v4 database creates fleet tables (idempotent)", () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  assert.ok(tables.includes("fleet_sessions"));
  assert.ok(tables.includes("fleet_worktrees"));
  assert.ok(tables.includes("fleet_mailbox_messages"));
  assert.ok(tables.includes("worker_sessions"));
  assert.ok(tables.includes("worker_mailbox_messages"));
  runMigrations(db); // second run: no throw
  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    20,
  );
  db.close();
});

test("true v3→v4 upgrade path preserves data and creates fleet tables", () => {
  const dir = tmpDir();
  // Create a genuine v3 database with all v1-v3 DDL
  const v3db = new DatabaseSync(path.join(dir, "elpis.db"));

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
    .prepare("INSERT INTO channels (id, name, updated_at) VALUES (?, ?, ?)")
    .run("ch-123", "general", now);
  v3db
    .prepare(
      "INSERT INTO scheduled_tasks (name, kind, payload, next_run_at, interval_ms) VALUES (?, ?, ?, ?, ?)",
    )
    .run("reminder-x", "reminder", '{"msg":"test"}', 1000000, 60000);

  // Set v3 schema version and close
  v3db.exec("PRAGMA user_version = 3");
  v3db.close();

  // Reopen via production path
  const upgradedDb = openDatabase(dir);

  // Assert schema version upgraded to the current level
  const finalVersion = (
    upgradedDb.prepare("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  assert.equal(finalVersion, 20, "user_version upgraded to 20");

  // Assert fleet tables exist
  const tableNames = (
    upgradedDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  assert.ok(
    tableNames.includes("fleet_sessions"),
    "fleet_sessions table created",
  );
  assert.ok(
    tableNames.includes("fleet_worktrees"),
    "fleet_worktrees table created",
  );

  // Assert pre-existing data survived
  const channelRow = upgradedDb
    .prepare("SELECT name FROM channels WHERE id='ch-123'")
    .get() as { name: string } | undefined;
  assert.equal(channelRow?.name, "general", "channels data preserved");

  const taskRow = upgradedDb
    .prepare(
      "SELECT kind, payload FROM scheduled_tasks WHERE name='reminder-x'",
    )
    .get() as { kind: string; payload: string } | undefined;
  assert.equal(taskRow?.kind, "reminder", "scheduled_tasks kind preserved");
  assert.equal(
    taskRow?.payload,
    '{"msg":"test"}',
    "scheduled_tasks payload preserved",
  );

  upgradedDb.close();
});
