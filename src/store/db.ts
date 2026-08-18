// db.ts — the agent's single SQLite database (elpis.db), the home for
// STRUCTURED data (channels, feedback signal). Markdown files (SOUL/MEMORY/…)
// and transcripts stay on the filesystem; see docs/persistence.md for the line.
//
// Built on the Node built-in `node:sqlite` (DatabaseSync) — no native dep, no
// experimental flag on Node 24. Opened once at boot; migrations are idempotent
// because each block below guards itself (CREATE TABLE IF NOT EXISTS,
// pragma_table_info checks before ALTER TABLE ADD COLUMN) — there is no
// version-gated early return. See docs/persistence.md.

import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';

export type Database = DatabaseSync;

/** The current schema level. Every migration block runs on every boot
 * regardless of this value — runMigrations never reads user_version back
 * to decide what to skip, only writes it at the end (see below) so
 * external tooling/humans can inspect the file's schema level. A version
 * gate here would let a DB already at an older version silently skip a
 * later block, which is the exact defect the v5 migration guarded against. */
const SCHEMA_VERSION = 11;

/** Idempotent schema migrations. */
export function runMigrations(db: DatabaseSync): void {
 // v0 -> 
  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS feedback (
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
    CREATE TABLE IF NOT EXISTS message_index (
      discord_message_id TEXT PRIMARY KEY,
      channel_id         TEXT NOT NULL,
      transcript_file    TEXT NOT NULL,
      send_channel       TEXT NOT NULL,
      send_text          TEXT NOT NULL,
      source             TEXT NOT NULL,
      indexed_at         TEXT NOT NULL
    );
  `);

 // -> v2 (scheduled_tasks baseline)
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
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

 // v2 -> v3 (nagging columns)
  const columns = (db.prepare(`SELECT name FROM pragma_table_info('scheduled_tasks')`).all() as { name: string }[]).map((r) => r.name);
  if (!columns.includes('nag_interval_ms')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN nag_interval_ms INTEGER');
  }
  if (!columns.includes('parent_id')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN parent_id INTEGER');
  }
  if (!columns.includes('nag_count')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN nag_count INTEGER NOT NULL DEFAULT 0');
  }

 // v3 -> v4 (fleet: coding-agent sessions + their worktrees)
  db.exec(`
    CREATE TABLE IF NOT EXISTS fleet_sessions (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      cwd               TEXT NOT NULL,
      sdk_session_id    TEXT,
      runner_pid        INTEGER,
      status            TEXT NOT NULL,
      model             TEXT NOT NULL,
      effort            TEXT NOT NULL,
      read_only         INTEGER NOT NULL DEFAULT 0,
      worktree_guidance INTEGER NOT NULL DEFAULT 1,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      delivered_seq     INTEGER NOT NULL DEFAULT 0,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      output_tokens     INTEGER NOT NULL DEFAULT 0,
      cost_estimate_usd REAL    NOT NULL DEFAULT 0,
      turns             INTEGER NOT NULL DEFAULT 0,
      last_error        TEXT
    );
    CREATE TABLE IF NOT EXISTS fleet_worktrees (
      session_id  TEXT NOT NULL,
      name        TEXT,
      path        TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      removed_at  INTEGER,
      PRIMARY KEY (session_id, path)
    );
  `);

 // v4 -> v5 (multi-server: channel guild provenance + the killswitch)
  const chanCols = (db.prepare(`SELECT name FROM pragma_table_info('channels')`).all() as { name: string }[]).map((r) => r.name);
  if (!chanCols.includes('guild_id')) {
    db.exec('ALTER TABLE channels ADD COLUMN guild_id TEXT');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_mutes (
      channel_id TEXT PRIMARY KEY,
      type       TEXT NOT NULL CHECK (type IN ('mute','deafen')),
      set_by     TEXT NOT NULL CHECK (set_by IN ('self','operator')),
      reason     TEXT,
      created_at TEXT NOT NULL
    );
  `);

 // v5 -> v6 (multi-server: a thread's parent channel id). A thread carries its
 // own Discord channel id and never gets a killswitch row of its own, so
 // Agent.send needs the recorded parent to make a mute on #general hold
 // inside the threads under it — the same inheritance ingest already applies
 // via resolvePolicyChannelId. NULL for a normal (non-thread) channel.
  if (!chanCols.includes('parent_id')) {
    db.exec('ALTER TABLE channels ADD COLUMN parent_id TEXT');
  }

 // v6 -> v7 (calibrated token density: per-model chars-per-token ratio, learned
 // from observed usage.prompt_tokens; see src/llm/density.ts + docs/persistence.md).
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_density (
      model      TEXT PRIMARY KEY,
      ratio      REAL NOT NULL,
      samples    INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

 // v8: generic subscription-OAuth credential store, one row per provider
 // ('anthropic' today; 'openai-codex' etc. later). Keyed by provider so a
 // single table serves every provider_type that authenticates by OAuth.
 // Secrets live here rather than on disk (src/llm/oauth/store.ts).
  db.exec(`
    CREATE TABLE IF NOT EXISTS oauth_credentials (
      provider      TEXT PRIMARY KEY,
      access        TEXT NOT NULL,
      refresh       TEXT NOT NULL,
      expires       INTEGER NOT NULL,
      account_id    TEXT,
      email         TEXT,
      org_id        TEXT,
      org_name      TEXT,
      authorized_at INTEGER,
      updated_at    INTEGER NOT NULL
    );
  `);

 // v9: elpis.mind — durable external cortex. Items carry hierarchy and state;
 // dependency edges derive readiness; comments/events preserve the lived work;
 // reminders point into the existing scheduler rather than duplicating clocks.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mind_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL DEFAULT '',
      kind        TEXT NOT NULL CHECK (kind IN ('task','project','idea','question','reminder')),
      status      TEXT NOT NULL CHECK (status IN ('inbox','open','in_progress','waiting','done','cancelled')),
      priority    INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
      parent_id   INTEGER REFERENCES mind_items(id) ON DELETE SET NULL,
      due_at      INTEGER,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      closed_at   INTEGER,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS mind_items_status_idx ON mind_items(status, archived_at, priority, due_at);
    CREATE INDEX IF NOT EXISTS mind_items_parent_idx ON mind_items(parent_id);

    CREATE TABLE IF NOT EXISTS mind_dependencies (
      item_id       INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      depends_on_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      created_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      PRIMARY KEY (item_id, depends_on_id),
      CHECK (item_id != depends_on_id)
    );
    CREATE INDEX IF NOT EXISTS mind_dependencies_reverse_idx ON mind_dependencies(depends_on_id, item_id);

    CREATE TABLE IF NOT EXISTS mind_tags (
      item_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      tag     TEXT NOT NULL,
      PRIMARY KEY (item_id, tag)
    );
    CREATE INDEX IF NOT EXISTS mind_tags_tag_idx ON mind_tags(tag, item_id);

    CREATE TABLE IF NOT EXISTS mind_comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      author     TEXT NOT NULL,
      body        TEXT NOT NULL,
      reply_to_id INTEGER REFERENCES mind_comments(id) ON DELETE SET NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER,
      deleted_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS mind_comments_item_idx ON mind_comments(item_id, created_at);

    CREATE TABLE IF NOT EXISTS mind_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      type       TEXT NOT NULL,
      actor      TEXT NOT NULL,
      data_json  TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mind_events_item_idx ON mind_events(item_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS mind_reminders (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id           INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE,
      scheduled_task_id INTEGER NOT NULL UNIQUE,
      fire_at           INTEGER NOT NULL,
      channel_id        TEXT,
      created_by        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      fired_at          INTEGER,
      cancelled_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS mind_reminders_item_idx ON mind_reminders(item_id, fire_at);
  `);

 // v10: atomic external-worker claims. The lease principal is session-specific;
 // owner is the human-readable MCP client actor preserved in the audit trail.
  db.exec(`
    CREATE TABLE IF NOT EXISTS mind_claims (
      item_id     INTEGER PRIMARY KEY REFERENCES mind_items(id) ON DELETE CASCADE,
      owner       TEXT NOT NULL,
      principal   TEXT NOT NULL,
      claimed_at  INTEGER NOT NULL,
      renewed_at  INTEGER NOT NULL,
      expires_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mind_claims_principal_idx ON mind_claims(principal, expires_at);
    CREATE INDEX IF NOT EXISTS mind_claims_expires_idx ON mind_claims(expires_at);
  `);

 // v11: comments can be explicit replies, allowing waitable task-bound MCP
 // correspondence without treating an unrelated later comment as the answer.
  const mindCommentColumns = (db.prepare(`SELECT name FROM pragma_table_info('mind_comments')`).all() as { name: string }[]).map((r) => r.name);
  if (!mindCommentColumns.includes('reply_to_id')) {
    db.exec('ALTER TABLE mind_comments ADD COLUMN reply_to_id INTEGER REFERENCES mind_comments(id) ON DELETE SET NULL');
  }
  db.exec('CREATE INDEX IF NOT EXISTS mind_comments_reply_idx ON mind_comments(reply_to_id)');

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Open (creating if needed) elpis.db under dataDirectory, set WAL, migrate.
 * busy_timeout lets a writer wait out a brief lock instead of throwing
 * SQLITE_BUSY — the offline scripts/feedback.ts reconcile may write
 * message_index while the live harness inserts a feedback row. */
export function openDatabase(dataDirectory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dataDirectory, 'elpis.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(db);
  return db;
}
