import { randomBytes as systemRandomBytes } from 'node:crypto';
import {
  RESIDENT_CONTROL_FORMATS,
  createNodeCredential,
  decodeResidentEnrollmentResult,
  decodeResidentRotationResult,
  encodeCredentialVerifier,
  isGatewayInstanceId,
  isRequestId,
  newGatewayInstanceId,
  parseEnrollmentCredential,
  parseNodeCredential,
  serializeResidentEnrollmentResult,
  serializeResidentRotationResult,
  type ResidentEnrollmentRequest,
  type ResidentEnrollmentResult,
  type ResidentRotationRequest,
  type ResidentRotationResult,
} from '@elpis/gateway-protocol';
import type { Database } from './db.js';

export type GatewayResidentPhase = 'idle' | 'enrolling' | 'active' | 'rotating';
export type GatewayResidentErrorCode =
  | 'invalid_input'
  | 'invalid_state'
  | 'conflict'
  | 'corrupt_state';

export class GatewayResidentStateError extends Error {
  constructor(readonly code: GatewayResidentErrorCode) {
    super(`gateway resident state ${code.replaceAll('_', ' ')}`);
    this.name = 'GatewayResidentStateError';
  }
}

export interface GatewayResidentSnapshot {
  readonly instanceId: string;
  readonly phase: GatewayResidentPhase;
  readonly endpoint: string | null;
  readonly displayName: string | null;
  readonly requestId: string | null;
  readonly activeCredentialId: string | null;
  readonly pendingCredentialId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly enrollmentStartedAt: number | null;
  readonly activatedAt: number | null;
  readonly rotationStartedAt: number | null;
}

export interface BeginGatewayEnrollment {
  readonly endpoint: string;
  readonly grantToken: string;
  readonly displayName: string;
}

export interface GatewayResidentTransitionReceipt {
  readonly instanceId: string;
  readonly credentialId: string;
  readonly previousCredentialId?: string;
}

export interface GatewayResidentStoreOptions {
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Buffer;
}

type Row = {
  instance_id: string;
  phase: GatewayResidentPhase;
  endpoint: string | null;
  display_name: string | null;
  enrollment_grant: string | null;
  request_id: string | null;
  active_credential_id: string | null;
  active_credential_token: string | null;
  pending_credential_id: string | null;
  pending_credential_token: string | null;
  created_at: number;
  updated_at: number;
  enrollment_started_at: number | null;
  activated_at: number | null;
  rotation_started_at: number | null;
};

function fail(code: GatewayResidentErrorCode): never {
  throw new GatewayResidentStateError(code);
}

function exactBytes(source: (size: number) => Buffer, size: number): Buffer {
  const value = source(size);
  if (!Buffer.isBuffer(value) || value.length !== size) fail('invalid_input');
  return Buffer.from(value);
}

function requestId(source: (size: number) => Buffer): string {
  const value = `egr1.${exactBytes(source, 16).toString('base64url')}`;
  if (!isRequestId(value)) fail('invalid_input');
  return value;
}

function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) fail('invalid_input');
  return value;
}

function validEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048)
    return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.origin === value
    );
  } catch {
    return false;
  }
}

function validDisplayName(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length === 0 ||
    /\p{Cc}/u.test(value)
  )
    return false;
  const bytes = Buffer.from(value, 'utf8');
  return bytes.length <= 128 && bytes.toString('utf8') === value;
}

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function credentialToken(id: string | null, token: string | null): string | null {
  if (id === null && token === null) return null;
  if (id === null || token === null) fail('corrupt_state');
  const parsed = parseNodeCredential(token);
  if (!parsed || parsed.id !== id) fail('corrupt_state');
  return token;
}

