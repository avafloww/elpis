import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const GATEWAY_APPLICATION_ID = 0x454c5047;
export const GATEWAY_SCHEMA_VERSION = 2;

export interface GatewayMigration {
  readonly name: string;
  readonly sql: string;
}

export interface GatewayMigrationResult {
  readonly existing: readonly string[];
  readonly applied: readonly string[];
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const INITIAL_SCHEMA = `
  PRAGMA application_id = ${GATEWAY_APPLICATION_ID};
  PRAGMA user_version = 1;

  CREATE TABLE gateway_config (
    singleton_id       INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    public_url         TEXT CHECK (public_url IS NULL OR length(public_url) BETWEEN 1 AND 2048),
    setup_completed_at INTEGER,
    revision           INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );

  INSERT INTO gateway_config (
    singleton_id, public_url, setup_completed_at, revision, created_at, updated_at
  ) VALUES (1, NULL, NULL, 0, unixepoch('subsec') * 1000, unixepoch('subsec') * 1000);

  CREATE TABLE gateway_instances (
    id           TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 256),
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    revoked_at   INTEGER
  );

  CREATE TABLE gateway_audit_events (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    actor_kind  TEXT NOT NULL CHECK (length(actor_kind) BETWEEN 1 AND 64),
    actor_id    TEXT CHECK (actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 256),
    action      TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 128),
    target_kind TEXT NOT NULL CHECK (length(target_kind) BETWEEN 1 AND 64),
    target_id   TEXT CHECK (target_id IS NULL OR length(target_id) BETWEEN 1 AND 256),
    outcome     TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'denied')),
    request_id  TEXT CHECK (request_id IS NULL OR length(request_id) BETWEEN 1 AND 128),
    detail_json TEXT NOT NULL CHECK (length(detail_json) <= 4096 AND json_valid(detail_json))
  );

  CREATE TRIGGER gateway_audit_events_no_update
    BEFORE UPDATE ON gateway_audit_events BEGIN
      SELECT RAISE(ABORT, 'gateway audit events are immutable');
    END;

  CREATE TRIGGER gateway_audit_events_no_delete
    BEFORE DELETE ON gateway_audit_events BEGIN
      SELECT RAISE(ABORT, 'gateway audit events are append-only');
    END;
`;

const CREDENTIAL_SCHEMA = `
  PRAGMA user_version = 2;

  CREATE TABLE gateway_enrollment_grants (
    id                           TEXT PRIMARY KEY CHECK (length(id) = 22),
    verifier                     BLOB NOT NULL CHECK (typeof(verifier) = 'blob' AND length(verifier) = 32),
    created_at                   INTEGER NOT NULL,
    expires_at                   INTEGER NOT NULL CHECK (expires_at > created_at),
    revoked_at                   INTEGER,
    consumed_at                  INTEGER,
    consumed_instance_id         TEXT,
    consumed_credential_id       TEXT,
    consumed_credential_verifier BLOB,
    FOREIGN KEY (consumed_instance_id) REFERENCES gateway_instances(id),
    FOREIGN KEY (consumed_credential_id) REFERENCES gateway_node_credentials(id),
    CHECK (
      (consumed_at IS NULL AND consumed_instance_id IS NULL AND consumed_credential_id IS NULL AND consumed_credential_verifier IS NULL)
      OR
      (consumed_at IS NOT NULL AND consumed_instance_id IS NOT NULL AND consumed_credential_id IS NOT NULL
        AND typeof(consumed_credential_verifier) = 'blob' AND length(consumed_credential_verifier) = 32)
    )
  );

  CREATE TABLE gateway_node_credentials (
    id                         TEXT PRIMARY KEY CHECK (length(id) = 22),
    instance_id                TEXT NOT NULL REFERENCES gateway_instances(id),
    verifier                   BLOB NOT NULL CHECK (typeof(verifier) = 'blob' AND length(verifier) = 32),
    state                      TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
    rotates_credential_id      TEXT REFERENCES gateway_node_credentials(id),
    replaced_by_credential_id  TEXT REFERENCES gateway_node_credentials(id),
    created_at                 INTEGER NOT NULL,
    activated_at               INTEGER,
    last_used_at               INTEGER,
    revoked_at                 INTEGER,
    CHECK (
      (state = 'pending' AND rotates_credential_id IS NOT NULL AND activated_at IS NULL AND revoked_at IS NULL)
      OR
      (state = 'active' AND activated_at IS NOT NULL AND revoked_at IS NULL)
      OR
      (state = 'revoked' AND revoked_at IS NOT NULL)
    )
  );

  CREATE UNIQUE INDEX gateway_one_pending_rotation
    ON gateway_node_credentials(rotates_credential_id)
    WHERE state = 'pending';

  CREATE UNIQUE INDEX gateway_one_active_credential
    ON gateway_node_credentials(instance_id)
    WHERE state = 'active';

  CREATE TRIGGER gateway_enrollment_grants_no_delete
    BEFORE DELETE ON gateway_enrollment_grants BEGIN
      SELECT RAISE(ABORT, 'gateway enrollment grants are retained');
    END;

  CREATE TRIGGER gateway_enrollment_grants_identity_immutable
    BEFORE UPDATE OF id, verifier, created_at, expires_at
    ON gateway_enrollment_grants BEGIN
      SELECT RAISE(ABORT, 'gateway enrollment grant identity is immutable');
    END;

  CREATE TRIGGER gateway_enrollment_grants_consumed_once
    BEFORE UPDATE OF consumed_at, consumed_instance_id, consumed_credential_id, consumed_credential_verifier
    ON gateway_enrollment_grants
    WHEN OLD.consumed_at IS NOT NULL BEGIN
      SELECT RAISE(ABORT, 'gateway enrollment grant binding is immutable');
    END;

  CREATE TRIGGER gateway_node_credentials_no_delete
    BEFORE DELETE ON gateway_node_credentials BEGIN
      SELECT RAISE(ABORT, 'gateway node credentials are retained');
    END;

  CREATE TRIGGER gateway_node_credentials_identity_immutable
    BEFORE UPDATE OF id, instance_id, verifier, rotates_credential_id, created_at
    ON gateway_node_credentials BEGIN
      SELECT RAISE(ABORT, 'gateway credential identity is immutable');
    END;

  CREATE TRIGGER gateway_node_credentials_state_monotonic
    BEFORE UPDATE OF state ON gateway_node_credentials
    WHEN NOT (
      (OLD.state = 'pending' AND NEW.state IN ('active', 'revoked'))
      OR (OLD.state = 'active' AND NEW.state = 'revoked')
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway credential state cannot move backward');
    END;
`;

export const GATEWAY_MIGRATIONS: readonly GatewayMigration[] = Object.freeze([
  Object.freeze({ name: '001-initial', sql: INITIAL_SCHEMA }),
  Object.freeze({ name: '002-credentials', sql: CREDENTIAL_SCHEMA }),
]);

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function ensureLedger(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS gateway_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS gateway_migrations_no_update
      BEFORE UPDATE ON gateway_migrations BEGIN
        SELECT RAISE(ABORT, 'gateway migration receipts are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS gateway_migrations_no_delete
      BEFORE DELETE ON gateway_migrations BEGIN
        SELECT RAISE(ABORT, 'gateway migration receipts are append-only');
      END;
  `);
}

export function verifyGatewayMigrationHistory(
  database: DatabaseSync,
  migrations: readonly GatewayMigration[] = GATEWAY_MIGRATIONS,
): readonly string[] {
  const declared = migrations.map((migration) => ({
    name: migration.name,
    checksum: checksum(migration.sql),
  }));
  const existing = database
    .prepare('SELECT name, checksum FROM gateway_migrations ORDER BY name')
    .all() as unknown as Array<{ name: string; checksum: string }>;
  if (existing.length !== declared.length)
    throw new Error('gateway migration history is incomplete');
  for (let index = 0; index < existing.length; index += 1) {
    if (existing[index].name !== declared[index].name)
      throw new Error(
        `gateway migration history is not exact at ${existing[index].name}`,
      );
    if (existing[index].checksum !== declared[index].checksum)
      throw new Error(
        `gateway migration checksum drift at ${existing[index].name}`,
      );
  }
  return Object.freeze(existing.map((receipt) => receipt.name));
}

export function runGatewayMigrations(
  database: DatabaseSync,
  migrations: readonly GatewayMigration[] = GATEWAY_MIGRATIONS,
  now: () => number = Date.now,
): GatewayMigrationResult {
  if (!Array.isArray(migrations))
    throw new Error('gateway migrations must be an array');
  const normalized = migrations.map((migration, index) => {
    if (!migration || typeof migration !== 'object')
      throw new Error(`gateway migration[${index}] must be an object`);
    if (!NAME_PATTERN.test(migration.name))
      throw new Error(`gateway migration[${index}] has an invalid name`);
    if (typeof migration.sql !== 'string' || !migration.sql.trim())
      throw new Error(`gateway migration ${migration.name} must contain SQL`);
    return {
      name: migration.name,
      sql: migration.sql,
      checksum: checksum(migration.sql),
    };
  });
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].name >= normalized[index].name)
      throw new Error(
        'gateway migrations must be strictly sorted by unique name',
      );
  }

  ensureLedger(database);
  const existing = database
    .prepare('SELECT name, checksum FROM gateway_migrations ORDER BY name')
    .all() as unknown as Array<{ name: string; checksum: string }>;
  if (existing.length > normalized.length)
    throw new Error('gateway migration history contains undeclared entries');
  for (let index = 0; index < existing.length; index += 1) {
    const receipt = existing[index];
    const declared = normalized[index];
    if (!declared || receipt.name !== declared.name)
      throw new Error(
        `gateway migration history is not an exact prefix at ${receipt.name}`,
      );
    if (receipt.checksum !== declared.checksum)
      throw new Error(`gateway migration checksum drift at ${receipt.name}`);
  }

  const applied: string[] = [];
  const insert = database.prepare(
    'INSERT INTO gateway_migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of normalized.slice(existing.length)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      insert.run(migration.name, migration.checksum, now());
      database.exec('COMMIT');
      applied.push(migration.name);
    } catch (error) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* preserve the migration error */
      }
      throw new Error(
        `gateway migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return Object.freeze({
    existing: Object.freeze(existing.map((row) => row.name)),
    applied: Object.freeze(applied),
  });
}
