import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  WorkerMailboxBroker,
  WorkerMailboxError,
} from "../src/worker/mailbox.js";
import { createWorkerControlCredential } from "../src/worker/auth.js";
import { noopLogger } from "../src/lib/log.js";
import { openDatabase } from "../src/store/db.js";
import { MindService } from "../src/store/mind.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mailbox-"));
  const db = openDatabase(dir);
  const scheduler = {
    create() {
      throw new Error("unused");
    },
    delete() {
      return true;
    },
    update() {
      return null;
    },
  };
  const mind = new MindService({
    db,
    scheduler: scheduler as never,
    logger: noopLogger,
  });
  const root = mind.create({ title: "worker root", kind: "project" });
  const otherRoot = mind.create({
    title: "other worker root",
    kind: "project",
  });
  const credential = createWorkerControlCredential();
  const other = createWorkerControlCredential();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO worker_sessions
     (id,slug,status,model_ref,mind_id,runtime,control_token_digest,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    "wrk-worker1",
    "quiet-otter",
    "running",
    "p/model",
    root.id,
    "kubernetes",
    credential.digest,
    now,
    now,
  );
  insert.run(
    "wrk-worker2",
    "still-fox",
    "running",
    "p/model",
    otherRoot.id,
    "kubernetes",
    other.digest,
    now,
    now,
  );
  let clock = 1000;
  return {
    dir,
    db,
    credential,
    other,
    broker: new WorkerMailboxBroker(db, () => ++clock),
  };
}

function close(f: ReturnType<typeof fixture>) {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test("mailbox delivers retry-safe dispatcher messages and receiver-owned acknowledgments", () => {
  const f = fixture();
  const sent = f.broker.sendToWorker(
    "wrk-worker1",
    "dispatch-1",
    "do the work",
  );
  const retried = f.broker.sendToWorker(
    "wrk-worker1",
    "dispatch-1",
    "do the work",
  );
  assert.equal(retried.id, sent.id);
  assert.equal(sent.sender, "dispatcher");
  assert.throws(
    () => f.broker.sendToWorker("wrk-worker1", "dispatch-1", "different"),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "conflict",
  );
  const pulled = f.broker.pullForWorker(f.credential.token);
  assert.equal(pulled.binding.worker, "worker:quiet-otter");
  assert.deepEqual(
    pulled.messages.map((message) => message.id),
    [sent.id],
  );
  assert.equal(f.broker.acknowledgeForWorker(f.credential.token, [sent.id]), 1);
  assert.equal(f.broker.acknowledgeForWorker(f.credential.token, [sent.id]), 1);
  assert.deepEqual(f.broker.pullForWorker(f.credential.token).messages, []);
  close(f);
});

test("mailbox keeps directions isolated and acknowledgments atomic", () => {
  const f = fixture();
  const incoming = f.broker.sendToWorker("wrk-worker1", "dispatch-1", "hello");
  const outgoing = f.broker.postFromWorker(
    f.credential.token,
    "progress-1",
    "message",
    "working",
  );
  assert.equal(outgoing.sender, "worker:quiet-otter");
  assert.deepEqual(
    f.broker.pullFromWorker("wrk-worker1").map((message) => message.id),
    [outgoing.id],
  );
  assert.throws(
    () =>
      f.broker.acknowledgeForWorker(f.credential.token, [
        incoming.id,
        outgoing.id,
      ]),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "not_found",
  );
  assert.deepEqual(
    f.broker
      .pullForWorker(f.credential.token)
      .messages.map((message) => message.id),
    [incoming.id],
  );
  assert.equal(f.broker.acknowledgeFromWorker("wrk-worker1", [outgoing.id]), 1);
  assert.deepEqual(f.broker.pullFromWorker("wrk-worker1"), []);
  assert.deepEqual(f.broker.pullFromWorker("wrk-worker2"), []);
  close(f);
});

test("mailbox records one idempotent terminal finish and rejects a second", () => {
  const f = fixture();
  const finish = f.broker.postFromWorker(
    f.credential.token,
    "finish-1",
    "finish",
    "done",
  );
  assert.equal(
    f.broker.postFromWorker(f.credential.token, "finish-1", "finish", "done")
      .id,
    finish.id,
  );
  assert.throws(
    () =>
      f.broker.postFromWorker(
        f.credential.token,
        "finish-2",
        "finish",
        "done again",
      ),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "conflict",
  );
  assert.throws(
    () =>
      f.broker.postFromWorker(
        f.credential.token,
        "progress-after-finish",
        "message",
        "too late",
      ),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "conflict",
  );
  assert.throws(
    () =>
      f.broker.sendToWorker("wrk-worker1", "dispatch-after-finish", "too late"),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "conflict",
  );
  assert.deepEqual(
    f.broker.pullFromWorker("wrk-worker1").map((message) => message.kind),
    ["finish"],
  );
  close(f);
});

test("source-bound worker cannot finish before matching artifact custody", () => {
  const f = fixture();
  f.db
    .prepare(
      `UPDATE worker_sessions
       SET source_revision = ?, source_sha256 = ?, source_bytes = ?
       WHERE id = 'wrk-worker1'`,
    )
    .run("a".repeat(40), "b".repeat(64), 10);
  assert.throws(
    () =>
      f.broker.postFromWorker(
        f.credential.token,
        "finish-before-artifact",
        "finish",
        "done",
      ),
    (error: unknown) =>
      error instanceof WorkerMailboxError &&
      error.code === "conflict" &&
      /artifact must be in custody/.test(error.message),
  );
  f.db
    .prepare(
      `INSERT INTO worker_workspace_artifacts
       (session_id,artifact_key,kind,source_sha256,sha256,size_bytes,relative_path,created_at)
       VALUES ('wrk-worker1','workspace.patch.gz','unified_patch_gzip',?,?,1,'artifacts/path',1)`,
    )
    .run("b".repeat(64), "c".repeat(64));
  const finish = f.broker.postFromWorker(
    f.credential.token,
    "finish-after-artifact",
    "finish",
    "done",
  );
  assert.equal(finish.kind, "finish");
  close(f);
});

test("mailbox token and session gates fail closed", () => {
  const f = fixture();
  assert.throws(
    () => f.broker.pullForWorker("x".repeat(43)),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "unauthorized",
  );
  assert.throws(
    () => f.broker.sendToWorker("missing", "dispatch-1", "x"),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "not_found",
  );
  f.db
    .prepare(
      "UPDATE worker_sessions SET status = 'dismissed' WHERE id = 'wrk-worker1'",
    )
    .run();
  assert.throws(
    () =>
      f.broker.postFromWorker(
        f.credential.token,
        "progress-1",
        "message",
        "late",
      ),
    (error: unknown) =>
      error instanceof WorkerMailboxError && error.code === "unauthorized",
  );
  close(f);
});
