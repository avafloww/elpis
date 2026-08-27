import { randomBytes as systemRandomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  createEnrollmentCredential,
  exactVerifier,
  isCredentialId,
  isGatewayInstanceId,
  parseEnrollmentCredential,
  parseNodeCredential,
  verifierMatches,
  type RandomBytes,
} from './credentials.js';
import type { GatewayAuditInput } from './store.js';

export type GatewayCredentialErrorCode =
  'invalid' | 'expired' | 'revoked' | 'conflict';

export class GatewayCredentialError extends Error {
  readonly code: GatewayCredentialErrorCode;

  constructor(code: GatewayCredentialErrorCode, message: string) {
    super(message);
    this.name = 'GatewayCredentialError';
    this.code = code;
  }
}

export interface EnrollmentGrantReceipt {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface EnrollmentRequest {
  readonly grantToken: string;
  readonly instanceId: string;
  readonly displayName: string;
  readonly credentialId: string;
  readonly credentialVerifier: Uint8Array;
  readonly requestId?: string | null;
}

export interface EnrollmentReceipt {
  readonly instanceId: string;
  readonly credentialId: string;
  readonly replayed: boolean;
}

export interface AuthenticatedNode {
  readonly instanceId: string;
  readonly credentialId: string;
}

export interface RotationReceipt extends AuthenticatedNode {
  readonly previousCredentialId: string;
  readonly replayed: boolean;
}

type AuditWriter = (input: GatewayAuditInput, at: number) => number;

type CredentialRow = {
  id: string;
  instance_id: string;
  verifier: Uint8Array;
  state: 'pending' | 'active' | 'revoked';
  rotates_credential_id: string | null;
  replaced_by_credential_id: string | null;
  revoked_at: number | null;
};

type GrantRow = {
  id: string;
  verifier: Uint8Array;
  expires_at: number;
  revoked_at: number | null;
  consumed_at: number | null;
  consumed_instance_id: string | null;
  consumed_credential_id: string | null;
  consumed_credential_verifier: Uint8Array | null;
};

function fail(code: GatewayCredentialErrorCode, message: string): never {
  throw new GatewayCredentialError(code, message);
}

function safeInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error(`${label} is not a safe integer`);
  return result;
}

function requestId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 128)
    throw new Error('requestId must contain 1 to 128 characters');
  return value;
}

function displayName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('displayName must be text');
  const result = value.trim();
  if (result.length < 1 || result.length > 256)
    throw new Error('displayName must contain 1 to 256 characters');
  if (/\p{Cc}/u.test(result))
    throw new Error('displayName must not contain control characters');
  return result;
}

function credentialId(value: unknown): string {
  if (!isCredentialId(value))
    throw new Error('credentialId has invalid syntax');
  return value;
}

function instanceId(value: unknown): string {
  if (!isGatewayInstanceId(value))
    throw new Error('instanceId has invalid syntax');
  return value;
}

function rowVerifier(value: unknown): Buffer {
  return exactVerifier(value);
}

export class GatewayCredentialStore {
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #randomBytes: RandomBytes;
  readonly #audit: AuditWriter;
  readonly #afterWrite: () => void;

  constructor(
    database: DatabaseSync,
    now: () => number,
    audit: AuditWriter,
    afterWrite: () => void,
    randomBytes: RandomBytes = systemRandomBytes,
  ) {
    this.#database = database;
    this.#now = now;
    this.#audit = audit;
    this.#afterWrite = afterWrite;
    this.#randomBytes = randomBytes;
  }

