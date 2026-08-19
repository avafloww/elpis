import { createHash } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';

const COMPONENT_PATTERN = /^(?:core|extension:[A-Za-z_][A-Za-z0-9]*)$/;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CHECKSUM_PATTERN = /^[0-9a-f]{64}$/;

export interface SqlMigration {
  readonly name: string;
  readonly sql: string;
}

export interface MigrationDatabase {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
}

export interface CodeMigration {
  readonly name: string;
  readonly checksum: string;
  readonly up: (database: MigrationDatabase) => void;
}

export type Migration = SqlMigration | CodeMigration;

export interface MigrationRunResult {
  readonly component: string;
  readonly existing: readonly string[];
  readonly applied: readonly string[];
}

interface AppliedMigration {
  readonly name: string;
  readonly checksum: string;
}

interface NormalizedMigration {
  readonly name: string;
  readonly checksum: string;
  readonly up: (database: DatabaseSync) => unknown;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checksum(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function runCodeMigration(
  database: DatabaseSync,
  up: (database: MigrationDatabase) => void,
): unknown {
  let active = true;
  const assertActive = (): void => {
    if (!active) throw new Error('migration database scope is closed');
  };
  const wrapIterator = <T>(iterator: Iterator<T>): Iterator<T> => new Proxy(iterator, {
    get(target, property) {
      assertActive();
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertActive();
        return Reflect.apply(value, target, args) as unknown;
      };
    },
  });
  const wrapStatement = (statement: StatementSync): StatementSync => new Proxy(statement, {
    get(target, property) {
      assertActive();
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        assertActive();
        const result = Reflect.apply(value, target, args) as unknown;
        return property === 'iterate' ? wrapIterator(result as Iterator<unknown>) : result;
      };
    },
  });
  const scoped = Object.freeze({
    exec(sql: string): void {
      assertActive();
      database.exec(sql);
    },
    prepare(sql: string): StatementSync {
      assertActive();
      return wrapStatement(database.prepare(sql));
    },
  });
  try {
    return up(scoped);
  } finally {
    active = false;
  }
}

function normalizeMigration(value: Migration, index: number): NormalizedMigration {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`migration[${index}] must be an object`);
  }
  if (typeof value.name !== 'string' || !NAME_PATTERN.test(value.name)) {
    throw new Error(`migration[${index}].name must match ${NAME_PATTERN}`);
  }
  const hasSql = Object.hasOwn(value, 'sql');
  const hasUp = Object.hasOwn(value, 'up');
  if (hasSql === hasUp) throw new Error(`migration ${value.name} must define exactly one of sql or up`);
  const allowed = new Set(hasSql ? ['name', 'sql'] : ['name', 'checksum', 'up']);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`migration ${value.name} contains unknown field ${unknown}`);
  if (hasSql) {
    const sql = (value as SqlMigration).sql;
    if (typeof sql !== 'string' || !sql.trim()) throw new Error(`migration ${value.name}.sql must be a non-empty string`);
    return { name: value.name, checksum: checksum(sql), up: (database) => database.exec(sql) };
  }
  const code = value as CodeMigration;
  if (typeof code.up !== 'function') throw new Error(`migration ${value.name}.up must be a function`);
  if (code.up.constructor.name === 'AsyncFunction') throw new Error(`migration ${value.name}.up must be synchronous`);
  if (typeof code.checksum !== 'string' || !CHECKSUM_PATTERN.test(code.checksum)) {
    throw new Error(`migration ${value.name}.checksum must be a lowercase SHA-256 hex string`);
  }
  return { name: value.name, checksum: code.checksum, up: (database) => runCodeMigration(database, code.up) };
}

export function ensureMigrationLedger(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS elpis_migrations (
      component  TEXT NOT NULL,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL,
      PRIMARY KEY (component, name)
    );
    CREATE TRIGGER IF NOT EXISTS elpis_migrations_no_update
      BEFORE UPDATE ON elpis_migrations BEGIN
        SELECT RAISE(ABORT, 'migration receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS elpis_migrations_no_delete
      BEFORE DELETE ON elpis_migrations BEGIN
        SELECT RAISE(ABORT, 'migration receipts are append-only');
      END;
  `);
}

export function runComponentMigrations(
  database: DatabaseSync,
  component: string,
  migrations: readonly Migration[],
  options: { now?: () => string } = {},
): MigrationRunResult {
  if (!COMPONENT_PATTERN.test(component)) throw new Error(`migration component must match ${COMPONENT_PATTERN}`);
  if (!Array.isArray(migrations)) throw new Error(`migrations for ${component} must be an array`);
  const normalized = migrations.map(normalizeMigration);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].name >= normalized[index].name) {
      throw new Error(`migrations for ${component} must be strictly sorted by unique name`);
    }
  }

  ensureMigrationLedger(database);
  const applied = database.prepare(`
    SELECT name, checksum
    FROM elpis_migrations
    WHERE component = ?
    ORDER BY name
  `).all(component) as unknown as AppliedMigration[];

  if (applied.length > normalized.length) {
    throw new Error(`migration history for ${component} contains undeclared entries`);
  }
  for (let index = 0; index < applied.length; index += 1) {
    const receipt = applied[index];
    const declared = normalized[index];
    if (!declared || receipt.name !== declared.name) {
      throw new Error(`migration history for ${component} is not an exact declared prefix at ${receipt.name}`);
    }
    if (receipt.checksum !== declared.checksum) {
      throw new Error(`migration checksum drift for ${component}/${receipt.name}`);
    }
  }

  const newlyApplied: string[] = [];
  const insert = database.prepare(`
    INSERT INTO elpis_migrations (component, name, checksum, applied_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const migration of normalized.slice(applied.length)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = migration.up(database);
      if (result != null && typeof (result as { then?: unknown }).then === 'function') {
        throw new Error('code migrations must be synchronous');
      }
      insert.run(component, migration.name, migration.checksum, (options.now ?? (() => new Date().toISOString()))());
      database.exec('COMMIT');
      newlyApplied.push(migration.name);
    } catch (error) {
      try { database.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
      throw new Error(`migration ${component}/${migration.name} failed: ${message(error)}`, { cause: error });
    }
  }

  return Object.freeze({
    component,
    existing: Object.freeze(applied.map((row) => row.name)),
    applied: Object.freeze(newlyApplied),
  });
}
