import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ActorMailboxBroker,
  ActorMailboxError,
} from "../src/fleet/actor-mailbox.js";
import { createActorControlCredential } from "../src/fleet/actor-auth.js";
import { noopLogger } from "../src/lib/log.js";
import { openDatabase } from "../src/store/db.js";
import { MindService } from "../src/store/mind.js";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "actor-mailbox-"));
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
  const root = mind.create({ title: "actor root", kind: "project" });
  const credential = createActorControlCredential();
  const other = createActorControlCredential();
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO fleet_sessions
     (id,name,cwd,status,model,effort,created_at,updated_at,model_ref,mind_id,runtime,control_token_digest)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    "f-actor",
    "quiet-otter",
    "/work",
    "running",
    "wire",
    "",
    now,
    now,
    "p/model",
    root.id,
    "kubernetes",
    credential.digest,
  );
  insert.run(
    "f-other",
    "still-fox",
    "/work2",
    "running",
    "wire",
    "",
    now,
    now,
    "p/model",
    root.id,
    "kubernetes",
    other.digest,
  );
  let clock = 1000;
  return {
    dir,
    db,
    credential,
    other,
    broker: new ActorMailboxBroker(db, () => ++clock),
  };
}

function close(f: ReturnType<typeof fixture>) {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test("mailbox delivers retry-safe dispatcher messages and receiver-owned acknowledgments", () => {
  const f = fixture();
  const sent = f.broker.sendToActor("f-actor", "dispatch-1", "do the work");
  const retried = f.broker.sendToActor("f-actor", "dispatch-1", "do the work");
  assert.equal(retried.id, sent.id);
  assert.equal(sent.sender, "dispatcher");
  assert.throws(
    () => f.broker.sendToActor("f-actor", "dispatch-1", "different"),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "conflict",
  );
  const pulled = f.broker.pullForActor(f.credential.token);
  assert.equal(pulled.binding.actor, "fleet:quiet-otter");
  assert.deepEqual(
    pulled.messages.map((message) => message.id),
    [sent.id],
  );
  assert.equal(f.broker.acknowledgeForActor(f.credential.token, [sent.id]), 1);
  assert.equal(f.broker.acknowledgeForActor(f.credential.token, [sent.id]), 1);
  assert.deepEqual(f.broker.pullForActor(f.credential.token).messages, []);
  close(f);
});

test("mailbox keeps directions isolated and acknowledgments atomic", () => {
  const f = fixture();
  const incoming = f.broker.sendToActor("f-actor", "dispatch-1", "hello");
  const outgoing = f.broker.postFromActor(
    f.credential.token,
    "progress-1",
    "message",
    "working",
  );
  assert.equal(outgoing.sender, "fleet:quiet-otter");
  assert.deepEqual(
    f.broker.pullFromActor("f-actor").map((message) => message.id),
    [outgoing.id],
  );
  assert.throws(
    () =>
      f.broker.acknowledgeForActor(f.credential.token, [
        incoming.id,
        outgoing.id,
      ]),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "not_found",
  );
  assert.deepEqual(
    f.broker
      .pullForActor(f.credential.token)
      .messages.map((message) => message.id),
    [incoming.id],
  );
  assert.equal(f.broker.acknowledgeFromActor("f-actor", [outgoing.id]), 1);
  assert.deepEqual(f.broker.pullFromActor("f-actor"), []);
  assert.deepEqual(f.broker.pullFromActor("f-other"), []);
  close(f);
});

test("mailbox records one idempotent terminal finish and rejects a second", () => {
  const f = fixture();
  const finish = f.broker.postFromActor(
    f.credential.token,
    "finish-1",
    "finish",
    "done",
  );
  assert.equal(
    f.broker.postFromActor(f.credential.token, "finish-1", "finish", "done").id,
    finish.id,
  );
  assert.throws(
    () =>
      f.broker.postFromActor(
        f.credential.token,
        "finish-2",
        "finish",
        "done again",
      ),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "conflict",
  );
  assert.throws(
    () =>
      f.broker.postFromActor(
        f.credential.token,
        "progress-after-finish",
        "message",
        "too late",
      ),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "conflict",
  );
  assert.throws(
    () => f.broker.sendToActor("f-actor", "dispatch-after-finish", "too late"),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "conflict",
  );
  assert.deepEqual(
    f.broker.pullFromActor("f-actor").map((message) => message.kind),
    ["finish"],
  );
  close(f);
});

test("mailbox token and session gates fail closed", () => {
  const f = fixture();
  assert.throws(
    () => f.broker.pullForActor("x".repeat(43)),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "unauthorized",
  );
  assert.throws(
    () => f.broker.sendToActor("missing", "dispatch-1", "x"),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "not_found",
  );
  f.db
    .prepare(
      "UPDATE fleet_sessions SET status = 'dismissed' WHERE id = 'f-actor'",
    )
    .run();
  assert.throws(
    () =>
      f.broker.postFromActor(
        f.credential.token,
        "progress-1",
        "message",
        "late",
      ),
    (error: unknown) =>
      error instanceof ActorMailboxError && error.code === "unauthorized",
  );
  close(f);
});
