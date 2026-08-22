// db.ts — the agent's single SQLite database (elpis.db), the home for
// STRUCTURED data (channels, feedback signal). Markdown files (SOUL/MEMORY/…)
// and transcripts stay on the filesystem; see docs/persistence.md for the line.
//
// Built on the Node built-in `node:sqlite` (DatabaseSync) — no native dep, no
// experimental flag on Node 24. Opened once at boot; migrations are idempotent
// because each block below guards itself (CREATE TABLE IF NOT EXISTS,
// pragma_table_info checks before ALTER TABLE ADD COLUMN) — there is no
// version-gated early return. See docs/persistence.md.

import { DatabaseSync } from "node:sqlite";
import * as path from "node:path";
import { runComponentMigrations } from "./migrations.js";
import {
  migrateMindIds,
  MIND_ID_MIGRATION_CHECKSUM,
} from "./mind-id-migration.js";
import { MIND_PROPOSAL_STATUS_MIGRATION } from "./mind-proposal-migration.js";

export type Database = DatabaseSync;

/** The current schema level. Every migration block runs on every boot
 * regardless of this value — runMigrations never reads user_version back
 * to decide what to skip, only writes it at the end (see below) so
 * external tooling/humans can inspect the file's schema level. A version
 * gate here would let a DB already at an older version silently skip a
 * later block, which is the exact defect the v5 migration guarded against. */
