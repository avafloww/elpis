import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDatabase } from "../src/store/db.js";
import { createActorControlCredential } from "../src/fleet/actor-auth.js";
import { resolveActorSession } from "../src/fleet/actor-session.js";

test("actor control token resolves immutable model, Mind, runtime, and provenance", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-session-"));
  const db = openDatabase(dir);
  const now = Date.now();
  db.prepare(
    `INSERT INTO mind_items (id, title, body, kind, status, priority, created_by, created_at, updated_at)
     VALUES (?, ?, '', 'task', 'in_progress', 2, 'agent', ?, ?)`,
  ).run("elm-actor001", "actor task", now, now);
  const credential = createActorControlCredential();
  db.prepare(
    `INSERT INTO fleet_sessions
      (id, name, cwd, status, model, effort, created_at, updated_at, model_ref, mind_id, runtime, control_token_digest)
     VALUES (?, ?, ?, 'running', ?, '', ?, ?, ?, ?, 'kubernetes', ?)`,
  ).run(
    "f-actor1",
    "quiet-otter",
    "/work",
    "wire-name",
    now,
    now,
    "codex/sol",
    "elm-actor001",
    credential.digest,
  );

  assert.deepEqual(resolveActorSession(db, credential.token), {
    sessionId: "f-actor1",
    actor: "fleet:quiet-otter",
    modelRef: "codex/sol",
    mindId: "elm-actor001",
    runtime: "kubernetes",
  });
  assert.equal(
    resolveActorSession(db, createActorControlCredential().token),
    null,
  );
  db.prepare(
    "UPDATE fleet_sessions SET status = 'dismissed' WHERE id = 'f-actor1'",
  ).run();
  assert.equal(
    resolveActorSession(db, credential.token),
    null,
    "dismissal revokes the credential",
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("legacy SDK sessions cannot authenticate as scoped actors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-session-"));
  const db = openDatabase(dir);
  const credential = createActorControlCredential();
  db.prepare(
    `INSERT INTO fleet_sessions
      (id, name, cwd, status, model, effort, created_at, updated_at, runtime, control_token_digest)
     VALUES ('f-legacy', 'legacy', '/work', 'running', 'opus', '', 1, 1, 'claude-sdk', ?)`,
  ).run(credential.digest);
  assert.equal(resolveActorSession(db, credential.token), null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
