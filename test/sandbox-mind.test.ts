import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { buildGlobals } from "../src/sandbox/globals.js";
import { runMigrations } from "../src/store/db.js";
import { MindService } from "../src/store/mind.js";
import { makeConfig } from "./helpers.js";

function setup(initialName = "Aster") {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  let next = 1;
  const tasks = new Map<number, any>();
  const scheduler = {
    create(opts: any) {
      const row = { id: next++, ...opts };
      tasks.set(row.id, row);
      return row;
    },
    delete(id: number) {
      return tasks.delete(id);
    },
    update(id: number, patch: any) {
      const row = tasks.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };
  const config = makeConfig();
  const mind = new MindService({ db, scheduler, logger: config.logger });
  let agentName = initialName;
  const globals = buildGlobals({
    config,
    logbuf: [],
    mind,
    agentName: () => agentName,
    inbound: { channelId: "home-channel" } as any,
  } as any) as any;
  return {
    db,
    tasks,
    mind,
    config,
    api: globals.elpis.mind,
    setAgentName: (name: string) => {
      agentName = name;
    },
  };
}

test("elpis.mind exposes a complete normalized work-graph surface", () => {
  const { db, api } = setup();
  const first = api.add({ title: "first", tags: ["Harness"] });
  const second = api.add({
    title: "second",
    parentId: first.id,
    dependsOn: [first.id],
    dueAt: "2030-01-02T03:04:05Z",
  });
  assert.equal(second.parentId, first.id);
  assert.equal(second.blockedBy[0].id, first.id);
  assert.equal(second.dueAt, Date.parse("2030-01-02T03:04:05Z"));
  assert.deepEqual(
    api.list({ blocked: true }).map((x: any) => x.id),
    [second.id],
  );

  api.comment(second.id, "the body matters", "bramble");
  api.done(first.id, "foundation complete");
  assert.deepEqual(
    api.ready().map((x: any) => x.id),
    [second.id],
  );
  api.update(second.id, { priority: 4, tags: ["dashboard"], parentId: null });
  const detail = api.get(second.id);
  assert.equal(detail.priority, 4);
  assert.deepEqual(detail.tags, ["dashboard"]);
  assert.equal(detail.parentId, null);
  assert.equal(detail.comments[0].body, "the body matters");
  assert.equal(api.stats().done, 1);
  assert.ok(api.graph(second.id).nodes.length >= 2);
  db.close();
});

test("elpis.mind self-attribution hot-reads the configured inhabitant name", () => {
  const { db, api, setAgentName } = setup("Aster");
  const item = api.add({ title: "first shape" });
  assert.equal(item.createdBy, "Aster");
  setAgentName("Bramble");
  api.comment(item.id, "the name changed without a restart");
  assert.equal(api.get(item.id).comments[0].author, "Bramble");
  db.close();
});

test("elpis.mind reminders inherit the active inbound channel", () => {
  const { db, tasks, api } = setup();
  const at = Date.now() + 60_000;
  const item = api.add({ title: "remember me", remindAt: at });
  assert.equal(item.reminders.length, 1);
  assert.equal(
    tasks.get(item.reminders[0].scheduledTaskId).channelId,
    "home-channel",
  );
  api.snoozeReminder(item.reminders[0].id, at + 60_000);
  assert.equal(
    tasks.get(item.reminders[0].scheduledTaskId).nextRunAt,
    at + 60_000,
  );
  api.cancelReminder(item.reminders[0].id);
  assert.equal(tasks.size, 0);
  db.close();
});

test("elpis.mind validates ids and dependency cycles teachably", () => {
  const { db, api } = setup();
  const a = api.add({ title: "a" });
  const b = api.add({ title: "b", dependsOn: [a.id] });
  assert.throws(() => api.depends(a.id, b.id), /would create a cycle/);
  assert.throws(() => api.get("banana"), /expected a full elm-\* item id/);
  db.close();
});

test("elpis.mind.reply preserves structured reply provenance", () => {
  const { db, api } = setup("Aster");
  const item = api.add({ title: "direct correspondence" });
  const question = api.comment(item.id, "Which boundary?");
  const reply = api.reply(item.id, question.id, "Keep the decoder boundary.");
  assert.equal(reply.replyToId, question.id);
  assert.equal(reply.author, "Aster");
  const stored = api
    .get(item.id)
    .comments.find((comment: any) => comment.id === reply.id);
  assert.equal(stored.replyToId, question.id);
  assert.equal(stored.body, "Keep the decoder boundary.");
  db.close();
});

test("elpis.mind.bound defaults every mutation to the persistent sandbox Mind", () => {
  const { db, mind, config, api } = setup("Aster");
  assert.throws(() => api.bound.get(), /no bound Mind item/);
  const bound = mind.create({ title: "bound work" });
  const other = mind.create({ title: "other work" });
  const globals = buildGlobals({
    config,
    logbuf: [],
    mind,
    mindDefaultId: bound.id,
    agentName: () => "Aster",
  } as any) as any;
  const boundApi = globals.elpis.mind.bound;
  assert.equal(boundApi.id(), bound.id);
  assert.equal(boundApi.get().id, bound.id);
  boundApi.comment("progress from inside");
  boundApi.tag("persistent");
  assert.equal(boundApi.get().comments[0].body, "progress from inside");
  assert.deepEqual(boundApi.get().tags, ["persistent"]);
  boundApi.done("verified");
  assert.equal(mind.get(bound.id)!.status, "done");
  assert.equal(
    mind.get(other.id)!.status,
    "open",
    "explicitly unrelated Mind is untouched",
  );
  db.close();
});