function assertRow(row: Row): void {
  if (
    !isGatewayInstanceId(row.instance_id) ||
    !['idle', 'enrolling', 'active', 'rotating'].includes(row.phase) ||
    (row.endpoint !== null && !validEndpoint(row.endpoint)) ||
    (row.display_name !== null && !validDisplayName(row.display_name)) ||
    (row.enrollment_grant !== null &&
      parseEnrollmentCredential(row.enrollment_grant) === null) ||
    (row.request_id !== null && !isRequestId(row.request_id)) ||
    !validTime(row.created_at) ||
    !validTime(row.updated_at) ||
    row.updated_at < row.created_at ||
    (row.enrollment_started_at !== null &&
      (!validTime(row.enrollment_started_at) ||
        row.enrollment_started_at < row.created_at)) ||
    (row.activated_at !== null &&
      (!validTime(row.activated_at) || row.activated_at < row.created_at)) ||
    (row.rotation_started_at !== null &&
      (!validTime(row.rotation_started_at) ||
        row.rotation_started_at < row.created_at))
  )
    fail('corrupt_state');

  credentialToken(row.active_credential_id, row.active_credential_token);
  credentialToken(row.pending_credential_id, row.pending_credential_token);

  const idle =
    row.endpoint === null &&
    row.display_name === null &&
    row.enrollment_grant === null &&
    row.request_id === null &&
    row.active_credential_id === null &&
    row.active_credential_token === null &&
    row.pending_credential_id === null &&
    row.pending_credential_token === null &&
    row.enrollment_started_at === null &&
    row.activated_at === null &&
    row.rotation_started_at === null;
  const enrolling =
    row.endpoint !== null &&
    row.display_name !== null &&
    row.enrollment_grant !== null &&
    row.request_id !== null &&
    row.active_credential_id === null &&
    row.active_credential_token === null &&
    row.pending_credential_id !== null &&
    row.pending_credential_token !== null &&
    row.enrollment_started_at !== null &&
    row.activated_at === null &&
    row.rotation_started_at === null;
  const active =
    row.endpoint !== null &&
    row.display_name !== null &&
    row.enrollment_grant === null &&
    row.request_id === null &&
    row.active_credential_id !== null &&
    row.active_credential_token !== null &&
    row.pending_credential_id === null &&
    row.pending_credential_token === null &&
    row.enrollment_started_at !== null &&
    row.activated_at !== null &&
    row.rotation_started_at === null;
  const rotating =
    row.endpoint !== null &&
    row.display_name !== null &&
    row.enrollment_grant === null &&
    row.request_id !== null &&
    row.active_credential_id !== null &&
    row.active_credential_token !== null &&
    row.pending_credential_id !== null &&
    row.pending_credential_token !== null &&
    row.active_credential_id !== row.pending_credential_id &&
    row.enrollment_started_at !== null &&
    row.activated_at !== null &&
    row.rotation_started_at !== null;
  if (
    (row.phase === 'idle' && !idle) ||
    (row.phase === 'enrolling' && !enrolling) ||
    (row.phase === 'active' && !active) ||
    (row.phase === 'rotating' && !rotating)
  )
    fail('corrupt_state');
}

function publicSnapshot(row: Row): GatewayResidentSnapshot {
  assertRow(row);
  return Object.freeze({
    instanceId: row.instance_id,
    phase: row.phase,
    endpoint: row.endpoint,
    displayName: row.display_name,
    requestId: row.request_id,
    activeCredentialId: row.active_credential_id,
    pendingCredentialId: row.pending_credential_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    enrollmentStartedAt: row.enrollment_started_at,
    activatedAt: row.activated_at,
    rotationStartedAt: row.rotation_started_at,
  });
}

function exactEnrollmentInput(value: unknown): BeginGatewayEnrollment {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return fail('invalid_input');
    const input = value as Record<string, unknown>;
    const keys = Object.keys(input).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== 'displayName' ||
      keys[1] !== 'endpoint' ||
      keys[2] !== 'grantToken' ||
      !validEndpoint(input.endpoint) ||
      !validDisplayName(input.displayName) ||
      typeof input.grantToken !== 'string' ||
      parseEnrollmentCredential(input.grantToken) === null
    )
      return fail('invalid_input');
    return Object.freeze({
      endpoint: input.endpoint,
      grantToken: input.grantToken,
      displayName: input.displayName,
    });
  } catch {
    return fail('invalid_input');
  }
}

function exactEnrollmentResult(value: unknown): ResidentEnrollmentResult {
  try {
    return decodeResidentEnrollmentResult(
      serializeResidentEnrollmentResult(value as ResidentEnrollmentResult),
    );
  } catch {
    return fail('invalid_input');
  }
}

