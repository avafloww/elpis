import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  SecretaryConversationBroker,
  SecretaryConversationError,
  SecretaryConversationStore,
  newSecretaryTurnId,
} from "../src/secretary/conversation.js";
import {
  SecretarySessionStore,
  newSecretarySessionId,
  secretaryControlTokenDigest,
} from "../src/secretary/session.js";
import { runMigrations } from "../src/store/db.js";
import type { MindId } from "../src/store/mind-id.js";

const ROOT = "elm-000000a1" as MindId;

function fixture(ready = true) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  db.prepare(
    `INSERT INTO mind_items
       (id,title,body,kind,status,priority,created_by,created_at,updated_at,closed_at,archived_at)
     VALUES (?,?,'','project','open',2,'test',1,1,NULL,NULL)`,
  ).run(ROOT, "Secretary root");
  let now = 100;
  let idByte = 1;
  const sessions = new SecretarySessionStore({
    db,
    now: () => now++,
    id: () => newSecretarySessionId(() => Buffer.alloc(16, 9)),
    credential: () => {
      const token = Buffer.alloc(32, 9).toString("base64url");
      return { token, digest: secretaryControlTokenDigest(token) };
    },
  });
  const created = sessions.create(ROOT, "resident/secretary-v1");
  const session = ready
    ? sessions.ready(created.session.id, {
        podName: "secretary-pod",
        podUid: "uid-1",
      })
    : created.session;
  const conversations = new SecretaryConversationStore({
    db,
    now: () => now++,
    id: () => newSecretaryTurnId(() => Buffer.alloc(16, idByte++)),
  });
  return {
    db,
    session,
    sessions,
    conversations,
    token: created.token,
    broker: new SecretaryConversationBroker(db, conversations),
  };
}

function user(content: string) {
  return { role: "user" as const, content };
}

function assistant(content: string) {
  return { role: "assistant" as const, content };
}

test("turn ids are canonical and enqueue permits only one active turn", () => {
  const f = fixture();
  const first = f.conversations.enqueue(f.session.id, user("hello"));
  assert.match(first.id, /^stn-[A-Za-z0-9_-]{22}$/);
  assert.equal(first.sequence, 1);
  assert.equal(first.status, "queued");
  assert.deepEqual(first.request, user("hello"));
  assert.equal(first.response, null);
  assert.throws(
    () => f.conversations.enqueue(f.session.id, user("too soon")),
    (error: unknown) =>
      error instanceof SecretaryConversationError && error.code === "conflict",
  );
  f.db.close();
});

test("starting session pulls an empty queue until ready instead of exiting", () => {
  const f = fixture(false);
  const starting = f.broker.pull(f.token);
  assert.equal(starting.binding.sessionId, f.session.id);
  assert.equal(starting.turn, null);
  f.sessions.ready(f.session.id, {
    podName: "secretary-pod",
    podUid: "uid-1",
  });
  const turn = f.conversations.enqueue(f.session.id, user("after ready"));
  assert.equal(f.broker.pull(f.token).turn?.id, turn.id);
  f.db.close();
});

test("token-bound broker never accepts caller-supplied session scope", () => {
  const f = fixture();
  assert.throws(
    () => f.broker.pull("x".repeat(43)),
    (error: unknown) =>
      error instanceof SecretaryConversationError &&
      error.code === "unauthorized",
  );
  const turn = f.conversations.enqueue(f.session.id, user("bound question"));
  const pulled = f.broker.pull(f.token);
  assert.equal(pulled.binding.sessionId, f.session.id);
  assert.equal(pulled.binding.rootMindId, ROOT);
  assert.equal(pulled.turn?.id, turn.id);
  assert.deepEqual(pulled.turn?.messages, [user("bound question")]);
  const completed = f.broker.complete(
    f.token,
    turn.id,
    assistant("bound answer"),
  );
  assert.equal(completed.binding.sessionId, f.session.id);
  assert.equal(completed.turn.id, turn.id);
  assert.equal(completed.turn.status, "completed");
  f.db.close();
});

test("claim is atomic and returns the bounded authoritative transcript", () => {
  const f = fixture();
  const first = f.conversations.enqueue(f.session.id, user("one"));
  const claim = f.conversations.claim(f.session.id);
  assert.ok(claim);
  assert.equal(claim.turn.id, first.id);
  assert.equal(claim.turn.status, "claimed");
  assert.deepEqual(claim.messages, [user("one")]);
  assert.equal(f.conversations.claim(f.session.id), null);
  const completed = f.conversations.complete(
    f.session.id,
    first.id,
    assistant("answer one"),
  );
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.response, assistant("answer one"));

  const second = f.conversations.enqueue(f.session.id, user("two"));
  const next = f.conversations.claim(f.session.id);
  assert.equal(next?.turn.id, second.id);
  assert.deepEqual(next?.messages, [
    user("one"),
    assistant("answer one"),
    user("two"),
  ]);
  f.db.close();
});

