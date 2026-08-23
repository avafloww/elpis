import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase, runMigrations } from "../src/store/db.js";
import { MindStore } from "../src/store/mind.js";
import {
  resolveSecretarySession,
  secretaryControlTokenDigest,
} from "../src/secretary/session.js";

function replaceWithV23Closure(db: ReturnType<typeof openDatabase>): void {
  const ledgerTriggers = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='elpis_migrations' ORDER BY name",
    )
    .all() as { name: string; sql: string }[];
  for (const trigger of ledgerTriggers)
    db.exec(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);
  db.exec(`
    DROP TABLE secretary_turns;
    DROP TABLE secretary_sessions;

    CREATE TABLE secretary_sessions (
      id TEXT PRIMARY KEY,
      root_mind_id TEXT NOT NULL REFERENCES mind_items(id) ON DELETE RESTRICT,
      status TEXT NOT NULL,
      model_ref TEXT NOT NULL,
      runtime TEXT NOT NULL,
      control_token_digest TEXT NOT NULL UNIQUE,
      pod_name TEXT,
      pod_uid TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_error TEXT
    );
    CREATE UNIQUE INDEX secretary_sessions_active_root_idx
      ON secretary_sessions(root_mind_id)
      WHERE status IN ('starting','ready');
    CREATE INDEX secretary_sessions_status_idx
      ON secretary_sessions(status, created_at);
    CREATE TRIGGER secretary_sessions_identity_no_update
      BEFORE UPDATE OF id, root_mind_id, model_ref, runtime, control_token_digest
      ON secretary_sessions BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_sessions_status_transition_guard
      BEFORE UPDATE OF status ON secretary_sessions BEGIN SELECT 1; END;

    CREATE TABLE secretary_turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES secretary_sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claimed_at INTEGER,
      completed_at INTEGER,
      last_error TEXT,
      UNIQUE(session_id, sequence)
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
      ON secretary_turns BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_turns_status_transition_guard
      BEFORE UPDATE OF status ON secretary_turns BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_turns_pristine_insert_guard
      BEFORE INSERT ON secretary_turns WHEN 0 BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_sessions_settle_turns_before_terminal
      BEFORE UPDATE OF status ON secretary_sessions BEGIN SELECT 1; END;
    CREATE TRIGGER secretary_turns_lifecycle_update_guard
      BEFORE UPDATE ON secretary_turns WHEN 0 BEGIN SELECT 1; END;

    PRAGMA user_version=23;
  `);
  db.prepare(
    "DELETE FROM elpis_migrations WHERE component='core' AND name='0024-global-secretary-authority'",
  ).run();
  for (const trigger of ledgerTriggers) db.exec(trigger.sql);
}

test("v24 preserves v23 session and turn history while converting root to optional hint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "secretary-v24-"));
  const db = openDatabase(dir);
  const mind = new MindStore(db);
  const root = mind.create({ title: "legacy exact root" });
  replaceWithV23Closure(db);

  const sessionId = "sec-" + "m".repeat(22);
  const turnId = "stn-" + "n".repeat(22);
  const token = "z".repeat(43);
  const request = JSON.stringify({ role: "user", content: "legacy question" });
  const response = JSON.stringify({
    role: "assistant",
    content: "legacy durable answer",
  });
  db.prepare(
    `INSERT INTO secretary_sessions
       (id,root_mind_id,status,model_ref,runtime,control_token_digest,
        pod_name,pod_uid,created_at,updated_at,last_error)
     VALUES (?,?,'closed','p/secretary','kubernetes',?,'pod-old','uid-old',10,20,NULL)`,
  ).run(sessionId, root.id, secretaryControlTokenDigest(token));
  db.prepare(
    `INSERT INTO secretary_turns
       (id,session_id,sequence,status,request_json,response_json,
        created_at,updated_at,claimed_at,completed_at,last_error)
     VALUES (?,?,1,'completed',?,?,11,19,12,19,NULL)`,
  ).run(turnId, sessionId, request, response);

  runMigrations(db);

  const session = db
    .prepare("SELECT * FROM secretary_sessions WHERE id=?")
    .get(sessionId) as Record<string, unknown>;
  assert.equal(session.hint_mind_id, root.id);
  assert.equal(Object.hasOwn(session, "root_mind_id"), false);
  assert.equal(session.status, "closed");
  assert.equal(session.pod_name, "pod-old");
  assert.equal(session.pod_uid, "uid-old");
  const turn = db
    .prepare("SELECT * FROM secretary_turns WHERE id=?")
    .get(turnId) as Record<string, unknown>;
  assert.equal(turn.session_id, sessionId);
  assert.equal(turn.status, "completed");
  assert.equal(turn.request_json, request);
  assert.equal(turn.response_json, response);
  assert.equal(turn.claimed_at, 12);
  assert.equal(turn.completed_at, 19);
  assert.equal(
    resolveSecretarySession(db, token),
    null,
    "closed token stays revoked",
  );
  assert.equal(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
    24,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM elpis_migrations WHERE component='core' AND name='0024-global-secretary-authority'",
        )
        .get() as { n: number }
    ).n,
    1,
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('secretary_turns_v23','secretary_sessions_v22')",
        )
        .get() as { n: number }
    ).n,
    0,
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
