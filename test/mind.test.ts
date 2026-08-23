import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../src/store/db.js";
import {
  MindService,
  MindStore,
  formatMindDetail,
  parseMindId,
  type MindReminder,
} from "../src/store/mind.js";
import { makeConfig } from "./helpers.js";
import { createSandboxRegistry } from "../src/sandbox/registry.js";

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

function schedulerStub() {
  let next = 1;
  const tasks = new Map<number, any>();
  return {
    tasks,
    create(opts: any) {
      const task = { id: next++, ...opts, doneAt: null };
      tasks.set(task.id, task);
      return task;
    },
    delete(id: number) {
      return tasks.delete(id);
    },
    update(id: number, patch: any) {
      const task = tasks.get(id);
      if (!task) return null;
      Object.assign(task, patch);
      return task;
    },
  };
}

const logger = makeConfig().logger;

test("mind migrations are idempotent and create the complete schema", () => {
  const db = database();
  runMigrations(db);
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mind_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((x) => x.name);
  assert.deepEqual(tables, [
    "mind_claims",
    "mind_comments",
    "mind_dependencies",
    "mind_events",
    "mind_id_migration_map",
    "mind_items",
    "mind_reminders",
    "mind_tags",
  ]);
  assert.equal(
    Number(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version,
    ),
    24,
  );
  db.close();
});

test("dependency chains derive blocked and ready state one bead at a time", () => {
  const db = database();
  const mind = new MindStore(db);
  const foundation = mind.create({ title: "foundation", priority: 3 });
  const walls = mind.create({ title: "walls", dependsOn: [foundation.id] });
  const roof = mind.create({ title: "roof", dependsOn: [walls.id] });

  assert.deepEqual(
    mind.ready().map((x) => x.id),
    [foundation.id],
  );
  assert.equal(mind.get(walls.id)!.effectiveStatus, "blocked");
  assert.deepEqual(
    mind.get(roof.id)!.blockedBy.map((x) => x.id),
    [walls.id],
  );

  mind.setStatus(foundation.id, "done", "test");
  assert.deepEqual(
    mind.ready().map((x) => x.id),
    [walls.id],
  );
  mind.setStatus(walls.id, "done", "test");
  assert.deepEqual(
    mind.ready().map((x) => x.id),
    [roof.id],
  );
  assert.throws(
    () => mind.addDependency(foundation.id, roof.id),
    /would create a cycle/,
  );
  db.close();
});

test("claims atomically exclude competing collaborators and recover after expiry", () => {
  const db = database();
  const mind = new MindStore(db);
  const item = mind.create({ title: "shared parser task" });
  const first = mind.claim(item.id, {
    owner: "mcp:worker-a",
    principal: "session-a",
    ttlMs: 60_000,
    note: "starting parser audit",
  });
  assert.equal(first.status, "in_progress");
  assert.equal(first.claim?.owner, "mcp:worker-a");
  assert.equal(
    first.comments.at(-1)?.body,
    "Work claimed through MCP.\n\nstarting parser audit",
  );
  assert.throws(
    () =>
      mind.claim(item.id, { owner: "mcp:worker-b", principal: "session-b" }),
    /claimed by mcp:worker-a/,
  );

  const renewed = mind.renewClaim(item.id, "session-a", 120_000);
  assert.ok(renewed.claim!.expiresAt > first.claim!.expiresAt);
  assert.throws(
    () => mind.releaseClaim(item.id, "session-b", "open", "wrong owner"),
    /another collaborator/,
  );
  db.prepare("UPDATE mind_claims SET expires_at = ? WHERE item_id = ?").run(
    Date.now() - 1,
    item.id,
  );
  assert.throws(() => mind.renewClaim(item.id, "session-a"), /no active claim/);

  const expiredIds = mind.expireClaims();
  assert.deepEqual(expiredIds, [item.id]);
  const reopened = mind.get(item.id)!;
  assert.equal(reopened.status, "open");
  assert.equal(reopened.claim, null);
  assert.match(
    reopened.comments.at(-1)!.body,
    /expired; item returned to open work/,
  );

  const takeover = mind.claim(item.id, {
    owner: "mcp:worker-b",
    principal: "session-b",
  });
  const waiting = mind.releaseClaim(
    item.id,
    "session-b",
    "waiting",
    "need an API decision",
  );
  assert.equal(takeover.claim?.owner, "mcp:worker-b");
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.claim, null);
  assert.ok(
    waiting.comments.some(
      (comment) => comment.body === "Blocked: need an API decision",
    ),
  );
  db.close();
});