test("completion is exactly idempotent and conflicting replay fails", () => {
  const f = fixture();
  const turn = f.conversations.enqueue(f.session.id, user("question"));
  f.conversations.claim(f.session.id);
  const first = f.conversations.complete(
    f.session.id,
    turn.id,
    assistant("same"),
  );
  const replay = f.conversations.complete(
    f.session.id,
    turn.id,
    assistant("same"),
  );
  assert.deepEqual(replay, first);
  assert.throws(
    () =>
      f.conversations.complete(f.session.id, turn.id, assistant("different")),
    (error: unknown) =>
      error instanceof SecretaryConversationError && error.code === "conflict",
  );
  f.db.close();
});

test("cold recovery marks claimed turns ambiguous and never requeues them", () => {
  const f = fixture();
  const claimed = f.conversations.enqueue(f.session.id, user("claimed"));
  f.conversations.claim(f.session.id);
  assert.equal(f.conversations.recoverClaimed(), 1);
  assert.equal(f.conversations.status(claimed.id).status, "ambiguous");
  assert.equal(f.conversations.claim(f.session.id), null);
  const next = f.conversations.enqueue(f.session.id, user("new explicit turn"));
  assert.equal(next.sequence, 2);
  assert.equal(f.conversations.recoverClaimed(), 0);
  f.db.close();
});

test("session terminal transition atomically settles active turns", () => {
  const queued = fixture();
  const queuedTurn = queued.conversations.enqueue(
    queued.session.id,
    user("not begun"),
  );
  queued.sessions.close(queued.session.id);
  assert.equal(queued.conversations.status(queuedTurn.id).status, "cancelled");
  queued.db.close();

  const claimed = fixture();
  const claimedTurn = claimed.conversations.enqueue(
    claimed.session.id,
    user("may have run"),
  );
  claimed.conversations.claim(claimed.session.id);
  claimed.sessions.fail(claimed.session.id, "pod failed");
  const settled = claimed.conversations.status(claimedTurn.id);
  assert.equal(settled.status, "ambiguous");
  assert.equal(settled.lastError, "pod failed");
  claimed.db.close();
});

test("session termination cancels queued work and makes claimed work ambiguous", () => {
  const queued = fixture();
  const queuedTurn = queued.conversations.enqueue(
    queued.session.id,
    user("not begun"),
  );
  queued.conversations.settleSession(queued.session.id, "session closed");
  assert.equal(queued.conversations.status(queuedTurn.id).status, "cancelled");
  queued.db.close();

  const claimed = fixture();
  const claimedTurn = claimed.conversations.enqueue(
    claimed.session.id,
    user("may have run"),
  );
  claimed.conversations.claim(claimed.session.id);
  claimed.conversations.settleSession(claimed.session.id, "session failed");
  const settled = claimed.conversations.status(claimedTurn.id);
  assert.equal(settled.status, "ambiguous");
  assert.equal(settled.lastError, "session failed");
  claimed.db.close();
});

test("v23 triggers reject lifecycle and identity corruption outside the store", () => {
  const f = fixture();
  const turn = f.conversations.enqueue(f.session.id, user("raw"));
  assert.throws(
    () =>
      f.db
        .prepare("UPDATE secretary_turns SET status='claimed' WHERE id=?")
        .run(turn.id),
    /lifecycle fields do not match status/,
  );
  f.db
    .prepare(
      "UPDATE secretary_turns SET status='claimed',claimed_at=updated_at WHERE id=?",
    )
    .run(turn.id);
  assert.throws(
    () =>
      f.db
        .prepare("UPDATE secretary_turns SET status='completed' WHERE id=?")
        .run(turn.id),
    /lifecycle fields do not match status/,
  );
  assert.throws(
    () =>
      f.db
        .prepare("UPDATE secretary_turns SET request_json='{}' WHERE id=?")
        .run(turn.id),
    /identity and request are immutable/,
  );
  f.db.close();
});

test("conversation message validation rejects non-final roles and oversized text", () => {
  const f = fixture();
  assert.throws(
    () =>
      f.conversations.enqueue(f.session.id, {
        role: "assistant",
        content: "wrong direction",
      } as never),
    /user message/,
  );
  assert.throws(
    () => f.conversations.enqueue(f.session.id, user("x".repeat(32_769))),
    /32768/,
  );
  const turn = f.conversations.enqueue(f.session.id, user("valid"));
  f.conversations.claim(f.session.id);
  assert.throws(
    () =>
      f.conversations.complete(f.session.id, turn.id, {
        role: "tool",
        content: "wrong direction",
      } as never),
    /assistant message/,
  );
  f.db.close();
});
