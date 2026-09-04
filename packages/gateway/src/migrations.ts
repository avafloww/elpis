import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const GATEWAY_APPLICATION_ID = 0x454c5047;
export const GATEWAY_SCHEMA_VERSION = 3;

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

const PROVIDER_STORE_SCHEMA = `
  PRAGMA user_version = 3;

  CREATE TABLE gateway_provider_catalog (
    singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
    revision     INTEGER NOT NULL CHECK (
                   typeof(revision) = 'integer' AND
                   revision BETWEEN 0 AND 9007199254740991
                 ),
    updated_at   INTEGER NOT NULL CHECK (
                   typeof(updated_at) = 'integer' AND updated_at >= 0
                 )
  );

  INSERT INTO gateway_provider_catalog (singleton_id, revision, updated_at)
  VALUES (1, 0, unixepoch('subsec') * 1000);

  CREATE TRIGGER gateway_provider_catalog_no_replace
    BEFORE INSERT ON gateway_provider_catalog
    WHEN EXISTS (
      SELECT 1 FROM gateway_provider_catalog WHERE singleton_id = NEW.singleton_id
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider catalog already exists');
    END;

  CREATE TRIGGER gateway_provider_catalog_no_delete
    BEFORE DELETE ON gateway_provider_catalog BEGIN
      SELECT RAISE(ABORT, 'gateway provider catalog is retained');
    END;

  CREATE TRIGGER gateway_provider_catalog_revision_monotonic
    BEFORE UPDATE ON gateway_provider_catalog
    WHEN NEW.singleton_id IS NOT OLD.singleton_id
      OR typeof(NEW.revision) != 'integer'
      OR typeof(NEW.updated_at) != 'integer'
      OR NEW.revision != OLD.revision + 1
      OR NEW.updated_at < OLD.updated_at BEGIN
      SELECT RAISE(ABORT, 'gateway provider catalog revision must advance once');
    END;

  CREATE TABLE gateway_provider_credentials (
    id                    TEXT PRIMARY KEY CHECK (
                              length(id) = 27 AND substr(id, 1, 5) = 'epc1.' AND
                              substr(id, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
                            ),
    provider_id           TEXT NOT NULL CHECK (
                              length(provider_id) BETWEEN 1 AND 128 AND
                              provider_id NOT GLOB '*[^a-z0-9._-]*'
                            ),
    provider_type         TEXT NOT NULL CHECK (
                              provider_type IN (
                                'openai-compatible', 'anthropic-oauth', 'codex-oauth'
                              )
                            ),
    account_ref           TEXT NOT NULL CHECK (length(account_ref) BETWEEN 1 AND 256),
    account_identity_json TEXT NOT NULL CHECK (
                              length(account_identity_json) BETWEEN 2 AND 16384 AND
                              json_valid(account_identity_json) AND
                              json_type(account_identity_json) = 'object' AND
                              json(account_identity_json) = account_identity_json
                            ),
    auth_kind             TEXT NOT NULL CHECK (auth_kind IN ('api-key', 'oauth')),
    api_key               BLOB,
    oauth_access          BLOB,
    oauth_refresh         BLOB,
    oauth_expires         INTEGER,
    oauth_secret_revision INTEGER NOT NULL CHECK (
                              typeof(oauth_secret_revision) = 'integer' AND
                              oauth_secret_revision BETWEEN 0 AND 9007199254740991
                            ),
    created_at            INTEGER NOT NULL CHECK (
                              typeof(created_at) = 'integer' AND created_at >= 0
                            ),
    updated_at            INTEGER NOT NULL CHECK (
                              typeof(updated_at) = 'integer' AND updated_at >= created_at
                            ),
    CHECK (
      (
        provider_type = 'openai-compatible' AND auth_kind = 'api-key' AND
        typeof(api_key) = 'blob' AND length(api_key) BETWEEN 1 AND 131072 AND
        oauth_access IS NULL AND oauth_refresh IS NULL AND oauth_expires IS NULL AND
        oauth_secret_revision = 0
      ) OR (
        provider_type IN ('anthropic-oauth', 'codex-oauth') AND auth_kind = 'oauth' AND
        api_key IS NULL AND
        typeof(oauth_access) = 'blob' AND length(oauth_access) BETWEEN 1 AND 131072 AND
        typeof(oauth_refresh) = 'blob' AND length(oauth_refresh) BETWEEN 1 AND 131072 AND
        typeof(oauth_expires) = 'integer' AND
        oauth_expires BETWEEN 0 AND 9007199254740991
      )
    )
  );

  CREATE TRIGGER gateway_provider_credentials_no_replace
    BEFORE INSERT ON gateway_provider_credentials
    WHEN EXISTS (
      SELECT 1 FROM gateway_provider_credentials WHERE id = NEW.id
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider credential already exists');
    END;

  CREATE TRIGGER gateway_provider_credentials_identity_valid
    BEFORE INSERT ON gateway_provider_credentials
    WHEN json_valid(NEW.account_identity_json) AND (
      EXISTS (
        SELECT 1 FROM json_each(NEW.account_identity_json)
        WHERE key NOT IN ('accountId', 'email', 'orgId', 'orgName', 'authorizedAt')
      ) OR (
        SELECT count(*) FROM json_each(NEW.account_identity_json)
      ) != (
        SELECT count(DISTINCT key) FROM json_each(NEW.account_identity_json)
      ) OR EXISTS (
        SELECT 1 FROM json_each(NEW.account_identity_json)
        WHERE (key = 'authorizedAt' AND type NOT IN ('integer', 'null'))
          OR (key != 'authorizedAt' AND type NOT IN ('text', 'null'))
      )
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider account identity is invalid');
    END;

  CREATE TRIGGER gateway_provider_credentials_type_consistent
    BEFORE INSERT ON gateway_provider_credentials
    WHEN EXISTS (
      SELECT 1 FROM gateway_provider_credentials
      WHERE provider_id = NEW.provider_id AND provider_type != NEW.provider_type
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider namespace type is immutable');
    END;

  CREATE TRIGGER gateway_provider_credentials_no_delete
    BEFORE DELETE ON gateway_provider_credentials BEGIN
      SELECT RAISE(ABORT, 'gateway provider credentials are retained');
    END;

  CREATE TRIGGER gateway_provider_credentials_update_guard
    BEFORE UPDATE ON gateway_provider_credentials
    WHEN OLD.auth_kind != 'oauth'
      OR NEW.id IS NOT OLD.id
      OR NEW.provider_id IS NOT OLD.provider_id
      OR NEW.provider_type IS NOT OLD.provider_type
      OR NEW.account_ref IS NOT OLD.account_ref
      OR NEW.account_identity_json IS NOT OLD.account_identity_json
      OR NEW.auth_kind IS NOT OLD.auth_kind
      OR NEW.api_key IS NOT OLD.api_key
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.oauth_secret_revision != OLD.oauth_secret_revision + 1
      OR NEW.updated_at < OLD.updated_at BEGIN
      SELECT RAISE(ABORT, 'gateway provider credential identity is immutable');
    END;

  CREATE TABLE gateway_provider_targets (
    target_seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    target_generation      TEXT NOT NULL UNIQUE CHECK (
                             length(target_generation) = 27 AND
                             substr(target_generation, 1, 5) = 'egt1.' AND
                             substr(target_generation, 6) NOT GLOB '*[^A-Za-z0-9_-]*'
                           ),
    model_ref              TEXT NOT NULL CHECK (
                             length(model_ref) BETWEEN 3 AND 256 AND
                             model_ref NOT GLOB '*[^a-z0-9._/-]*' AND
                             instr(model_ref, '/') > 1 AND
                             instr(substr(model_ref, instr(model_ref, '/') + 1), '/') = 0
                           ),
    provider_id            TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
    provider_type          TEXT NOT NULL CHECK (
                             provider_type IN (
                               'openai-compatible', 'anthropic-oauth', 'codex-oauth'
                             )
                           ),
    credential_id          TEXT NOT NULL REFERENCES gateway_provider_credentials(id),
    account_ref            TEXT NOT NULL CHECK (length(account_ref) BETWEEN 1 AND 256),
    account_identity_json  TEXT NOT NULL CHECK (
                             length(account_identity_json) BETWEEN 2 AND 16384 AND
                             json_valid(account_identity_json) AND
                             json_type(account_identity_json) = 'object' AND
                             json(account_identity_json) = account_identity_json
                           ),
    base_url               TEXT NOT NULL CHECK (length(base_url) BETWEEN 8 AND 2048),
    upstream_model         TEXT NOT NULL CHECK (length(upstream_model) BETWEEN 1 AND 512),
    allowed_routes_json    TEXT NOT NULL CHECK (
                             length(allowed_routes_json) BETWEEN 2 AND 1024 AND
                             json_valid(allowed_routes_json) AND
                             json_type(allowed_routes_json) = 'array' AND
                             json(allowed_routes_json) = allowed_routes_json
                           ),
    wire_grammar_json      TEXT NOT NULL CHECK (
                             length(wire_grammar_json) BETWEEN 2 AND 4096 AND
                             json_valid(wire_grammar_json) AND
                             json_type(wire_grammar_json) = 'object' AND
                             json(wire_grammar_json) = wire_grammar_json
                           ),
    context_size           INTEGER CHECK (
                             context_size IS NULL OR (
                               typeof(context_size) = 'integer' AND
                               context_size BETWEEN 1 AND 16777216
                             )
                           ),
    reasoning_effort       TEXT CHECK (
                             reasoning_effort IS NULL OR length(reasoning_effort) <= 1024
                           ),
    reasoning_summary      TEXT CHECK (
                             reasoning_summary IS NULL OR length(reasoning_summary) <= 1024
                           ),
    reasoning_context      TEXT CHECK (
                             reasoning_context IS NULL OR length(reasoning_context) <= 1024
                           ),
    tool_tier              TEXT CHECK (
                             tool_tier IS NULL OR tool_tier IN ('weak', 'medium', 'strong')
                           ),
    external_thinking      INTEGER NOT NULL CHECK (
                             typeof(external_thinking) = 'integer' AND
                             external_thinking IN (0, 1)
                           ),
    tool_contract_version  TEXT NOT NULL CHECK (
                             length(tool_contract_version) BETWEEN 1 AND 128
                           ),
    call_timeout_ms        INTEGER NOT NULL CHECK (
                             typeof(call_timeout_ms) = 'integer' AND
                             call_timeout_ms BETWEEN 1 AND 86400000
                           ),
    stream_idle_timeout_ms INTEGER NOT NULL CHECK (
                             typeof(stream_idle_timeout_ms) = 'integer' AND
                             stream_idle_timeout_ms BETWEEN 1 AND 86400000
                           ),
    snapshot_sha256        BLOB NOT NULL CHECK (
                             typeof(snapshot_sha256) = 'blob' AND
                             length(snapshot_sha256) = 32
                           ),
    created_at             INTEGER NOT NULL CHECK (
                             typeof(created_at) = 'integer' AND created_at >= 0
                           ),
    UNIQUE (target_seq, model_ref, target_generation),
    CHECK (provider_id = substr(model_ref, 1, instr(model_ref, '/') - 1)),
    CHECK (external_thinking = 0 OR provider_type = 'codex-oauth')
  );

  CREATE INDEX gateway_provider_targets_by_model
    ON gateway_provider_targets (model_ref, target_seq DESC);

  CREATE TRIGGER gateway_provider_targets_no_replace
    BEFORE INSERT ON gateway_provider_targets
    WHEN EXISTS (
      SELECT 1 FROM gateway_provider_targets
      WHERE target_seq = NEW.target_seq
         OR target_generation = NEW.target_generation
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider target already exists');
    END;

  CREATE TRIGGER gateway_provider_targets_credential_match
    BEFORE INSERT ON gateway_provider_targets
    WHEN NOT EXISTS (
      SELECT 1 FROM gateway_provider_credentials
      WHERE id = NEW.credential_id
        AND provider_id = NEW.provider_id
        AND provider_type = NEW.provider_type
        AND account_ref = NEW.account_ref
        AND account_identity_json = NEW.account_identity_json
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider target credential does not match');
    END;

  CREATE TRIGGER gateway_provider_targets_no_update
    BEFORE UPDATE ON gateway_provider_targets BEGIN
      SELECT RAISE(ABORT, 'gateway provider targets are immutable');
    END;

  CREATE TRIGGER gateway_provider_targets_no_delete
    BEFORE DELETE ON gateway_provider_targets BEGIN
      SELECT RAISE(ABORT, 'gateway provider targets are retained');
    END;

  CREATE TABLE gateway_provider_model_heads (
    model_ref         TEXT PRIMARY KEY,
    target_seq        INTEGER NOT NULL,
    target_generation TEXT NOT NULL,
    enabled           INTEGER NOT NULL CHECK (
                        typeof(enabled) = 'integer' AND enabled IN (0, 1)
                      ),
    created_at        INTEGER NOT NULL CHECK (
                        typeof(created_at) = 'integer' AND created_at >= 0
                      ),
    updated_at        INTEGER NOT NULL CHECK (
                        typeof(updated_at) = 'integer' AND updated_at >= created_at
                      ),
    FOREIGN KEY (target_seq, model_ref, target_generation)
      REFERENCES gateway_provider_targets (target_seq, model_ref, target_generation)
  );

  CREATE TRIGGER gateway_provider_model_heads_no_replace
    BEFORE INSERT ON gateway_provider_model_heads
    WHEN EXISTS (
      SELECT 1 FROM gateway_provider_model_heads WHERE model_ref = NEW.model_ref
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider model head already exists');
    END;

  CREATE TRIGGER gateway_provider_model_heads_no_delete
    BEFORE DELETE ON gateway_provider_model_heads BEGIN
      SELECT RAISE(ABORT, 'gateway provider model heads are retained');
    END;

  CREATE TRIGGER gateway_provider_model_heads_update_guard
    BEFORE UPDATE ON gateway_provider_model_heads
    WHEN NEW.model_ref IS NOT OLD.model_ref
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.updated_at < OLD.updated_at
      OR NEW.target_seq < OLD.target_seq
      OR (NEW.target_seq = OLD.target_seq AND NEW.target_generation IS NOT OLD.target_generation)
      OR (NEW.target_seq = OLD.target_seq AND OLD.enabled = 0 AND NEW.enabled = 1)
      OR (NEW.target_seq = OLD.target_seq AND OLD.enabled = NEW.enabled) BEGIN
      SELECT RAISE(ABORT, 'gateway provider model head must advance or disable; enabling requires a newer target');
    END;

  CREATE TABLE gateway_instance_model_grants (
    instance_id       TEXT NOT NULL REFERENCES gateway_instances(id),
    model_ref         TEXT NOT NULL REFERENCES gateway_provider_model_heads(model_ref),
    target_seq        INTEGER NOT NULL,
    target_generation TEXT NOT NULL,
    authorized_at     INTEGER NOT NULL CHECK (
                        typeof(authorized_at) = 'integer' AND authorized_at >= 0
                      ),
    PRIMARY KEY (instance_id, model_ref),
    FOREIGN KEY (target_seq, model_ref, target_generation)
      REFERENCES gateway_provider_targets (target_seq, model_ref, target_generation)
  );

  CREATE INDEX gateway_instance_model_grants_by_instance
    ON gateway_instance_model_grants (instance_id, model_ref);

  CREATE TRIGGER gateway_instance_model_grants_no_replace
    BEFORE INSERT ON gateway_instance_model_grants
    WHEN EXISTS (
      SELECT 1 FROM gateway_instance_model_grants
      WHERE instance_id = NEW.instance_id AND model_ref = NEW.model_ref
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider model grant already exists');
    END;

  CREATE TRIGGER gateway_instance_model_grants_active_instance
    BEFORE INSERT ON gateway_instance_model_grants
    WHEN NOT EXISTS (
      SELECT 1 FROM gateway_instances
      WHERE id = NEW.instance_id AND revoked_at IS NULL
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider grant instance is revoked');
    END;

  CREATE TRIGGER gateway_instance_model_grants_active_head
    BEFORE INSERT ON gateway_instance_model_grants
    WHEN NOT EXISTS (
      SELECT 1 FROM gateway_provider_model_heads
      WHERE model_ref = NEW.model_ref
        AND target_seq = NEW.target_seq
        AND target_generation = NEW.target_generation
        AND enabled = 1
    ) BEGIN
      SELECT RAISE(ABORT, 'gateway provider grant requires active head');
    END;

  CREATE TRIGGER gateway_instance_model_grants_no_update
    BEFORE UPDATE ON gateway_instance_model_grants BEGIN
      SELECT RAISE(ABORT, 'gateway provider grants are immutable');
    END;

  CREATE TRIGGER gateway_provider_model_heads_clear_grants
    AFTER UPDATE ON gateway_provider_model_heads
    WHEN NEW.target_seq != OLD.target_seq OR NEW.enabled = 0 BEGIN
      DELETE FROM gateway_instance_model_grants WHERE model_ref = OLD.model_ref;
    END;

  CREATE TRIGGER gateway_provider_model_heads_revision_insert
    AFTER INSERT ON gateway_provider_model_heads BEGIN
      UPDATE gateway_provider_catalog
      SET revision = revision + 1,
          updated_at = max(updated_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
      WHERE singleton_id = 1 AND revision < 9007199254740991;
      SELECT CASE WHEN changes() != 1
        THEN RAISE(ABORT, 'gateway provider catalog revision exhausted') END;
    END;

  CREATE TRIGGER gateway_provider_model_heads_revision_update
    AFTER UPDATE ON gateway_provider_model_heads BEGIN
      UPDATE gateway_provider_catalog
      SET revision = revision + 1,
          updated_at = max(updated_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
      WHERE singleton_id = 1 AND revision < 9007199254740991;
      SELECT CASE WHEN changes() != 1
        THEN RAISE(ABORT, 'gateway provider catalog revision exhausted') END;
    END;

  CREATE TRIGGER gateway_instance_model_grants_revision_insert
    AFTER INSERT ON gateway_instance_model_grants BEGIN
      UPDATE gateway_provider_catalog
      SET revision = revision + 1,
          updated_at = max(updated_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
      WHERE singleton_id = 1 AND revision < 9007199254740991;
      SELECT CASE WHEN changes() != 1
        THEN RAISE(ABORT, 'gateway provider catalog revision exhausted') END;
    END;

  CREATE TRIGGER gateway_instance_model_grants_revision_delete
    AFTER DELETE ON gateway_instance_model_grants BEGIN
      UPDATE gateway_provider_catalog
      SET revision = revision + 1,
          updated_at = max(updated_at, CAST(unixepoch('subsec') * 1000 AS INTEGER))
      WHERE singleton_id = 1 AND revision < 9007199254740991;
      SELECT CASE WHEN changes() != 1
        THEN RAISE(ABORT, 'gateway provider catalog revision exhausted') END;
    END;

  CREATE TRIGGER gateway_instances_provider_revocation_monotonic
    BEFORE UPDATE OF revoked_at ON gateway_instances
    WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at BEGIN
      SELECT RAISE(ABORT, 'gateway instance revocation is irreversible');
    END;

  CREATE TRIGGER gateway_instances_clear_provider_grants
    AFTER UPDATE OF revoked_at ON gateway_instances
    WHEN OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL BEGIN
      DELETE FROM gateway_instance_model_grants WHERE instance_id = OLD.id;
    END;
`;

export const GATEWAY_MIGRATIONS: readonly GatewayMigration[] = Object.freeze([
  Object.freeze({ name: '001-initial', sql: INITIAL_SCHEMA }),
  Object.freeze({ name: '002-credentials', sql: CREDENTIAL_SCHEMA }),
  Object.freeze({ name: '003-provider-store', sql: PROVIDER_STORE_SCHEMA }),
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