test("discovery ranks fresh context and finish requires the full claimed-work receipt", () => {
  const db = database();
  const mind = new MindStore(db);
  const parser = mind.create({
    title: "Repair parser cache",
    body: "src/parser/cache.ts decoder invalidation",
    tags: ["parser"],
  });
  mind.create({
    title: "Restyle console tabs",
    body: "CSS navigation polish",
    tags: ["console"],
  });
  const matches = mind.discover(
    "debugging decoder invalidation in src/parser/cache.ts",
  );
  assert.equal(matches[0].item.id, parser.id);
  assert.ok(matches[0].score > 0);

  mind.claim(parser.id, { owner: "mcp:worker", principal: "session" });
  const logged = mind.logClaim(
    parser.id,
    "session",
    "mcp:worker",
    "verification",
    "focused parser test passes",
  );
  assert.ok(
    logged.comments.some(
      (comment) => comment.body === "Verification: focused parser test passes",
    ),
  );
  assert.throws(
    () =>
      mind.finishClaim(
        parser.id,
        "other",
        "mcp:other",
        "done",
        "tests",
        "none",
      ),
    /another collaborator/,
  );
  const dependency = mind.create({ title: "newly discovered prerequisite" });
  mind.addDependency(parser.id, dependency.id, "agent");
  assert.throws(
    () =>
      mind.finishClaim(
        parser.id,
        "session",
        "mcp:worker",
        "fixed cache",
        "parser tests pass",
        "none",
      ),
    /became blocked/,
  );
  mind.setStatus(dependency.id, "done", "agent");
  const finished = mind.finishClaim(
    parser.id,
    "session",
    "mcp:worker",
    "fixed cache",
    "parser tests pass",
    "integration suite not run",
  );
  assert.equal(finished.status, "done");
  assert.equal(finished.claim, null);
  assert.match(
    finished.comments.at(-1)!.body,
    /Result:\nfixed cache[\s\S]*Verification:\nparser tests pass[\s\S]*Omissions:\nintegration suite not run/,
  );
  db.close();
});

test("claims reject dependency-blocked and manually in-progress work", () => {
  const db = database();
  const mind = new MindStore(db);
  const dependency = mind.create({ title: "dependency" });
  const blocked = mind.create({ title: "blocked", dependsOn: [dependency.id] });
  const manual = mind.create({ title: "manual", status: "in_progress" });
  const inbox = mind.create({ title: "untriaged", status: "inbox" });
  const idea = mind.create({ title: "possible someday", kind: "idea" });
  assert.throws(
    () => mind.claim(blocked.id, { owner: "mcp:worker", principal: "session" }),
    /blocked by dependencies/,
  );
  assert.throws(
    () => mind.claim(manual.id, { owner: "mcp:worker", principal: "session" }),
    /outside an MCP claim/,
  );
  assert.throws(
    () => mind.claim(inbox.id, { owner: "mcp:worker", principal: "session" }),
    /inbox, not open work/,
  );
  assert.throws(
    () => mind.claim(idea.id, { owner: "mcp:worker", principal: "session" }),
    /not an executable task/,
  );
  assert.ok(
    !mind
      .discover("untriaged possible someday")
      .some((match) => match.item.id === inbox.id || match.item.id === idea.id),
  );
  assert.ok(
    mind
      .ready()
      .every(
        (item) =>
          item.kind === "task" &&
          item.status === "open" &&
          item.blockedBy.length === 0,
      ),
  );
  assert.ok(
    !mind
      .ready()
      .some(
        (item) =>
          item.id === inbox.id || item.id === idea.id || item.id === manual.id,
      ),
  );
  db.close();
});

test("resume atomically claims waiting dependency-ready work", () => {
  const db = database();
  const mind = new MindStore(db);
  const waiting = mind.create({ title: "waiting work", status: "waiting" });
  const resumed = mind.resumeClaim(waiting.id, {
    owner: "mcp:worker",
    principal: "session",
    note: "fixture arrived",
  });
  assert.equal(resumed.status, "in_progress");
  assert.equal(resumed.claim?.owner, "mcp:worker");
  assert.ok(resumed.events.some((event) => event.type === "claim.resumed"));
  assert.match(resumed.comments.at(-1)!.body, /fixture arrived/);
  assert.throws(
    () =>
      mind.resumeClaim(waiting.id, {
        owner: "mcp:other",
        principal: "other",
        note: "again",
      }),
    /not waiting/,
  );

  const dependency = mind.create({ title: "unfinished dependency" });
  const blocked = mind.create({
    title: "blocked waiting work",
    status: "waiting",
    dependsOn: [dependency.id],
  });
  assert.throws(
    () =>
      mind.resumeClaim(blocked.id, {
        owner: "mcp:worker",
        principal: "session",
        note: "not actually resolved",
      }),
    /blocked by dependencies/,
  );
  db.close();
});

