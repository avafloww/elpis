import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createActorControlCredential } from "../src/fleet/actor-auth.js";
import { ActorMindBroker, ActorMindError } from "../src/fleet/actor-mind.js";
import { noopLogger } from "../src/lib/log.js";
import { openDatabase } from "../src/store/db.js";
import { MindService } from "../src/store/mind.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-mind-"));
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
  const credential = createActorControlCredential();
  const now = Date.now();
  db.prepare(
    `INSERT INTO fleet_sessions (id,name,cwd,status,model,effort,created_at,updated_at,model_ref,mind_id,runtime,control_token_digest) VALUES ('f-1','quiet-otter','/work','running','wire','','${now}','${now}','p/actor',?,'kubernetes',?)`,
  ).run(root.id, credential.digest);
  return {
    dir,
    db,
    mind,
    root,
    child,
    outside,
    token: credential.token,
    broker: new ActorMindBroker(db, mind),
  };
}

function close(f: ReturnType<typeof fixture>) {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test("actor Mind broker permits only linked root and descendants", () => {
  const f = fixture();
  assert.equal(f.broker.get(f.token).item.id, f.root.id);
  assert.equal(f.broker.get(f.token, f.child.id).item.id, f.child.id);
  assert.throws(
    () => f.broker.get(f.token, f.outside.id),
    (error: unknown) =>
      error instanceof ActorMindError && error.code === "outside_scope",
  );
  assert.throws(
    () => f.broker.addComment(f.token, f.outside.id, "escape"),
    (error: unknown) =>
      error instanceof ActorMindError && error.code === "outside_scope",
  );
  close(f);
});

test("actor Mind mutations inject server-bound fleet provenance", () => {
  const f = fixture();
  const created = f.broker.createChild(f.token, { title: "made here" });
  assert.equal(created.parentId, f.root.id);
  assert.equal(created.createdBy, "fleet:quiet-otter");
  const comment = f.broker.addComment(f.token, created.id, "progress");
  assert.equal(comment.author, "fleet:quiet-otter");
  const done = f.broker.setStatus(f.token, created.id, "done");
  assert.equal(done.status, "done");
  const actors = done.events.map((event) => event.actor);
  assert.ok(actors.includes("fleet:quiet-otter"));
  assert.throws(
    () =>
      f.broker.createChild(f.token, {
        title: "escape",
        parentId: f.outside.id,
      }),
    (error: unknown) =>
      error instanceof ActorMindError && error.code === "outside_scope",
  );
  close(f);
});
