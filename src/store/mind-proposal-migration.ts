import type { MigrationDatabase } from "./migrations.js";

export const MIND_PROPOSAL_STATUS_MIGRATION_CHECKSUM =
  "c807ba65c9117d02083fe695f35101a47723080253f2b5cc0acfccee3c308712";

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function referencingTableClosure(
  db: MigrationDatabase,
  root: string,
): string[] {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((row) => String((row as { name: unknown }).name));
  const selected = [root];
  const seen = new Set(selected);
  for (let cursor = 0; cursor < selected.length; cursor += 1) {
    const parent = selected[cursor];
    for (const table of tables) {
      if (seen.has(table)) continue;
      const references = db
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all()
        .some((row) => String((row as { table: unknown }).table) === parent);
      if (references) {
        seen.add(table);
        selected.push(table);
      }
    }
  }
  return selected;
}

function createForReplacement(
  sql: string,
  table: string,
  root: string,
): string {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const create = sql.replace(
    new RegExp(`^(\\s*CREATE\\s+TABLE\\s+)(?:["']?${escaped}["']?)`, "i"),
    (_match, prefix: string) => `${prefix}${quoteIdentifier(table)}`,
  );
  return create.replace(
    /(REFERENCES\s+)(?:["']?mind_items["']?)(\s*\()/gi,
    (_match, prefix: string, suffix: string) =>
      `${prefix}${quoteIdentifier(root)}${suffix}`,
  );
}

const PROPOSAL_GUARDS_SQL = `
  CREATE TRIGGER mind_items_proposal_transition_guard
  BEFORE UPDATE OF status ON mind_items
  WHEN (OLD.status = 'proposal' AND NEW.status NOT IN ('proposal','inbox','open','cancelled'))
    OR (OLD.status != 'proposal' AND NEW.status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: invalid proposal status transition');
  END;

  CREATE TRIGGER mind_items_proposal_due_insert_guard
  BEFORE INSERT ON mind_items
  WHEN NEW.status = 'proposal' AND NEW.due_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot have a due date');
  END;
  CREATE TRIGGER mind_items_proposal_due_update_guard
  BEFORE UPDATE OF status, due_at ON mind_items
  WHEN NEW.status = 'proposal' AND NEW.due_at IS NOT NULL
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot have a due date');
  END;

  CREATE TRIGGER mind_dependencies_proposal_insert_guard
  BEFORE INSERT ON mind_dependencies
  WHEN EXISTS (
    SELECT 1 FROM mind_items
    WHERE id IN (NEW.item_id, NEW.depends_on_id) AND status = 'proposal'
  )
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot have readiness dependencies');
  END;
  CREATE TRIGGER mind_dependencies_proposal_update_guard
  BEFORE UPDATE OF item_id, depends_on_id ON mind_dependencies
  WHEN EXISTS (
    SELECT 1 FROM mind_items
    WHERE id IN (NEW.item_id, NEW.depends_on_id) AND status = 'proposal'
  )
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot have readiness dependencies');
  END;

  CREATE TRIGGER mind_reminders_proposal_insert_guard
  BEFORE INSERT ON mind_reminders
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.item_id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot have reminders');
  END;
  CREATE TRIGGER mind_reminders_proposal_update_guard
  BEFORE UPDATE OF item_id ON mind_reminders
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.item_id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot have reminders');
  END;

  CREATE TRIGGER mind_claims_proposal_insert_guard
  BEFORE INSERT ON mind_claims
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.item_id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot be claimed');
  END;
  CREATE TRIGGER mind_claims_proposal_update_guard
  BEFORE UPDATE OF item_id ON mind_claims
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.item_id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot be claimed');
  END;

  CREATE TRIGGER worker_sessions_proposal_insert_guard
  BEFORE INSERT ON worker_sessions
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.mind_id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot be claimed by workers');
  END;
  CREATE TRIGGER worker_sessions_proposal_update_guard
  BEFORE UPDATE OF mind_id ON worker_sessions
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.mind_id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot be claimed by workers');
  END;

  CREATE TRIGGER persistent_sandboxes_proposal_insert_guard
  BEFORE INSERT ON persistent_sandboxes
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot receive a persistent sandbox');
  END;
  CREATE TRIGGER persistent_sandboxes_proposal_update_guard
  BEFORE UPDATE OF id ON persistent_sandboxes
  WHEN EXISTS (SELECT 1 FROM mind_items WHERE id = NEW.id AND status = 'proposal')
  BEGIN
    SELECT RAISE(ABORT, 'mind: proposal items cannot receive a persistent sandbox');
  END;
`;

export function migrateMindProposalStatus(db: MigrationDatabase): void {
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'mind_items'",
    )
    .get() as { sql?: unknown } | undefined;
  if (!schema?.sql)
    throw new Error("mind proposal migration: mind_items is missing");
  const sql = String(schema.sql);
  const oldStatuses =
    "('inbox','open','in_progress','waiting','done','cancelled')";
  if (!sql.includes(oldStatuses))
    throw new Error(
      "mind proposal migration: unexpected mind_items status constraint",
    );

  const root = "mind_items_v20";
  const tables = referencingTableClosure(db, "mind_items");
  const definitions = new Map<string, string>();
  for (const table of tables) {
    const row = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?",
      )
      .get(table) as { sql?: unknown } | undefined;
    if (!row?.sql)
      throw new Error(`mind proposal migration: missing schema for ${table}`);
    definitions.set(table, String(row.sql));
  }
  const schemaObjects = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_schema
       WHERE tbl_name IN (${tables.map(() => "?").join(",")})
         AND type IN ('index','trigger') AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all(...tables) as { type: string; name: string; sql: string }[];

  db.exec("PRAGMA defer_foreign_keys = ON");
  for (const object of schemaObjects)
    db.exec(
      `DROP ${object.type.toUpperCase()} ${quoteIdentifier(object.name)}`,
    );
  for (const table of tables.slice(1))
    db.exec(
      `ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(`${table}_legacy_v20`)}`,
    );

  db.exec(`CREATE TABLE ${quoteIdentifier(root)} (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL CHECK (kind IN ('task','project','idea','question','reminder')),
    status TEXT NOT NULL CHECK (status IN ('proposal','inbox','open','in_progress','waiting','done','cancelled')),
    priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 0 AND 4),
    parent_id TEXT REFERENCES ${quoteIdentifier(root)}(id) ON DELETE SET NULL,
    due_at INTEGER,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    archived_at INTEGER
  )`);
  db.exec(`INSERT INTO ${quoteIdentifier(root)} SELECT * FROM mind_items`);

  for (const table of tables.slice(1)) {
    db.exec(createForReplacement(definitions.get(table)!, table, root));
    db.exec(
      `INSERT INTO ${quoteIdentifier(table)} SELECT * FROM ${quoteIdentifier(`${table}_legacy_v20`)}`,
    );
  }
  for (const table of [...tables.slice(1)].reverse())
    db.exec(`DROP TABLE ${quoteIdentifier(`${table}_legacy_v20`)}`);
  db.exec("DROP TABLE mind_items");
  db.exec(`ALTER TABLE ${quoteIdentifier(root)} RENAME TO mind_items`);

  for (const object of schemaObjects) db.exec(object.sql);
  db.exec(PROPOSAL_GUARDS_SQL);

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length > 0)
    throw new Error(
      `mind proposal migration: foreign key check failed (${violations.length} violations)`,
    );
}

export const MIND_PROPOSAL_STATUS_MIGRATION = Object.freeze({
  name: "0020-mind-proposal-status",
  checksum: MIND_PROPOSAL_STATUS_MIGRATION_CHECKSUM,
  up: migrateMindProposalStatus,
});