test("resident overrides and archive revoke external claims visibly", () => {
  const db = database();
  const mind = new MindStore(db);
  const statusItem = mind.create({ title: "resident override" });
  mind.claim(statusItem.id, { owner: "mcp:worker", principal: "session-a" });
  const waiting = mind.setStatus(statusItem.id, "waiting", "resident");
  assert.equal(waiting.claim, null);
  assert.ok(
    waiting.events.some(
      (event) => event.type === "claim.revoked" && event.actor === "resident",
    ),
  );

  const archivedItem = mind.create({ title: "archive override" });
  mind.claim(archivedItem.id, { owner: "mcp:worker", principal: "session-b" });
  const archived = mind.archive(archivedItem.id, "resident");
  assert.equal(archived.claim, null);
  assert.ok(
    archived.events.some(
      (event) => event.type === "claim.revoked" && event.data.archived === true,
    ),
  );
  db.close();
});

test("hierarchy, graph traversal, tags and search share one item model", () => {
  const db = database();
  const mind = new MindStore(db);
  const project = mind.create({
    title: "Cerebral cortex",
    kind: "project",
    tags: ["Harness", "brain work"],
  });
  const store = mind.create({
    title: "Implement graph store",
    body: "Recursive dependency CTE",
    parentId: project.id,
    tags: ["harness"],
  });
  const ui = mind.create({
    title: "Build dashboard",
    parentId: project.id,
    dependsOn: [store.id],
  });

  assert.equal(mind.get(project.id)!.childCount, 2);
  assert.deepEqual(
    new Set(mind.list({ tag: "harness" }).map((x) => x.id)),
    new Set([store.id, project.id]),
  );
  assert.deepEqual(
    mind.list({ query: "recursive" }).map((x) => x.id),
    [store.id],
  );
  const graph = mind.graph(ui.id, 4);
  assert.deepEqual(
    new Set(graph.nodes.map((x) => x.id)),
    new Set([project.id, store.id, ui.id]),
  );
  assert.ok(
    graph.edges.some(
      (x) => x.type === "depends_on" && x.from === ui.id && x.to === store.id,
    ),
  );
  assert.ok(
    graph.edges.some(
      (x) => x.type === "parent" && x.from === ui.id && x.to === project.id,
    ),
  );
  assert.throws(
    () => mind.update(project.id, { parentId: ui.id }),
    /would create a cycle/,
  );
  db.close();
});

test("list sorting covers created, updated, and last-comment timestamps in both directions", () => {
  const db = database();
  const mind = new MindStore(db);
  const a = mind.create({ title: "oldest, no comment" });
  const b = mind.create({ title: "middle, newest comment" });
  const c = mind.create({ title: "newest, oldest comment" });
  const cb = mind.addComment(b.id, "new comment");
  const cc = mind.addComment(c.id, "old comment");
  db.prepare(
    "UPDATE mind_items SET created_at = ?, updated_at = ? WHERE id = ?",
  ).run(100, 300, a.id);
  db.prepare(
    "UPDATE mind_items SET created_at = ?, updated_at = ? WHERE id = ?",
  ).run(200, 100, b.id);
  db.prepare(
    "UPDATE mind_items SET created_at = ?, updated_at = ? WHERE id = ?",
  ).run(300, 200, c.id);
  db.prepare("UPDATE mind_comments SET created_at = ? WHERE id = ?").run(
    300,
    cb.id,
  );
  db.prepare("UPDATE mind_comments SET created_at = ? WHERE id = ?").run(
    200,
    cc.id,
  );

  assert.deepEqual(
    mind.list({ sort: "created_asc" }).map((x) => x.id),
    [a.id, b.id, c.id],
  );
  assert.deepEqual(
    mind.list({ sort: "created_desc" }).map((x) => x.id),
    [c.id, b.id, a.id],
  );
  assert.deepEqual(
    mind.list({ sort: "updated_asc" }).map((x) => x.id),
    [b.id, c.id, a.id],
  );
  assert.deepEqual(
    mind.list().map((x) => x.id),
    [a.id, c.id, b.id],
    "updated_desc is the default",
  );
  assert.deepEqual(
    mind.list({ sort: "last_comment_asc" }).map((x) => x.id),
    [c.id, b.id, a.id],
  );
  const byComment = mind.list({ sort: "last_comment_desc" });
  assert.deepEqual(
    byComment.map((x) => x.id),
    [b.id, c.id, a.id],
  );
  assert.deepEqual(
    byComment.map((x) => x.lastCommentAt),
    [300, 200, null],
  );
  assert.throws(() => mind.list({ sort: "nonsense" as any }), /invalid sort/);
  db.close();
});

