import type { MigrationDatabase } from "./migrations.js";
import { newMindId, type MindId } from "./mind-id.js";

export const MIND_ID_MIGRATION_CHECKSUM =
  "e1b78fed03275bc53aa632b66629dfb0feda655c224438b44b08168df5409000";

function tableExists(db: MigrationDatabase, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

export function migrateMindIds(
  db: MigrationDatabase,
  generate: () => MindId = newMindId,
): void {
  const type = db
    .prepare(
      "SELECT type FROM pragma_table_info('mind_items') WHERE name = 'id'",
    )
    .get() as { type?: string } | undefined;
  if (!type || String(type.type).toUpperCase() === "TEXT") return;

  const rows = db.prepare("SELECT id FROM mind_items ORDER BY id").all() as {
    id: number;
  }[];
  const ids = new Map<number, MindId>();
  const used = new Set<string>();
  for (const row of rows) {
    let id: MindId;
    do id = generate();
    while (used.has(id));
    used.add(id);
    ids.set(Number(row.id), id);
  }
  const ref = (value: unknown): MindId => {
    const id = ids.get(Number(value));
    if (!id)
      throw new Error(
        `mind id migration: missing mapping for ${String(value)}`,
      );
    return id;
  };

  db.exec("PRAGMA defer_foreign_keys = ON");
  db.exec(`
    CREATE TABLE mind_id_migration_map (
      legacy_id INTEGER PRIMARY KEY,
      mind_id TEXT NOT NULL UNIQUE CHECK (mind_id GLOB 'elm-[0-9a-z]*' AND length(mind_id) = 12)
    );
    CREATE TABLE mind_items_v16 (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL CHECK (kind IN ('task','project','idea','question','reminder')),
      status TEXT NOT NULL CHECK (status IN ('inbox','open','in_progress','waiting','done','cancelled')),
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
      parent_id TEXT REFERENCES mind_items_v16(id) ON DELETE SET NULL,
      due_at INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      closed_at INTEGER,
      archived_at INTEGER
    );
  `);
  const insertMap = db.prepare(
    "INSERT INTO mind_id_migration_map (legacy_id, mind_id) VALUES (?, ?)",
  );
  for (const [legacy, id] of ids) insertMap.run(legacy, id);
  const insertItem = db.prepare(`INSERT INTO mind_items_v16
    (id,title,body,kind,status,priority,parent_id,due_at,created_by,created_at,updated_at,closed_at,archived_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of db
    .prepare("SELECT * FROM mind_items ORDER BY id")
    .all() as Record<string, unknown>[]) {
    insertItem.run(
      ref(row.id),
      String(row.title),
      String(row.body ?? ""),
      String(row.kind),
      String(row.status),
      Number(row.priority),
      row.parent_id == null ? null : ref(row.parent_id),
      row.due_at == null ? null : Number(row.due_at),
      String(row.created_by),
      Number(row.created_at),
      Number(row.updated_at),
      row.closed_at == null ? null : Number(row.closed_at),
      row.archived_at == null ? null : Number(row.archived_at),
    );
  }

  const childTables = [
    ["mind_dependencies", ["item_id", "depends_on_id"], ["TEXT", "TEXT"]],
    ["mind_tags", ["item_id"], ["TEXT"]],
    ["mind_comments", ["item_id"], ["TEXT"]],
    ["mind_events", ["item_id"], ["TEXT"]],
    ["mind_reminders", ["item_id"], ["TEXT"]],
    ["mind_claims", ["item_id"], ["TEXT"]],
  ] as const;
  const existingChildTables = childTables.filter(([table]) =>
    tableExists(db, table),
  );
  for (const [table] of existingChildTables)
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy_v15`);
  for (const [table, columns] of existingChildTables) {
    const sql = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
      .get(`${table}_legacy_v15`) as { sql: string };
    const create = sql.sql
      .replace(
        new RegExp(`CREATE TABLE ["']?${table}_legacy_v15["']?`, "i"),
        `CREATE TABLE ${table}`,
      )
      .replace(
        /INTEGER NOT NULL REFERENCES ["']?mind_items["']?\(id\)/g,
        "TEXT NOT NULL REFERENCES mind_items_v16(id)",
      )
      .replace(
        /INTEGER PRIMARY KEY REFERENCES ["']?mind_items["']?\(id\)/g,
        "TEXT PRIMARY KEY REFERENCES mind_items_v16(id)",
      )
      .replace(
        /REFERENCES ["']?mind_items["']?\(id\)/g,
        "REFERENCES mind_items_v16(id)",
      )
      .replace(
        /REFERENCES ["']?mind_comments_legacy_v15["']?\(id\)/g,
        "REFERENCES mind_comments(id)",
      );
    db.exec(create);
    const info = db
      .prepare(
        `SELECT name FROM pragma_table_info('${table}_legacy_v15') ORDER BY cid`,
      )
      .all() as { name: string }[];
    const names = info.map((x) => x.name);
    const select = names.map((name) =>
      columns.includes(name as never) ? `m_${name}.mind_id` : `l.${name}`,
    );
    const joins = columns
      .map(
        (name) =>
          `JOIN mind_id_migration_map m_${name} ON m_${name}.legacy_id = l.${name}`,
      )
      .join(" ");
    db.exec(
      `INSERT INTO ${table} (${names.join(",")}) SELECT ${select.join(",")} FROM ${table}_legacy_v15 l ${joins}`,
    );
  }
  for (const [table] of [...existingChildTables].reverse())
    db.exec(`DROP TABLE ${table}_legacy_v15`);

  if (tableExists(db, "persistent_sandboxes")) {
    db.exec(`
      DROP TRIGGER IF EXISTS persistent_sandboxes_identity_no_update;
      DROP TRIGGER IF EXISTS persistent_sandboxes_no_delete;
      DROP TRIGGER IF EXISTS sandbox_aliases_identity_no_update;
      DROP TRIGGER IF EXISTS sandbox_aliases_no_delete;
      DROP TABLE IF EXISTS sandbox_aliases;
      ALTER TABLE persistent_sandboxes RENAME TO persistent_sandboxes_legacy_v15;
      CREATE TABLE persistent_sandboxes (
        id TEXT PRIMARY KEY REFERENCES mind_items_v16(id) ON DELETE RESTRICT,
        executor_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('ready','busy','detached','retired')),
        reminder_latched INTEGER NOT NULL DEFAULT 0 CHECK (reminder_latched IN (0,1)),
        retire_requested INTEGER NOT NULL DEFAULT 0 CHECK (retire_requested IN (0,1)),
        retire_requested_at INTEGER,
        cold_notice_pending INTEGER NOT NULL DEFAULT 0 CHECK (cold_notice_pending IN (0,1)),
        active_run_id TEXT,
        next_run_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_run_seq >= 1),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        retired_at INTEGER
      );
      INSERT INTO persistent_sandboxes
        SELECT map.mind_id, p.executor_id, p.generation, p.lifecycle, p.reminder_latched,
               p.retire_requested, p.retire_requested_at, p.cold_notice_pending, p.active_run_id,
               p.next_run_seq, p.created_at, p.updated_at, p.retired_at
        FROM persistent_sandboxes_legacy_v15 p
        JOIN mind_id_migration_map map ON map.legacy_id = p.mind_id;
      DROP TABLE persistent_sandboxes_legacy_v15;
    `);
  }

  db.exec(`
    DROP TABLE mind_items;
    ALTER TABLE mind_items_v16 RENAME TO mind_items;
    CREATE INDEX mind_items_status_idx ON mind_items(status, archived_at, priority, due_at);
    CREATE INDEX mind_items_parent_idx ON mind_items(parent_id);
  `);
}
