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
import { runComponentMigrations } from './migrations.js';
import {
  migrateMindIds,
  MIND_ID_MIGRATION_CHECKSUM,
} from './mind-id-migration.js';
import { MIND_PROPOSAL_STATUS_MIGRATION } from './mind-proposal-migration.js';

export type Database = DatabaseSync;

/** The current schema level. Every migration block runs on every boot
 * regardless of this value — runMigrations never reads user_version back
 * to decide what to skip, only writes it at the end (see below) so
 * external tooling/humans can inspect the file's schema level. A version
 * gate here would let a DB already at an older version silently skip a
 * later block, which is the exact defect the v5 migration guarded against. */
const SCHEMA_VERSION = 36;

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
  if (!columns.includes('nag_interval_ms')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN nag_interval_ms INTEGER');
  }
  if (!columns.includes('parent_id')) {
    db.exec('ALTER TABLE scheduled_tasks ADD COLUMN parent_id INTEGER');
  }
  if (!columns.includes('nag_count')) {
    db.exec(
      'ALTER TABLE scheduled_tasks ADD COLUMN nag_count INTEGER NOT NULL DEFAULT 0',
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
  const mindCommentColumns = (
    db.prepare(`SELECT name FROM pragma_table_info('mind_comments')`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  if (!mindCommentColumns.includes('reply_to_id')) {
    db.exec(
      'ALTER TABLE mind_comments ADD COLUMN reply_to_id INTEGER REFERENCES mind_comments(id) ON DELETE SET NULL',
    );
  }
  db.exec(
    'CREATE INDEX IF NOT EXISTS mind_comments_reply_idx ON mind_comments(reply_to_id)',
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
  if (!sandboxColumns.includes('cold_notice_pending')) {
    db.exec(
      'ALTER TABLE persistent_sandboxes ADD COLUMN cold_notice_pending INTEGER NOT NULL DEFAULT 0 CHECK (cold_notice_pending IN (0,1))',
    );
  }

  // This receipt says only that the idempotent legacy blocks above completed;
  // it does not invent checksummed history for schema versions 1 through 13.
  runComponentMigrations(db, 'core', [
    {
      name: '0013-legacy-through-v13',
      sql: 'SELECT 1;',
    },
    {
      name: '0015-sandbox-retirement-deadline',
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
      name: '0016-mind-elm-identities',
      checksum: MIND_ID_MIGRATION_CHECKSUM,
      up: migrateMindIds,
    },
    {
      name: '0017-fleet-actor-sessions',
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
      name: '0018-fleet-actor-mailbox',
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
      name: '0019-native-workers',
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
      name: '0021-worker-workspace-custody',
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
    {
      name: '0022-secretary-sessions',
      sql: `
        CREATE TABLE secretary_sessions (
          id                   TEXT PRIMARY KEY
            CHECK (
              length(id) = 26
              AND substr(id, 1, 4) = 'sec-'
              AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          root_mind_id         TEXT NOT NULL REFERENCES mind_items(id) ON DELETE RESTRICT,
          status               TEXT NOT NULL CHECK (status IN ('starting','ready','closed','failed')),
          model_ref            TEXT NOT NULL
            CHECK (
              length(model_ref) >= 3
              AND model_ref = lower(model_ref)
              AND model_ref NOT GLOB '*[^a-z0-9._/-]*'
              AND instr(model_ref, '/') > 1
              AND instr(substr(model_ref, instr(model_ref, '/') + 1), '/') = 0
              AND substr(model_ref, 1, 1) GLOB '[a-z0-9]'
              AND substr(model_ref, instr(model_ref, '/') + 1, 1) GLOB '[a-z0-9]'
            ),
          runtime              TEXT NOT NULL CHECK (runtime = 'kubernetes'),
          control_token_digest TEXT NOT NULL UNIQUE
            CHECK (
              length(control_token_digest) = 64
              AND control_token_digest NOT GLOB '*[^0-9a-f]*'
            ),
          pod_name             TEXT CHECK (pod_name IS NULL OR length(pod_name) BETWEEN 1 AND 253),
          pod_uid              TEXT CHECK (pod_uid IS NULL OR length(pod_uid) BETWEEN 1 AND 128),
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL CHECK (updated_at >= created_at),
          last_error           TEXT
        );
        CREATE UNIQUE INDEX secretary_sessions_active_root_idx
          ON secretary_sessions(root_mind_id)
          WHERE status IN ('starting','ready');
        CREATE INDEX secretary_sessions_status_idx
          ON secretary_sessions(status, created_at);

        CREATE TRIGGER secretary_sessions_identity_no_update
        BEFORE UPDATE OF id, root_mind_id, model_ref, runtime, control_token_digest
        ON secretary_sessions
        BEGIN
          SELECT RAISE(ABORT, 'secretary session identity and scope are immutable');
        END;
        CREATE TRIGGER secretary_sessions_status_transition_guard
        BEFORE UPDATE OF status ON secretary_sessions
        WHEN NEW.status != OLD.status
          AND NOT (
            (OLD.status = 'starting' AND NEW.status IN ('ready','closed','failed'))
            OR (OLD.status = 'ready' AND NEW.status IN ('closed','failed'))
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid secretary session status transition');
        END;
      `,
    },
    {
      name: '0023-secretary-conversation-turns',
      sql: `
        CREATE TABLE secretary_turns (
          id               TEXT PRIMARY KEY
            CHECK (
              length(id) = 26
              AND substr(id, 1, 4) = 'stn-'
              AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          session_id       TEXT NOT NULL REFERENCES secretary_sessions(id) ON DELETE CASCADE,
          sequence         INTEGER NOT NULL CHECK (sequence >= 1),
          status           TEXT NOT NULL
            CHECK (status IN ('queued','claimed','completed','ambiguous','cancelled')),
          request_json     TEXT NOT NULL
            CHECK (
              length(request_json) BETWEEN 2 AND 262144
              AND json_valid(request_json)
              AND json_type(request_json) = 'object'
            ),
          response_json    TEXT
            CHECK (
              response_json IS NULL
              OR (
                length(response_json) BETWEEN 2 AND 262144
                AND json_valid(response_json)
                AND json_type(response_json) = 'object'
              )
            ),
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL CHECK (updated_at >= created_at),
          claimed_at       INTEGER CHECK (claimed_at IS NULL OR claimed_at >= created_at),
          completed_at     INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
          last_error       TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
          UNIQUE (session_id, sequence)
        );
        CREATE UNIQUE INDEX secretary_turns_active_session_idx
          ON secretary_turns(session_id)
          WHERE status IN ('queued','claimed');
        CREATE INDEX secretary_turns_session_sequence_idx
          ON secretary_turns(session_id, sequence);
        CREATE INDEX secretary_turns_status_idx
          ON secretary_turns(status, updated_at);

        CREATE TRIGGER secretary_turns_identity_no_update
        BEFORE UPDATE OF id, session_id, sequence, request_json, created_at
        ON secretary_turns
        BEGIN
          SELECT RAISE(ABORT, 'secretary turn identity and request are immutable');
        END;
        CREATE TRIGGER secretary_turns_status_transition_guard
        BEFORE UPDATE OF status ON secretary_turns
        WHEN NEW.status != OLD.status
          AND NOT (
            (OLD.status = 'queued' AND NEW.status IN ('claimed','cancelled'))
            OR (OLD.status = 'claimed' AND NEW.status IN ('completed','ambiguous','cancelled'))
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid secretary turn status transition');
        END;
        CREATE TRIGGER secretary_turns_pristine_insert_guard
        BEFORE INSERT ON secretary_turns
        WHEN NEW.status != 'queued'
          OR NEW.response_json IS NOT NULL
          OR NEW.claimed_at IS NOT NULL
          OR NEW.completed_at IS NOT NULL
          OR NEW.last_error IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'new secretary turns must be pristine');
        END;
        CREATE TRIGGER secretary_sessions_settle_turns_before_terminal
        BEFORE UPDATE OF status ON secretary_sessions
        WHEN OLD.status IN ('starting','ready')
          AND NEW.status IN ('closed','failed')
        BEGIN
          UPDATE secretary_turns
          SET status='cancelled', updated_at=MAX(updated_at, NEW.updated_at),
              last_error=COALESCE(NEW.last_error, 'secretary session closed')
          WHERE session_id=OLD.id AND status='queued';
          UPDATE secretary_turns
          SET status='ambiguous', updated_at=MAX(updated_at, NEW.updated_at),
              last_error=COALESCE(NEW.last_error, 'secretary session closed')
          WHERE session_id=OLD.id AND status='claimed';
        END;
        CREATE TRIGGER secretary_turns_lifecycle_update_guard
        BEFORE UPDATE ON secretary_turns
        WHEN
          (NEW.status = 'queued' AND (NEW.claimed_at IS NOT NULL OR NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NOT NULL))
          OR (NEW.status = 'claimed' AND (NEW.claimed_at IS NULL OR NEW.claimed_at > NEW.updated_at OR NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NOT NULL))
          OR (NEW.status = 'completed' AND (NEW.claimed_at IS NULL OR NEW.completed_at IS NULL OR NEW.completed_at < NEW.claimed_at OR NEW.completed_at > NEW.updated_at OR NEW.response_json IS NULL OR NEW.last_error IS NOT NULL))
          OR (NEW.status = 'ambiguous' AND (NEW.claimed_at IS NULL OR NEW.claimed_at > NEW.updated_at OR NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NULL))
          OR (NEW.status = 'cancelled' AND (NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NULL))
        BEGIN
          SELECT RAISE(ABORT, 'secretary turn lifecycle fields do not match status');
        END;
      `,
    },
    {
      name: '0024-global-secretary-authority',
      sql: `
        ALTER TABLE secretary_turns RENAME TO secretary_turns_v23;
        ALTER TABLE secretary_sessions RENAME TO secretary_sessions_v22;

        DROP INDEX secretary_turns_active_session_idx;
        DROP INDEX secretary_turns_session_sequence_idx;
        DROP INDEX secretary_turns_status_idx;
        DROP TRIGGER secretary_turns_identity_no_update;
        DROP TRIGGER secretary_turns_status_transition_guard;
        DROP TRIGGER secretary_turns_pristine_insert_guard;
        DROP TRIGGER secretary_turns_lifecycle_update_guard;
        DROP TRIGGER secretary_sessions_settle_turns_before_terminal;
        DROP INDEX secretary_sessions_active_root_idx;
        DROP INDEX secretary_sessions_status_idx;
        DROP TRIGGER secretary_sessions_identity_no_update;
        DROP TRIGGER secretary_sessions_status_transition_guard;

        CREATE TABLE secretary_sessions (
          id                   TEXT PRIMARY KEY
            CHECK (
              length(id) = 26
              AND substr(id, 1, 4) = 'sec-'
              AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          hint_mind_id         TEXT REFERENCES mind_items(id) ON DELETE RESTRICT,
          status               TEXT NOT NULL CHECK (status IN ('starting','ready','closed','failed')),
          model_ref            TEXT NOT NULL
            CHECK (
              length(model_ref) >= 3
              AND model_ref = lower(model_ref)
              AND model_ref NOT GLOB '*[^a-z0-9._/-]*'
              AND instr(model_ref, '/') > 1
              AND instr(substr(model_ref, instr(model_ref, '/') + 1), '/') = 0
              AND substr(model_ref, 1, 1) GLOB '[a-z0-9]'
              AND substr(model_ref, instr(model_ref, '/') + 1, 1) GLOB '[a-z0-9]'
            ),
          runtime              TEXT NOT NULL CHECK (runtime = 'kubernetes'),
          control_token_digest TEXT NOT NULL UNIQUE
            CHECK (
              length(control_token_digest) = 64
              AND control_token_digest NOT GLOB '*[^0-9a-f]*'
            ),
          pod_name             TEXT CHECK (pod_name IS NULL OR length(pod_name) BETWEEN 1 AND 253),
          pod_uid              TEXT CHECK (pod_uid IS NULL OR length(pod_uid) BETWEEN 1 AND 128),
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL CHECK (updated_at >= created_at),
          last_error           TEXT
        );
        INSERT INTO secretary_sessions
          (id, hint_mind_id, status, model_ref, runtime, control_token_digest,
           pod_name, pod_uid, created_at, updated_at, last_error)
        SELECT id, root_mind_id, status, model_ref, runtime, control_token_digest,
               pod_name, pod_uid, created_at, updated_at, last_error
        FROM secretary_sessions_v22;
        CREATE INDEX secretary_sessions_status_idx
          ON secretary_sessions(status, created_at);
        CREATE TRIGGER secretary_sessions_identity_no_update
        BEFORE UPDATE OF id, hint_mind_id, model_ref, runtime, control_token_digest
        ON secretary_sessions
        BEGIN
          SELECT RAISE(ABORT, 'secretary session identity and hint are immutable');
        END;
        CREATE TRIGGER secretary_sessions_status_transition_guard
        BEFORE UPDATE OF status ON secretary_sessions
        WHEN NEW.status != OLD.status
          AND NOT (
            (OLD.status = 'starting' AND NEW.status IN ('ready','closed','failed'))
            OR (OLD.status = 'ready' AND NEW.status IN ('closed','failed'))
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid secretary session status transition');
        END;

        CREATE TABLE secretary_turns (
          id               TEXT PRIMARY KEY
            CHECK (
              length(id) = 26
              AND substr(id, 1, 4) = 'stn-'
              AND substr(id, 5) NOT GLOB '*[^A-Za-z0-9_-]*'
            ),
          session_id       TEXT NOT NULL REFERENCES secretary_sessions(id) ON DELETE CASCADE,
          sequence         INTEGER NOT NULL CHECK (sequence >= 1),
          status           TEXT NOT NULL
            CHECK (status IN ('queued','claimed','completed','ambiguous','cancelled')),
          request_json     TEXT NOT NULL
            CHECK (
              length(request_json) BETWEEN 2 AND 262144
              AND json_valid(request_json)
              AND json_type(request_json) = 'object'
            ),
          response_json    TEXT
            CHECK (
              response_json IS NULL
              OR (
                length(response_json) BETWEEN 2 AND 262144
                AND json_valid(response_json)
                AND json_type(response_json) = 'object'
              )
            ),
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL CHECK (updated_at >= created_at),
          claimed_at       INTEGER CHECK (claimed_at IS NULL OR claimed_at >= created_at),
          completed_at     INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
          last_error       TEXT CHECK (last_error IS NULL OR length(last_error) <= 1000),
          UNIQUE (session_id, sequence)
        );
        INSERT INTO secretary_turns
          (id, session_id, sequence, status, request_json, response_json,
           created_at, updated_at, claimed_at, completed_at, last_error)
        SELECT id, session_id, sequence, status, request_json, response_json,
               created_at, updated_at, claimed_at, completed_at, last_error
        FROM secretary_turns_v23;
        CREATE UNIQUE INDEX secretary_turns_active_session_idx
          ON secretary_turns(session_id)
          WHERE status IN ('queued','claimed');
        CREATE INDEX secretary_turns_session_sequence_idx
          ON secretary_turns(session_id, sequence);
        CREATE INDEX secretary_turns_status_idx
          ON secretary_turns(status, updated_at);
        CREATE TRIGGER secretary_turns_identity_no_update
        BEFORE UPDATE OF id, session_id, sequence, request_json, created_at
        ON secretary_turns
        BEGIN
          SELECT RAISE(ABORT, 'secretary turn identity and request are immutable');
        END;
        CREATE TRIGGER secretary_turns_status_transition_guard
        BEFORE UPDATE OF status ON secretary_turns
        WHEN NEW.status != OLD.status
          AND NOT (
            (OLD.status = 'queued' AND NEW.status IN ('claimed','cancelled'))
            OR (OLD.status = 'claimed' AND NEW.status IN ('completed','ambiguous','cancelled'))
          )
        BEGIN
          SELECT RAISE(ABORT, 'invalid secretary turn status transition');
        END;
        CREATE TRIGGER secretary_turns_pristine_insert_guard
        BEFORE INSERT ON secretary_turns
        WHEN NEW.status != 'queued'
          OR NEW.response_json IS NOT NULL
          OR NEW.claimed_at IS NOT NULL
          OR NEW.completed_at IS NOT NULL
          OR NEW.last_error IS NOT NULL
        BEGIN
          SELECT RAISE(ABORT, 'new secretary turns must be pristine');
        END;
        CREATE TRIGGER secretary_sessions_settle_turns_before_terminal
        BEFORE UPDATE OF status ON secretary_sessions
        WHEN OLD.status IN ('starting','ready')
          AND NEW.status IN ('closed','failed')
        BEGIN
          UPDATE secretary_turns
          SET status='cancelled', updated_at=MAX(updated_at, NEW.updated_at),
              last_error=COALESCE(NEW.last_error, 'secretary session closed')
          WHERE session_id=OLD.id AND status='queued';
          UPDATE secretary_turns
          SET status='ambiguous', updated_at=MAX(updated_at, NEW.updated_at),
              last_error=COALESCE(NEW.last_error, 'secretary session closed')
          WHERE session_id=OLD.id AND status='claimed';
        END;
        CREATE TRIGGER secretary_turns_lifecycle_update_guard
        BEFORE UPDATE ON secretary_turns
        WHEN
          (NEW.status = 'queued' AND (NEW.claimed_at IS NOT NULL OR NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NOT NULL))
          OR (NEW.status = 'claimed' AND (NEW.claimed_at IS NULL OR NEW.claimed_at > NEW.updated_at OR NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NOT NULL))
          OR (NEW.status = 'completed' AND (NEW.claimed_at IS NULL OR NEW.completed_at IS NULL OR NEW.completed_at < NEW.claimed_at OR NEW.completed_at > NEW.updated_at OR NEW.response_json IS NULL OR NEW.last_error IS NOT NULL))
          OR (NEW.status = 'ambiguous' AND (NEW.claimed_at IS NULL OR NEW.claimed_at > NEW.updated_at OR NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NULL))
          OR (NEW.status = 'cancelled' AND (NEW.response_json IS NOT NULL OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NULL))
        BEGIN
          SELECT RAISE(ABORT, 'secretary turn lifecycle fields do not match status');
        END;

        DROP TABLE secretary_turns_v23;
        DROP TABLE secretary_sessions_v22;
      `,
    },
    {
      name: '0025-gateway-resident-state',
      sql: `
        CREATE TABLE gateway_resident_state (
          singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
          instance_id              TEXT NOT NULL UNIQUE
            CHECK (length(instance_id) = 27 AND substr(instance_id,1,5) = 'egi1.'
              AND substr(instance_id,6) NOT GLOB '*[^A-Za-z0-9_-]*'),
          phase                    TEXT NOT NULL CHECK (phase IN ('idle','enrolling','active','rotating')),
          endpoint                 TEXT CHECK (endpoint IS NULL OR length(endpoint) BETWEEN 1 AND 2048),
          display_name             TEXT CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 128),
          enrollment_grant         TEXT
            CHECK (enrollment_grant IS NULL OR
              (length(enrollment_grant) = 71 AND substr(enrollment_grant,1,5) = 'ege1.'
               AND substr(enrollment_grant,6,22) NOT GLOB '*[^A-Za-z0-9_-]*'
               AND substr(enrollment_grant,28,1) = '.'
               AND substr(enrollment_grant,29) NOT GLOB '*[^A-Za-z0-9_-]*')),
          request_id               TEXT
            CHECK (request_id IS NULL OR
              (length(request_id) = 27 AND substr(request_id,1,5) = 'egr1.'
               AND substr(request_id,6) NOT GLOB '*[^A-Za-z0-9_-]*')),
          active_credential_id     TEXT
            CHECK (active_credential_id IS NULL OR
              (length(active_credential_id) = 22
               AND active_credential_id NOT GLOB '*[^A-Za-z0-9_-]*')),
          active_credential_token  TEXT,
          pending_credential_id    TEXT
            CHECK (pending_credential_id IS NULL OR
              (length(pending_credential_id) = 22
               AND pending_credential_id NOT GLOB '*[^A-Za-z0-9_-]*')),
          pending_credential_token TEXT,
          created_at               INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at               INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at),
          enrollment_started_at    INTEGER CHECK (enrollment_started_at IS NULL OR (typeof(enrollment_started_at) = 'integer' AND enrollment_started_at >= created_at)),
          activated_at             INTEGER CHECK (activated_at IS NULL OR (typeof(activated_at) = 'integer' AND activated_at >= created_at)),
          rotation_started_at      INTEGER CHECK (rotation_started_at IS NULL OR (typeof(rotation_started_at) = 'integer' AND rotation_started_at >= created_at)),
          CHECK (active_credential_token IS NULL OR
            (length(active_credential_token) = 71
             AND substr(active_credential_token,1,5) = 'egc1.'
             AND substr(active_credential_token,6,22) = active_credential_id
             AND substr(active_credential_token,28,1) = '.'
             AND substr(active_credential_token,29) NOT GLOB '*[^A-Za-z0-9_-]*')),
          CHECK (pending_credential_token IS NULL OR
            (length(pending_credential_token) = 71
             AND substr(pending_credential_token,1,5) = 'egc1.'
             AND substr(pending_credential_token,6,22) = pending_credential_id
             AND substr(pending_credential_token,28,1) = '.'
             AND substr(pending_credential_token,29) NOT GLOB '*[^A-Za-z0-9_-]*')),
          CHECK (
            (phase = 'idle' AND endpoint IS NULL AND display_name IS NULL
              AND enrollment_grant IS NULL AND request_id IS NULL
              AND active_credential_id IS NULL AND active_credential_token IS NULL
              AND pending_credential_id IS NULL AND pending_credential_token IS NULL
              AND enrollment_started_at IS NULL AND activated_at IS NULL AND rotation_started_at IS NULL)
            OR
            (phase = 'enrolling' AND endpoint IS NOT NULL AND display_name IS NOT NULL
              AND enrollment_grant IS NOT NULL AND request_id IS NOT NULL
              AND active_credential_id IS NULL AND active_credential_token IS NULL
              AND pending_credential_id IS NOT NULL AND pending_credential_token IS NOT NULL
              AND enrollment_started_at IS NOT NULL AND activated_at IS NULL AND rotation_started_at IS NULL)
            OR
            (phase = 'active' AND endpoint IS NOT NULL AND display_name IS NOT NULL
              AND enrollment_grant IS NULL AND request_id IS NULL
              AND active_credential_id IS NOT NULL AND active_credential_token IS NOT NULL
              AND pending_credential_id IS NULL AND pending_credential_token IS NULL
              AND enrollment_started_at IS NOT NULL AND activated_at IS NOT NULL AND rotation_started_at IS NULL)
            OR
            (phase = 'rotating' AND endpoint IS NOT NULL AND display_name IS NOT NULL
              AND enrollment_grant IS NULL AND request_id IS NOT NULL
              AND active_credential_id IS NOT NULL AND active_credential_token IS NOT NULL
              AND pending_credential_id IS NOT NULL AND pending_credential_token IS NOT NULL
              AND active_credential_id != pending_credential_id
              AND enrollment_started_at IS NOT NULL AND activated_at IS NOT NULL AND rotation_started_at IS NOT NULL)
          )
        );
        CREATE TRIGGER gateway_resident_state_identity_no_update
        BEFORE UPDATE OF singleton, instance_id, created_at ON gateway_resident_state
        BEGIN SELECT RAISE(ABORT, 'gateway resident identity is immutable'); END;
        CREATE TRIGGER gateway_resident_state_no_delete
        BEFORE DELETE ON gateway_resident_state
        BEGIN SELECT RAISE(ABORT, 'gateway resident identity is immutable'); END;
        CREATE TRIGGER gateway_resident_state_binding_no_update
        BEFORE UPDATE OF endpoint, display_name ON gateway_resident_state
        WHEN OLD.endpoint IS NOT NULL
          AND (NEW.endpoint != OLD.endpoint OR NEW.display_name != OLD.display_name)
        BEGIN SELECT RAISE(ABORT, 'gateway resident endpoint binding is immutable'); END;
        CREATE TRIGGER gateway_resident_state_candidate_no_rewrite
        BEFORE UPDATE OF enrollment_grant, request_id,
          active_credential_id, active_credential_token,
          pending_credential_id, pending_credential_token
        ON gateway_resident_state
        WHEN NEW.phase = OLD.phase
        BEGIN SELECT RAISE(ABORT, 'gateway resident candidate is immutable'); END;
        CREATE TRIGGER gateway_resident_state_timestamp_guard
        BEFORE UPDATE ON gateway_resident_state
        WHEN NEW.updated_at < OLD.updated_at
          OR (OLD.enrollment_started_at IS NOT NULL AND NEW.enrollment_started_at < OLD.enrollment_started_at)
          OR (OLD.activated_at IS NOT NULL AND NEW.activated_at < OLD.activated_at)
        BEGIN SELECT RAISE(ABORT, 'gateway resident timestamps cannot regress'); END;
        CREATE TRIGGER gateway_resident_state_transition_guard
        BEFORE UPDATE OF phase ON gateway_resident_state
        WHEN NEW.phase != OLD.phase AND NOT (
          (OLD.phase = 'idle' AND NEW.phase = 'enrolling') OR
          (OLD.phase = 'enrolling' AND NEW.phase = 'active') OR
          (OLD.phase = 'active' AND NEW.phase = 'rotating') OR
          (OLD.phase = 'rotating' AND NEW.phase = 'active'))
        BEGIN SELECT RAISE(ABORT, 'invalid gateway resident phase transition'); END;
      `,
    },
    {
      name: '0026-gateway-rotation-proposal-checkpoint',
      sql: `
        ALTER TABLE gateway_resident_state ADD COLUMN rotation_proposed_at INTEGER
          CHECK (
            rotation_proposed_at IS NULL
            OR (
              phase = 'rotating'
              AND typeof(rotation_proposed_at) = 'integer'
              AND rotation_started_at IS NOT NULL
              AND rotation_proposed_at >= rotation_started_at
              AND rotation_proposed_at <= updated_at
            )
          );
        CREATE TRIGGER gateway_resident_state_rotation_proposal_guard
        BEFORE UPDATE OF rotation_proposed_at ON gateway_resident_state
        WHEN NOT (
          (OLD.phase = 'active' AND NEW.phase = 'rotating'
            AND NEW.rotation_proposed_at IS NULL)
          OR
          (OLD.phase = 'rotating' AND NEW.phase = 'rotating'
            AND OLD.rotation_proposed_at IS NULL
            AND NEW.rotation_proposed_at IS NOT NULL)
          OR
          (OLD.phase = 'rotating' AND NEW.phase = 'active'
            AND NEW.rotation_proposed_at IS NULL)
        )
        BEGIN SELECT RAISE(ABORT, 'gateway rotation proposal checkpoint is immutable'); END;
      `,
    },
    {
      name: '0027-discord-person-settings',
      sql: `
        CREATE TABLE discord_person_settings (
          guild_id TEXT NOT NULL
            CHECK (length(guild_id) BETWEEN 1 AND 20 AND guild_id NOT GLOB '*[^0-9]*'),
          user_id TEXT NOT NULL
            CHECK (length(user_id) BETWEEN 1 AND 20 AND user_id NOT GLOB '*[^0-9]*'),
          notify_on_mention INTEGER NOT NULL DEFAULT 0
            CHECK (typeof(notify_on_mention) = 'integer' AND notify_on_mention IN (0, 1)),
          updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
          PRIMARY KEY (guild_id, user_id)
        ) WITHOUT ROWID;
      `,
    },
    {
      name: '0028-worker-completion-delivery',
      sql: `
        ALTER TABLE worker_sessions ADD COLUMN completion_notified_at INTEGER
          CHECK (
            completion_notified_at IS NULL
            OR (
              typeof(completion_notified_at) = 'integer'
              AND completion_notified_at >= created_at
            )
          );
        ALTER TABLE worker_sessions ADD COLUMN runtime_cleanup_completed_at INTEGER
          CHECK (
            runtime_cleanup_completed_at IS NULL
            OR (
              typeof(runtime_cleanup_completed_at) = 'integer'
              AND runtime_cleanup_completed_at >= created_at
            )
          );
        ALTER TABLE worker_sessions ADD COLUMN runtime_cleanup_error TEXT;
        UPDATE worker_sessions
        SET completion_notified_at = MAX(created_at, updated_at)
        WHERE status = 'finished'
           OR (
             status = 'failed'
             AND NOT EXISTS (
               SELECT 1 FROM worker_mailbox_messages message
               WHERE message.session_id = worker_sessions.id
                 AND message.direction = 'worker_to_dispatcher'
                 AND message.kind = 'finish'
             )
           );
        CREATE INDEX worker_sessions_completion_pending_idx
          ON worker_sessions(status, updated_at, id)
          WHERE status IN ('finished', 'failed') AND completion_notified_at IS NULL;
        CREATE INDEX worker_sessions_cleanup_pending_idx
          ON worker_sessions(status, updated_at, id)
          WHERE status IN ('finished', 'failed', 'dismissed')
            AND runtime_cleanup_completed_at IS NULL;
      `,
    },
    {
      name: '0029-context-graph-dark-store',
      sql: `
        CREATE TABLE context_world_events (
          sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id       TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 128),
          world_id       TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          event_kind     TEXT NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 64),
          payload_json   TEXT NOT NULL CHECK (length(payload_json) >= 1 AND json_valid(payload_json)),
          payload_hash   TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
          occurred_at    INTEGER NOT NULL CHECK (typeof(occurred_at) = 'integer' AND occurred_at >= 0),
          recorded_at    INTEGER NOT NULL CHECK (typeof(recorded_at) = 'integer' AND recorded_at >= 0),
          UNIQUE (event_id, world_id)
        );
        CREATE INDEX context_world_events_world_idx
          ON context_world_events(world_id, sequence);
        CREATE TRIGGER context_world_events_no_update
          BEFORE UPDATE ON context_world_events BEGIN
            SELECT RAISE(ABORT, 'context world events are immutable');
          END;
        CREATE TRIGGER context_world_events_no_delete
          BEFORE DELETE ON context_world_events BEGIN
            SELECT RAISE(ABORT, 'context world events are immutable');
          END;

        CREATE TABLE context_branches (
          branch_id        TEXT PRIMARY KEY CHECK (length(branch_id) BETWEEN 1 AND 128),
          world_id         TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          parent_branch_id TEXT,
          status           TEXT NOT NULL CHECK (status IN ('running','yielded','crashed')),
          authority_epoch  INTEGER NOT NULL CHECK (typeof(authority_epoch) = 'integer' AND authority_epoch >= 0),
          started_at       INTEGER NOT NULL CHECK (typeof(started_at) = 'integer' AND started_at >= 0),
          ended_at         INTEGER CHECK (ended_at IS NULL OR (typeof(ended_at) = 'integer' AND ended_at >= started_at)),
          CHECK ((status = 'running' AND ended_at IS NULL) OR (status != 'running' AND ended_at IS NOT NULL)),
          UNIQUE (branch_id, world_id),
          UNIQUE (branch_id, world_id, authority_epoch),
          FOREIGN KEY (parent_branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT
        );
        CREATE INDEX context_branches_world_idx
          ON context_branches(world_id, started_at, branch_id);
        CREATE TRIGGER context_branches_identity_no_update
          BEFORE UPDATE OF branch_id, world_id, parent_branch_id, authority_epoch, started_at
          ON context_branches BEGIN
            SELECT RAISE(ABORT, 'context branch identity is immutable');
          END;
        CREATE TRIGGER context_branches_transition_guard
          BEFORE UPDATE OF status, ended_at ON context_branches
          WHEN NOT (OLD.status = 'running' AND NEW.status IN ('yielded','crashed') AND NEW.ended_at IS NOT NULL)
          BEGIN
            SELECT RAISE(ABORT, 'invalid context branch transition');
          END;
        CREATE TRIGGER context_branches_no_delete
          BEFORE DELETE ON context_branches BEGIN
            SELECT RAISE(ABORT, 'context branches are permanent');
          END;

        CREATE TABLE context_manifests (
          manifest_id           TEXT PRIMARY KEY CHECK (length(manifest_id) BETWEEN 1 AND 128),
          branch_id             TEXT NOT NULL UNIQUE,
          world_id              TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          manifest_hash         TEXT NOT NULL CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
          manifest_json         TEXT NOT NULL CHECK (length(manifest_json) >= 1 AND json_valid(manifest_json)),
          projection_generation INTEGER NOT NULL CHECK (typeof(projection_generation) = 'integer' AND projection_generation >= 0),
          policy_generation     INTEGER NOT NULL CHECK (typeof(policy_generation) = 'integer' AND policy_generation >= 0),
          cache_namespace       TEXT NOT NULL CHECK (length(cache_namespace) BETWEEN 16 AND 256),
          created_at            INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          UNIQUE (manifest_id, world_id),
          UNIQUE (branch_id, manifest_hash),
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT
        );
        CREATE TRIGGER context_manifests_running_branch_guard
          BEFORE INSERT ON context_manifests
          WHEN (SELECT status FROM context_branches WHERE branch_id = NEW.branch_id) != 'running'
          BEGIN
            SELECT RAISE(ABORT, 'context manifest branch is not running');
          END;
        CREATE TRIGGER context_manifests_no_update
          BEFORE UPDATE ON context_manifests BEGIN
            SELECT RAISE(ABORT, 'context manifests are immutable');
          END;
        CREATE TRIGGER context_manifests_no_delete
          BEFORE DELETE ON context_manifests BEGIN
            SELECT RAISE(ABORT, 'context manifests are immutable');
          END;

        CREATE TABLE context_manifest_events (
          manifest_id TEXT NOT NULL,
          event_id    TEXT NOT NULL,
          world_id    TEXT NOT NULL,
          ordinal     INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
          PRIMARY KEY (manifest_id, event_id),
          UNIQUE (manifest_id, ordinal),
          FOREIGN KEY (manifest_id, world_id)
            REFERENCES context_manifests(manifest_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (event_id, world_id)
            REFERENCES context_world_events(event_id, world_id) ON DELETE RESTRICT
        ) WITHOUT ROWID;
        CREATE TRIGGER context_manifest_events_no_update
          BEFORE UPDATE ON context_manifest_events BEGIN
            SELECT RAISE(ABORT, 'context manifest event edges are immutable');
          END;
        CREATE TRIGGER context_manifest_events_no_delete
          BEFORE DELETE ON context_manifest_events BEGIN
            SELECT RAISE(ABORT, 'context manifest event edges are immutable');
          END;

        CREATE TABLE context_capsules (
          sequence              INTEGER PRIMARY KEY AUTOINCREMENT,
          capsule_id            TEXT NOT NULL UNIQUE CHECK (length(capsule_id) BETWEEN 1 AND 128),
          branch_id             TEXT NOT NULL,
          world_id              TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          capsule_kind          TEXT NOT NULL CHECK (capsule_kind IN ('private','root_receipt','self_delta','legacy_opaque')),
          view_manifest_hash    TEXT CHECK (view_manifest_hash IS NULL OR (length(view_manifest_hash) = 64 AND view_manifest_hash NOT GLOB '*[^0-9a-f]*')),
          source_root_hash      TEXT NOT NULL CHECK (length(source_root_hash) = 64 AND source_root_hash NOT GLOB '*[^0-9a-f]*'),
          policy_generation     INTEGER NOT NULL CHECK (typeof(policy_generation) = 'integer' AND policy_generation >= 0),
          summarizer_model      TEXT,
          summarizer_prompt_hash TEXT CHECK (summarizer_prompt_hash IS NULL OR (length(summarizer_prompt_hash) = 64 AND summarizer_prompt_hash NOT GLOB '*[^0-9a-f]*')),
          content_json          TEXT NOT NULL CHECK (length(content_json) >= 1 AND json_valid(content_json)),
          content_hash          TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
          created_at            INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          CHECK (capsule_kind = 'legacy_opaque' OR view_manifest_hash IS NOT NULL),
          UNIQUE (capsule_id, world_id),
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (branch_id, view_manifest_hash)
            REFERENCES context_manifests(branch_id, manifest_hash) ON DELETE RESTRICT
        );
        CREATE INDEX context_capsules_branch_idx
          ON context_capsules(branch_id, created_at, capsule_id);
        CREATE TRIGGER context_capsules_running_branch_guard
          BEFORE INSERT ON context_capsules
          WHEN (SELECT status FROM context_branches WHERE branch_id = NEW.branch_id) != 'running'
          BEGIN
            SELECT RAISE(ABORT, 'context capsule branch is not running');
          END;
        CREATE TRIGGER context_capsules_policy_guard
          BEFORE INSERT ON context_capsules
          WHEN NEW.capsule_kind != 'legacy_opaque'
            AND NEW.policy_generation != (
              SELECT policy_generation FROM context_manifests
              WHERE branch_id = NEW.branch_id
                AND manifest_hash = NEW.view_manifest_hash
            )
          BEGIN
            SELECT RAISE(ABORT, 'context capsule policy does not match its manifest');
          END;
        CREATE TRIGGER context_capsules_no_update
          BEFORE UPDATE ON context_capsules BEGIN
            SELECT RAISE(ABORT, 'context capsules are immutable');
          END;
        CREATE TRIGGER context_capsules_no_delete
          BEFORE DELETE ON context_capsules BEGIN
            SELECT RAISE(ABORT, 'context capsules are immutable');
          END;

        CREATE TABLE context_capsule_edges (
          child_capsule_id  TEXT NOT NULL,
          parent_capsule_id TEXT NOT NULL,
          world_id          TEXT NOT NULL,
          ordinal           INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
          PRIMARY KEY (child_capsule_id, parent_capsule_id),
          UNIQUE (child_capsule_id, ordinal),
          CHECK (child_capsule_id != parent_capsule_id),
          FOREIGN KEY (child_capsule_id, world_id)
            REFERENCES context_capsules(capsule_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (parent_capsule_id, world_id)
            REFERENCES context_capsules(capsule_id, world_id) ON DELETE RESTRICT
        ) WITHOUT ROWID;
        CREATE TRIGGER context_capsule_edges_order_guard
          BEFORE INSERT ON context_capsule_edges
          WHEN (SELECT sequence FROM context_capsules WHERE capsule_id = NEW.parent_capsule_id)
            >= (SELECT sequence FROM context_capsules WHERE capsule_id = NEW.child_capsule_id)
          BEGIN
            SELECT RAISE(ABORT, 'context capsule parent must predate child');
          END;
        CREATE TRIGGER context_capsule_edges_no_update
          BEFORE UPDATE ON context_capsule_edges BEGIN
            SELECT RAISE(ABORT, 'context capsule edges are immutable');
          END;
        CREATE TRIGGER context_capsule_edges_no_delete
          BEFORE DELETE ON context_capsule_edges BEGIN
            SELECT RAISE(ABORT, 'context capsule edges are immutable');
          END;

        CREATE TABLE context_share_grants (
          grant_id             TEXT PRIMARY KEY CHECK (length(grant_id) BETWEEN 1 AND 128),
          shared_event_id      TEXT NOT NULL UNIQUE CHECK (length(shared_event_id) BETWEEN 1 AND 128),
          source_capsule_id    TEXT NOT NULL,
          source_world_id      TEXT NOT NULL CHECK (length(source_world_id) BETWEEN 1 AND 256),
          destination_world_id TEXT NOT NULL CHECK (length(destination_world_id) BETWEEN 1 AND 256),
          canonical_text       TEXT NOT NULL,
          content_hash         TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
          status               TEXT NOT NULL CHECK (status IN ('active','revoked')),
          authority_epoch      INTEGER NOT NULL CHECK (typeof(authority_epoch) = 'integer' AND authority_epoch >= 0),
          created_at           INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          revoked_at           INTEGER CHECK (revoked_at IS NULL OR (typeof(revoked_at) = 'integer' AND revoked_at >= created_at)),
          CHECK (source_world_id != destination_world_id),
          CHECK ((status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)),
          UNIQUE (grant_id, destination_world_id, shared_event_id),
          FOREIGN KEY (source_capsule_id, source_world_id)
            REFERENCES context_capsules(capsule_id, world_id) ON DELETE RESTRICT
        );
        CREATE TRIGGER context_share_grants_identity_no_update
          BEFORE UPDATE OF grant_id, shared_event_id, source_capsule_id, source_world_id, destination_world_id,
            canonical_text, content_hash, authority_epoch, created_at
          ON context_share_grants BEGIN
            SELECT RAISE(ABORT, 'context share grant identity is immutable');
          END;
        CREATE TRIGGER context_share_grants_transition_guard
          BEFORE UPDATE OF status, revoked_at ON context_share_grants
          WHEN NOT (OLD.status = 'active' AND NEW.status = 'revoked' AND NEW.revoked_at IS NOT NULL)
          BEGIN
            SELECT RAISE(ABORT, 'invalid context share grant transition');
          END;
        CREATE TRIGGER context_share_grants_no_delete
          BEFORE DELETE ON context_share_grants BEGIN
            SELECT RAISE(ABORT, 'context share grants are permanent');
          END;

        CREATE TABLE context_manifest_shares (
          manifest_id          TEXT NOT NULL,
          grant_id             TEXT NOT NULL,
          shared_event_id      TEXT NOT NULL,
          destination_world_id TEXT NOT NULL,
          ordinal             INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
          PRIMARY KEY (manifest_id, grant_id),
          UNIQUE (manifest_id, ordinal),
          FOREIGN KEY (manifest_id, destination_world_id)
            REFERENCES context_manifests(manifest_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (grant_id, destination_world_id, shared_event_id)
            REFERENCES context_share_grants(grant_id, destination_world_id, shared_event_id) ON DELETE RESTRICT
        ) WITHOUT ROWID;
        CREATE TRIGGER context_manifest_shares_active_guard
          BEFORE INSERT ON context_manifest_shares
          WHEN (SELECT status FROM context_share_grants WHERE grant_id = NEW.grant_id) != 'active'
          BEGIN
            SELECT RAISE(ABORT, 'revoked context share cannot enter a manifest');
          END;
        CREATE TRIGGER context_manifest_shares_no_update
          BEFORE UPDATE ON context_manifest_shares BEGIN
            SELECT RAISE(ABORT, 'context manifest share edges are immutable');
          END;
        CREATE TRIGGER context_manifest_shares_no_delete
          BEFORE DELETE ON context_manifest_shares BEGIN
            SELECT RAISE(ABORT, 'context manifest share edges are immutable');
          END;

        CREATE TABLE context_legacy_import_receipts (
          receipt_id       TEXT PRIMARY KEY CHECK (length(receipt_id) BETWEEN 1 AND 128),
          source_ref       TEXT NOT NULL UNIQUE CHECK (length(source_ref) BETWEEN 1 AND 512),
          source_hash      TEXT NOT NULL CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
          source_size      INTEGER NOT NULL CHECK (typeof(source_size) = 'integer' AND source_size >= 0),
          artifact_ref     TEXT NOT NULL CHECK (length(artifact_ref) BETWEEN 1 AND 512),
          import_generation INTEGER NOT NULL CHECK (typeof(import_generation) = 'integer' AND import_generation >= 1),
          capsule_id       TEXT NOT NULL UNIQUE REFERENCES context_capsules(capsule_id) ON DELETE RESTRICT,
          imported_at      INTEGER NOT NULL CHECK (typeof(imported_at) = 'integer' AND imported_at >= 0)
        );
        CREATE TRIGGER context_legacy_import_kind_guard
          BEFORE INSERT ON context_legacy_import_receipts
          WHEN (SELECT capsule_kind FROM context_capsules WHERE capsule_id = NEW.capsule_id) != 'legacy_opaque'
          BEGIN
            SELECT RAISE(ABORT, 'legacy import must reference a legacy opaque capsule');
          END;
        CREATE TRIGGER context_legacy_import_receipts_no_update
          BEFORE UPDATE ON context_legacy_import_receipts BEGIN
            SELECT RAISE(ABORT, 'context legacy import receipts are immutable');
          END;
        CREATE TRIGGER context_legacy_import_receipts_no_delete
          BEFORE DELETE ON context_legacy_import_receipts BEGIN
            SELECT RAISE(ABORT, 'context legacy import receipts are immutable');
          END;

        CREATE TABLE context_effects (
          effect_id            TEXT PRIMARY KEY CHECK (length(effect_id) BETWEEN 1 AND 128),
          branch_id            TEXT NOT NULL,
          world_id             TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          destination_world_id TEXT NOT NULL CHECK (length(destination_world_id) BETWEEN 1 AND 256),
          effect_kind          TEXT NOT NULL CHECK (length(effect_kind) BETWEEN 1 AND 64),
          authority_epoch      INTEGER NOT NULL CHECK (typeof(authority_epoch) = 'integer' AND authority_epoch >= 0),
          payload_json         TEXT NOT NULL CHECK (length(payload_json) >= 1 AND json_valid(payload_json)),
          payload_hash         TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
          idempotency_key      TEXT,
          status               TEXT NOT NULL CHECK (status IN ('prepared','observed','failed','uncertain')),
          prepared_at          INTEGER NOT NULL CHECK (typeof(prepared_at) = 'integer' AND prepared_at >= 0),
          resolved_at          INTEGER CHECK (resolved_at IS NULL OR (typeof(resolved_at) = 'integer' AND resolved_at >= prepared_at)),
          observation_json     TEXT CHECK (observation_json IS NULL OR json_valid(observation_json)),
          CHECK (world_id = destination_world_id),
          CHECK ((status = 'prepared' AND resolved_at IS NULL AND observation_json IS NULL)
            OR (status != 'prepared' AND resolved_at IS NOT NULL)),
          UNIQUE (branch_id, idempotency_key),
          FOREIGN KEY (branch_id, world_id, authority_epoch)
            REFERENCES context_branches(branch_id, world_id, authority_epoch) ON DELETE RESTRICT
        );
        CREATE INDEX context_effects_recovery_idx
          ON context_effects(status, prepared_at, effect_id);
        CREATE TRIGGER context_effects_running_branch_guard
          BEFORE INSERT ON context_effects
          WHEN (SELECT status FROM context_branches WHERE branch_id = NEW.branch_id) != 'running'
          BEGIN
            SELECT RAISE(ABORT, 'context effect branch is not running');
          END;
        CREATE TRIGGER context_effects_identity_no_update
          BEFORE UPDATE OF effect_id, branch_id, world_id, destination_world_id, effect_kind,
            authority_epoch, payload_json, payload_hash, idempotency_key, prepared_at
          ON context_effects BEGIN
            SELECT RAISE(ABORT, 'context effect issuance is immutable');
          END;
        CREATE TRIGGER context_effects_transition_guard
          BEFORE UPDATE OF status, resolved_at, observation_json ON context_effects
          WHEN NOT (OLD.status = 'prepared' AND NEW.status IN ('observed','failed','uncertain') AND NEW.resolved_at IS NOT NULL)
          BEGIN
            SELECT RAISE(ABORT, 'invalid context effect transition');
          END;
        CREATE TRIGGER context_effects_no_delete
          BEFORE DELETE ON context_effects BEGIN
            SELECT RAISE(ABORT, 'context effects are permanent');
          END;
        CREATE TRIGGER context_branches_unresolved_effect_guard
          BEFORE UPDATE OF status ON context_branches
          WHEN EXISTS (
            SELECT 1 FROM context_effects
            WHERE branch_id = OLD.branch_id AND status = 'prepared'
          )
          BEGIN
            SELECT RAISE(ABORT, 'context branch has a prepared effect');
          END;

        CREATE TABLE context_continuation_head (
          singleton     INTEGER PRIMARY KEY CHECK (singleton = 1),
          branch_id     TEXT,
          world_id      TEXT,
          revision      INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision >= 0),
          updated_at    INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
          CHECK ((branch_id IS NULL) = (world_id IS NULL)),
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT
        );
        INSERT INTO context_continuation_head(singleton, branch_id, world_id, revision, updated_at)
          VALUES (1, NULL, NULL, 0, 0);

        CREATE TABLE context_continuation_advances (
          revision              INTEGER PRIMARY KEY CHECK (revision >= 1),
          predecessor_branch_id TEXT,
          predecessor_world_id  TEXT,
          branch_id             TEXT NOT NULL UNIQUE,
          world_id              TEXT NOT NULL,
          advanced_at           INTEGER NOT NULL CHECK (typeof(advanced_at) = 'integer' AND advanced_at >= 0),
          CHECK ((predecessor_branch_id IS NULL) = (predecessor_world_id IS NULL)),
          CHECK (predecessor_branch_id IS NULL OR predecessor_branch_id != branch_id),
          FOREIGN KEY (predecessor_branch_id, predecessor_world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT
        );
        CREATE TRIGGER context_continuation_advances_guard
          BEFORE INSERT ON context_continuation_advances
          WHEN NEW.revision != (SELECT revision + 1 FROM context_continuation_head WHERE singleton = 1)
            OR NEW.predecessor_branch_id IS NOT (SELECT branch_id FROM context_continuation_head WHERE singleton = 1)
            OR NEW.predecessor_world_id IS NOT (SELECT world_id FROM context_continuation_head WHERE singleton = 1)
            OR (SELECT status FROM context_branches WHERE branch_id = NEW.branch_id) != 'yielded'
          BEGIN
            SELECT RAISE(ABORT, 'invalid context continuation advance');
          END;
        CREATE TRIGGER context_continuation_advances_no_update
          BEFORE UPDATE ON context_continuation_advances BEGIN
            SELECT RAISE(ABORT, 'context continuation advances are immutable');
          END;
        CREATE TRIGGER context_continuation_advances_no_delete
          BEFORE DELETE ON context_continuation_advances BEGIN
            SELECT RAISE(ABORT, 'context continuation advances are immutable');
          END;

        CREATE TRIGGER context_continuation_head_guard
          BEFORE UPDATE ON context_continuation_head
          WHEN NEW.singleton != 1 OR NEW.revision != OLD.revision + 1 OR NEW.updated_at < OLD.updated_at
          BEGIN
            SELECT RAISE(ABORT, 'invalid context continuation head advance');
          END;
        CREATE TRIGGER context_continuation_head_no_delete
          BEFORE DELETE ON context_continuation_head BEGIN
            SELECT RAISE(ABORT, 'context continuation head is permanent');
          END;

        CREATE TABLE context_graph_activation (
          singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
          mode       TEXT NOT NULL CHECK (mode IN ('dark','active')),
          epoch      INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch >= 0),
          created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          updated_at INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= created_at)
        );
        INSERT INTO context_graph_activation(singleton, mode, epoch, created_at, updated_at)
          VALUES (1, 'dark', 0, 0, 0);
        CREATE TRIGGER context_graph_activation_guard
          BEFORE UPDATE ON context_graph_activation
          WHEN NOT (OLD.mode = 'dark' AND NEW.mode = 'active'
            AND NEW.epoch = OLD.epoch + 1 AND NEW.created_at = OLD.created_at
            AND NEW.updated_at >= OLD.updated_at)
          BEGIN
            SELECT RAISE(ABORT, 'context graph activation is one-way');
          END;
        CREATE TRIGGER context_graph_activation_no_delete
          BEFORE DELETE ON context_graph_activation BEGIN
            SELECT RAISE(ABORT, 'context graph activation state is permanent');
          END;
      `,
    },
    {
      name: '0030-context-root-coordinator',
      sql: `
        CREATE TABLE context_v30_running_guard (
          running_count INTEGER NOT NULL CHECK (running_count = 0)
        );
        INSERT INTO context_v30_running_guard(running_count)
          SELECT count(*) FROM context_branches WHERE status = 'running';
        DROP TABLE context_v30_running_guard;

        CREATE UNIQUE INDEX context_branches_single_running_idx
          ON context_branches(status) WHERE status = 'running';

        CREATE TABLE context_branch_starts (
          branch_id              TEXT PRIMARY KEY,
          world_id               TEXT NOT NULL,
          base_revision          INTEGER NOT NULL CHECK (typeof(base_revision) = 'integer' AND base_revision >= 0),
          predecessor_branch_id  TEXT,
          predecessor_world_id   TEXT,
          started_at             INTEGER NOT NULL CHECK (typeof(started_at) = 'integer' AND started_at >= 0),
          CHECK ((predecessor_branch_id IS NULL) = (predecessor_world_id IS NULL)),
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (predecessor_branch_id, predecessor_world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT
        );
        CREATE TRIGGER context_branch_starts_head_guard
          BEFORE INSERT ON context_branch_starts
          WHEN NEW.base_revision != (
              SELECT revision FROM context_continuation_head WHERE singleton = 1
            )
            OR NEW.predecessor_branch_id IS NOT (
              SELECT branch_id FROM context_continuation_head WHERE singleton = 1
            )
            OR NEW.predecessor_world_id IS NOT (
              SELECT world_id FROM context_continuation_head WHERE singleton = 1
            )
          BEGIN
            SELECT RAISE(ABORT, 'context branch start does not match continuation head');
          END;
        CREATE TRIGGER context_branch_starts_no_update
          BEFORE UPDATE ON context_branch_starts BEGIN
            SELECT RAISE(ABORT, 'context branch starts are immutable');
          END;
        CREATE TRIGGER context_branch_starts_no_delete
          BEFORE DELETE ON context_branch_starts BEGIN
            SELECT RAISE(ABORT, 'context branch starts are immutable');
          END;
        CREATE TRIGGER context_branches_coordinated_return_guard
          BEFORE UPDATE OF status ON context_branches
          WHEN NEW.status = 'yielded'
            AND EXISTS (
              SELECT 1 FROM context_branch_starts
              WHERE branch_id = OLD.branch_id
            )
            AND (
              NOT EXISTS (
                SELECT 1 FROM context_capsules
                WHERE branch_id = OLD.branch_id AND capsule_kind = 'private'
              )
              OR NOT EXISTS (
                SELECT 1 FROM context_capsules
                WHERE branch_id = OLD.branch_id AND capsule_kind = 'root_receipt'
              )
            )
          BEGIN
            SELECT RAISE(ABORT, 'coordinated branch return capsules are incomplete');
          END;
        CREATE TRIGGER context_continuation_head_advance_guard
          BEFORE UPDATE ON context_continuation_head
          WHEN NOT EXISTS (
            SELECT 1 FROM context_continuation_advances
            WHERE revision = NEW.revision
              AND branch_id = NEW.branch_id
              AND world_id = NEW.world_id
              AND advanced_at = NEW.updated_at
          )
          BEGIN
            SELECT RAISE(ABORT, 'context continuation head lacks an advance receipt');
          END;

        CREATE TABLE context_root_coordinator (
          singleton              INTEGER PRIMARY KEY CHECK (singleton = 1),
          active_branch_id       TEXT UNIQUE,
          active_world_id        TEXT,
          base_revision          INTEGER NOT NULL CHECK (typeof(base_revision) = 'integer' AND base_revision >= 0),
          predecessor_branch_id  TEXT,
          predecessor_world_id   TEXT,
          updated_at             INTEGER NOT NULL CHECK (typeof(updated_at) = 'integer' AND updated_at >= 0),
          CHECK ((active_branch_id IS NULL) = (active_world_id IS NULL)),
          CHECK ((predecessor_branch_id IS NULL) = (predecessor_world_id IS NULL)),
          FOREIGN KEY (active_branch_id, active_world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (predecessor_branch_id, predecessor_world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT
        );
        INSERT INTO context_root_coordinator(
          singleton, active_branch_id, active_world_id, base_revision,
          predecessor_branch_id, predecessor_world_id, updated_at
        ) SELECT 1, NULL, NULL, revision, branch_id, world_id, updated_at
          FROM context_continuation_head WHERE singleton = 1;
        CREATE TRIGGER context_root_coordinator_transition_guard
          BEFORE UPDATE ON context_root_coordinator
          WHEN NEW.singleton != 1 OR NEW.updated_at < OLD.updated_at OR NOT (
            (
              OLD.active_branch_id IS NULL
              AND NEW.active_branch_id IS NOT NULL
              AND NEW.base_revision = OLD.base_revision
              AND NEW.predecessor_branch_id IS OLD.predecessor_branch_id
              AND NEW.predecessor_world_id IS OLD.predecessor_world_id
              AND EXISTS (
                SELECT 1 FROM context_branch_starts AS starts
                JOIN context_branches AS branches
                  ON branches.branch_id = starts.branch_id
                 AND branches.world_id = starts.world_id
                WHERE starts.branch_id = NEW.active_branch_id
                  AND starts.world_id = NEW.active_world_id
                  AND starts.base_revision = NEW.base_revision
                  AND starts.predecessor_branch_id IS NEW.predecessor_branch_id
                  AND starts.predecessor_world_id IS NEW.predecessor_world_id
                  AND branches.status = 'running'
              )
            )
            OR (
              OLD.active_branch_id IS NOT NULL
              AND NEW.active_branch_id IS NULL
              AND NEW.base_revision = OLD.base_revision
              AND NEW.predecessor_branch_id IS OLD.predecessor_branch_id
              AND NEW.predecessor_world_id IS OLD.predecessor_world_id
              AND (SELECT status FROM context_branches
                   WHERE branch_id = OLD.active_branch_id) = 'crashed'
            )
            OR (
              NEW.active_branch_id IS NULL
              AND NEW.base_revision = OLD.base_revision + 1
              AND NEW.base_revision = (
                SELECT revision FROM context_continuation_head WHERE singleton = 1
              )
              AND NEW.predecessor_branch_id IS (
                SELECT branch_id FROM context_continuation_head WHERE singleton = 1
              )
              AND NEW.predecessor_world_id IS (
                SELECT world_id FROM context_continuation_head WHERE singleton = 1
              )
              AND (
                OLD.active_branch_id IS NULL
                OR (
                  OLD.active_branch_id IS NEW.predecessor_branch_id
                  AND OLD.active_world_id IS NEW.predecessor_world_id
                )
              )
            )
          )
          BEGIN
            SELECT RAISE(ABORT, 'invalid context root coordinator transition');
          END;
        CREATE TRIGGER context_root_coordinator_no_delete
          BEFORE DELETE ON context_root_coordinator BEGIN
            SELECT RAISE(ABORT, 'context root coordinator is permanent');
          END;

        CREATE TABLE context_branch_recoveries (
          branch_id              TEXT PRIMARY KEY,
          world_id               TEXT NOT NULL,
          base_revision          INTEGER NOT NULL CHECK (typeof(base_revision) = 'integer' AND base_revision >= 0),
          predecessor_branch_id  TEXT,
          predecessor_world_id   TEXT,
          uncertain_effects      INTEGER NOT NULL CHECK (typeof(uncertain_effects) = 'integer' AND uncertain_effects >= 0),
          recovered_at           INTEGER NOT NULL CHECK (typeof(recovered_at) = 'integer' AND recovered_at >= 0),
          CHECK ((predecessor_branch_id IS NULL) = (predecessor_world_id IS NULL)),
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (predecessor_branch_id, predecessor_world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT
        );
        CREATE TRIGGER context_branch_recoveries_crashed_guard
          BEFORE INSERT ON context_branch_recoveries
          WHEN (SELECT status FROM context_branches WHERE branch_id = NEW.branch_id) != 'crashed'
          BEGIN
            SELECT RAISE(ABORT, 'context recovery requires a crashed branch');
          END;
        CREATE TRIGGER context_branch_recoveries_no_update
          BEFORE UPDATE ON context_branch_recoveries BEGIN
            SELECT RAISE(ABORT, 'context branch recoveries are immutable');
          END;
        CREATE TRIGGER context_branch_recoveries_no_delete
          BEFORE DELETE ON context_branch_recoveries BEGIN
            SELECT RAISE(ABORT, 'context branch recoveries are immutable');
          END;
      `,
    },
    {
      name: '0031-context-shadow-projections',
      sql: `
        CREATE TABLE context_shadow_projection_plans (
          plan_id       TEXT PRIMARY KEY CHECK (length(plan_id) BETWEEN 1 AND 128),
          world_id      TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          wake_event_id TEXT NOT NULL CHECK (length(wake_event_id) BETWEEN 1 AND 128),
          plan_json     TEXT NOT NULL CHECK (length(plan_json) >= 1 AND json_valid(plan_json)),
          plan_hash     TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
          created_at    INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          UNIQUE (plan_id, world_id),
          FOREIGN KEY (wake_event_id, world_id)
            REFERENCES context_world_events(event_id, world_id) ON DELETE RESTRICT
        );
        CREATE TRIGGER context_shadow_projection_plans_no_update
          BEFORE UPDATE ON context_shadow_projection_plans BEGIN
            SELECT RAISE(ABORT, 'context shadow projection plans are immutable');
          END;
        CREATE TRIGGER context_shadow_projection_plans_no_delete
          BEFORE DELETE ON context_shadow_projection_plans BEGIN
            SELECT RAISE(ABORT, 'context shadow projection plans are immutable');
          END;

        CREATE TABLE context_shadow_request_observations (
          sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
          observation_id TEXT NOT NULL UNIQUE CHECK (length(observation_id) BETWEEN 1 AND 128),
          plan_id         TEXT NOT NULL,
          world_id        TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          surface         TEXT NOT NULL CHECK (surface IN ('openai-chat','openai-responses','codex-responses','anthropic-messages')),
          actual_hash     TEXT NOT NULL CHECK (length(actual_hash) = 64 AND actual_hash NOT GLOB '*[^0-9a-f]*'),
          actual_bytes    INTEGER NOT NULL CHECK (typeof(actual_bytes) = 'integer' AND actual_bytes >= 0),
          result          TEXT NOT NULL CHECK (result IN ('ineligible','equal','different')),
          reason          TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
          expected_hash   TEXT CHECK (expected_hash IS NULL OR (length(expected_hash) = 64 AND expected_hash NOT GLOB '*[^0-9a-f]*')),
          expected_bytes  INTEGER CHECK (expected_bytes IS NULL OR (typeof(expected_bytes) = 'integer' AND expected_bytes >= 0)),
          observed_at     INTEGER NOT NULL CHECK (typeof(observed_at) = 'integer' AND observed_at >= 0),
          CHECK (
            (result = 'ineligible' AND reason IS NOT NULL AND expected_hash IS NULL AND expected_bytes IS NULL)
            OR
            (
              result = 'equal' AND reason IS NULL
              AND expected_hash IS NOT NULL AND expected_bytes IS NOT NULL
              AND actual_hash = expected_hash AND actual_bytes = expected_bytes
            )
            OR
            (
              result = 'different' AND reason IS NULL
              AND expected_hash IS NOT NULL AND expected_bytes IS NOT NULL
              AND (actual_hash != expected_hash OR actual_bytes != expected_bytes)
            )
          ),
          FOREIGN KEY (plan_id, world_id)
            REFERENCES context_shadow_projection_plans(plan_id, world_id) ON DELETE RESTRICT
        );
        CREATE INDEX context_shadow_request_observations_plan_idx
          ON context_shadow_request_observations(plan_id, sequence);
        CREATE TRIGGER context_shadow_request_observations_no_update
          BEFORE UPDATE ON context_shadow_request_observations BEGIN
            SELECT RAISE(ABORT, 'context shadow request observations are immutable');
          END;
        CREATE TRIGGER context_shadow_request_observations_no_delete
          BEFORE DELETE ON context_shadow_request_observations BEGIN
            SELECT RAISE(ABORT, 'context shadow request observations are immutable');
          END;
      `,
    },
    {
      name: '0032-context-event-message-projections',
      sql: `
        CREATE TABLE context_event_message_projections (
          projection_id       TEXT PRIMARY KEY CHECK (length(projection_id) BETWEEN 1 AND 128),
          source_event_id     TEXT NOT NULL CHECK (length(source_event_id) BETWEEN 1 AND 128),
          world_id            TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          renderer_generation INTEGER NOT NULL CHECK (typeof(renderer_generation) = 'integer' AND renderer_generation >= 1),
          message_json        TEXT NOT NULL CHECK (length(message_json) >= 1 AND json_valid(message_json)),
          message_hash        TEXT NOT NULL CHECK (length(message_hash) = 64 AND message_hash NOT GLOB '*[^0-9a-f]*'),
          created_at          INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          UNIQUE (source_event_id, renderer_generation),
          UNIQUE (projection_id, world_id),
          FOREIGN KEY (source_event_id, world_id)
            REFERENCES context_world_events(event_id, world_id) ON DELETE RESTRICT
        );
        CREATE INDEX context_event_message_projections_world_idx
          ON context_event_message_projections(world_id, source_event_id, renderer_generation);
        CREATE TRIGGER context_event_message_projections_no_update
          BEFORE UPDATE ON context_event_message_projections BEGIN
            SELECT RAISE(ABORT, 'context event message projections are immutable');
          END;
        CREATE TRIGGER context_event_message_projections_no_delete
          BEFORE DELETE ON context_event_message_projections BEGIN
            SELECT RAISE(ABORT, 'context event message projections are immutable');
          END;
      `,
    },
    {
      name: '0033-context-system-layer-projections',
      sql: `
        CREATE TABLE context_system_layer_projections (
          layer_id             TEXT PRIMARY KEY CHECK (length(layer_id) BETWEEN 1 AND 128),
          layer_kind           TEXT NOT NULL CHECK (layer_kind IN ('runtime_contract','identity','integrated_self','world_policy','private_frontier','legacy_memory','legacy_focus','runtime_hint')),
          visibility           TEXT NOT NULL CHECK (visibility IN ('global_contract','integrated_self','integrated_self_candidate','world','private_root','legacy_mixed')),
          world_id             TEXT CHECK (world_id IS NULL OR length(world_id) BETWEEN 1 AND 256),
          renderer_generation  INTEGER NOT NULL CHECK (typeof(renderer_generation) = 'integer' AND renderer_generation >= 1),
          policy_generation    INTEGER NOT NULL CHECK (typeof(policy_generation) = 'integer' AND policy_generation >= 1),
          source_kind          TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 64),
          source_hash          TEXT NOT NULL CHECK (length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'),
          content_text         TEXT NOT NULL,
          content_hash         TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
          content_bytes        INTEGER NOT NULL CHECK (typeof(content_bytes) = 'integer' AND content_bytes >= 0),
          created_at           INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          CHECK (
            (visibility = 'world' AND world_id IS NOT NULL)
            OR (visibility != 'world' AND world_id IS NULL)
          )
        );
        CREATE INDEX context_system_layer_projections_scope_idx
          ON context_system_layer_projections(visibility, world_id, layer_kind, renderer_generation, policy_generation);
        CREATE TRIGGER context_system_layer_projections_no_update
          BEFORE UPDATE ON context_system_layer_projections BEGIN
            SELECT RAISE(ABORT, 'context system layer projections are immutable');
          END;
        CREATE TRIGGER context_system_layer_projections_no_delete
          BEFORE DELETE ON context_system_layer_projections BEGIN
            SELECT RAISE(ABORT, 'context system layer projections are immutable');
          END;
      `,
    },
    {
      name: '0034-context-local-branch-request-views',
      sql: `
        CREATE TABLE context_local_branch_request_views (
          request_view_id              TEXT PRIMARY KEY CHECK (length(request_view_id) BETWEEN 1 AND 128),
          branch_id                    TEXT NOT NULL UNIQUE,
          world_id                     TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          manifest_id                  TEXT NOT NULL UNIQUE,
          manifest_hash                TEXT NOT NULL CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
          view_json                    TEXT NOT NULL CHECK (length(view_json) >= 1 AND json_valid(view_json)),
          view_hash                    TEXT NOT NULL CHECK (length(view_hash) = 64 AND view_hash NOT GLOB '*[^0-9a-f]*'),
          message_renderer_generation  INTEGER NOT NULL CHECK (typeof(message_renderer_generation) = 'integer' AND message_renderer_generation >= 1),
          system_renderer_generation   INTEGER NOT NULL CHECK (typeof(system_renderer_generation) = 'integer' AND system_renderer_generation >= 1),
          policy_generation            INTEGER NOT NULL CHECK (typeof(policy_generation) = 'integer' AND policy_generation >= 1),
          system_layer_count           INTEGER NOT NULL CHECK (typeof(system_layer_count) = 'integer' AND system_layer_count >= 1),
          message_projection_count     INTEGER NOT NULL CHECK (typeof(message_projection_count) = 'integer' AND message_projection_count >= 0),
          tool_mode                    TEXT NOT NULL CHECK (tool_mode = 'none'),
          runnable                     INTEGER NOT NULL CHECK (runnable = 0),
          created_at                   INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at >= 0),
          UNIQUE (request_view_id, world_id),
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (manifest_id, world_id)
            REFERENCES context_manifests(manifest_id, world_id) ON DELETE RESTRICT
        );
        CREATE TRIGGER context_local_branch_request_views_lineage_guard
          BEFORE INSERT ON context_local_branch_request_views
          WHEN NOT EXISTS (
            SELECT 1
            FROM context_branch_starts AS starts
            JOIN context_branches AS branches
              ON branches.branch_id = starts.branch_id
             AND branches.world_id = starts.world_id
            JOIN context_manifests AS manifests
              ON manifests.branch_id = starts.branch_id
             AND manifests.world_id = starts.world_id
            JOIN context_root_coordinator AS coordinator
              ON coordinator.singleton = 1
            JOIN context_continuation_head AS head
              ON head.singleton = 1
            WHERE starts.branch_id = NEW.branch_id
              AND starts.world_id = NEW.world_id
              AND branches.status = 'running'
              AND manifests.manifest_id = NEW.manifest_id
              AND manifests.manifest_hash = NEW.manifest_hash
              AND manifests.projection_generation = NEW.message_renderer_generation
              AND manifests.policy_generation = NEW.policy_generation
              AND coordinator.active_branch_id = NEW.branch_id
              AND coordinator.active_world_id = NEW.world_id
              AND coordinator.base_revision = starts.base_revision
              AND coordinator.predecessor_branch_id IS starts.predecessor_branch_id
              AND coordinator.predecessor_world_id IS starts.predecessor_world_id
              AND head.revision = starts.base_revision
              AND head.branch_id IS starts.predecessor_branch_id
              AND head.world_id IS starts.predecessor_world_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'context local branch request view lineage is invalid');
          END;
        CREATE TRIGGER context_local_branch_request_views_no_update
          BEFORE UPDATE ON context_local_branch_request_views BEGIN
            SELECT RAISE(ABORT, 'context local branch request views are immutable');
          END;
        CREATE TRIGGER context_local_branch_request_views_no_delete
          BEFORE DELETE ON context_local_branch_request_views BEGIN
            SELECT RAISE(ABORT, 'context local branch request views are immutable');
          END;

        CREATE TABLE context_local_branch_request_system_layers (
          request_view_id TEXT NOT NULL,
          layer_id        TEXT NOT NULL,
          world_id        TEXT NOT NULL,
          ordinal         INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
          PRIMARY KEY (request_view_id, layer_id),
          UNIQUE (request_view_id, ordinal),
          FOREIGN KEY (request_view_id, world_id)
            REFERENCES context_local_branch_request_views(request_view_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (layer_id)
            REFERENCES context_system_layer_projections(layer_id) ON DELETE RESTRICT
        ) WITHOUT ROWID;
        CREATE TRIGGER context_local_branch_request_system_layers_scope_guard
          BEFORE INSERT ON context_local_branch_request_system_layers
          WHEN NOT EXISTS (
            SELECT 1
            FROM context_local_branch_request_views AS views
            JOIN context_system_layer_projections AS layers
              ON layers.layer_id = NEW.layer_id
            WHERE views.request_view_id = NEW.request_view_id
              AND views.world_id = NEW.world_id
              AND layers.renderer_generation = views.system_renderer_generation
              AND layers.policy_generation = views.policy_generation
              AND (
                (layers.visibility = 'global_contract' AND layers.world_id IS NULL AND layers.layer_kind = 'runtime_contract')
                OR (layers.visibility = 'integrated_self' AND layers.world_id IS NULL AND layers.layer_kind IN ('identity','integrated_self'))
                OR (layers.visibility = 'world' AND layers.world_id = views.world_id AND layers.layer_kind = 'world_policy')
              )
          )
          BEGIN
            SELECT RAISE(ABORT, 'context local branch request system layer is invalid');
          END;
        CREATE TRIGGER context_local_branch_request_system_layers_no_update
          BEFORE UPDATE ON context_local_branch_request_system_layers BEGIN
            SELECT RAISE(ABORT, 'context local branch request system layer edges are immutable');
          END;
        CREATE TRIGGER context_local_branch_request_system_layers_no_delete
          BEFORE DELETE ON context_local_branch_request_system_layers BEGIN
            SELECT RAISE(ABORT, 'context local branch request system layer edges are immutable');
          END;

        CREATE TABLE context_local_branch_request_messages (
          request_view_id TEXT NOT NULL,
          projection_id   TEXT NOT NULL,
          world_id        TEXT NOT NULL,
          ordinal         INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal >= 0),
          PRIMARY KEY (request_view_id, projection_id),
          UNIQUE (request_view_id, ordinal),
          FOREIGN KEY (request_view_id, world_id)
            REFERENCES context_local_branch_request_views(request_view_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (projection_id, world_id)
            REFERENCES context_event_message_projections(projection_id, world_id) ON DELETE RESTRICT
        ) WITHOUT ROWID;
        CREATE TRIGGER context_local_branch_request_messages_lineage_guard
          BEFORE INSERT ON context_local_branch_request_messages
          WHEN NOT EXISTS (
            SELECT 1
            FROM context_local_branch_request_views AS views
            JOIN context_manifests AS manifests
              ON manifests.manifest_id = views.manifest_id
             AND manifests.world_id = views.world_id
            JOIN context_manifest_events AS events
              ON events.manifest_id = manifests.manifest_id
             AND events.world_id = manifests.world_id
             AND events.ordinal = NEW.ordinal
            JOIN context_event_message_projections AS projections
              ON projections.projection_id = NEW.projection_id
             AND projections.world_id = NEW.world_id
             AND projections.source_event_id = events.event_id
            WHERE views.request_view_id = NEW.request_view_id
              AND views.world_id = NEW.world_id
              AND projections.renderer_generation = views.message_renderer_generation
          )
          BEGIN
            SELECT RAISE(ABORT, 'context local branch request message is invalid');
          END;
        CREATE TRIGGER context_local_branch_request_messages_no_update
          BEFORE UPDATE ON context_local_branch_request_messages BEGIN
            SELECT RAISE(ABORT, 'context local branch request message edges are immutable');
          END;
        CREATE TRIGGER context_local_branch_request_messages_no_delete
          BEFORE DELETE ON context_local_branch_request_messages BEGIN
            SELECT RAISE(ABORT, 'context local branch request message edges are immutable');
          END;
      `,
    },
    {
      name: '0035-context-dark-ingress-admissions',
      sql: `
        CREATE TABLE context_dark_ingress_generations (
          queue_generation          INTEGER PRIMARY KEY
            CHECK (typeof(queue_generation) = 'integer' AND queue_generation >= 1),
          first_admissible_sequence INTEGER NOT NULL UNIQUE
            CHECK (typeof(first_admissible_sequence) = 'integer' AND first_admissible_sequence >= 1),
          activation_epoch          INTEGER NOT NULL
            CHECK (typeof(activation_epoch) = 'integer' AND activation_epoch >= 0),
          UNIQUE (queue_generation, activation_epoch)
        ) WITHOUT ROWID;
        CREATE TRIGGER context_dark_ingress_generations_insert_guard
          BEFORE INSERT ON context_dark_ingress_generations
          WHEN NOT (
            NEW.queue_generation = COALESCE(
              (SELECT MAX(queue_generation) + 1 FROM context_dark_ingress_generations),
              1
            )
            AND NEW.first_admissible_sequence =
              COALESCE((SELECT MAX(sequence) FROM context_world_events), 0) + 1
            AND EXISTS (
              SELECT 1 FROM context_graph_activation
              WHERE singleton = 1
                AND mode = 'dark'
                AND epoch = NEW.activation_epoch
            )
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark ingress generation lineage is invalid');
          END;
        INSERT INTO context_dark_ingress_generations(
          queue_generation, first_admissible_sequence, activation_epoch
        )
        SELECT
          1,
          COALESCE((SELECT MAX(sequence) FROM context_world_events), 0) + 1,
          epoch
        FROM context_graph_activation
        WHERE singleton = 1;
        CREATE TRIGGER context_dark_ingress_generations_no_update
          BEFORE UPDATE ON context_dark_ingress_generations BEGIN
            SELECT RAISE(ABORT, 'context dark ingress generations are immutable');
          END;
        CREATE TRIGGER context_dark_ingress_generations_no_delete
          BEFORE DELETE ON context_dark_ingress_generations BEGIN
            SELECT RAISE(ABORT, 'context dark ingress generations are immutable');
          END;

        CREATE TABLE context_dark_ingress_admissions (
          event_id                    TEXT PRIMARY KEY
            CHECK (length(event_id) BETWEEN 1 AND 128),
          world_id                    TEXT NOT NULL
            CHECK (length(world_id) BETWEEN 1 AND 256),
          source_sequence             INTEGER NOT NULL UNIQUE
            CHECK (typeof(source_sequence) = 'integer' AND source_sequence >= 1),
          activation_epoch            INTEGER NOT NULL
            CHECK (typeof(activation_epoch) = 'integer' AND activation_epoch >= 0),
          queue_generation            INTEGER NOT NULL
            CHECK (typeof(queue_generation) = 'integer' AND queue_generation >= 1),
          wake_class                  TEXT NOT NULL CHECK (wake_class = 'text_user_turn'),
          message_renderer_generation INTEGER NOT NULL
            CHECK (typeof(message_renderer_generation) = 'integer' AND message_renderer_generation >= 1),
          admitted_at                 INTEGER NOT NULL
            CHECK (typeof(admitted_at) = 'integer' AND admitted_at >= 0),
          UNIQUE (event_id, world_id),
          FOREIGN KEY (event_id, world_id)
            REFERENCES context_world_events(event_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (queue_generation, activation_epoch)
            REFERENCES context_dark_ingress_generations(queue_generation, activation_epoch)
            ON DELETE RESTRICT
        ) WITHOUT ROWID;
        CREATE TRIGGER context_dark_ingress_admissions_lineage_guard
          BEFORE INSERT ON context_dark_ingress_admissions
          WHEN NOT EXISTS (
            SELECT 1
            FROM context_world_events AS events
            JOIN context_dark_ingress_generations AS generations
              ON generations.queue_generation = NEW.queue_generation
             AND generations.activation_epoch = NEW.activation_epoch
            JOIN context_graph_activation AS activation
              ON activation.singleton = 1
            WHERE events.event_id = NEW.event_id
              AND events.world_id = NEW.world_id
              AND events.sequence = NEW.source_sequence
              AND events.event_kind GLOB 'inbound:*'
              AND events.sequence >= generations.first_admissible_sequence
              AND activation.mode = 'dark'
              AND activation.epoch = NEW.activation_epoch
              AND NEW.admitted_at >= events.recorded_at
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark ingress admission lineage is invalid');
          END;
        CREATE TRIGGER context_dark_ingress_admissions_no_update
          BEFORE UPDATE ON context_dark_ingress_admissions BEGIN
            SELECT RAISE(ABORT, 'context dark ingress admissions are immutable');
          END;
        CREATE TRIGGER context_dark_ingress_admissions_no_delete
          BEFORE DELETE ON context_dark_ingress_admissions BEGIN
            SELECT RAISE(ABORT, 'context dark ingress admissions are immutable');
          END;
      `,
    },
    {
      name: '0036-context-dark-pending-branch-attempts',
      sql: `
        CREATE TABLE context_dark_pending_branch_attempts (
          branch_id             TEXT PRIMARY KEY CHECK (length(branch_id) BETWEEN 1 AND 128),
          world_id              TEXT NOT NULL CHECK (length(world_id) BETWEEN 1 AND 256),
          request_view_id       TEXT NOT NULL UNIQUE CHECK (length(request_view_id) BETWEEN 1 AND 128),
          activation_epoch      INTEGER NOT NULL CHECK (typeof(activation_epoch) = 'integer' AND activation_epoch >= 0),
          queue_generation      INTEGER NOT NULL CHECK (typeof(queue_generation) = 'integer' AND queue_generation >= 1),
          max_events            INTEGER NOT NULL CHECK (typeof(max_events) = 'integer' AND max_events BETWEEN 1 AND 1024),
          selected_count        INTEGER NOT NULL CHECK (typeof(selected_count) = 'integer' AND selected_count BETWEEN 1 AND max_events),
          first_source_sequence INTEGER NOT NULL CHECK (typeof(first_source_sequence) = 'integer' AND first_source_sequence >= 1),
          last_source_sequence  INTEGER NOT NULL CHECK (typeof(last_source_sequence) = 'integer' AND last_source_sequence >= first_source_sequence),
          assembled_at          INTEGER NOT NULL CHECK (typeof(assembled_at) = 'integer' AND assembled_at >= 0),
          UNIQUE (branch_id, world_id),
          UNIQUE (request_view_id, world_id),
          FOREIGN KEY (branch_id, world_id)
            REFERENCES context_branches(branch_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (request_view_id, world_id)
            REFERENCES context_local_branch_request_views(request_view_id, world_id) ON DELETE RESTRICT,
          FOREIGN KEY (queue_generation, activation_epoch)
            REFERENCES context_dark_ingress_generations(queue_generation, activation_epoch) ON DELETE RESTRICT
        ) WITHOUT ROWID;

        CREATE TABLE context_dark_pending_branch_abandonments (
          branch_id    TEXT PRIMARY KEY CHECK (length(branch_id) BETWEEN 1 AND 128),
          abandoned_at INTEGER NOT NULL CHECK (typeof(abandoned_at) = 'integer' AND abandoned_at >= 0),
          reason       TEXT NOT NULL CHECK (reason = 'coordinator_recovery'),
          FOREIGN KEY (branch_id)
            REFERENCES context_dark_pending_branch_attempts(branch_id) ON DELETE RESTRICT
        ) WITHOUT ROWID;

        CREATE TRIGGER context_dark_pending_branch_attempts_lineage_guard
          BEFORE INSERT ON context_dark_pending_branch_attempts
          WHEN NOT (
            EXISTS (
              SELECT 1
              FROM context_branches AS branches
              JOIN context_branch_starts AS starts
                ON starts.branch_id = branches.branch_id
               AND starts.world_id = branches.world_id
              JOIN context_local_branch_request_views AS views
                ON views.branch_id = branches.branch_id
               AND views.world_id = branches.world_id
              JOIN context_manifests AS manifests
                ON manifests.manifest_id = views.manifest_id
               AND manifests.world_id = views.world_id
              JOIN context_root_coordinator AS coordinator
                ON coordinator.singleton = 1
              JOIN context_continuation_head AS head
                ON head.singleton = 1
              JOIN context_graph_activation AS activation
                ON activation.singleton = 1
              WHERE branches.branch_id = NEW.branch_id
                AND branches.world_id = NEW.world_id
                AND branches.status = 'running'
                AND views.request_view_id = NEW.request_view_id
                AND views.tool_mode = 'none'
                AND views.runnable = 0
                AND views.message_projection_count = NEW.selected_count
                AND manifests.branch_id = NEW.branch_id
                AND NOT EXISTS (
                  SELECT 1 FROM context_manifest_shares
                  WHERE manifest_id = manifests.manifest_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM context_effects
                  WHERE branch_id = NEW.branch_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM context_capsules
                  WHERE branch_id = NEW.branch_id
                )
                AND coordinator.active_branch_id = NEW.branch_id
                AND coordinator.active_world_id = NEW.world_id
                AND coordinator.base_revision = starts.base_revision
                AND coordinator.predecessor_branch_id IS starts.predecessor_branch_id
                AND coordinator.predecessor_world_id IS starts.predecessor_world_id
                AND head.revision = starts.base_revision
                AND head.branch_id IS starts.predecessor_branch_id
                AND head.world_id IS starts.predecessor_world_id
                AND activation.mode = 'dark'
                AND activation.epoch = NEW.activation_epoch
                AND branches.started_at = NEW.assembled_at
                AND starts.started_at = NEW.assembled_at
                AND manifests.created_at = NEW.assembled_at
                AND views.created_at = NEW.assembled_at
            )
            AND (
              SELECT COUNT(*)
              FROM context_local_branch_request_messages
              WHERE request_view_id = NEW.request_view_id
            ) = NEW.selected_count
            AND (
              SELECT COUNT(*)
              FROM context_local_branch_request_system_layers
              WHERE request_view_id = NEW.request_view_id
            ) = (
              SELECT system_layer_count
              FROM context_local_branch_request_views
              WHERE request_view_id = NEW.request_view_id
            )
            AND (
              SELECT COUNT(*)
              FROM context_manifest_events
              WHERE manifest_id = (
                SELECT manifest_id
                FROM context_local_branch_request_views
                WHERE request_view_id = NEW.request_view_id
              )
            ) = NEW.selected_count
            AND COALESCE(
              (
                SELECT MAX(admissions.admitted_at)
                FROM context_local_branch_request_messages AS request_messages
                JOIN context_event_message_projections AS projections
                  ON projections.projection_id = request_messages.projection_id
                 AND projections.world_id = request_messages.world_id
                JOIN context_dark_ingress_admissions AS admissions
                  ON admissions.event_id = projections.source_event_id
                 AND admissions.world_id = projections.world_id
                WHERE request_messages.request_view_id = NEW.request_view_id
              ),
              NEW.assembled_at + 1
            ) <= NEW.assembled_at
            AND COALESCE(
              (
                SELECT MAX(projections.created_at)
                FROM context_local_branch_request_messages AS request_messages
                JOIN context_event_message_projections AS projections
                  ON projections.projection_id = request_messages.projection_id
                 AND projections.world_id = request_messages.world_id
                WHERE request_messages.request_view_id = NEW.request_view_id
              ),
              NEW.assembled_at + 1
            ) <= NEW.assembled_at
            AND COALESCE(
              (
                SELECT MAX(layers.created_at)
                FROM context_local_branch_request_system_layers AS request_layers
                JOIN context_system_layer_projections AS layers
                  ON layers.layer_id = request_layers.layer_id
                WHERE request_layers.request_view_id = NEW.request_view_id
              ),
              NEW.assembled_at + 1
            ) <= NEW.assembled_at
            AND (
              SELECT MIN(ordinal)
              FROM context_local_branch_request_messages
              WHERE request_view_id = NEW.request_view_id
            ) = 0
            AND (
              SELECT MAX(ordinal)
              FROM context_local_branch_request_messages
              WHERE request_view_id = NEW.request_view_id
            ) = NEW.selected_count - 1
            AND NOT EXISTS (
              SELECT 1
              FROM context_local_branch_request_messages AS request_messages
              JOIN context_event_message_projections AS projections
                ON projections.projection_id = request_messages.projection_id
               AND projections.world_id = request_messages.world_id
              LEFT JOIN context_dark_ingress_admissions AS admissions
                ON admissions.event_id = projections.source_event_id
               AND admissions.world_id = projections.world_id
               AND admissions.activation_epoch = NEW.activation_epoch
               AND admissions.queue_generation = NEW.queue_generation
               AND admissions.message_renderer_generation = projections.renderer_generation
              WHERE request_messages.request_view_id = NEW.request_view_id
                AND admissions.event_id IS NULL
            )
            AND (
              SELECT MIN(admissions.source_sequence)
              FROM context_local_branch_request_messages AS request_messages
              JOIN context_event_message_projections AS projections
                ON projections.projection_id = request_messages.projection_id
               AND projections.world_id = request_messages.world_id
              JOIN context_dark_ingress_admissions AS admissions
                ON admissions.event_id = projections.source_event_id
               AND admissions.world_id = projections.world_id
              WHERE request_messages.request_view_id = NEW.request_view_id
            ) = NEW.first_source_sequence
            AND (
              SELECT MAX(admissions.source_sequence)
              FROM context_local_branch_request_messages AS request_messages
              JOIN context_event_message_projections AS projections
                ON projections.projection_id = request_messages.projection_id
               AND projections.world_id = request_messages.world_id
              JOIN context_dark_ingress_admissions AS admissions
                ON admissions.event_id = projections.source_event_id
               AND admissions.world_id = projections.world_id
              WHERE request_messages.request_view_id = NEW.request_view_id
            ) = NEW.last_source_sequence
            AND NEW.first_source_sequence = (
              SELECT MIN(source_sequence) FROM context_dark_ingress_admissions
            )
            AND (
              SELECT COUNT(*) FROM context_dark_ingress_admissions
              WHERE source_sequence BETWEEN NEW.first_source_sequence AND NEW.last_source_sequence
            ) = NEW.selected_count
            AND NOT EXISTS (
              SELECT 1
              FROM context_local_branch_request_messages AS request_messages
              JOIN context_event_message_projections AS projections
                ON projections.projection_id = request_messages.projection_id
               AND projections.world_id = request_messages.world_id
              JOIN context_dark_ingress_admissions AS admissions
                ON admissions.event_id = projections.source_event_id
               AND admissions.world_id = projections.world_id
              WHERE request_messages.request_view_id = NEW.request_view_id
                AND request_messages.ordinal != (
                  SELECT COUNT(*) - 1
                  FROM context_dark_ingress_admissions AS prior
                  WHERE prior.source_sequence BETWEEN NEW.first_source_sequence AND admissions.source_sequence
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM context_dark_pending_branch_attempts AS active_attempts
              LEFT JOIN context_dark_pending_branch_abandonments AS abandonments
                ON abandonments.branch_id = active_attempts.branch_id
              WHERE abandonments.branch_id IS NULL
                AND active_attempts.first_source_sequence <= NEW.last_source_sequence
                AND active_attempts.last_source_sequence >= NEW.first_source_sequence
            )
            AND NOT (
              NEW.selected_count < NEW.max_events
              AND EXISTS (
                SELECT 1
                FROM context_dark_ingress_admissions AS next_admission
                JOIN context_local_branch_request_views AS views
                  ON views.request_view_id = NEW.request_view_id
                JOIN context_event_message_projections AS projections
                  ON projections.source_event_id = next_admission.event_id
                 AND projections.world_id = next_admission.world_id
                 AND projections.renderer_generation = next_admission.message_renderer_generation
                WHERE next_admission.source_sequence = (
                  SELECT MIN(source_sequence)
                  FROM context_dark_ingress_admissions
                  WHERE source_sequence > NEW.last_source_sequence
                )
                  AND next_admission.world_id = NEW.world_id
                  AND next_admission.activation_epoch = NEW.activation_epoch
                  AND next_admission.queue_generation = NEW.queue_generation
                  AND next_admission.message_renderer_generation = views.message_renderer_generation
              )
            )
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch attempt lineage is invalid');
          END;
        CREATE TRIGGER context_dark_pending_branch_attempts_no_update
          BEFORE UPDATE ON context_dark_pending_branch_attempts BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch attempts are immutable');
          END;
        CREATE TRIGGER context_dark_pending_branch_attempts_no_delete
          BEFORE DELETE ON context_dark_pending_branch_attempts BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch attempts are immutable');
          END;
        CREATE TRIGGER context_dark_pending_branch_request_messages_sealed
          BEFORE INSERT ON context_local_branch_request_messages
          WHEN EXISTS (
            SELECT 1 FROM context_dark_pending_branch_attempts
            WHERE request_view_id = NEW.request_view_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch request messages are sealed');
          END;
        CREATE TRIGGER context_dark_pending_branch_system_layers_sealed
          BEFORE INSERT ON context_local_branch_request_system_layers
          WHEN EXISTS (
            SELECT 1 FROM context_dark_pending_branch_attempts
            WHERE request_view_id = NEW.request_view_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch system layers are sealed');
          END;
        CREATE TRIGGER context_dark_pending_branch_manifest_events_sealed
          BEFORE INSERT ON context_manifest_events
          WHEN EXISTS (
            SELECT 1
            FROM context_dark_pending_branch_attempts AS attempts
            JOIN context_local_branch_request_views AS views
              ON views.request_view_id = attempts.request_view_id
             AND views.world_id = attempts.world_id
            WHERE views.manifest_id = NEW.manifest_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch manifest events are sealed');
          END;
        CREATE TRIGGER context_dark_pending_branch_manifest_shares_sealed
          BEFORE INSERT ON context_manifest_shares
          WHEN EXISTS (
            SELECT 1
            FROM context_dark_pending_branch_attempts AS attempts
            JOIN context_local_branch_request_views AS views
              ON views.request_view_id = attempts.request_view_id
             AND views.world_id = attempts.world_id
            WHERE views.manifest_id = NEW.manifest_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch manifest shares are sealed');
          END;

        CREATE TRIGGER context_dark_pending_branch_abandonments_lineage_guard
          BEFORE INSERT ON context_dark_pending_branch_abandonments
          WHEN NOT EXISTS (
            SELECT 1
            FROM context_dark_pending_branch_attempts AS attempts
            JOIN context_branches AS branches
              ON branches.branch_id = attempts.branch_id
             AND branches.world_id = attempts.world_id
            JOIN context_branch_starts AS starts
              ON starts.branch_id = branches.branch_id
             AND starts.world_id = branches.world_id
            JOIN context_root_coordinator AS coordinator
              ON coordinator.singleton = 1
            JOIN context_continuation_head AS head
              ON head.singleton = 1
            WHERE attempts.branch_id = NEW.branch_id
              AND branches.status = 'running'
              AND coordinator.active_branch_id = attempts.branch_id
              AND coordinator.active_world_id = attempts.world_id
              AND coordinator.base_revision = starts.base_revision
              AND coordinator.predecessor_branch_id IS starts.predecessor_branch_id
              AND coordinator.predecessor_world_id IS starts.predecessor_world_id
              AND head.revision = starts.base_revision
              AND head.branch_id IS starts.predecessor_branch_id
              AND head.world_id IS starts.predecessor_world_id
              AND NEW.abandoned_at >= attempts.assembled_at
              AND NOT EXISTS (
                SELECT 1 FROM context_effects
                WHERE branch_id = attempts.branch_id
              )
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch abandonment lineage is invalid');
          END;
        CREATE TRIGGER context_dark_pending_branch_abandonments_no_update
          BEFORE UPDATE ON context_dark_pending_branch_abandonments BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch abandonments are immutable');
          END;
        CREATE TRIGGER context_dark_pending_branch_abandonments_no_delete
          BEFORE DELETE ON context_dark_pending_branch_abandonments BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch abandonments are immutable');
          END;

        CREATE TRIGGER context_dark_pending_branch_effect_guard
          BEFORE INSERT ON context_effects
          WHEN EXISTS (
            SELECT 1 FROM context_dark_pending_branch_attempts
            WHERE branch_id = NEW.branch_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch cannot issue effects');
          END;
        CREATE TRIGGER context_dark_pending_branch_capsule_guard
          BEFORE INSERT ON context_capsules
          WHEN EXISTS (
            SELECT 1 FROM context_dark_pending_branch_attempts
            WHERE branch_id = NEW.branch_id
          )
          BEGIN
            SELECT RAISE(ABORT, 'context dark pending branch cannot create capsules');
          END;
        CREATE TRIGGER context_dark_pending_branch_transition_guard
          BEFORE UPDATE OF status, ended_at ON context_branches
          WHEN EXISTS (
            SELECT 1 FROM context_dark_pending_branch_attempts
            WHERE branch_id = OLD.branch_id
          )
            AND NOT (
              OLD.status = 'running'
              AND NEW.status = 'crashed'
              AND NEW.ended_at IS NOT NULL
              AND NEW.ended_at >= (
                SELECT abandoned_at
                FROM context_dark_pending_branch_abandonments
                WHERE branch_id = OLD.branch_id
              )
              AND EXISTS (
                SELECT 1 FROM context_dark_pending_branch_abandonments
                WHERE branch_id = OLD.branch_id
              )
            )
          BEGIN
            SELECT RAISE(ABORT, 'invalid context dark pending branch transition');
          END;
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
  const db = new DatabaseSync(path.join(dataDirectory, 'elpis.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(db);
  return db;
}
