import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupGatewayDatabase, type GatewayBackupReceipt } from './backup.js';
import { GatewayCredentialStore } from './credential-store.js';
import {
  isCredentialId,
  isGatewayInstanceId,
  type RandomBytes,
} from './credentials.js';
import { parseCanonicalPublicOrigin } from './http-guards.js';
import {
  GATEWAY_APPLICATION_ID,
  GATEWAY_MIGRATIONS,
  GATEWAY_SCHEMA_VERSION,
  runGatewayMigrations,
} from './migrations.js';

const DATABASE_NAME = 'gateway.db';
const MAX_AUDIT_DETAIL_BYTES = 4096;

export interface GatewayConfig {
  publicUrl: string | null;
  setupCompletedAt: number | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface GatewayInstanceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
  readonly activeCredentialId: string | null;
  readonly activeSince: number | null;
  readonly lastUsedAt: number | null;
}

export interface GatewayAuditInput {
  actorKind: string;
  actorId?: string | null;
  action: string;
  targetKind: string;
  targetId?: string | null;
  outcome: 'succeeded' | 'failed' | 'denied';
  requestId?: string | null;
  detail?: Record<string, unknown>;
}

export interface GatewayAuditEvent extends GatewayAuditInput {
  seq: number;
  at: number;
  actorId: string | null;
  targetId: string | null;
  requestId: string | null;
  detail: Record<string, unknown>;
}

export interface OpenGatewayStoreOptions {
  now?: () => number;
  randomBytes?: RandomBytes;
}

function exactInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`${label} is not a safe integer`);
  return number;
}

function exactIntegerOrNull(value: unknown, label: string): number | null {
  return value === null ? null : exactInteger(value, label);
}

function gatewayInstanceId(value: unknown): string {
  if (!isGatewayInstanceId(value))
    throw new Error('instance id has invalid syntax');
  return value;
}

function gatewayCredentialIdOrNull(value: unknown): string | null {
  if (value === null) return null;
  if (!isCredentialId(value))
    throw new Error('active credential id has invalid syntax');
  return value;
}

function gatewayDisplayName(value: unknown): string {
  if (typeof value !== 'string')
    throw new Error('instance display name must be text');
  const result = value.trim();
  if (result.length < 1 || result.length > 256)
    throw new Error('instance display name must contain 1 to 256 characters');
  if (/\p{Cc}/u.test(result))
    throw new Error(
      'instance display name must not contain control characters',
    );
  return result;
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw new Error(`${label} must contain 1 to ${max} characters`);
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  max: number,
): string | null {
  if (value == null) return null;
  return boundedText(value, label, max);
}

function canonicalPublicUrl(value: string): string {
  return parseCanonicalPublicOrigin(value, { allowLocalHttp: true });
}

function assertPlainDetail(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error('audit detail must be a plain object');
  return value as Record<string, unknown>;
}

function hardenDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('gateway data directory must be a real directory');
  fs.chmodSync(directory, 0o700);
}

function ensureDatabaseFile(file: string): void {
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error('gateway database must be a regular file');
  }
  const flags =
    fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW;
  const descriptor = fs.openSync(file, flags, 0o600);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile())
      throw new Error('gateway database must be a regular file');
  } finally {
    fs.closeSync(descriptor);
  }
  fs.chmodSync(file, 0o600);
}

function hardenDatabaseFiles(file: string): void {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
    if (!fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error(
        `gateway SQLite file is not regular: ${path.basename(candidate)}`,
      );
    fs.chmodSync(candidate, 0o600);
  }
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<
    string,
    unknown
  >;
  return exactInteger(row[name], `PRAGMA ${name}`);
}

function preflightAndClaimApplicationIdentity(database: DatabaseSync): void {
  const applicationId = pragmaNumber(database, 'application_id');
  if (applicationId === GATEWAY_APPLICATION_ID) return;
  if (applicationId !== 0)
    throw new Error('database application_id does not belong to Elpis Gateway');
  const row = database
    .prepare(
      "SELECT count(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
    )
    .get() as { count: number };
  if (exactInteger(row.count, 'database object count') !== 0)
    throw new Error(
      'non-empty SQLite database does not belong to Elpis Gateway',
    );
  database.exec(`PRAGMA application_id = ${GATEWAY_APPLICATION_ID}`);
}

