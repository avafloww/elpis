import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateMindIds } from "../src/store/mind-id-migration.js";
import type { MindId } from "../src/store/mind-id.js";

const ids = ["elm-00000001", "elm-00000002"] as MindId[];

test("v15 Mind relations and sandbox state migrate to shared elm identities", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE mind_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL, parent_id INTEGER REFERENCES mind_items(id) ON DELETE SET NULL, due_at INTEGER, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER, archived_at INTEGER);
    CREATE TABLE mind_dependencies (item_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE, depends_on_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(item_id,depends_on_id));
    CREATE TABLE mind_tags (item_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY(item_id,tag));
    CREATE TABLE mind_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE, author TEXT NOT NULL, body TEXT NOT NULL, reply_to_id INTEGER REFERENCES mind_comments(id) ON DELETE SET NULL, created_at INTEGER NOT NULL, updated_at INTEGER, deleted_at INTEGER);
    CREATE TABLE mind_events (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE, type TEXT NOT NULL, actor TEXT NOT NULL, data_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL);
    CREATE TABLE mind_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES mind_items(id) ON DELETE CASCADE, scheduled_task_id INTEGER NOT NULL UNIQUE, fire_at INTEGER NOT NULL, channel_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, fired_at INTEGER, cancelled_at INTEGER);
    CREATE TABLE mind_claims (item_id INTEGER PRIMARY KEY REFERENCES mind_items(id) ON DELETE CASCADE, owner TEXT NOT NULL, principal TEXT NOT NULL, claimed_at INTEGER NOT NULL, renewed_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE persistent_sandboxes (id TEXT PRIMARY KEY, mind_id INTEGER NOT NULL UNIQUE REFERENCES mind_items(id) ON DELETE RESTRICT, executor_id TEXT NOT NULL, generation INTEGER NOT NULL, lifecycle TEXT NOT NULL, reminder_latched INTEGER NOT NULL, retire_requested INTEGER NOT NULL, retire_requested_at INTEGER, cold_notice_pending INTEGER NOT NULL, active_run_id TEXT, next_run_seq INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, retired_at INTEGER);
    CREATE TABLE sandbox_aliases (alias TEXT PRIMARY KEY, sandbox_id TEXT NOT NULL UNIQUE REFERENCES persistent_sandboxes(id) ON DELETE RESTRICT, reserved_at INTEGER NOT NULL, retired_at INTEGER);
    INSERT INTO mind_items VALUES (1,'parent','','project','open',2,NULL,NULL,'agent',1,1,NULL,NULL),(2,'child','','task','in_progress',3,1,NULL,'agent',2,2,NULL,NULL);
    INSERT INTO mind_dependencies VALUES (2,1,'agent',3);
    INSERT INTO mind_tags VALUES (2,'x');
    INSERT INTO mind_comments(item_id,author,body,created_at) VALUES (2,'agent','kept',4);
    INSERT INTO mind_events(item_id,type,actor,data_json,created_at) VALUES (2,'item.created','agent','{}',5);
    INSERT INTO mind_reminders(item_id,scheduled_task_id,fire_at,created_by,created_at) VALUES (2,9,99,'agent',6);
    INSERT INTO mind_claims VALUES (2,'worker','p',7,7,999);
    INSERT INTO persistent_sandboxes VALUES ('old-sandbox',2,'exec',4,'ready',1,0,NULL,1,NULL,8,10,11,NULL);
    INSERT INTO sandbox_aliases VALUES ('quiet-old-alias','old-sandbox',8,NULL);
  `);
  let n = 0;
  migrateMindIds(db as any, () => ids[n++]);
  const map = db
    .prepare("SELECT * FROM mind_id_migration_map ORDER BY legacy_id")
    .all() as any[];
  assert.deepEqual(
    map.map((row) => ({ ...row })),
    [
      { legacy_id: 1, mind_id: ids[0] },
      { legacy_id: 2, mind_id: ids[1] },
    ],
  );
  assert.deepEqual(
    (
      db
        .prepare("SELECT id,parent_id,title FROM mind_items ORDER BY title")
        .all() as any[]
    ).map((row) => ({ ...row })),
    [
      { id: ids[1], parent_id: ids[0], title: "child" },
      { id: ids[0], parent_id: null, title: "parent" },
    ],
  );
  assert.deepEqual(
    {
      ...(db
        .prepare("SELECT item_id,depends_on_id FROM mind_dependencies")
        .get() as any),
    },
    { item_id: ids[1], depends_on_id: ids[0] },
  );
  assert.equal(
    (db.prepare("SELECT item_id FROM mind_comments").get() as any).item_id,
    ids[1],
  );
  assert.deepEqual(
    {
      ...(db
        .prepare(
          "SELECT id,generation,lifecycle,cold_notice_pending FROM persistent_sandboxes",
        )
        .get() as any),
    },
    { id: ids[1], generation: 4, lifecycle: "ready", cold_notice_pending: 1 },
  );
  assert.equal(
    (
      db
        .prepare(
          "SELECT COUNT(*) n FROM sqlite_master WHERE name='sandbox_aliases'",
        )
        .get() as any
    ).n,
    0,
  );
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  db.close();
});
