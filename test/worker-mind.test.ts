import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkerControlCredential } from "../src/worker/auth.js";
import { WorkerMindBroker, WorkerMindError } from "../src/worker/mind.js";
import { noopLogger } from "../src/lib/log.js";
import { openDatabase } from "../src/store/db.js";
import { MindService } from "../src/store/mind.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-mind-"));
  const db = openDatabase(dir);
  let scheduled = 0;
  const scheduler = {
    create(opts: { name: string; payload: string; nextRunAt: number }) {
      return {
        id: ++scheduled,
        name: opts.name,
        kind: "custom" as const,
        channelId: null,
        payload: opts.payload,
        nextRunAt: opts.nextRunAt,
        intervalMs: null,
        nagIntervalMs: null,
        snoozeUntil: null,
        doneAt: null,
        createdAt: Date.now(),
        nagCount: 0,
        parentId: null,
      };
    },
    delete() {
      return true;
    },
    update() {
      return null;
    },
  };
  const mind = new MindService({ db, scheduler, logger: noopLogger });
  const root = mind.create({ title: "root", kind: "project" });
  const child = mind.create({ title: "child", parentId: root.id });
  const outside = mind.create({ title: "outside" });
  const credential = createWorkerControlCredential();
  const now = Date.now();
  db.prepare(
    `INSERT INTO worker_sessions (id,slug,status,model_ref,mind_id,runtime,control_token_digest,created_at,updated_at) VALUES ('wrk-worker1','quiet-otter','running','p/worker',?,'kubernetes',?,'${now}','${now}')`,
  ).run(root.id, credential.digest);
  return {
    dir,
    db,
    mind,
    root,
    child,
    outside,
    token: credential.token,
    broker: new WorkerMindBroker(db, mind),
  };
}

function close(f: ReturnType<typeof fixture>) {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test("worker Mind broker permits only linked root and descendants", () => {
  const f = fixture();
  assert.equal(f.broker.get(f.token).item.id, f.root.id);
  assert.equal(f.broker.get(f.token, f.child.id).item.id, f.child.id);
  assert.throws(
    () => f.broker.get(f.token, f.outside.id),
    (error: unknown) =>
      error instanceof WorkerMindError && error.code === "outside_scope",
  );
  assert.throws(
    () => f.broker.addComment(f.token, f.outside.id, "escape"),
    (error: unknown) =>
      error instanceof WorkerMindError && error.code === "outside_scope",
  );
  close(f);
});

test("worker Mind mutations inject server-bound worker provenance", () => {
  const f = fixture();
  const created = f.broker.createChild(f.token, { title: "made here" });
  assert.equal(created.parentId, f.root.id);
  assert.equal(created.createdBy, "worker:quiet-otter");
  const comment = f.broker.addComment(f.token, created.id, "progress");
  assert.equal(comment.author, "worker:quiet-otter");
  const done = f.broker.setStatus(f.token, created.id, "done");
  assert.equal(done.status, "done");
  const actors = done.events.map((event) => event.actor);
  assert.ok(actors.includes("worker:quiet-otter"));
  assert.throws(
    () =>
      f.broker.createChild(f.token, {
        title: "escape",
        parentId: f.outside.id,
      }),
    (error: unknown) =>
      error instanceof WorkerMindError && error.code === "outside_scope",
  );
  close(f);
});