function assertHealthy(database: DatabaseSync): void {
  const row = database.prepare('PRAGMA quick_check').get() as Record<
    string,
    unknown
  >;
  if (row.quick_check !== 'ok')
    throw new Error('gateway database quick_check failed');
  if (pragmaNumber(database, 'application_id') !== GATEWAY_APPLICATION_ID)
    throw new Error(
      'gateway database application identity was not established',
    );
  if (pragmaNumber(database, 'user_version') !== GATEWAY_SCHEMA_VERSION)
    throw new Error('gateway database schema version is invalid');
}

function configFromRow(row: Record<string, unknown>): GatewayConfig {
  const publicUrl = row.public_url;
  const setupCompletedAt = row.setup_completed_at;
  return {
    publicUrl: publicUrl == null ? null : String(publicUrl),
    setupCompletedAt:
      setupCompletedAt == null
        ? null
        : exactInteger(setupCompletedAt, 'setup completed timestamp'),
    revision: exactInteger(row.revision, 'gateway config revision'),
    createdAt: exactInteger(row.created_at, 'gateway config created timestamp'),
    updatedAt: exactInteger(row.updated_at, 'gateway config updated timestamp'),
  };
}

export class GatewayStore {
  readonly dataDirectory: string;
  readonly databasePath: string;
  readonly credentials: GatewayCredentialStore;
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  #closed = false;

  constructor(
    dataDirectory: string,
    databasePath: string,
    database: DatabaseSync,
    now: () => number,
    randomBytes?: RandomBytes,
  ) {
    this.dataDirectory = dataDirectory;
    this.databasePath = databasePath;
    this.#database = database;
    this.#now = now;
    this.credentials = new GatewayCredentialStore(
      database,
      now,
      (input, at) => this.insertAudit(input, at),
      () => hardenDatabaseFiles(this.databasePath),
      randomBytes,
    );
  }

  config(): GatewayConfig {
    const row = this.#database
      .prepare('SELECT * FROM gateway_config WHERE singleton_id = 1')
      .get() as Record<string, unknown> | undefined;
    if (!row) throw new Error('gateway config singleton is missing');
    return configFromRow(row);
  }