test("comments are CRUD-capable while events preserve the audit trail", () => {
  const db = database();
  const mind = new MindStore(db);
  const item = mind.create({ title: "Read the body" });
  const comment = mind.addComment(item.id, "first note", "bramble");
  mind.updateComment(comment.id, "corrected note", "bramble");
  mind.update(item.id, { priority: 4, status: "in_progress" }, "aster");

  let detail = mind.get(item.id)!;
  assert.equal(detail.comments[0].body, "corrected note");
  assert.ok(detail.events.some((x) => x.type === "comment.added"));
  assert.ok(detail.events.some((x) => x.type === "comment.updated"));
  assert.ok(detail.events.some((x) => x.type === "item.updated"));

  assert.equal(mind.deleteComment(comment.id, "bramble"), true);
  detail = mind.get(item.id)!;
  assert.equal(detail.comments.length, 0);
  assert.ok(detail.events.some((x) => x.type === "comment.deleted"));
  db.close();
});

test("MindService links reminders to scheduler tasks, fires and cancels them", () => {
  const db = database();
  const scheduler = schedulerStub();
  let changes = 0;
  const service = new MindService({
    db,
    scheduler,
    logger,
    onChanged: () => {
      changes++;
    },
  });
  const fireAt = Date.now() + 60_000;
  const item = service.create({
    title: "wake me",
    remindAt: fireAt,
    reminderChannelId: "home",
    actor: "aster",
  });
  const reminder = item.reminders[0] as MindReminder;
  assert.equal(scheduler.tasks.get(reminder.scheduledTaskId).nextRunAt, fireAt);

  service.onScheduledTaskWake({
    id: reminder.scheduledTaskId,
    name: `mind-${item.id}-x`,
  } as any);
  assert.ok(service.get(item.id)!.reminders[0].firedAt);

  const second = service.addReminder(
    item.id,
    Date.now() + 120_000,
    "bramble",
    "home",
  );
  service.setStatus(item.id, "done", "aster");
  assert.equal(scheduler.tasks.has(second.scheduledTaskId), false);
  assert.ok(
    service.get(item.id)!.reminders.find((x) => x.id === second.id)!
      .cancelledAt,
  );

  const claimed = service.create({ title: "worker completion reminder" });
  const third = service.addReminder(
    claimed.id,
    Date.now() + 180_000,
    "aster",
    "home",
  );
  service.claim(claimed.id, { owner: "mcp:worker", principal: "session" });
  service.finishClaim(
    claimed.id,
    "session",
    "mcp:worker",
    "implemented",
    "focused tests pass",
    "none",
  );
  assert.equal(scheduler.tasks.has(third.scheduledTaskId), false);
  assert.ok(
    service.get(claimed.id)!.reminders.find((x) => x.id === third.id)!
      .cancelledAt,
  );
  assert.ok(changes >= 4);

  db.close();
});

test("archive is soft, ids parse from human forms, and detail formatting is useful", () => {
  const db = database();
  const mind = new MindStore(db);
  const item = mind.create({
    title: "A small true task",
    body: "Do the next thing",
    dueAt: Date.now() + 1000,
  });
  assert.equal(parseMindId(item.id), item.id);
  assert.match(
    formatMindDetail(item),
    new RegExp(`#${item.id}.*A small true task`),
  );
  mind.archive(item.id);
  assert.equal(mind.list().length, 0);
  assert.equal(mind.list({ includeArchived: true }).length, 1);
  mind.restore(item.id);
  assert.equal(mind.list().length, 1);
  db.close();
});

test("MindService state callback requests retirement after the Mind commit", () => {
  const db = database();
  const scheduler = schedulerStub();
  let nextUuid = 0;
  const registry = createSandboxRegistry({
    db,
    uuid: () => `mind-hook-${++nextUuid}`,
  });
  const states: Array<{ id: string; status: string; archived: boolean }> = [];
  const service = new MindService({
    db,
    scheduler,
    logger,
    onItemStateChanged: (id, status, archived) => {
      states.push({ id, status, archived });
      if (archived || status === "done" || status === "cancelled")
        registry.retireByMind(id);
    },
  });
  const item = service.create({ title: "persistent work" });
  const sandbox = registry.ensureForMind(item.id);
  const run = registry.beginRun(sandbox.id);

  service.setStatus(item.id, "done", "test");
  const pending = registry.get(sandbox.id);
  assert.equal(pending.lifecycle, "busy");
  assert.equal(pending.retireRequested, true);
  assert.deepEqual(states, [{ id: item.id, status: "done", archived: false }]);
  const idle = registry.finishRun(sandbox.id, run.runId);
  assert.equal(idle.lifecycle, "ready");
  assert.equal(idle.retireRequested, true);
  assert.equal(registry.finalizeRetirement(sandbox.id).lifecycle, "retired");
  db.close();
});