function exactRotationResult(value: unknown): ResidentRotationResult {
  try {
    return decodeResidentRotationResult(
      serializeResidentRotationResult(value as ResidentRotationResult),
    );
  } catch {
    return fail('invalid_input');
  }
}

export class GatewayResidentStore {
  private readonly getRow;
  private readonly now: () => number;
  private readonly bytes: (size: number) => Buffer;

  constructor(
    private readonly db: Database,
    options: GatewayResidentStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.bytes = options.randomBytes ?? systemRandomBytes;
    this.getRow = db.prepare(
      'SELECT * FROM gateway_resident_state WHERE singleton=1',
    );
    if (!(this.getRow.get() as Row | undefined)) {
      const at = timestamp(this.now);
      const instanceId = newGatewayInstanceId((size) =>
        exactBytes(this.bytes, size),
      );
      try {
        db.prepare(
          `INSERT INTO gateway_resident_state
            (singleton,instance_id,phase,created_at,updated_at)
           VALUES (1,?,'idle',?,?)`,
        ).run(instanceId, at, at);
      } catch (error) {
        if (!(this.getRow.get() as Row | undefined)) throw error;
      }
    }
    this.row();
  }

  private row(): Row {
    const row = this.getRow.get() as Row | undefined;
    if (!row) fail('corrupt_state');
    assertRow(row);
    return row;
  }

  read(): GatewayResidentSnapshot {
    return publicSnapshot(this.row());
  }

  secretValues(): readonly string[] {
    const row = this.row();
    const values = [
      row.enrollment_grant,
      row.active_credential_token,
      row.pending_credential_token,
    ].filter((value): value is string => value !== null);
    return Object.freeze(values);
  }

  activeNodeToken(): string {
    const row = this.row();
    if (
      (row.phase !== 'active' && row.phase !== 'rotating') ||
      row.active_credential_token === null
    )
      fail('invalid_state');
    return row.active_credential_token;
  }

  pendingNodeToken(): string {
    const row = this.row();
    if (row.phase !== 'rotating' || row.pending_credential_token === null)
      fail('invalid_state');
    return row.pending_credential_token;
  }