  instances(limit = 100): readonly GatewayInstanceSummary[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('instance limit must be an integer from 1 to 1000');
    const rows = this.#database
      .prepare(
        `SELECT
           i.id AS instance_id,
           i.display_name AS display_name,
           i.created_at AS instance_created_at,
           i.updated_at AS instance_updated_at,
           i.revoked_at AS instance_revoked_at,
           c.id AS active_credential_id,
           c.activated_at AS active_since,
           c.last_used_at AS last_used_at
         FROM gateway_instances AS i
         LEFT JOIN gateway_node_credentials AS c
           ON c.instance_id = i.id AND c.state = 'active'
         ORDER BY i.created_at ASC, i.id ASC
         LIMIT ?`,
      )
      .all(limit) as unknown as Record<string, unknown>[];
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          id: gatewayInstanceId(row.instance_id),
          displayName: gatewayDisplayName(row.display_name),
          createdAt: exactInteger(
            row.instance_created_at,
            'instance created timestamp',
          ),
          updatedAt: exactInteger(
            row.instance_updated_at,
            'instance updated timestamp',
          ),
          revokedAt: exactIntegerOrNull(
            row.instance_revoked_at,
            'instance revoked timestamp',
          ),
          activeCredentialId: gatewayCredentialIdOrNull(
            row.active_credential_id,
          ),
          activeSince: exactIntegerOrNull(
            row.active_since,
            'active credential activation timestamp',
          ),
          lastUsedAt: exactIntegerOrNull(
            row.last_used_at,
            'active credential last-used timestamp',
          ),
        }),
      ),
    );
  }

  setPublicUrl(value: string, requestId: string | null = null): GatewayConfig {
    const publicUrl = canonicalPublicUrl(value);
    const at = this.#now();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare(
          `UPDATE gateway_config
           SET public_url = ?, setup_completed_at = COALESCE(setup_completed_at, ?),
               revision = revision + 1, updated_at = ?
           WHERE singleton_id = 1`,
        )
        .run(publicUrl, at, at);
      this.insertAudit(
        {
          actorKind: 'operator-proxy',
          action: 'gateway.configure',
          targetKind: 'gateway',
          outcome: 'succeeded',
          requestId,
          detail: { publicUrl },
        },
        at,
      );
      this.#database.exec('COMMIT');
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the transaction error */
      }
      throw error;
    }
    hardenDatabaseFiles(this.databasePath);
    return this.config();
  }

  appendAudit(input: GatewayAuditInput): GatewayAuditEvent {
    const at = this.#now();
    const seq = this.insertAudit(input, at);
    hardenDatabaseFiles(this.databasePath);
    const row = this.#database
      .prepare('SELECT * FROM gateway_audit_events WHERE seq = ?')
      .get(seq) as Record<string, unknown>;
    return this.auditFromRow(row);
  }

  audit(limit = 100): GatewayAuditEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('audit limit must be an integer from 1 to 1000');
    return (
      this.#database
        .prepare('SELECT * FROM gateway_audit_events ORDER BY seq DESC LIMIT ?')
        .all(limit) as unknown as Record<string, unknown>[]
    ).map((row) => this.auditFromRow(row));
  }

  async backup(destination: string): Promise<GatewayBackupReceipt> {
    return backupGatewayDatabase(this.#database, destination);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
    hardenDatabaseFiles(this.databasePath);
  }

  private insertAudit(input: GatewayAuditInput, at: number): number {
    const detail = assertPlainDetail(input.detail);
    const detailJson = JSON.stringify(detail);
    if (Buffer.byteLength(detailJson, 'utf8') > MAX_AUDIT_DETAIL_BYTES)
      throw new Error('audit detail exceeds 4096 UTF-8 bytes');
    const result = this.#database
      .prepare(
        `INSERT INTO gateway_audit_events (
          at, actor_kind, actor_id, action, target_kind, target_id,
          outcome, request_id, detail_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        at,
        boundedText(input.actorKind, 'audit actorKind', 64),
        optionalText(input.actorId, 'audit actorId', 256),
        boundedText(input.action, 'audit action', 128),
        boundedText(input.targetKind, 'audit targetKind', 64),
        optionalText(input.targetId, 'audit targetId', 256),
        input.outcome,
        optionalText(input.requestId, 'audit requestId', 128),
        detailJson,
      );
    return exactInteger(result.lastInsertRowid, 'audit sequence');
  }

  private auditFromRow(row: Record<string, unknown>): GatewayAuditEvent {
    const detail = JSON.parse(String(row.detail_json)) as unknown;
    return {
      seq: exactInteger(row.seq, 'audit sequence'),
      at: exactInteger(row.at, 'audit timestamp'),
      actorKind: boundedText(row.actor_kind, 'audit actorKind', 64),
      actorId: optionalText(row.actor_id, 'audit actorId', 256),
      action: boundedText(row.action, 'audit action', 128),
      targetKind: boundedText(row.target_kind, 'audit targetKind', 64),
      targetId: optionalText(row.target_id, 'audit targetId', 256),
      outcome:
        row.outcome === 'succeeded' ||
        row.outcome === 'failed' ||
        row.outcome === 'denied'
          ? row.outcome
          : (() => {
              throw new Error('audit outcome is invalid');
            })(),
      requestId: optionalText(row.request_id, 'audit requestId', 128),
      detail: assertPlainDetail(detail),
    };
  }
}

export function openGatewayStore(
  inputDirectory: string,
  options: OpenGatewayStoreOptions = {},
): GatewayStore {
  const dataDirectory = path.resolve(inputDirectory);
  hardenDirectory(dataDirectory);
  const databasePath = path.join(dataDirectory, DATABASE_NAME);
  ensureDatabaseFile(databasePath);
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, {
      allowExtension: false,
      defensive: false,
      enableDoubleQuotedStringLiterals: false,
      enableForeignKeyConstraints: true,
      timeout: 5000,
    });
    preflightAndClaimApplicationIdentity(database);
    database.exec('PRAGMA trusted_schema = OFF; PRAGMA synchronous = FULL;');
    const journal = database.prepare('PRAGMA journal_mode = WAL').get() as {
      journal_mode?: unknown;
    };
    if (String(journal.journal_mode).toLowerCase() !== 'wal')
      throw new Error('gateway database did not enter WAL mode');
    runGatewayMigrations(database, GATEWAY_MIGRATIONS, options.now ?? Date.now);
    assertHealthy(database);
    database.enableDefensive(true);
    hardenDatabaseFiles(databasePath);
    return new GatewayStore(
      dataDirectory,
      databasePath,
      database,
      options.now ?? Date.now,
      options.randomBytes,
    );
  } catch (error) {
    try {
      database?.close();
    } catch {
      /* preserve the open error */
    }
    throw new Error(
      `could not open Elpis Gateway database: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