const SCHEMA_VERSION = 21;

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
  const columns = (
    db
      .prepare(`SELECT name FROM pragma_table_info('scheduled_tasks')`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  if (!columns.includes("nag_interval_ms")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN nag_interval_ms INTEGER");
  }
  if (!columns.includes("parent_id")) {
    db.exec("ALTER TABLE scheduled_tasks ADD COLUMN parent_id INTEGER");
  }
  if (!columns.includes("nag_count")) {
    db.exec(
      "ALTER TABLE scheduled_tasks ADD COLUMN nag_count INTEGER NOT NULL DEFAULT 0",
    );
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
  const chanCols = (
    db.prepare(`SELECT name FROM pragma_table_info('channels')`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  if (!chanCols.includes("guild_id")) {
    db.exec("ALTER TABLE channels ADD COLUMN guild_id TEXT");
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
  if (!chanCols.includes("parent_id")) {
    db.exec("ALTER TABLE channels ADD COLUMN parent_id TEXT");
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
  const mindCommentColumns = (
    db.prepare(`SELECT name FROM pragma_table_info('mind_comments')`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  if (!mindCommentColumns.includes("reply_to_id")) {
    db.exec(
      "ALTER TABLE mind_comments ADD COLUMN reply_to_id INTEGER REFERENCES mind_comments(id) ON DELETE SET NULL",
    );
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS mind_comments_reply_idx ON mind_comments(reply_to_id)",
  );

  // v12: persistent run-v3 sandboxes. Registrations and alias reservations are
  // durable identity records, not disposable executor state.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sandbox_executor_identity (
      singleton   INTEGER PRIMARY KEY CHECK (singleton = 1),
      executor_id TEXT NOT NULL UNIQUE,
      created_at  INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS sandbox_executor_identity_no_update
      BEFORE UPDATE ON sandbox_executor_identity BEGIN
        SELECT RAISE(ABORT, 'sandbox executor identity is immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS sandbox_executor_identity_no_delete
      BEFORE DELETE ON sandbox_executor_identity BEGIN
        SELECT RAISE(ABORT, 'sandbox executor identity is immutable');
      END;

    CREATE TABLE IF NOT EXISTS persistent_sandboxes (
      id                TEXT PRIMARY KEY,
      mind_id           INTEGER NOT NULL UNIQUE REFERENCES mind_items(id) ON DELETE RESTRICT,
      executor_id       TEXT NOT NULL,
      generation        INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
      lifecycle         TEXT NOT NULL CHECK (lifecycle IN ('ready','busy','detached','retired')),
      reminder_latched  INTEGER NOT NULL DEFAULT 0 CHECK (reminder_latched IN (0,1)),
      retire_requested  INTEGER NOT NULL DEFAULT 0 CHECK (retire_requested IN (0,1)),
      cold_notice_pending INTEGER NOT NULL DEFAULT 0 CHECK (cold_notice_pending IN (0,1)),
      active_run_id     TEXT,
      next_run_seq      INTEGER NOT NULL DEFAULT 1 CHECK (next_run_seq >= 1),
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      retired_at        INTEGER,
      CHECK (
        (lifecycle IN ('ready','retired') AND active_run_id IS NULL) OR
        (lifecycle IN ('busy','detached') AND active_run_id IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS persistent_sandboxes_lifecycle_idx ON persistent_sandboxes(lifecycle, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS persistent_sandboxes_active_run_idx ON persistent_sandboxes(active_run_id) WHERE active_run_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS persistent_sandboxes_identity_no_update
      BEFORE UPDATE OF id, mind_id, executor_id ON persistent_sandboxes BEGIN
        SELECT RAISE(ABORT, 'sandbox registration identity is immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS persistent_sandboxes_no_delete
      BEFORE DELETE ON persistent_sandboxes BEGIN
        SELECT RAISE(ABORT, 'sandbox registrations are permanent');
      END;

    CREATE TABLE IF NOT EXISTS sandbox_aliases (
      alias       TEXT PRIMARY KEY,
      sandbox_id  TEXT NOT NULL UNIQUE REFERENCES persistent_sandboxes(id) ON DELETE RESTRICT,
      reserved_at INTEGER NOT NULL,
      retired_at  INTEGER
    );
    CREATE TRIGGER IF NOT EXISTS sandbox_aliases_identity_no_update
      BEFORE UPDATE OF alias, sandbox_id ON sandbox_aliases BEGIN
        SELECT RAISE(ABORT, 'sandbox alias reservations are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS sandbox_aliases_no_delete
      BEFORE DELETE ON sandbox_aliases BEGIN
        SELECT RAISE(ABORT, 'sandbox aliases are never reused');
      END;
  `);

  // v13: process-cold generation notices survive until the next selected run.
  // Existing v12 databases gain the column idempotently; fresh databases already
  // have it in the CREATE TABLE above.
  const sandboxColumns = (
    db
      .prepare(`SELECT name FROM pragma_table_info('persistent_sandboxes')`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  if (!sandboxColumns.includes("cold_notice_pending")) {
    db.exec(
      "ALTER TABLE persistent_sandboxes ADD COLUMN cold_notice_pending INTEGER NOT NULL DEFAULT 0 CHECK (cold_notice_pending IN (0,1))",
    );
  }

  // This receipt says only that the idempotent legacy blocks above completed;
  // it does not invent checksummed history for schema versions 1 through 13.
  runComponentMigrations(db, "core", [
    {
      name: "0013-legacy-through-v13",
      sql: "SELECT 1;",
    },
    {
      name: "0015-sandbox-retirement-deadline",
      sql: `
        ALTER TABLE persistent_sandboxes ADD COLUMN retire_requested_at INTEGER;
        UPDATE persistent_sandboxes
        SET retire_requested_at = updated_at
        WHERE retire_requested = 1;
        CREATE INDEX persistent_sandboxes_retirement_idx
        ON persistent_sandboxes(retire_requested, retire_requested_at, lifecycle);
      `,
    },
    {
      name: "0016-mind-elm-identities",
      checksum: MIND_ID_MIGRATION_CHECKSUM,
      up: migrateMindIds,
    },
    {
      name: "0017-fleet-actor-sessions",
      sql: `
        ALTER TABLE fleet_sessions ADD COLUMN model_ref TEXT;
        ALTER TABLE fleet_sessions ADD COLUMN mind_id TEXT REFERENCES mind_items(id);
        ALTER TABLE fleet_sessions ADD COLUMN runtime TEXT NOT NULL DEFAULT 'claude-sdk'
          CHECK (runtime IN ('claude-sdk', 'trusted', 'kubernetes'));
        ALTER TABLE fleet_sessions ADD COLUMN control_token_digest TEXT;
        CREATE INDEX fleet_sessions_mind_idx ON fleet_sessions(mind_id, created_at);
        CREATE UNIQUE INDEX fleet_sessions_control_token_idx
          ON fleet_sessions(control_token_digest) WHERE control_token_digest IS NOT NULL;
      `,
    },
    {
      name: "0018-fleet-actor-mailbox",
      sql: `
        CREATE TABLE fleet_mailbox_messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT NOT NULL REFERENCES fleet_sessions(id) ON DELETE CASCADE,
          direction       TEXT NOT NULL CHECK (direction IN ('dispatcher_to_actor', 'actor_to_dispatcher')),
          kind            TEXT NOT NULL CHECK (kind IN ('message', 'finish')),
          message_key     TEXT NOT NULL CHECK (length(message_key) BETWEEN 1 AND 80),
          sender          TEXT NOT NULL CHECK (length(sender) BETWEEN 1 AND 80),
          body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
          created_at      INTEGER NOT NULL,
          acknowledged_at INTEGER,
          CHECK (direction = 'actor_to_dispatcher' OR kind = 'message'),
          UNIQUE (session_id, direction, message_key)
        );
        CREATE INDEX fleet_mailbox_pending_idx
          ON fleet_mailbox_messages(session_id, direction, id)
          WHERE acknowledged_at IS NULL;
        CREATE UNIQUE INDEX fleet_mailbox_actor_finish_idx
          ON fleet_mailbox_messages(session_id)
          WHERE direction = 'actor_to_dispatcher' AND kind = 'finish';
      `,
    },
    {
      name: "0019-native-workers",
      sql: `
        CREATE TABLE worker_sessions (
          id                   TEXT PRIMARY KEY,
          slug                 TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 80),
          status               TEXT NOT NULL CHECK (status IN ('spawning','running','idle','finished','failed','dismissed')),
          model_ref            TEXT NOT NULL,
          mind_id              TEXT NOT NULL REFERENCES mind_items(id),
          runtime              TEXT NOT NULL CHECK (runtime IN ('trusted','kubernetes')),
          control_token_digest TEXT NOT NULL UNIQUE CHECK (length(control_token_digest) = 64),
          pod_name             TEXT,
          pod_uid              TEXT,
          workspace_ref        TEXT,
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL,
          last_error           TEXT
        );
        CREATE UNIQUE INDEX worker_sessions_active_mind_idx
          ON worker_sessions(mind_id)
          WHERE status IN ('spawning','running','idle');
        CREATE INDEX worker_sessions_status_idx
          ON worker_sessions(status, created_at);

        CREATE TABLE worker_mailbox_messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id      TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
          direction       TEXT NOT NULL CHECK (direction IN ('dispatcher_to_worker', 'worker_to_dispatcher')),
          kind            TEXT NOT NULL CHECK (kind IN ('message', 'finish')),
          message_key     TEXT NOT NULL CHECK (length(message_key) BETWEEN 1 AND 80),
          sender          TEXT NOT NULL CHECK (length(sender) BETWEEN 1 AND 80),
          body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
          created_at      INTEGER NOT NULL,
          acknowledged_at INTEGER,
          CHECK (direction = 'worker_to_dispatcher' OR kind = 'message'),
          UNIQUE (session_id, direction, message_key)
        );
        CREATE INDEX worker_mailbox_pending_idx
          ON worker_mailbox_messages(session_id, direction, id)
          WHERE acknowledged_at IS NULL;
        CREATE UNIQUE INDEX worker_mailbox_finish_idx
          ON worker_mailbox_messages(session_id)
          WHERE direction = 'worker_to_dispatcher' AND kind = 'finish';
      `,
    },
    MIND_PROPOSAL_STATUS_MIGRATION,
    {
      name: "0021-worker-workspace-custody",
      sql: `
        ALTER TABLE worker_sessions ADD COLUMN source_revision TEXT
          CHECK (source_revision IS NULL OR length(source_revision) BETWEEN 1 AND 128);
        ALTER TABLE worker_sessions ADD COLUMN source_sha256 TEXT
          CHECK (source_sha256 IS NULL OR length(source_sha256) = 64);
        ALTER TABLE worker_sessions ADD COLUMN source_bytes INTEGER
          CHECK (source_bytes IS NULL OR source_bytes >= 0);

        CREATE TRIGGER worker_sessions_source_insert_guard
        BEFORE INSERT ON worker_sessions
        WHEN (NEW.source_revision IS NULL) != (NEW.source_sha256 IS NULL)
          OR (NEW.source_revision IS NULL) != (NEW.source_bytes IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'worker source receipt must be complete');
        END;
        CREATE TRIGGER worker_sessions_source_update_guard
        BEFORE UPDATE OF source_revision, source_sha256, source_bytes ON worker_sessions
        WHEN (NEW.source_revision IS NULL) != (NEW.source_sha256 IS NULL)
          OR (NEW.source_revision IS NULL) != (NEW.source_bytes IS NULL)
        BEGIN
          SELECT RAISE(ABORT, 'worker source receipt must be complete');
        END;

        CREATE TABLE worker_workspace_artifacts (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id     TEXT NOT NULL REFERENCES worker_sessions(id) ON DELETE CASCADE,
          artifact_key   TEXT NOT NULL CHECK (length(artifact_key) BETWEEN 1 AND 80),
          kind           TEXT NOT NULL CHECK (kind IN ('unified_patch_gzip')),
          source_sha256  TEXT NOT NULL CHECK (length(source_sha256) = 64),
          sha256         TEXT NOT NULL CHECK (length(sha256) = 64),
          size_bytes     INTEGER NOT NULL CHECK (size_bytes >= 0),
          relative_path  TEXT NOT NULL CHECK (length(relative_path) BETWEEN 1 AND 240),
          created_at     INTEGER NOT NULL,
          UNIQUE (session_id, artifact_key)
        );
        CREATE INDEX worker_workspace_artifacts_session_idx
          ON worker_workspace_artifacts(session_id, id);
      `,
    },
  ]);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
}

/** Open (creating if needed) elpis.db under dataDirectory, set WAL, migrate.
 * busy_timeout lets a writer wait out a brief lock instead of throwing
 * SQLITE_BUSY — the offline scripts/feedback.ts reconcile may write
 * message_index while the live harness inserts a feedback row. */
export function openDatabase(dataDirectory: string): DatabaseSync {
  const db = new DatabaseSync(path.join(dataDirectory, "elpis.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  runMigrations(db);
  return db;
}
