import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  isBranchId,
  isEventId,
  isWorldId,
  createViewManifest,
  LEGACY_WORLD_ID,
  type BranchId,
  type EventId,
  type WorldId,
  type ViewManifest,
} from '../context-graph.js';

export type { BranchId, EventId, WorldId } from '../context-graph.js';

declare const contextIdBrand: unique symbol;
type ContextId<Kind extends string> = string & {
  readonly [contextIdBrand]: Kind;
};

export type ManifestId = ContextId<'ManifestId'>;
export type CapsuleId = ContextId<'CapsuleId'>;
export type ShareGrantId = ContextId<'ShareGrantId'>;
export type LegacyImportReceiptId = ContextId<'LegacyImportReceiptId'>;
export type EffectId = ContextId<'EffectId'>;

function branded<Kind extends string>(
  label: string,
  value: string,
  prefix: string,
): ContextId<Kind> {
  if (
    typeof value !== 'string' ||
    !value.startsWith(prefix) ||
    value.length <= prefix.length ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a bounded ${prefix} identity`);
  }
  return value as ContextId<Kind>;
}

export function worldId(value: string): WorldId {
  if (!isWorldId(value)) throw new Error('invalid WorldId');
  return value;
}

export function eventId(value: string): EventId {
  if (!isEventId(value) || value.length > 128) throw new Error('invalid EventId');
  return value;
}

export function branchId(value: string): BranchId {
  if (!isBranchId(value) || value.length > 128) throw new Error('invalid BranchId');
  return value;
}

export const manifestId = (value: string): ManifestId =>
  branded<'ManifestId'>('manifestId', value, 'manifest:');
export const capsuleId = (value: string): CapsuleId =>
  branded<'CapsuleId'>('capsuleId', value, 'capsule:');
export const shareGrantId = (value: string): ShareGrantId =>
  branded<'ShareGrantId'>('shareGrantId', value, 'share:');
export const legacyImportReceiptId = (value: string): LegacyImportReceiptId =>
  branded<'LegacyImportReceiptId'>(
    'legacyImportReceiptId',
    value,
    'legacy-import:',
  );
export const effectId = (value: string): EffectId =>
  branded<'EffectId'>('effectId', value, 'effect:');

export type BranchStatus = 'running' | 'yielded' | 'crashed';
export type CapsuleKind =
  'private' | 'root_receipt' | 'self_delta' | 'legacy_opaque';
export type EffectStatus = 'prepared' | 'observed' | 'failed' | 'uncertain';
export type ContextGraphMode = 'dark' | 'active';

export interface WorldEventRecord {
  readonly sequence: number;
  readonly eventId: EventId;
  readonly worldId: WorldId;
  readonly kind: string;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly occurredAt: number;
  readonly recordedAt: number;
}

export interface BranchRecord {
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly parentBranchId: BranchId | null;
  readonly status: BranchStatus;
  readonly authorityEpoch: number;
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export interface ManifestRecord {
  readonly manifestId: ManifestId;
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly hash: string;
  readonly json: string;
  readonly projectionGeneration: number;
  readonly policyGeneration: number;
  readonly cacheNamespace: string;
  readonly createdAt: number;
}

export interface CapsuleRecord {
  readonly capsuleId: CapsuleId;
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly kind: CapsuleKind;
  readonly viewManifestHash: string | null;
  readonly sourceRootHash: string;
  readonly policyGeneration: number;
  readonly summarizerModel: string | null;
  readonly summarizerPromptHash: string | null;
  readonly contentJson: string;
  readonly contentHash: string;
  readonly createdAt: number;
}

export interface EffectRecord {
  readonly effectId: EffectId;
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly destinationWorldId: WorldId;
  readonly kind: string;
  readonly authorityEpoch: number;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly idempotencyKey: string | null;
  readonly status: EffectStatus;
  readonly preparedAt: number;
  readonly resolvedAt: number | null;
  readonly observationJson: string | null;
}

export interface ContinuationHead {
  readonly branchId: BranchId | null;
  readonly worldId: WorldId | null;
  readonly revision: number;
  readonly updatedAt: number;
}

export interface LegacyImportReceipt {
  readonly receiptId: LegacyImportReceiptId;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly sourceSize: number;
  readonly artifactRef: string;
  readonly importGeneration: number;
  readonly capsuleId: CapsuleId;
  readonly importedAt: number;
}

export interface ContextGraphActivation {
  readonly mode: ContextGraphMode;
  readonly epoch: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export class StaleContinuationHeadError extends Error {
  constructor(expectedRevision: number) {
    super(`continuation head is not at revision ${expectedRevision}`);
    this.name = 'StaleContinuationHeadError';
  }
}

export class LegacyImportConflictError extends Error {
  constructor(sourceRef: string) {
    super(`legacy source already has a different import receipt: ${sourceRef}`);
    this.name = 'LegacyImportConflictError';
  }
}

export class StaleActivationStateError extends Error {
  constructor(expectedEpoch: number) {
    super(`context graph activation is not dark at epoch ${expectedEpoch}`);
    this.name = 'StaleActivationStateError';
  }
}

function timestamp(label: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function generation(label: string, value: number): number {
  return timestamp(label, value);
}

function serialize(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error('context graph payload must be JSON serializable');
  return encoded;
}

export function hashContextBytes(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function transaction<T>(database: DatabaseSync, body: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = body();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

interface WorldEventRow {
  sequence: number;
  event_id: string;
  world_id: string;
  event_kind: string;
  payload_json: string;
  payload_hash: string;
  occurred_at: number;
  recorded_at: number;
}

interface BranchRow {
  branch_id: string;
  world_id: string;
  parent_branch_id: string | null;
  status: BranchStatus;
  authority_epoch: number;
  started_at: number;
  ended_at: number | null;
}

interface EffectRow {
  effect_id: string;
  branch_id: string;
  world_id: string;
  destination_world_id: string;
  effect_kind: string;
  authority_epoch: number;
  payload_json: string;
  payload_hash: string;
  idempotency_key: string | null;
  status: EffectStatus;
  prepared_at: number;
  resolved_at: number | null;
  observation_json: string | null;
}

function mapWorldEvent(row: WorldEventRow): WorldEventRecord {
  return {
    sequence: row.sequence,
    eventId: eventId(row.event_id),
    worldId: worldId(row.world_id),
    kind: row.event_kind,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function mapBranch(row: BranchRow): BranchRecord {
  return {
    branchId: branchId(row.branch_id),
    worldId: worldId(row.world_id),
    parentBranchId:
      row.parent_branch_id === null ? null : branchId(row.parent_branch_id),
    status: row.status,
    authorityEpoch: row.authority_epoch,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function mapEffect(row: EffectRow): EffectRecord {
  return {
    effectId: effectId(row.effect_id),
    branchId: branchId(row.branch_id),
    worldId: worldId(row.world_id),
    destinationWorldId: worldId(row.destination_world_id),
    kind: row.effect_kind,
    authorityEpoch: row.authority_epoch,
    payloadJson: row.payload_json,
    payloadHash: row.payload_hash,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    preparedAt: row.prepared_at,
    resolvedAt: row.resolved_at,
    observationJson: row.observation_json,
  };
}

/**
 * Durable, dark-mode persistence for the scoped context graph.
 *
 * This store deliberately has no provider, tool, transport, or prompt dependency.
 * Database constraints are the final guard for immutable records and world-scoped
 * graph edges, so a future coordinator cannot bypass them accidentally.
 */
export class ContextGraphStore {
  constructor(private readonly database: DatabaseSync) {}

  appendWorldEvent(input: {
    eventId: EventId;
    worldId: WorldId;
    kind: string;
    payload: unknown;
    occurredAt: number;
    recordedAt: number;
  }): WorldEventRecord {
    const payloadJson = serialize(input.payload);
    const payloadHash = hashContextBytes(payloadJson);
    const existing = this.getWorldEvent(input.eventId);
    if (existing) {
      if (
        existing.worldId !== input.worldId ||
        existing.kind !== input.kind ||
        existing.payloadHash !== payloadHash ||
        existing.occurredAt !== input.occurredAt
      ) {
        throw new Error(`context event identity conflict: ${input.eventId}`);
      }
      return existing;
    }
    const result = this.database
      .prepare(
        `
        INSERT INTO context_world_events(
          event_id, world_id, event_kind, payload_json, payload_hash,
          occurred_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.eventId,
        input.worldId,
        input.kind,
        payloadJson,
        payloadHash,
        timestamp('occurredAt', input.occurredAt),
        timestamp('recordedAt', input.recordedAt),
      );
    const row = this.database
      .prepare('SELECT * FROM context_world_events WHERE sequence = ?')
      .get(result.lastInsertRowid) as unknown as WorldEventRow;
    return mapWorldEvent(row);
  }

  getWorldEvent(id: EventId): WorldEventRecord | null {
    const row = this.database
      .prepare('SELECT * FROM context_world_events WHERE event_id = ?')
      .get(id) as unknown as WorldEventRow | undefined;
    return row ? mapWorldEvent(row) : null;
  }

  createBranch(input: {
    branchId: BranchId;
    worldId: WorldId;
    parentBranchId?: BranchId;
    authorityEpoch: number;
    startedAt: number;
  }): BranchRecord {
    this.database
      .prepare(
        `
        INSERT INTO context_branches(
          branch_id, world_id, parent_branch_id, status, authority_epoch,
          started_at, ended_at
        ) VALUES (?, ?, ?, 'running', ?, ?, NULL)
      `,
      )
      .run(
        input.branchId,
        input.worldId,
        input.parentBranchId ?? null,
        generation('authorityEpoch', input.authorityEpoch),
        timestamp('startedAt', input.startedAt),
      );
    return this.requireBranch(input.branchId);
  }

  finishBranch(
    id: BranchId,
    status: Exclude<BranchStatus, 'running'>,
    endedAt: number,
  ): BranchRecord {
    const result = this.database
      .prepare(
        `
        UPDATE context_branches SET status = ?, ended_at = ?
        WHERE branch_id = ? AND status = 'running'
      `,
      )
      .run(status, timestamp('endedAt', endedAt), id);
    if (result.changes !== 1) throw new Error(`branch is not running: ${id}`);
    return this.requireBranch(id);
  }

  getBranch(id: BranchId): BranchRecord | null {
    const row = this.database
      .prepare('SELECT * FROM context_branches WHERE branch_id = ?')
      .get(id) as unknown as BranchRow | undefined;
    return row ? mapBranch(row) : null;
  }

  private requireBranch(id: BranchId): BranchRecord {
    const branch = this.getBranch(id);
    if (!branch) throw new Error(`unknown branch: ${id}`);
    return branch;
  }

  createManifest(input: {
    manifestId: ManifestId;
    branchId: BranchId;
    worldId: WorldId;
    manifest: ViewManifest;
    projectionGeneration: number;
    shareGrantIds?: readonly ShareGrantId[];
    createdAt: number;
  }): ManifestRecord {
    const { hash: suppliedHash, ...manifestInput } = input.manifest;
    const manifest = createViewManifest(manifestInput);
    if (manifest.hash !== suppliedHash) {
      throw new Error('view manifest hash does not match its canonical bytes');
    }
    if (
      manifest.branchId !== input.branchId ||
      manifest.worldId !== input.worldId
    ) {
      throw new Error('view manifest identity does not match its store key');
    }
    const branch = this.requireBranch(input.branchId);
    if (
      branch.worldId !== input.worldId ||
      branch.parentBranchId !== manifest.parentBranchId ||
      branch.authorityEpoch !== manifest.authorityEpoch
    ) {
      throw new Error('view manifest lineage does not match its branch');
    }
    const shareGrantIds = [...(input.shareGrantIds ?? [])];
    if (shareGrantIds.length !== manifest.sharedEventIds.length) {
      throw new Error('view manifest shared events require exact share grants');
    }
    const projectionGeneration = generation(
      'projectionGeneration',
      input.projectionGeneration,
    );
    const manifestJson = serialize(manifest);
    const cacheNamespace = `context:${hashContextBytes(
      `${input.worldId}\u0000${projectionGeneration}\u0000${manifest.hash}`,
    )}`;
    transaction(this.database, () => {
      this.database
        .prepare(
          `
          INSERT INTO context_manifests(
            manifest_id, branch_id, world_id, manifest_hash, manifest_json,
            projection_generation, policy_generation, cache_namespace, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.manifestId,
          input.branchId,
          input.worldId,
          manifest.hash,
          manifestJson,
          projectionGeneration,
          manifest.policyGeneration,
          cacheNamespace,
          timestamp('createdAt', input.createdAt),
        );
      const eventStatement = this.database.prepare(`
        INSERT INTO context_manifest_events(manifest_id, event_id, world_id, ordinal)
        VALUES (?, ?, ?, ?)
      `);
      manifest.eventIds.forEach((id, ordinal) =>
        eventStatement.run(input.manifestId, id, input.worldId, ordinal),
      );
      const shareStatement = this.database.prepare(`
        INSERT INTO context_manifest_shares(
          manifest_id, grant_id, shared_event_id, destination_world_id, ordinal
        ) VALUES (?, ?, ?, ?, ?)
      `);
      shareGrantIds.forEach((id, ordinal) =>
        shareStatement.run(
          input.manifestId,
          id,
          manifest.sharedEventIds[ordinal],
          input.worldId,
          ordinal,
        ),
      );
    });
    return {
      manifestId: input.manifestId,
      branchId: input.branchId,
      worldId: input.worldId,
      hash: manifest.hash,
      json: manifestJson,
      projectionGeneration,
      policyGeneration: manifest.policyGeneration,
      cacheNamespace,
      createdAt: input.createdAt,
    };
  }

  createCapsule(input: {
    capsuleId: CapsuleId;
    branchId: BranchId;
    worldId: WorldId;
    kind: CapsuleKind;
    viewManifestHash: string | null;
    sourceRootHash: string;
    policyGeneration: number;
    summarizerModel?: string;
    summarizerPromptHash?: string;
    content: unknown;
    parentCapsuleIds?: readonly CapsuleId[];
    createdAt: number;
  }): CapsuleRecord {
    const contentJson = serialize(input.content);
    const contentHash = hashContextBytes(contentJson);
    transaction(this.database, () => {
      this.database
        .prepare(
          `
          INSERT INTO context_capsules(
            capsule_id, branch_id, world_id, capsule_kind,
            view_manifest_hash, source_root_hash, policy_generation,
            summarizer_model, summarizer_prompt_hash, content_json,
            content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.capsuleId,
          input.branchId,
          input.worldId,
          input.kind,
          input.viewManifestHash,
          input.sourceRootHash,
          generation('policyGeneration', input.policyGeneration),
          input.summarizerModel ?? null,
          input.summarizerPromptHash ?? null,
          contentJson,
          contentHash,
          timestamp('createdAt', input.createdAt),
        );
      const statement = this.database.prepare(`
        INSERT INTO context_capsule_edges(
          child_capsule_id, parent_capsule_id, world_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      input.parentCapsuleIds?.forEach((id, ordinal) =>
        statement.run(input.capsuleId, id, input.worldId, ordinal),
      );
    });
    return {
      capsuleId: input.capsuleId,
      branchId: input.branchId,
      worldId: input.worldId,
      kind: input.kind,
      viewManifestHash: input.viewManifestHash,
      sourceRootHash: input.sourceRootHash,
      policyGeneration: input.policyGeneration,
      summarizerModel: input.summarizerModel ?? null,
      summarizerPromptHash: input.summarizerPromptHash ?? null,
      contentJson,
      contentHash,
      createdAt: input.createdAt,
    };
  }

  createShareGrant(input: {
    grantId: ShareGrantId;
    sharedEventId: EventId;
    sourceCapsuleId: CapsuleId;
    sourceWorldId: WorldId;
    destinationWorldId: WorldId;
    canonicalText: string;
    authorityEpoch: number;
    createdAt: number;
  }): void {
    this.database
      .prepare(
        `
        INSERT INTO context_share_grants(
          grant_id, shared_event_id, source_capsule_id, source_world_id,
          destination_world_id, canonical_text, content_hash, status,
          authority_epoch, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)
      `,
      )
      .run(
        input.grantId,
        input.sharedEventId,
        input.sourceCapsuleId,
        input.sourceWorldId,
        input.destinationWorldId,
        input.canonicalText,
        hashContextBytes(input.canonicalText),
        generation('authorityEpoch', input.authorityEpoch),
        timestamp('createdAt', input.createdAt),
      );
  }

  revokeShareGrant(id: ShareGrantId, revokedAt: number): void {
    const result = this.database
      .prepare(
        `
        UPDATE context_share_grants
        SET status = 'revoked', revoked_at = ?
        WHERE grant_id = ? AND status = 'active'
      `,
      )
      .run(timestamp('revokedAt', revokedAt), id);
    if (result.changes !== 1)
      throw new Error(`share grant is not active: ${id}`);
  }

  getContinuationHead(): ContinuationHead {
    const row = this.database
      .prepare(
        `
        SELECT branch_id, world_id, revision, updated_at
        FROM context_continuation_head WHERE singleton = 1
      `,
      )
      .get() as {
      branch_id: string | null;
      world_id: string | null;
      revision: number;
      updated_at: number;
    };
    return {
      branchId: row.branch_id === null ? null : branchId(row.branch_id),
      worldId: row.world_id === null ? null : worldId(row.world_id),
      revision: row.revision,
      updatedAt: row.updated_at,
    };
  }

  advanceContinuationHead(input: {
    expectedRevision: number;
    branchId: BranchId;
    updatedAt: number;
  }): ContinuationHead {
    const expectedRevision = generation(
      'expectedRevision',
      input.expectedRevision,
    );
    const updatedAt = timestamp('updatedAt', input.updatedAt);
    return transaction(this.database, () => {
      const current = this.getContinuationHead();
      if (current.revision !== expectedRevision) {
        throw new StaleContinuationHeadError(expectedRevision);
      }
      const target = this.requireBranch(input.branchId);
      if (target.status !== 'yielded') {
        throw new Error(`continuation branch has not yielded: ${input.branchId}`);
      }
      this.database
        .prepare(
          `
          INSERT INTO context_continuation_advances(
            revision, predecessor_branch_id, predecessor_world_id,
            branch_id, world_id, advanced_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          expectedRevision + 1,
          current.branchId,
          current.worldId,
          target.branchId,
          target.worldId,
          updatedAt,
        );
      const result = this.database
        .prepare(
          `
          UPDATE context_continuation_head
          SET branch_id = ?, world_id = ?, revision = revision + 1, updated_at = ?
          WHERE singleton = 1 AND revision = ?
        `,
        )
        .run(target.branchId, target.worldId, updatedAt, expectedRevision);
      if (result.changes !== 1) {
        throw new StaleContinuationHeadError(expectedRevision);
      }
      return this.getContinuationHead();
    });
  }

  prepareEffect(input: {
    effectId: EffectId;
    branchId: BranchId;
    worldId: WorldId;
    destinationWorldId: WorldId;
    kind: string;
    authorityEpoch: number;
    payload: unknown;
    idempotencyKey?: string;
    preparedAt: number;
  }): EffectRecord {
    const payloadJson = serialize(input.payload);
    this.database
      .prepare(
        `
        INSERT INTO context_effects(
          effect_id, branch_id, world_id, destination_world_id,
          effect_kind, authority_epoch, payload_json, payload_hash,
          idempotency_key, status, prepared_at, resolved_at, observation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, NULL)
      `,
      )
      .run(
        input.effectId,
        input.branchId,
        input.worldId,
        input.destinationWorldId,
        input.kind,
        generation('authorityEpoch', input.authorityEpoch),
        payloadJson,
        hashContextBytes(payloadJson),
        input.idempotencyKey ?? null,
        timestamp('preparedAt', input.preparedAt),
      );
    return this.requireEffect(input.effectId);
  }

  resolveEffect(
    id: EffectId,
    status: Extract<EffectStatus, 'observed' | 'failed'>,
    resolvedAt: number,
    observation?: unknown,
  ): EffectRecord {
    const observationJson =
      observation === undefined ? null : serialize(observation);
    const result = this.database
      .prepare(
        `
        UPDATE context_effects
        SET status = ?, resolved_at = ?, observation_json = ?
        WHERE effect_id = ? AND status = 'prepared'
      `,
      )
      .run(status, timestamp('resolvedAt', resolvedAt), observationJson, id);
    if (result.changes !== 1) throw new Error(`effect is not prepared: ${id}`);
    return this.requireEffect(id);
  }

  /** Marks issuance without an observation as uncertain; it never retries it. */
  recoverPreparedEffects(recoveredAt: number): readonly EffectRecord[] {
    const at = timestamp('recoveredAt', recoveredAt);
    return transaction(this.database, () => {
      const rows = this.database
        .prepare(
          `
          SELECT * FROM context_effects
          WHERE status = 'prepared'
          ORDER BY prepared_at, effect_id
        `,
        )
        .all() as unknown as EffectRow[];
      const update = this.database.prepare(`
        UPDATE context_effects
        SET status = 'uncertain', resolved_at = ?, observation_json = NULL
        WHERE effect_id = ? AND status = 'prepared'
      `);
      for (const row of rows) update.run(at, row.effect_id);
      return rows.map((row) =>
        mapEffect({
          ...row,
          status: 'uncertain',
          resolved_at: at,
          observation_json: null,
        }),
      );
    });
  }

  getEffect(id: EffectId): EffectRecord | null {
    const row = this.database
      .prepare('SELECT * FROM context_effects WHERE effect_id = ?')
      .get(id) as unknown as EffectRow | undefined;
    return row ? mapEffect(row) : null;
  }

  private requireEffect(id: EffectId): EffectRecord {
    const effect = this.getEffect(id);
    if (!effect) throw new Error(`unknown effect: ${id}`);
    return effect;
  }

  importLegacyArtifact(input: {
    receiptId: LegacyImportReceiptId;
    sourceRef: string;
    sourceHash: string;
    sourceSize: number;
    artifactRef: string;
    importGeneration: number;
    branchId: BranchId;
    capsuleId: CapsuleId;
    importedAt: number;
  }): LegacyImportReceipt {
    if (!/^[0-9a-f]{64}$/.test(input.sourceHash)) {
      throw new Error('sourceHash must be a lowercase SHA-256 digest');
    }
    const sourceSize = timestamp('sourceSize', input.sourceSize);
    const importGeneration = generation(
      'importGeneration',
      input.importGeneration,
    );
    if (importGeneration < 1) {
      throw new Error('importGeneration must be positive');
    }
    const importedAt = timestamp('importedAt', input.importedAt);
    const contentJson = serialize({
      schemaVersion: 1,
      provenance: 'legacy-mixed-unscoped',
      artifactRef: input.artifactRef,
      sourceHash: input.sourceHash,
      sourceSize,
    });
    const contentHash = hashContextBytes(contentJson);
    return transaction(this.database, () => {
      const existing = this.database
        .prepare(
          `SELECT receipt_id, source_ref, source_hash, source_size,
             artifact_ref, import_generation, capsule_id, imported_at
           FROM context_legacy_import_receipts WHERE source_ref = ?`,
        )
        .get(input.sourceRef) as
        | {
            receipt_id: string;
            source_ref: string;
            source_hash: string;
            source_size: number;
            artifact_ref: string;
            import_generation: number;
            capsule_id: string;
            imported_at: number;
          }
        | undefined;
      if (existing) {
        if (
          existing.source_hash !== input.sourceHash ||
          existing.source_size !== sourceSize ||
          existing.artifact_ref !== input.artifactRef ||
          existing.import_generation !== importGeneration ||
          existing.capsule_id !== input.capsuleId
        ) {
          throw new LegacyImportConflictError(input.sourceRef);
        }
        return {
          receiptId: legacyImportReceiptId(existing.receipt_id),
          sourceRef: existing.source_ref,
          sourceHash: existing.source_hash,
          sourceSize: existing.source_size,
          artifactRef: existing.artifact_ref,
          importGeneration: existing.import_generation,
          capsuleId: capsuleId(existing.capsule_id),
          importedAt: existing.imported_at,
        };
      }
      this.database
        .prepare(
          `INSERT INTO context_branches(
             branch_id, world_id, parent_branch_id, authority_epoch,
             status, started_at, ended_at
           ) VALUES (?, ?, NULL, 0, 'running', ?, NULL)`,
        )
        .run(input.branchId, LEGACY_WORLD_ID, importedAt);
      this.database
        .prepare(
          `INSERT INTO context_capsules(
             capsule_id, branch_id, world_id, capsule_kind, view_manifest_hash,
             source_root_hash, policy_generation, summarizer_model,
             summarizer_prompt_hash, content_json, content_hash, created_at
           ) VALUES (?, ?, ?, 'legacy_opaque', NULL, ?, 0, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          input.capsuleId,
          input.branchId,
          LEGACY_WORLD_ID,
          input.sourceHash,
          contentJson,
          contentHash,
          importedAt,
        );
      this.database
        .prepare(
          `UPDATE context_branches
           SET status = 'yielded', ended_at = ?
           WHERE branch_id = ? AND status = 'running'`,
        )
        .run(importedAt, input.branchId);
      this.database
        .prepare(
          `INSERT INTO context_legacy_import_receipts(
             receipt_id, source_ref, source_hash, source_size, artifact_ref,
             import_generation, capsule_id, imported_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.receiptId,
          input.sourceRef,
          input.sourceHash,
          sourceSize,
          input.artifactRef,
          importGeneration,
          input.capsuleId,
          importedAt,
        );
      return {
        receiptId: input.receiptId,
        sourceRef: input.sourceRef,
        sourceHash: input.sourceHash,
        sourceSize,
        artifactRef: input.artifactRef,
        importGeneration,
        capsuleId: input.capsuleId,
        importedAt,
      };
    });
  }

  recordLegacyImport(input: {
    receiptId: LegacyImportReceiptId;
    sourceRef: string;
    sourceHash: string;
    sourceSize: number;
    artifactRef: string;
    importGeneration: number;
    capsuleId: CapsuleId;
    importedAt: number;
  }): LegacyImportReceipt {
    if (!/^[0-9a-f]{64}$/.test(input.sourceHash)) {
      throw new Error('sourceHash must be a lowercase SHA-256 digest');
    }
    const sourceSize = timestamp('sourceSize', input.sourceSize);
    const importGeneration = generation(
      'importGeneration',
      input.importGeneration,
    );
    if (importGeneration < 1) {
      throw new Error('importGeneration must be positive');
    }
    return transaction(this.database, () => {
      const existing = this.database
        .prepare(
          `
          SELECT receipt_id, source_ref, source_hash, source_size,
            artifact_ref, import_generation, capsule_id, imported_at
          FROM context_legacy_import_receipts WHERE source_ref = ?
        `,
        )
        .get(input.sourceRef) as
        | {
            receipt_id: string;
            source_ref: string;
            source_hash: string;
            source_size: number;
            artifact_ref: string;
            import_generation: number;
            capsule_id: string;
            imported_at: number;
          }
        | undefined;
      if (existing) {
        if (
          existing.source_hash !== input.sourceHash ||
          existing.source_size !== sourceSize ||
          existing.artifact_ref !== input.artifactRef ||
          existing.import_generation !== importGeneration ||
          existing.capsule_id !== input.capsuleId
        ) {
          throw new LegacyImportConflictError(input.sourceRef);
        }
        return {
          receiptId: legacyImportReceiptId(existing.receipt_id),
          sourceRef: existing.source_ref,
          sourceHash: existing.source_hash,
          sourceSize: existing.source_size,
          artifactRef: existing.artifact_ref,
          importGeneration: existing.import_generation,
          capsuleId: capsuleId(existing.capsule_id),
          importedAt: existing.imported_at,
        };
      }
      this.database
        .prepare(
          `
          INSERT INTO context_legacy_import_receipts(
            receipt_id, source_ref, source_hash, source_size, artifact_ref,
            import_generation, capsule_id, imported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.receiptId,
          input.sourceRef,
          input.sourceHash,
          sourceSize,
          input.artifactRef,
          importGeneration,
          input.capsuleId,
          timestamp('importedAt', input.importedAt),
        );
      return {
        receiptId: input.receiptId,
        sourceRef: input.sourceRef,
        sourceHash: input.sourceHash,
        sourceSize,
        artifactRef: input.artifactRef,
        importGeneration,
        capsuleId: input.capsuleId,
        importedAt: input.importedAt,
      };
    });
  }

  getActivationState(): ContextGraphActivation {
    const row = this.database
      .prepare(
        `
        SELECT mode, epoch, created_at, updated_at
        FROM context_graph_activation WHERE singleton = 1
      `,
      )
      .get() as {
      mode: ContextGraphMode;
      epoch: number;
      created_at: number;
      updated_at: number;
    };
    return {
      mode: row.mode,
      epoch: row.epoch,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Persists the future one-way cutover flag; this dark-mode change never calls it. */
  activate(expectedEpoch: number, activatedAt: number): ContextGraphActivation {
    const result = this.database
      .prepare(
        `
        UPDATE context_graph_activation
        SET mode = 'active', epoch = epoch + 1, updated_at = ?
        WHERE singleton = 1 AND mode = 'dark' AND epoch = ?
      `,
      )
      .run(
        timestamp('activatedAt', activatedAt),
        generation('expectedEpoch', expectedEpoch),
      );
    if (result.changes !== 1)
      throw new StaleActivationStateError(expectedEpoch);
    return this.getActivationState();
  }
}