  beginEnrollment(input: BeginGatewayEnrollment): GatewayResidentSnapshot {
    const normalized = exactEnrollmentInput(input);
    const old = this.row();
    if (old.phase === 'enrolling') {
      if (
        old.endpoint !== normalized.endpoint ||
        old.display_name !== normalized.displayName ||
        old.enrollment_grant !== normalized.grantToken
      )
        fail('conflict');
      return publicSnapshot(old);
    }
    if (old.phase !== 'idle') fail('invalid_state');

    const next = createNodeCredential((size) => exactBytes(this.bytes, size));
    const rid = requestId(this.bytes);
    const at = Math.max(timestamp(this.now), old.updated_at);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          `UPDATE gateway_resident_state SET
             phase='enrolling', endpoint=?, display_name=?, enrollment_grant=?,
             request_id=?, pending_credential_id=?, pending_credential_token=?,
             enrollment_started_at=?, updated_at=?
           WHERE singleton=1 AND phase='idle'`,
        )
        .run(
          normalized.endpoint,
          normalized.displayName,
          normalized.grantToken,
          rid,
          next.id,
          next.token,
          at,
          at,
        );
      if (changed.changes !== 1) fail('conflict');
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
    return this.read();
  }

  enrollmentRequest(): Readonly<ResidentEnrollmentRequest> {
    const row = this.row();
    if (
      row.phase !== 'enrolling' ||
      row.enrollment_grant === null ||
      row.display_name === null ||
      row.request_id === null ||
      row.pending_credential_id === null ||
      row.pending_credential_token === null
    )
      fail('invalid_state');
    const parsed = parseNodeCredential(row.pending_credential_token);
    if (!parsed || parsed.id !== row.pending_credential_id) fail('corrupt_state');
    return Object.freeze({
      format: RESIDENT_CONTROL_FORMATS.enrollmentRequest,
      grantToken: row.enrollment_grant,
      instanceId: row.instance_id as ResidentEnrollmentRequest['instanceId'],
      displayName: row.display_name,
      credentialId: row.pending_credential_id,
      credentialVerifier: encodeCredentialVerifier(parsed.verifier),
      requestId: row.request_id as ResidentEnrollmentRequest['requestId'],
    });
  }

  activateEnrollment(value: unknown): GatewayResidentTransitionReceipt {
    const result = exactEnrollmentResult(value);
    const row = this.row();
    if (
      row.phase !== 'enrolling' ||
      row.pending_credential_id === null
    )
      fail('invalid_state');
    if (
      result.instanceId !== row.instance_id ||
      result.credentialId !== row.pending_credential_id
    )
      fail('conflict');
    const at = Math.max(timestamp(this.now), row.updated_at);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          `UPDATE gateway_resident_state SET
             phase='active', enrollment_grant=NULL, request_id=NULL,
             active_credential_id=pending_credential_id,
             active_credential_token=pending_credential_token,
             pending_credential_id=NULL, pending_credential_token=NULL,
             activated_at=?, updated_at=?
           WHERE singleton=1 AND phase='enrolling'
             AND instance_id=? AND pending_credential_id=?`,
        )
        .run(at, at, row.instance_id, row.pending_credential_id);
      if (changed.changes !== 1) fail('conflict');
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
    return Object.freeze({
      instanceId: row.instance_id,
      credentialId: row.pending_credential_id,
    });
  }

  beginRotation(): GatewayResidentSnapshot {
    const old = this.row();
    if (old.phase === 'rotating') return publicSnapshot(old);
    if (old.phase !== 'active' || old.active_credential_id === null)
      fail('invalid_state');
    const next = createNodeCredential((size) => exactBytes(this.bytes, size));
    const rid = requestId(this.bytes);
    const at = Math.max(timestamp(this.now), old.updated_at);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          `UPDATE gateway_resident_state SET
             phase='rotating', request_id=?, pending_credential_id=?,
             pending_credential_token=?, rotation_started_at=?, updated_at=?
           WHERE singleton=1 AND phase='active' AND active_credential_id=?`,
        )
        .run(rid, next.id, next.token, at, at, old.active_credential_id);
      if (changed.changes !== 1) fail('conflict');
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
    return this.read();
  }

  rotationRequest(): Readonly<ResidentRotationRequest> {
    const row = this.row();
    if (
      row.phase !== 'rotating' ||
      row.request_id === null ||
      row.pending_credential_id === null ||
      row.pending_credential_token === null
    )
      fail('invalid_state');
    const parsed = parseNodeCredential(row.pending_credential_token);
    if (!parsed || parsed.id !== row.pending_credential_id) fail('corrupt_state');
    return Object.freeze({
      format: RESIDENT_CONTROL_FORMATS.rotationRequest,
      credentialId: row.pending_credential_id,
      credentialVerifier: encodeCredentialVerifier(parsed.verifier),
      requestId: row.request_id as ResidentRotationRequest['requestId'],
    });
  }

  activateRotation(value: unknown): GatewayResidentTransitionReceipt {
    const result = exactRotationResult(value);
    const row = this.row();
    if (
      row.phase !== 'rotating' ||
      row.active_credential_id === null ||
      row.pending_credential_id === null
    )
      fail('invalid_state');
    if (
      result.instanceId !== row.instance_id ||
      result.credentialId !== row.pending_credential_id ||
      result.previousCredentialId !== row.active_credential_id
    )
      fail('conflict');
    const at = Math.max(timestamp(this.now), row.updated_at);
    const oldId = row.active_credential_id;
    const newId = row.pending_credential_id;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          `UPDATE gateway_resident_state SET
             phase='active', request_id=NULL,
             active_credential_id=pending_credential_id,
             active_credential_token=pending_credential_token,
             pending_credential_id=NULL, pending_credential_token=NULL,
             rotation_started_at=NULL, activated_at=?, updated_at=?
           WHERE singleton=1 AND phase='rotating'
             AND instance_id=? AND active_credential_id=?
             AND pending_credential_id=?`,
        )
        .run(at, at, row.instance_id, oldId, newId);
      if (changed.changes !== 1) fail('conflict');
      this.db.exec('COMMIT');
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw error;
    }
    return Object.freeze({
      instanceId: row.instance_id,
      credentialId: newId,
      previousCredentialId: oldId,
    });
  }
}

export function createGatewayResidentStore(
  db: Database,
  options: GatewayResidentStoreOptions = {},
): GatewayResidentStore {
  return new GatewayResidentStore(db, options);
}
