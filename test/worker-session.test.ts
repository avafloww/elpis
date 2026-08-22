import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../src/store/db.js";
import { createWorkerControlCredential } from "../src/worker/auth.js";
import { resolveWorkerSession } from "../src/worker/session.js";

test("worker control token resolves immutable model, Mind, runtime, and provenance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-session-"));
  const db = openDatabase(dir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO mind_items (id, title, body, kind, status, priority, created_by, created_at, updated_at)
     VALUES (?, ?, '', 'task', 'in_progress', 2, 'agent', ?, ?)`,
  ).run("elm-worker001", "worker task", now, now);
  const credential = createWorkerControlCredential();
  db.prepare(
    `INSERT INTO worker_sessions
      (id, slug, status, model_ref, mind_id, runtime, control_token_digest, created_at, updated_at)
     VALUES (?, ?, 'running', ?, ?, 'kubernetes', ?, ?, ?)`,
  ).run(
    "wrk-worker1",
    "quiet-otter",
    "codex/sol",
    "elm-worker001",
    credential.digest,
    now,
    now,
  );

  assert.deepEqual(resolveWorkerSession(db, credential.token), {
    sessionId: "wrk-worker1",
    worker: "worker:quiet-otter",
    modelRef: "codex/sol",
    mindId: "elm-worker001",
    runtime: "kubernetes",
  });
  assert.equal(
    resolveWorkerSession(db, createWorkerControlCredential().token),
    null,
  );
  db.prepare(
    "UPDATE worker_sessions SET status = 'dismissed' WHERE id = 'wrk-worker1'",
  ).run();
  assert.equal(
    resolveWorkerSession(db, credential.token),
    null,
    "dismissal revokes the credential",
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy SDK sessions cannot authenticate as scoped workers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-session-"));
  const db = openDatabase(dir);
  const credential = createWorkerControlCredential();
  db.prepare(
    `INSERT INTO fleet_sessions
      (id, name, cwd, status, model, effort, created_at, updated_at, runtime, control_token_digest)
     VALUES ('f-legacy', 'legacy', '/work', 'running', 'opus', '', 1, 1, 'claude-sdk', ?)`,
  ).run(credential.digest);
  assert.equal(resolveWorkerSession(db, credential.token), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