  createEnrollmentGrant(
    ttlMs = 10 * 60 * 1000,
    grantRequestId: string | null = null,
  ): EnrollmentGrantReceipt {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 60 * 60 * 1000)
      throw new Error('enrollment grant TTL must be 1 second to 1 hour');
    const createdAt = this.currentTime();
    const expiresAt = createdAt + ttlMs;
    if (!Number.isSafeInteger(expiresAt))
      throw new Error('enrollment expiry is invalid');
    const boundedRequestId = requestId(grantRequestId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const material = createEnrollmentCredential(this.#randomBytes);
      try {
        const receipt = this.transaction(() => {
          this.#database
            .prepare(
              `INSERT INTO gateway_enrollment_grants
                (id, verifier, created_at, expires_at)
               VALUES (?, ?, ?, ?)`,
            )
            .run(material.id, material.verifier, createdAt, expiresAt);
          this.#audit(
            {
              actorKind: 'operator-proxy',
              action: 'gateway.enrollment-grant.create',
              targetKind: 'enrollment-grant',
              targetId: material.id,
              outcome: 'succeeded',
              requestId: boundedRequestId,
              detail: { expiresAt },
            },
            createdAt,
          );
          return Object.freeze({
            id: material.id,
            token: material.token,
            expiresAt,
          });
        });
        this.#afterWrite();
        return receipt;
      } catch (error) {
        if (
          attempt < 2 &&
          error instanceof Error &&
          /UNIQUE constraint failed/.test(error.message)
        )
          continue;
        throw error;
      }
    }
    throw new Error('could not allocate enrollment grant id');
  }

  revokeEnrollmentGrant(
    id: string,
    grantRequestId: string | null = null,
  ): { readonly id: string; readonly replayed: boolean } {
    const boundedId = credentialId(id);
    const boundedRequestId = requestId(grantRequestId);
    const at = this.currentTime();
    const result = this.transaction(() => {
      const row = this.#database
        .prepare(
          'SELECT revoked_at FROM gateway_enrollment_grants WHERE id = ?',
        )
        .get(boundedId) as { revoked_at: number | null } | undefined;
      if (!row) fail('invalid', 'enrollment grant is invalid');
      if (row.revoked_at != null)
        return Object.freeze({ id: boundedId, replayed: true });
      this.#database
        .prepare(
          'UPDATE gateway_enrollment_grants SET revoked_at = ? WHERE id = ?',
        )
        .run(at, boundedId);
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'gateway.enrollment-grant.revoke',
          targetKind: 'enrollment-grant',
          targetId: boundedId,
          outcome: 'succeeded',
          requestId: boundedRequestId,
        },
        at,
      );
      return Object.freeze({ id: boundedId, replayed: false });
    });
    this.#afterWrite();
    return result;
  }

  enroll(input: EnrollmentRequest): EnrollmentReceipt {
    const grant = parseEnrollmentCredential(input.grantToken);
    if (!grant) fail('invalid', 'enrollment grant is invalid');
    const boundedInstanceId = instanceId(input.instanceId);
    const boundedDisplayName = displayName(input.displayName);
    const boundedCredentialId = credentialId(input.credentialId);
    const boundedVerifier = exactVerifier(input.credentialVerifier);
    const boundedRequestId = requestId(input.requestId);
    const at = this.currentTime();
    const result = this.transaction(() => {
      const row = this.#database
        .prepare('SELECT * FROM gateway_enrollment_grants WHERE id = ?')
        .get(grant.id) as GrantRow | undefined;
      const expected = row ? rowVerifier(row.verifier) : Buffer.alloc(32);
      if (!verifierMatches(grant.verifier, expected) || !row)
        fail('invalid', 'enrollment grant is invalid');

      if (row.consumed_at != null) {
        const exactReplay =
          row.consumed_instance_id === boundedInstanceId &&
          row.consumed_credential_id === boundedCredentialId &&
          row.consumed_credential_verifier != null &&
          verifierMatches(boundedVerifier, row.consumed_credential_verifier);
        if (!exactReplay)
          fail('conflict', 'enrollment grant was already consumed');
        return Object.freeze({
          instanceId: boundedInstanceId,
          credentialId: boundedCredentialId,
          replayed: true,
        });
      }
      if (row.revoked_at != null)
        fail('revoked', 'enrollment grant is revoked');
      if (safeInteger(row.expires_at, 'enrollment expiry') <= at)
        fail('expired', 'enrollment grant is expired');
      if (
        this.#database
          .prepare('SELECT 1 FROM gateway_instances WHERE id = ?')
          .get(boundedInstanceId)
      )
        fail('conflict', 'instance is already enrolled');
      if (
        this.#database
          .prepare('SELECT 1 FROM gateway_node_credentials WHERE id = ?')
          .get(boundedCredentialId)
      )
        fail('conflict', 'credential id is already enrolled');

      this.#database
        .prepare(
          `INSERT INTO gateway_instances (id, display_name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(boundedInstanceId, boundedDisplayName, at, at);
      this.#database
        .prepare(
          `INSERT INTO gateway_node_credentials
            (id, instance_id, verifier, state, created_at, activated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .run(boundedCredentialId, boundedInstanceId, boundedVerifier, at, at);
      this.#database
        .prepare(
          `UPDATE gateway_enrollment_grants
           SET consumed_at = ?, consumed_instance_id = ?, consumed_credential_id = ?,
               consumed_credential_verifier = ?
           WHERE id = ?`,
        )
        .run(
          at,
          boundedInstanceId,
          boundedCredentialId,
          boundedVerifier,
          grant.id,
        );
      this.#audit(
        {
          actorKind: 'resident',
          actorId: boundedInstanceId,
          action: 'gateway.instance.enroll',
          targetKind: 'instance',
          targetId: boundedInstanceId,
          outcome: 'succeeded',
          requestId: boundedRequestId,
          detail: { credentialId: boundedCredentialId, grantId: grant.id },
        },
        at,
      );
      return Object.freeze({
        instanceId: boundedInstanceId,
        credentialId: boundedCredentialId,
        replayed: false,
      });
    });
    this.#afterWrite();
    return result;
  }

  authenticateNode(token: unknown): AuthenticatedNode | null {
    const parsed = parseNodeCredential(token);
    if (!parsed) return null;
    const row = this.#database
      .prepare(
        `SELECT c.*, i.revoked_at AS instance_revoked_at
         FROM gateway_node_credentials c
         JOIN gateway_instances i ON i.id = c.instance_id
         WHERE c.id = ?`,
      )
      .get(parsed.id) as
      (CredentialRow & { instance_revoked_at: number | null }) | undefined;
    const expected = row ? rowVerifier(row.verifier) : Buffer.alloc(32);
    if (!verifierMatches(parsed.verifier, expected)) return null;
    if (!row || row.state !== 'active' || row.instance_revoked_at != null)
      return null;
    const at = this.currentTime();
    this.#database
      .prepare(
        'UPDATE gateway_node_credentials SET last_used_at = ? WHERE id = ?',
      )
      .run(at, row.id);
    this.#afterWrite();
    return Object.freeze({ instanceId: row.instance_id, credentialId: row.id });
  }

  proposeRotation(
    oldToken: unknown,
    newCredentialId: string,
    newVerifier: Uint8Array,
    rotationRequestId: string | null = null,
  ): RotationReceipt {
    const old = parseNodeCredential(oldToken);
    if (!old) fail('invalid', 'node credential is invalid');
    const boundedNewId = credentialId(newCredentialId);
    const boundedNewVerifier = exactVerifier(newVerifier);
    const boundedRequestId = requestId(rotationRequestId);
    const at = this.currentTime();
    const result = this.transaction(() => {
      const oldRow = this.credential(old.id);
      if (!oldRow || !verifierMatches(old.verifier, oldRow.verifier))
        fail('invalid', 'node credential is invalid');
      if (oldRow.state !== 'active')
        fail('revoked', 'node credential is not active');
      if (boundedNewId === oldRow.id)
        fail('conflict', 'new credential id must differ');

      const existing = this.credential(boundedNewId);
      if (existing) {
        const exactReplay =
          existing.state === 'pending' &&
          existing.instance_id === oldRow.instance_id &&
          existing.rotates_credential_id === oldRow.id &&
          verifierMatches(boundedNewVerifier, existing.verifier);
        if (!exactReplay) fail('conflict', 'new credential id is already used');
        return Object.freeze({
          instanceId: oldRow.instance_id,
          credentialId: boundedNewId,
          previousCredentialId: oldRow.id,
          replayed: true,
        });
      }
      if (
        this.#database
          .prepare(
            "SELECT 1 FROM gateway_node_credentials WHERE rotates_credential_id = ? AND state = 'pending'",
          )
          .get(oldRow.id)
      )
        fail('conflict', 'node credential already has a pending rotation');

      this.#database
        .prepare(
          `INSERT INTO gateway_node_credentials
            (id, instance_id, verifier, state, rotates_credential_id, created_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          boundedNewId,
          oldRow.instance_id,
          boundedNewVerifier,
          oldRow.id,
          at,
        );
      this.#audit(
        {
          actorKind: 'resident',
          actorId: oldRow.instance_id,
          action: 'gateway.credential.rotation-propose',
          targetKind: 'node-credential',
          targetId: boundedNewId,
          outcome: 'succeeded',
          requestId: boundedRequestId,
          detail: { previousCredentialId: oldRow.id },
        },
        at,
      );
      return Object.freeze({
        instanceId: oldRow.instance_id,
        credentialId: boundedNewId,
        previousCredentialId: oldRow.id,
        replayed: false,
      });
    });
    this.#afterWrite();
    return result;
  }

  activateRotation(
    newToken: unknown,
    rotationRequestId: string | null = null,
  ): RotationReceipt {
    const parsed = parseNodeCredential(newToken);
    if (!parsed) fail('invalid', 'node credential is invalid');
    const boundedRequestId = requestId(rotationRequestId);
    const at = this.currentTime();
    const result = this.transaction(() => {
      const row = this.credential(parsed.id);
      if (!row || !verifierMatches(parsed.verifier, row.verifier))
        fail('invalid', 'node credential is invalid');
      const oldId = row.rotates_credential_id;
      if (!oldId) fail('conflict', 'node credential is not a rotation');
      const old = this.credential(oldId);
      if (
        row.state === 'active' &&
        old?.state === 'revoked' &&
        old.replaced_by_credential_id === row.id
      )
        return Object.freeze({
          instanceId: row.instance_id,
          credentialId: row.id,
          previousCredentialId: old.id,
          replayed: true,
        });
      if (row.state !== 'pending')
        fail('revoked', 'node credential is not pending');
      if (!old || old.state !== 'active' || old.instance_id !== row.instance_id)
        fail('conflict', 'previous node credential is not active');

      this.#database
        .prepare(
          `UPDATE gateway_node_credentials
           SET state = 'revoked', revoked_at = ?, replaced_by_credential_id = ?
           WHERE id = ? AND state = 'active'`,
        )
        .run(at, row.id, old.id);
      this.#database
        .prepare(
          `UPDATE gateway_node_credentials
           SET state = 'active', activated_at = ?
           WHERE id = ? AND state = 'pending'`,
        )
        .run(at, row.id);
      this.#audit(
        {
          actorKind: 'resident',
          actorId: row.instance_id,
          action: 'gateway.credential.rotation-activate',
          targetKind: 'node-credential',
          targetId: row.id,
          outcome: 'succeeded',
          requestId: boundedRequestId,
          detail: { previousCredentialId: old.id },
        },
        at,
      );
      return Object.freeze({
        instanceId: row.instance_id,
        credentialId: row.id,
        previousCredentialId: old.id,
        replayed: false,
      });
    });
    this.#afterWrite();
    return result;
  }

  revokeCredential(
    id: string,
    revokeRequestId: string | null = null,
  ): { readonly credentialId: string; readonly replayed: boolean } {
    const boundedId = credentialId(id);
    const boundedRequestId = requestId(revokeRequestId);
    const at = this.currentTime();
    const result = this.transaction(() => {
      const row = this.credential(boundedId);
      if (!row) fail('invalid', 'node credential is invalid');
      if (row.state === 'revoked')
        return Object.freeze({ credentialId: boundedId, replayed: true });
      this.#database
        .prepare(
          `UPDATE gateway_node_credentials
           SET state = 'revoked', revoked_at = ?
           WHERE id = ?`,
        )
        .run(at, boundedId);
      this.#audit(
        {
          actorKind: 'operator-proxy',
          action: 'gateway.credential.revoke',
          targetKind: 'node-credential',
          targetId: boundedId,
          outcome: 'succeeded',
          requestId: boundedRequestId,
          detail: { instanceId: row.instance_id },
        },
        at,
      );
      return Object.freeze({ credentialId: boundedId, replayed: false });
    });
    this.#afterWrite();
    return result;
  }

  private currentTime(): number {
    return safeInteger(this.#now(), 'gateway clock');
  }

  private credential(id: string): CredentialRow | undefined {
    return this.#database
      .prepare('SELECT * FROM gateway_node_credentials WHERE id = ?')
      .get(id) as CredentialRow | undefined;
  }

  private transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK');
      } catch {
        /* preserve the operation error */
      }
      throw error;
    }
  }
}
