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
export type EventMessageProjectionId =
  ContextId<'EventMessageProjectionId'>;
export type SystemLayerProjectionId = ContextId<'SystemLayerProjectionId'>;
export type ShadowProjectionPlanId = ContextId<'ShadowProjectionPlanId'>;
export type ShadowRequestObservationId =
  ContextId<'ShadowRequestObservationId'>;

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
  if (!isEventId(value) || value.length > 128)
    throw new Error('invalid EventId');
  return value;
}

export function branchId(value: string): BranchId {
  if (!isBranchId(value) || value.length > 128)
    throw new Error('invalid BranchId');
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
export const eventMessageProjectionId = (
  value: string,
): EventMessageProjectionId =>
  branded<'EventMessageProjectionId'>(
    'eventMessageProjectionId',
    value,
    'event-message:',
  );
export const systemLayerProjectionId = (
  value: string,
): SystemLayerProjectionId =>
  branded<'SystemLayerProjectionId'>(
    'systemLayerProjectionId',
    value,
    'system-layer:',
  );
export const shadowProjectionPlanId = (value: string): ShadowProjectionPlanId =>
  branded<'ShadowProjectionPlanId'>(
    'shadowProjectionPlanId',
    value,
    'shadow-plan:',
  );
export const shadowRequestObservationId = (
  value: string,
): ShadowRequestObservationId =>
  branded<'ShadowRequestObservationId'>(
    'shadowRequestObservationId',
    value,
    'shadow-observation:',
  );

export type BranchStatus = 'running' | 'yielded' | 'crashed';
export type CapsuleKind =
  'private' | 'root_receipt' | 'self_delta' | 'legacy_opaque';
export type EffectStatus = 'prepared' | 'observed' | 'failed' | 'uncertain';
export type ContextGraphMode = 'dark' | 'active';
export type SystemLayerKind =
  | 'runtime_contract'
  | 'identity'
  | 'integrated_self'
  | 'world_policy'
  | 'private_frontier'
  | 'legacy_memory'
  | 'legacy_focus'
  | 'runtime_hint';
export type SystemLayerVisibility =
  | 'global_contract'
  | 'integrated_self'
  | 'integrated_self_candidate'
  | 'world'
  | 'private_root'
  | 'legacy_mixed';

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

export interface ProjectedUserMessage {
  readonly role: 'user';
  readonly content: string;
}

export interface EventMessageProjectionRecord {
  readonly projectionId: EventMessageProjectionId;
  readonly sourceEventId: EventId;
  readonly worldId: WorldId;
  readonly rendererGeneration: number;
  readonly message: ProjectedUserMessage;
  readonly messageJson: string;
  readonly messageHash: string;
  readonly createdAt: number;
}

export interface SystemLayerProjectionRecord {
  readonly layerId: SystemLayerProjectionId;
  readonly kind: SystemLayerKind;
  readonly visibility: SystemLayerVisibility;
  readonly worldId: WorldId | null;
  readonly rendererGeneration: number;
  readonly policyGeneration: number;
  readonly sourceKind: string;
  readonly sourceHash: string;
  readonly content: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly createdAt: number;
}

export type ShadowProjectionSurface =
  'openai-chat' | 'openai-responses' | 'codex-responses' | 'anthropic-messages';
export type ShadowProjectionResult = 'ineligible' | 'equal' | 'different';

export interface ShadowProjectionPlanRecord {
  readonly planId: ShadowProjectionPlanId;
  readonly worldId: WorldId;
  readonly wakeEventId: EventId;
  readonly planJson: string;
  readonly planHash: string;
  readonly createdAt: number;
}

export interface ShadowRequestObservationRecord {
  readonly sequence: number;
  readonly observationId: ShadowRequestObservationId;
  readonly planId: ShadowProjectionPlanId;
  readonly worldId: WorldId;
  readonly surface: ShadowProjectionSurface;
  readonly actualHash: string;
  readonly actualBytes: number;
  readonly result: ShadowProjectionResult;
  readonly reason: string | null;
  readonly expectedHash: string | null;
  readonly expectedBytes: number | null;
  readonly observedAt: number;
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

export interface ManifestShareRecord {
  readonly grantId: ShareGrantId;
  readonly eventId: EventId;
  readonly sourceCapsuleId: CapsuleId;
  readonly sourceWorldId: WorldId;
  readonly destinationWorldId: WorldId;
  readonly canonicalText: string;
  readonly contentHash: string;
  readonly status: 'active' | 'revoked';
  readonly authorityEpoch: number;
}

export interface ManifestProjection {
  readonly record: ManifestRecord;
  readonly manifest: ViewManifest;
  readonly localEvents: readonly WorldEventRecord[];
  readonly shares: readonly ManifestShareRecord[];
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

export interface BranchStartRecord {
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly baseRevision: number;
  readonly predecessorBranchId: BranchId | null;
  readonly predecessorWorldId: WorldId | null;
  readonly startedAt: number;
}

export interface RootCoordinatorState {
  readonly activeBranchId: BranchId | null;
  readonly activeWorldId: WorldId | null;
  readonly baseRevision: number;
  readonly predecessorBranchId: BranchId | null;
  readonly predecessorWorldId: WorldId | null;
  readonly updatedAt: number;
}

export interface BranchRecoveryRecord extends BranchStartRecord {
  readonly uncertainEffects: number;
  readonly recoveredAt: number;
}

export type BranchReturnOutcome = 'completed' | 'interrupted' | 'failed';

export interface RootReturnEffectReceipt {
  readonly effectId: EffectId;
  readonly destinationWorldId: WorldId;
  readonly kind: string;
  readonly authorityEpoch: number;
  readonly payloadHash: string;
  readonly status: Exclude<EffectStatus, 'prepared'>;
  readonly preparedAt: number;
  readonly resolvedAt: number;
}

export interface RootReturnReceiptV1 {
  readonly schemaVersion: 1;
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly viewManifestHash: string;
  readonly outcome: BranchReturnOutcome;
  readonly authorityEpoch: number;
  readonly privateCapsuleId: CapsuleId;
  readonly effects: readonly RootReturnEffectReceipt[];
  readonly commitments: readonly string[];
  readonly blockers: readonly string[];
  readonly artifactRefs: readonly string[];
}

export interface CoordinatedBranchReturn {
  readonly branch: BranchRecord;
  readonly privateCapsule: CapsuleRecord;
  readonly rootReceipt: CapsuleRecord;
  readonly head: ContinuationHead;
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

function boundedStrings(label: string, values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length > 128) {
    throw new Error(`${label} must contain at most 128 strings`);
  }
  return values.map((value) => {
    if (
      typeof value !== 'string' ||
      value.length > 4096 ||
      value.includes('\u0000')
    ) {
      throw new Error(`${label} contains an invalid string`);
    }
    return value;
  });
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

function sha256(label: string, value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function boundedReason(value: string | null): string | null {
  if (value === null) return null;
  if (!value || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('shadow observation reason must be a bounded token');
  }
  return value;
}

function shadowPlanObject(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactShadowPlanKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, i) => key !== wanted[i])
  ) {
    throw new Error(`${label} contains an unsupported field`);
  }
}

function normalizeProjectedUserMessage(value: unknown): ProjectedUserMessage {
  const message = shadowPlanObject(value, 'projected user message');
  exactShadowPlanKeys(message, ['role', 'content'], 'projected user message');
  if (
    message.role !== 'user' ||
    typeof message.content !== 'string' ||
    Buffer.byteLength(message.content) > 8 * 1024 * 1024
  ) {
    throw new Error('projected user message is invalid');
  }
  return { role: 'user', content: message.content };
}

function renderedProjectionIdentity(input: {
  sourceEventId: EventId;
  worldId: WorldId;
  rendererGeneration: number;
  messageHash: string;
}): EventMessageProjectionId {
  const hash = hashContextBytes(
    serialize({
      schemaVersion: 1,
      sourceEventId: input.sourceEventId,
      worldId: input.worldId,
      rendererGeneration: input.rendererGeneration,
      messageHash: input.messageHash,
    }),
  );
  return eventMessageProjectionId(`event-message:${hash}`);
}

const SYSTEM_LAYER_KINDS = new Set<SystemLayerKind>([
  'runtime_contract',
  'identity',
  'integrated_self',
  'world_policy',
  'private_frontier',
  'legacy_memory',
  'legacy_focus',
  'runtime_hint',
]);
const SYSTEM_LAYER_VISIBILITIES = new Set<SystemLayerVisibility>([
  'global_contract',
  'integrated_self',
  'integrated_self_candidate',
  'world',
  'private_root',
  'legacy_mixed',
]);

function systemLayerKind(value: unknown): SystemLayerKind {
  if (typeof value !== 'string' || !SYSTEM_LAYER_KINDS.has(value as SystemLayerKind)) {
    throw new Error('system layer kind is invalid');
  }
  return value as SystemLayerKind;
}

function systemLayerVisibility(value: unknown): SystemLayerVisibility {
  if (
    typeof value !== 'string' ||
    !SYSTEM_LAYER_VISIBILITIES.has(value as SystemLayerVisibility)
  ) {
    throw new Error('system layer visibility is invalid');
  }
  return value as SystemLayerVisibility;
}

function systemLayerSourceKind(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    !/^[a-z0-9:_-]+$/.test(value)
  ) {
    throw new Error('system layer source kind is invalid');
  }
  return value;
}

function systemLayerIdentity(input: {
  kind: SystemLayerKind;
  visibility: SystemLayerVisibility;
  worldId: WorldId | null;
  rendererGeneration: number;
  policyGeneration: number;
  sourceKind: string;
  sourceHash: string;
  contentHash: string;
  contentBytes: number;
}): SystemLayerProjectionId {
  const hash = hashContextBytes(
    serialize({ schemaVersion: 1, ...input }),
  );
  return systemLayerProjectionId(`system-layer:${hash}`);
}

function shadowCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function validateShadowProjectionPlan(
  value: unknown,
  world: WorldId,
  wakeEvent: EventId,
): void {
  const plan = shadowPlanObject(value, 'shadow projection plan');
  const isV2 = plan.schemaVersion === 2;
  const isV3 = plan.schemaVersion === 3;
  if (plan.schemaVersion !== 1 && !isV2 && !isV3) {
    throw new Error('shadow projection plan version is invalid');
  }
  exactShadowPlanKeys(
    plan,
    isV3
      ? [
          'schemaVersion',
          'worldId',
          'wakeEventId',
          'projectionGeneration',
          'policyGeneration',
          'rendererGeneration',
          'systemRendererGeneration',
          'localEventIds',
          'localMessageProjectionIds',
          'sharedEventIds',
          'foreignWorlds',
          'unlineagedRoles',
          'systemLayerProjectionIds',
          'blockers',
        ]
      : isV2
        ? [
            'schemaVersion',
            'worldId',
            'wakeEventId',
            'projectionGeneration',
            'policyGeneration',
            'rendererGeneration',
            'localEventIds',
            'localMessageProjectionIds',
            'sharedEventIds',
            'foreignWorlds',
            'unlineagedRoles',
            'systemLayers',
            'blockers',
          ]
        : [
          'schemaVersion',
          'worldId',
          'wakeEventId',
          'projectionGeneration',
          'policyGeneration',
          'localEventIds',
          'sharedEventIds',
          'foreignWorlds',
          'unlineagedRoles',
          'systemLayers',
          'blockers',
        ],
    'shadow projection plan',
  );
  if (
    plan.projectionGeneration !== (isV3 ? 3 : isV2 ? 2 : 1) ||
    plan.policyGeneration !== 1 ||
    plan.worldId !== world ||
    plan.wakeEventId !== wakeEvent ||
    ((isV2 || isV3) && plan.rendererGeneration !== 1) ||
    (isV3 && plan.systemRendererGeneration !== 1)
  ) {
    throw new Error('shadow projection plan identity or generation is invalid');
  }
  const local = plan.localEventIds;
  const shared = plan.sharedEventIds;
  if (
    !Array.isArray(local) ||
    !Array.isArray(shared) ||
    local.length > 4096 ||
    shared.length > 4096
  ) {
    throw new Error('shadow projection plan event lists are invalid');
  }
  const events = [...local, ...shared];
  if (
    events.some((id) => !isEventId(id) || id.length > 128) ||
    new Set(events).size !== events.length ||
    !local.includes(wakeEvent)
  ) {
    throw new Error('shadow projection plan event lineage is invalid');
  }
  const localProjectionIds =
    isV2 || isV3 ? plan.localMessageProjectionIds : [];
  if (
    !Array.isArray(localProjectionIds) ||
    localProjectionIds.length > local.length ||
    localProjectionIds.some((id) => {
      try {
        eventMessageProjectionId(String(id));
        return typeof id !== 'string';
      } catch {
        return true;
      }
    }) ||
    new Set(localProjectionIds).size !== localProjectionIds.length
  ) {
    throw new Error('shadow projection plan message projections are invalid');
  }
  if (!Array.isArray(plan.foreignWorlds) || plan.foreignWorlds.length > 4096) {
    throw new Error('shadow projection plan foreign worlds are invalid');
  }
  const foreign = new Set<string>();
  for (const item of plan.foreignWorlds) {
    const row = shadowPlanObject(item, 'shadow projection foreign world');
    exactShadowPlanKeys(
      row,
      ['worldId', 'messageCount'],
      'shadow projection foreign world',
    );
    if (
      !isWorldId(row.worldId) ||
      row.worldId === world ||
      foreign.has(row.worldId)
    ) {
      throw new Error(
        'shadow projection plan foreign world identity is invalid',
      );
    }
    foreign.add(row.worldId);
    shadowCount(row.messageCount, 'shadow projection foreign message count');
  }
  const roles = shadowPlanObject(
    plan.unlineagedRoles,
    'shadow projection role counts',
  );
  exactShadowPlanKeys(
    roles,
    ['system', 'user', 'assistant', 'tool'],
    'shadow projection role counts',
  );
  for (const role of ['system', 'user', 'assistant', 'tool']) {
    shadowCount(roles[role], `shadow projection ${role} count`);
  }
  const systemLayerProjectionIds = isV3
    ? Array.isArray(plan.systemLayerProjectionIds)
      ? plan.systemLayerProjectionIds
      : null
    : [];
  if (isV3) {
    if (
      systemLayerProjectionIds === null ||
      systemLayerProjectionIds.length > 64 ||
      systemLayerProjectionIds.some((id) => {
        try {
          systemLayerProjectionId(String(id));
          return typeof id !== 'string';
        } catch {
          return true;
        }
      }) ||
      new Set(systemLayerProjectionIds).size !== systemLayerProjectionIds.length
    ) {
      throw new Error('shadow projection system layer references are invalid');
    }
  } else {
    if (!Array.isArray(plan.systemLayers) || plan.systemLayers.length > 64) {
      throw new Error('shadow projection system layers are invalid');
    }
    const ordinals = new Set<number>();
    for (const item of plan.systemLayers) {
      const layer = shadowPlanObject(item, 'shadow projection system layer');
      exactShadowPlanKeys(
        layer,
        ['ordinal', 'sha256', 'byteLength', 'scope'],
        'shadow projection system layer',
      );
      const ordinal = shadowCount(
        layer.ordinal,
        'shadow projection layer ordinal',
      );
      if (ordinals.has(ordinal) || layer.scope !== 'legacy-mixed') {
        throw new Error('shadow projection system layer is invalid');
      }
      ordinals.add(ordinal);
      sha256('shadow projection layer hash', String(layer.sha256));
      shadowCount(layer.byteLength, 'shadow projection layer bytes');
    }
  }
  const allowedBlockers = new Set([
    ...(!isV3 ? ['legacy_mixed_system'] : []),
    'unlineaged_history',
    'multiple_worlds',
    'unverified_share',
    'multimodal_unavailable',
    'duplicate_event',
    ...(isV2 || isV3
      ? [
          'unsupported_projected_role',
          'unrendered_event',
          'render_projection_mismatch',
        ]
      : []),
    ...(isV3
      ? [
          'legacy_monocontext_contract',
          'legacy_mixed_memory',
          'legacy_mixed_focus',
          'identity_candidate_unapproved',
          'runtime_hint_unscoped',
          'system_layer_unavailable',
          'system_layer_mismatch',
          'unbound_effect_tools',
        ]
      : []),
  ]);
  if (
    !Array.isArray(plan.blockers) ||
    plan.blockers.length > allowedBlockers.size ||
    plan.blockers.some(
      (entry) => typeof entry !== 'string' || !allowedBlockers.has(entry),
    ) ||
    new Set(plan.blockers).size !== plan.blockers.length
  ) {
    throw new Error('shadow projection blockers are invalid');
  }
  if (isV2 || isV3) {
    const incomplete = localProjectionIds.length !== local.length;
    const saysIncomplete = plan.blockers.includes('unrendered_event');
    if (
      incomplete !== saysIncomplete ||
      (plan.blockers.includes('render_projection_mismatch') && !saysIncomplete) ||
      (plan.blockers.includes('unsupported_projected_role') && !saysIncomplete)
    ) {
      throw new Error('shadow projection rendering state is inconsistent');
    }
  }
  if (isV3) {
    const systemUnavailable = systemLayerProjectionIds?.length === 0;
    const saysUnavailable = plan.blockers.includes('system_layer_unavailable');
    if (
      systemUnavailable !== saysUnavailable ||
      (plan.blockers.includes('system_layer_mismatch') && !saysUnavailable) ||
      !plan.blockers.includes('unbound_effect_tools')
    ) {
      throw new Error('shadow projection system state is inconsistent');
    }
  }
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

interface EventMessageProjectionRow {
  projection_id: string;
  source_event_id: string;
  world_id: string;
  renderer_generation: number;
  message_json: string;
  message_hash: string;
  created_at: number;
}

interface SystemLayerProjectionRow {
  layer_id: string;
  layer_kind: string;
  visibility: string;
  world_id: string | null;
  renderer_generation: number;
  policy_generation: number;
  source_kind: string;
  source_hash: string;
  content_text: string;
  content_hash: string;
  content_bytes: number;
  created_at: number;
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

interface ShadowProjectionPlanRow {
  plan_id: string;
  world_id: string;
  wake_event_id: string;
  plan_json: string;
  plan_hash: string;
  created_at: number;
}

interface ShadowRequestObservationRow {
  sequence: number;
  observation_id: string;
  plan_id: string;
  world_id: string;
  surface: ShadowProjectionSurface;
  actual_hash: string;
  actual_bytes: number;
  result: ShadowProjectionResult;
  reason: string | null;
  expected_hash: string | null;
  expected_bytes: number | null;
  observed_at: number;
}

function mapShadowRequestObservation(
  row: ShadowRequestObservationRow,
): ShadowRequestObservationRecord {
  return {
    sequence: row.sequence,
    observationId: shadowRequestObservationId(row.observation_id),
    planId: shadowProjectionPlanId(row.plan_id),
    worldId: worldId(row.world_id),
    surface: row.surface,
    actualHash: sha256('actualHash', row.actual_hash),
    actualBytes: timestamp('actualBytes', row.actual_bytes),
    result: row.result,
    reason: row.reason,
    expectedHash:
      row.expected_hash === null
        ? null
        : sha256('expectedHash', row.expected_hash),
    expectedBytes:
      row.expected_bytes === null
        ? null
        : timestamp('expectedBytes', row.expected_bytes),
    observedAt: timestamp('observedAt', row.observed_at),
  };
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

function mapEventMessageProjection(
  row: EventMessageProjectionRow,
): EventMessageProjectionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.message_json);
  } catch (error) {
    throw new Error(
      `stored event message projection is invalid: ${row.projection_id}`,
      { cause: error },
    );
  }
  const message = normalizeProjectedUserMessage(parsed);
  const messageJson = serialize(message);
  const sourceEventId = eventId(row.source_event_id);
  const projectionWorldId = worldId(row.world_id);
  const rendererGeneration = generation(
    'rendererGeneration',
    row.renderer_generation,
  );
  const messageHash = sha256('messageHash', row.message_hash);
  if (
    rendererGeneration < 1 ||
    messageJson !== row.message_json ||
    hashContextBytes(messageJson) !== messageHash ||
    renderedProjectionIdentity({
      sourceEventId,
      worldId: projectionWorldId,
      rendererGeneration,
      messageHash,
    }) !== row.projection_id
  ) {
    throw new Error(
      `stored event message projection is invalid: ${row.projection_id}`,
    );
  }
  return {
    projectionId: eventMessageProjectionId(row.projection_id),
    sourceEventId,
    worldId: projectionWorldId,
    rendererGeneration,
    message,
    messageJson,
    messageHash,
    createdAt: timestamp('createdAt', row.created_at),
  };
}

function mapSystemLayerProjection(
  row: SystemLayerProjectionRow,
): SystemLayerProjectionRecord {
  const kind = systemLayerKind(row.layer_kind);
  const visibility = systemLayerVisibility(row.visibility);
  const projectionWorldId =
    row.world_id === null ? null : worldId(row.world_id);
  const rendererGeneration = generation(
    'rendererGeneration',
    row.renderer_generation,
  );
  const policyGeneration = generation(
    'policyGeneration',
    row.policy_generation,
  );
  const sourceKind = systemLayerSourceKind(row.source_kind);
  const sourceHash = sha256('sourceHash', row.source_hash);
  const contentHash = sha256('contentHash', row.content_hash);
  const contentBytes = shadowCount(row.content_bytes, 'contentBytes');
  if (
    rendererGeneration < 1 ||
    policyGeneration < 1 ||
    (visibility === 'world') !== (projectionWorldId !== null) ||
    Buffer.byteLength(row.content_text) !== contentBytes ||
    contentBytes > 8 * 1024 * 1024 ||
    hashContextBytes(row.content_text) !== contentHash ||
    systemLayerIdentity({
      kind,
      visibility,
      worldId: projectionWorldId,
      rendererGeneration,
      policyGeneration,
      sourceKind,
      sourceHash,
      contentHash,
      contentBytes,
    }) !== row.layer_id
  ) {
    throw new Error(`stored system layer projection is invalid: ${row.layer_id}`);
  }
  return {
    layerId: systemLayerProjectionId(row.layer_id),
    kind,
    visibility,
    worldId: projectionWorldId,
    rendererGeneration,
    policyGeneration,
    sourceKind,
    sourceHash,
    content: row.content_text,
    contentHash,
    contentBytes,
    createdAt: timestamp('createdAt', row.created_at),
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

  createEventMessageProjection(input: {
    sourceEventId: EventId;
    sourceSequence: number;
    worldId: WorldId;
    rendererGeneration: number;
    message: ProjectedUserMessage;
    createdAt: number;
  }): EventMessageProjectionRecord {
    const rendererGeneration = generation(
      'rendererGeneration',
      input.rendererGeneration,
    );
    if (rendererGeneration < 1) {
      throw new Error('rendererGeneration must be positive');
    }
    const sourceSequence = generation('sourceSequence', input.sourceSequence);
    if (sourceSequence < 1) {
      throw new Error('sourceSequence must be positive');
    }
    const source = this.getWorldEvent(input.sourceEventId);
    if (
      !source ||
      source.worldId !== input.worldId ||
      !source.kind.startsWith('inbound:') ||
      source.sequence !== sourceSequence
    ) {
      throw new Error('event message projection source lineage is invalid');
    }
    const message = normalizeProjectedUserMessage(input.message);
    const messageJson = serialize(message);
    const messageHash = hashContextBytes(messageJson);
    const projectionId = renderedProjectionIdentity({
      sourceEventId: input.sourceEventId,
      worldId: input.worldId,
      rendererGeneration,
      messageHash,
    });
    const existing = this.getEventMessageProjectionForSource(
      input.sourceEventId,
      rendererGeneration,
    );
    if (existing) {
      if (
        existing.projectionId !== projectionId ||
        existing.worldId !== input.worldId ||
        existing.messageHash !== messageHash ||
        existing.messageJson !== messageJson
      ) {
        throw new Error(
          `event message projection identity conflict: ${input.sourceEventId}`,
        );
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO context_event_message_projections(
           projection_id, source_event_id, world_id, renderer_generation,
           message_json, message_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectionId,
        input.sourceEventId,
        input.worldId,
        rendererGeneration,
        messageJson,
        messageHash,
        timestamp('createdAt', input.createdAt),
      );
    return this.getEventMessageProjection(projectionId)!;
  }

  getEventMessageProjection(
    id: EventMessageProjectionId,
  ): EventMessageProjectionRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_event_message_projections WHERE projection_id = ?',
      )
      .get(id) as unknown as EventMessageProjectionRow | undefined;
    if (!row) return null;
    const projection = mapEventMessageProjection(row);
    const source = this.getWorldEvent(projection.sourceEventId);
    if (
      !source ||
      source.worldId !== projection.worldId ||
      !source.kind.startsWith('inbound:')
    ) {
      throw new Error(
        `stored event message projection has invalid source: ${id}`,
      );
    }
    return projection;
  }

  getEventMessageProjectionForSource(
    sourceEventId: EventId,
    rendererGeneration: number,
  ): EventMessageProjectionRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM context_event_message_projections
         WHERE source_event_id = ? AND renderer_generation = ?`,
      )
      .get(
        sourceEventId,
        generation('rendererGeneration', rendererGeneration),
      ) as unknown as EventMessageProjectionRow | undefined;
    if (!row) return null;
    return this.getEventMessageProjection(
      eventMessageProjectionId(row.projection_id),
    );
  }

  createSystemLayerProjection(input: {
    kind: SystemLayerKind;
    visibility: SystemLayerVisibility;
    worldId: WorldId | null;
    rendererGeneration: number;
    policyGeneration: number;
    sourceKind: string;
    sourceHash: string;
    content: string;
    createdAt: number;
  }): SystemLayerProjectionRecord {
    const kind = systemLayerKind(input.kind);
    const visibility = systemLayerVisibility(input.visibility);
    const sourceKind = systemLayerSourceKind(input.sourceKind);
    const sourceHash = sha256('sourceHash', input.sourceHash);
    const rendererGeneration = generation(
      'rendererGeneration',
      input.rendererGeneration,
    );
    const policyGeneration = generation(
      'policyGeneration',
      input.policyGeneration,
    );
    const projectionWorldId =
      input.worldId === null ? null : worldId(input.worldId);
    if (
      rendererGeneration < 1 ||
      policyGeneration < 1 ||
      (visibility === 'world') !== (projectionWorldId !== null) ||
      typeof input.content !== 'string'
    ) {
      throw new Error('system layer projection metadata is invalid');
    }
    const contentBytes = Buffer.byteLength(input.content);
    if (contentBytes > 8 * 1024 * 1024) {
      throw new Error('system layer projection content is too large');
    }
    const contentHash = hashContextBytes(input.content);
    const layerId = systemLayerIdentity({
      kind,
      visibility,
      worldId: projectionWorldId,
      rendererGeneration,
      policyGeneration,
      sourceKind,
      sourceHash,
      contentHash,
      contentBytes,
    });
    const existing = this.getSystemLayerProjection(layerId);
    if (existing) {
      if (
        existing.kind !== kind ||
        existing.visibility !== visibility ||
        existing.worldId !== projectionWorldId ||
        existing.rendererGeneration !== rendererGeneration ||
        existing.policyGeneration !== policyGeneration ||
        existing.sourceKind !== sourceKind ||
        existing.sourceHash !== sourceHash ||
        existing.contentHash !== contentHash ||
        existing.contentBytes !== contentBytes ||
        existing.content !== input.content
      ) {
        throw new Error(`system layer projection identity conflict: ${layerId}`);
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO context_system_layer_projections(
           layer_id, layer_kind, visibility, world_id, renderer_generation,
           policy_generation, source_kind, source_hash, content_text,
           content_hash, content_bytes, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        layerId,
        kind,
        visibility,
        projectionWorldId,
        rendererGeneration,
        policyGeneration,
        sourceKind,
        sourceHash,
        input.content,
        contentHash,
        contentBytes,
        timestamp('createdAt', input.createdAt),
      );
    return this.getSystemLayerProjection(layerId)!;
  }

  getSystemLayerProjection(
    id: SystemLayerProjectionId,
  ): SystemLayerProjectionRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_system_layer_projections WHERE layer_id = ?',
      )
      .get(id) as unknown as SystemLayerProjectionRow | undefined;
    return row ? mapSystemLayerProjection(row) : null;
  }

  private validateShadowMessageProjectionLineage(
    plan: unknown,
    planWorldId: WorldId,
  ): void {
    const parsed = plan as {
      schemaVersion: number;
      rendererGeneration?: number;
      localEventIds: EventId[];
      localMessageProjectionIds?: string[];
    };
    if (parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) return;
    let previousEventSequence = -1;
    for (const id of parsed.localEventIds) {
      const event = this.getWorldEvent(id);
      if (
        !event ||
        event.worldId !== planWorldId ||
        event.sequence <= previousEventSequence
      ) {
        throw new Error('shadow projection local event order is invalid');
      }
      previousEventSequence = event.sequence;
    }
    const positions = new Map(
      parsed.localEventIds.map((id, index) => [id, index] as const),
    );
    let previousPosition = -1;
    for (const rawId of parsed.localMessageProjectionIds ?? []) {
      const projection = this.getEventMessageProjection(
        eventMessageProjectionId(rawId),
      );
      const position = projection
        ? positions.get(projection.sourceEventId)
        : undefined;
      if (
        !projection ||
        projection.worldId !== planWorldId ||
        projection.rendererGeneration !== parsed.rendererGeneration ||
        position === undefined ||
        position <= previousPosition
      ) {
        throw new Error('shadow projection message lineage is invalid');
      }
      previousPosition = position;
    }
  }

  private validateShadowSystemLayerLineage(
    plan: unknown,
    planWorldId: WorldId,
  ): void {
    const parsed = plan as {
      schemaVersion: number;
      systemRendererGeneration?: number;
      policyGeneration: number;
      systemLayerProjectionIds?: string[];
      blockers: string[];
    };
    if (parsed.schemaVersion !== 3) return;
    const order: Readonly<Record<SystemLayerKind, number>> = {
      runtime_contract: 0,
      legacy_memory: 1,
      legacy_focus: 2,
      identity: 3,
      integrated_self: 4,
      world_policy: 5,
      private_frontier: 6,
      runtime_hint: 7,
    };
    const expectedBlockers = new Set<string>();
    let previousOrder = -1;
    for (const rawId of parsed.systemLayerProjectionIds ?? []) {
      const layer = this.getSystemLayerProjection(
        systemLayerProjectionId(rawId),
      );
      if (
        !layer ||
        layer.rendererGeneration !== parsed.systemRendererGeneration ||
        layer.policyGeneration !== parsed.policyGeneration ||
        (layer.visibility === 'world' && layer.worldId !== planWorldId) ||
        (layer.visibility !== 'world' && layer.worldId !== null) ||
        order[layer.kind] <= previousOrder
      ) {
        throw new Error('shadow projection system layer lineage is invalid');
      }
      previousOrder = order[layer.kind];
      if (
        layer.kind === 'runtime_contract' &&
        layer.visibility === 'legacy_mixed'
      ) {
        expectedBlockers.add('legacy_monocontext_contract');
      } else if (
        layer.kind === 'legacy_memory' &&
        layer.visibility === 'legacy_mixed'
      ) {
        expectedBlockers.add('legacy_mixed_memory');
      } else if (
        layer.kind === 'legacy_focus' &&
        layer.visibility === 'legacy_mixed'
      ) {
        expectedBlockers.add('legacy_mixed_focus');
      } else if (
        layer.kind === 'identity' &&
        layer.visibility === 'integrated_self_candidate'
      ) {
        expectedBlockers.add('identity_candidate_unapproved');
      } else if (
        layer.kind === 'runtime_hint' &&
        layer.visibility === 'legacy_mixed'
      ) {
        expectedBlockers.add('runtime_hint_unscoped');
      } else if (
        !(
          (layer.kind === 'runtime_contract' &&
            layer.visibility === 'global_contract') ||
          ((layer.kind === 'identity' || layer.kind === 'integrated_self') &&
            layer.visibility === 'integrated_self') ||
          (layer.kind === 'world_policy' && layer.visibility === 'world')
        )
      ) {
        throw new Error('shadow projection system layer scope is unsupported');
      }
    }
    for (const blocker of [
      'legacy_monocontext_contract',
      'legacy_mixed_memory',
      'legacy_mixed_focus',
      'identity_candidate_unapproved',
      'runtime_hint_unscoped',
    ]) {
      if (parsed.blockers.includes(blocker) !== expectedBlockers.has(blocker)) {
        throw new Error('shadow projection system blocker lineage is invalid');
      }
    }
  }

  createShadowProjectionPlan(input: {
    planId: ShadowProjectionPlanId;
    worldId: WorldId;
    wakeEventId: EventId;
    plan: unknown;
    createdAt: number;
  }): ShadowProjectionPlanRecord {
    validateShadowProjectionPlan(input.plan, input.worldId, input.wakeEventId);
    const lineage = input.plan as {
      localEventIds: EventId[];
      sharedEventIds: EventId[];
    };
    for (const id of lineage.localEventIds) {
      const event = this.getWorldEvent(id);
      if (!event || event.worldId !== input.worldId) {
        throw new Error(
          `shadow projection local event is not in its world: ${id}`,
        );
      }
    }
    for (const id of lineage.sharedEventIds) {
      const event = this.getWorldEvent(id);
      if (!event || event.worldId === input.worldId) {
        throw new Error(
          `shadow projection shared event lacks foreign lineage: ${id}`,
        );
      }
    }
    this.validateShadowMessageProjectionLineage(input.plan, input.worldId);
    this.validateShadowSystemLayerLineage(input.plan, input.worldId);
    const planJson = serialize(input.plan);

    const planHash = hashContextBytes(planJson);
    if (input.planId !== `shadow-plan:${planHash}`) {
      throw new Error(
        'shadow projection plan identity does not match its bytes',
      );
    }
    const wake = this.getWorldEvent(input.wakeEventId);
    if (!wake || wake.worldId !== input.worldId) {
      throw new Error('shadow projection plan wake event is not in its world');
    }
    const existing = this.getShadowProjectionPlan(input.planId);
    if (existing) {
      if (
        existing.worldId !== input.worldId ||
        existing.wakeEventId !== input.wakeEventId ||
        existing.planHash !== planHash
      ) {
        throw new Error(
          `shadow projection plan identity conflict: ${input.planId}`,
        );
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO context_shadow_projection_plans(
           plan_id, world_id, wake_event_id, plan_json, plan_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.planId,
        input.worldId,
        input.wakeEventId,
        planJson,
        planHash,
        timestamp('createdAt', input.createdAt),
      );
    return this.getShadowProjectionPlan(input.planId)!;
  }

  getShadowProjectionPlan(
    id: ShadowProjectionPlanId,
  ): ShadowProjectionPlanRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_shadow_projection_plans WHERE plan_id = ?',
      )
      .get(id) as unknown as ShadowProjectionPlanRow | undefined;
    if (!row) return null;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.plan_json) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`stored shadow projection plan is invalid: ${id}`, {
        cause: error,
      });
    }
    validateShadowProjectionPlan(
      parsed,
      worldId(row.world_id),
      eventId(row.wake_event_id),
    );
    this.validateShadowMessageProjectionLineage(parsed, worldId(row.world_id));
    this.validateShadowSystemLayerLineage(parsed, worldId(row.world_id));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed.schemaVersion !== 1 &&
        parsed.schemaVersion !== 2 &&
        parsed.schemaVersion !== 3) ||
      parsed.worldId !== row.world_id ||
      parsed.wakeEventId !== row.wake_event_id ||
      serialize(parsed) !== row.plan_json ||
      hashContextBytes(row.plan_json) !== row.plan_hash ||
      row.plan_id !== `shadow-plan:${row.plan_hash}`
    ) {
      throw new Error(`stored shadow projection plan is invalid: ${id}`);
    }
    return {
      planId: shadowProjectionPlanId(row.plan_id),
      worldId: worldId(row.world_id),
      wakeEventId: eventId(row.wake_event_id),
      planJson: row.plan_json,
      planHash: sha256('planHash', row.plan_hash),
      createdAt: timestamp('createdAt', row.created_at),
    };
  }

  recordShadowRequestObservation(input: {
    observationId: ShadowRequestObservationId;
    planId: ShadowProjectionPlanId;
    worldId: WorldId;
    surface: ShadowProjectionSurface;
    actualHash: string;
    actualBytes: number;
    result: ShadowProjectionResult;
    reason: string | null;
    expectedHash: string | null;
    expectedBytes: number | null;
    observedAt: number;
  }): ShadowRequestObservationRecord {
    const plan = this.getShadowProjectionPlan(input.planId);
    if (!plan || plan.worldId !== input.worldId) {
      throw new Error('shadow request observation plan is not in its world');
    }
    const actualHash = sha256('actualHash', input.actualHash);
    const actualBytes = timestamp('actualBytes', input.actualBytes);
    const reason = boundedReason(input.reason);
    const expectedHash =
      input.expectedHash === null
        ? null
        : sha256('expectedHash', input.expectedHash);
    const expectedBytes =
      input.expectedBytes === null
        ? null
        : timestamp('expectedBytes', input.expectedBytes);
    if (input.result === 'ineligible') {
      if (reason === null || expectedHash !== null || expectedBytes !== null) {
        throw new Error('ineligible shadow observation requires only a reason');
      }
    } else {
      if (reason !== null || expectedHash === null || expectedBytes === null) {
        throw new Error(
          'compared shadow observation requires an expected projection',
        );
      }
      const equal =
        actualHash === expectedHash && actualBytes === expectedBytes;
      if ((input.result === 'equal') !== equal) {
        throw new Error(
          'shadow observation result does not match its projections',
        );
      }
    }
    const existing = this.getShadowRequestObservation(input.observationId);
    if (existing) {
      const expected = {
        ...input,
        actualHash,
        actualBytes,
        reason,
        expectedHash,
        expectedBytes,
      };
      if (
        existing.planId !== expected.planId ||
        existing.worldId !== expected.worldId ||
        existing.surface !== expected.surface ||
        existing.actualHash !== expected.actualHash ||
        existing.actualBytes !== expected.actualBytes ||
        existing.result !== expected.result ||
        existing.reason !== expected.reason ||
        existing.expectedHash !== expected.expectedHash ||
        existing.expectedBytes !== expected.expectedBytes ||
        existing.observedAt !== expected.observedAt
      ) {
        throw new Error(
          `shadow request observation identity conflict: ${input.observationId}`,
        );
      }
      return existing;
    }
    const result = this.database
      .prepare(
        `INSERT INTO context_shadow_request_observations(
           observation_id, plan_id, world_id, surface, actual_hash, actual_bytes,
           result, reason, expected_hash, expected_bytes, observed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.observationId,
        input.planId,
        input.worldId,
        input.surface,
        actualHash,
        actualBytes,
        input.result,
        reason,
        expectedHash,
        expectedBytes,
        timestamp('observedAt', input.observedAt),
      );
    const row = this.database
      .prepare(
        'SELECT * FROM context_shadow_request_observations WHERE sequence = ?',
      )
      .get(result.lastInsertRowid) as unknown as ShadowRequestObservationRow;
    return mapShadowRequestObservation(row);
  }

  getShadowRequestObservation(
    id: ShadowRequestObservationId,
  ): ShadowRequestObservationRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_shadow_request_observations WHERE observation_id = ?',
      )
      .get(id) as unknown as ShadowRequestObservationRow | undefined;
    return row ? mapShadowRequestObservation(row) : null;
  }

  listShadowRequestObservations(
    planId: ShadowProjectionPlanId,
  ): ShadowRequestObservationRecord[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM context_shadow_request_observations
           WHERE plan_id = ? ORDER BY sequence`,
        )
        .all(planId) as unknown as ShadowRequestObservationRow[]
    ).map(mapShadowRequestObservation);
  }

  getRootCoordinatorState(): RootCoordinatorState {
    const row = this.database
      .prepare(
        `SELECT active_branch_id, active_world_id, base_revision,
           predecessor_branch_id, predecessor_world_id, updated_at
         FROM context_root_coordinator WHERE singleton = 1`,
      )
      .get() as {
      active_branch_id: string | null;
      active_world_id: string | null;
      base_revision: number;
      predecessor_branch_id: string | null;
      predecessor_world_id: string | null;
      updated_at: number;
    };
    return {
      activeBranchId:
        row.active_branch_id === null ? null : branchId(row.active_branch_id),
      activeWorldId:
        row.active_world_id === null ? null : worldId(row.active_world_id),
      baseRevision: row.base_revision,
      predecessorBranchId:
        row.predecessor_branch_id === null
          ? null
          : branchId(row.predecessor_branch_id),
      predecessorWorldId:
        row.predecessor_world_id === null
          ? null
          : worldId(row.predecessor_world_id),
      updatedAt: row.updated_at,
    };
  }

  getBranchStart(id: BranchId): BranchStartRecord | null {
    const row = this.database
      .prepare(
        `SELECT branch_id, world_id, base_revision, predecessor_branch_id,
           predecessor_world_id, started_at
         FROM context_branch_starts WHERE branch_id = ?`,
      )
      .get(id) as
      | {
          branch_id: string;
          world_id: string;
          base_revision: number;
          predecessor_branch_id: string | null;
          predecessor_world_id: string | null;
          started_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      branchId: branchId(row.branch_id),
      worldId: worldId(row.world_id),
      baseRevision: row.base_revision,
      predecessorBranchId:
        row.predecessor_branch_id === null
          ? null
          : branchId(row.predecessor_branch_id),
      predecessorWorldId:
        row.predecessor_world_id === null
          ? null
          : worldId(row.predecessor_world_id),
      startedAt: row.started_at,
    };
  }

  beginCoordinatedBranch(input: {
    branchId: BranchId;
    worldId: WorldId;
    expectedRevision: number;
    authorityEpoch: number;
    startedAt: number;
  }): {
    branch: BranchRecord;
    start: BranchStartRecord;
    state: RootCoordinatorState;
  } {
    const expectedRevision = generation(
      'expectedRevision',
      input.expectedRevision,
    );
    const authorityEpoch = generation('authorityEpoch', input.authorityEpoch);
    if (authorityEpoch < 1) throw new Error('authorityEpoch must be positive');
    const startedAt = timestamp('startedAt', input.startedAt);
    return transaction(this.database, () => {
      const head = this.getContinuationHead();
      if (head.revision !== expectedRevision) {
        throw new StaleContinuationHeadError(expectedRevision);
      }
      const state = this.getRootCoordinatorState();
      if (state.activeBranchId !== null) {
        throw new Error(
          `context branch already active: ${state.activeBranchId}`,
        );
      }
      if (
        state.baseRevision !== head.revision ||
        state.predecessorBranchId !== head.branchId ||
        state.predecessorWorldId !== head.worldId
      ) {
        throw new Error(
          'context root coordinator does not match continuation head',
        );
      }
      const localParent = this.database
        .prepare(
          `SELECT branch_id FROM context_continuation_advances
           WHERE world_id = ? ORDER BY revision DESC LIMIT 1`,
        )
        .get(input.worldId) as { branch_id: string } | undefined;
      const branch = this.createBranch({
        branchId: input.branchId,
        worldId: input.worldId,
        parentBranchId:
          localParent === undefined
            ? undefined
            : branchId(localParent.branch_id),
        authorityEpoch,
        startedAt,
      });
      this.database
        .prepare(
          `INSERT INTO context_branch_starts(
             branch_id, world_id, base_revision, predecessor_branch_id,
             predecessor_world_id, started_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          branch.branchId,
          branch.worldId,
          head.revision,
          head.branchId,
          head.worldId,
          startedAt,
        );
      const update = this.database
        .prepare(
          `UPDATE context_root_coordinator
           SET active_branch_id = ?, active_world_id = ?, updated_at = ?
           WHERE singleton = 1 AND active_branch_id IS NULL
             AND base_revision = ?
             AND predecessor_branch_id IS ?
             AND predecessor_world_id IS ?`,
        )
        .run(
          branch.branchId,
          branch.worldId,
          startedAt,
          head.revision,
          head.branchId,
          head.worldId,
        );
      if (update.changes !== 1) {
        throw new Error('context root coordinator changed during branch start');
      }
      const start = this.getBranchStart(branch.branchId);
      if (!start) throw new Error('context branch start was not persisted');
      return { branch, start, state: this.getRootCoordinatorState() };
    });
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

  recoverCoordinatedBranch(recoveredAt: number): BranchRecoveryRecord | null {
    const at = timestamp('recoveredAt', recoveredAt);
    return transaction(this.database, () => {
      const state = this.getRootCoordinatorState();
      if (state.activeBranchId === null || state.activeWorldId === null) {
        return null;
      }
      const head = this.getContinuationHead();
      if (
        state.baseRevision !== head.revision ||
        state.predecessorBranchId !== head.branchId ||
        state.predecessorWorldId !== head.worldId
      ) {
        throw new Error(
          'active context branch is detached from continuation head',
        );
      }
      const start = this.getBranchStart(state.activeBranchId);
      if (
        !start ||
        start.worldId !== state.activeWorldId ||
        start.baseRevision !== state.baseRevision ||
        start.predecessorBranchId !== state.predecessorBranchId ||
        start.predecessorWorldId !== state.predecessorWorldId
      ) {
        throw new Error('active context branch start receipt is invalid');
      }
      const branch = this.requireBranch(state.activeBranchId);
      if (branch.status !== 'running') {
        throw new Error(
          `active context branch is not running: ${branch.branchId}`,
        );
      }
      const effects = this.database
        .prepare(
          `UPDATE context_effects
           SET status = 'uncertain', resolved_at = ?, observation_json = NULL
           WHERE branch_id = ? AND status = 'prepared'`,
        )
        .run(at, branch.branchId);
      const uncertainEffects = generation(
        'uncertainEffects',
        Number(effects.changes),
      );
      const crashed = this.database
        .prepare(
          `UPDATE context_branches SET status = 'crashed', ended_at = ?
           WHERE branch_id = ? AND status = 'running'`,
        )
        .run(at, branch.branchId);
      if (crashed.changes !== 1) {
        throw new Error(
          `context branch could not be recovered: ${branch.branchId}`,
        );
      }
      this.database
        .prepare(
          `INSERT INTO context_branch_recoveries(
             branch_id, world_id, base_revision, predecessor_branch_id,
             predecessor_world_id, uncertain_effects, recovered_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          branch.branchId,
          branch.worldId,
          start.baseRevision,
          start.predecessorBranchId,
          start.predecessorWorldId,
          uncertainEffects,
          at,
        );
      const released = this.database
        .prepare(
          `UPDATE context_root_coordinator
           SET active_branch_id = NULL, active_world_id = NULL, updated_at = ?
           WHERE singleton = 1 AND active_branch_id = ?
             AND active_world_id = ? AND base_revision = ?`,
        )
        .run(at, branch.branchId, branch.worldId, start.baseRevision);
      if (released.changes !== 1) {
        throw new Error(
          'context root coordinator could not release crashed branch',
        );
      }
      return {
        ...start,
        uncertainEffects,
        recoveredAt: at,
      };
    });
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

  getManifestProjection(
    id: ManifestId,
    options: { requireActiveShares?: boolean } = {},
  ): ManifestProjection | null {
    const row = this.database
      .prepare(
        `SELECT manifest_id, branch_id, world_id, manifest_hash, manifest_json,
           projection_generation, policy_generation, cache_namespace, created_at
         FROM context_manifests WHERE manifest_id = ?`,
      )
      .get(id) as
      | {
          manifest_id: string;
          branch_id: string;
          world_id: string;
          manifest_hash: string;
          manifest_json: string;
          projection_generation: number;
          policy_generation: number;
          cache_namespace: string;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    let decoded: ViewManifest;
    try {
      const parsed = JSON.parse(row.manifest_json) as ViewManifest;
      decoded = createViewManifest({
        branchId: parsed.branchId,
        worldId: parsed.worldId,
        parentBranchId: parsed.parentBranchId,
        authorityEpoch: parsed.authorityEpoch,
        eventIds: parsed.eventIds,
        sharedEventIds: parsed.sharedEventIds,
        policyGeneration: parsed.policyGeneration,
      });
      if (
        parsed.hash !== decoded.hash ||
        row.manifest_hash !== decoded.hash ||
        row.manifest_json !== serialize(decoded)
      ) {
        throw new Error('canonical manifest bytes do not match');
      }
    } catch (error) {
      throw new Error(`stored context manifest is invalid: ${id}`, {
        cause: error,
      });
    }
    const record: ManifestRecord = {
      manifestId: manifestId(row.manifest_id),
      branchId: branchId(row.branch_id),
      worldId: worldId(row.world_id),
      hash: row.manifest_hash,
      json: row.manifest_json,
      projectionGeneration: row.projection_generation,
      policyGeneration: row.policy_generation,
      cacheNamespace: row.cache_namespace,
      createdAt: row.created_at,
    };
    if (
      decoded.branchId !== record.branchId ||
      decoded.worldId !== record.worldId ||
      decoded.policyGeneration !== record.policyGeneration
    ) {
      throw new Error(`stored context manifest identity is invalid: ${id}`);
    }
    const localEvents = (
      this.database
        .prepare(
          `SELECT events.* FROM context_manifest_events AS edges
           JOIN context_world_events AS events
             ON events.event_id = edges.event_id
            AND events.world_id = edges.world_id
           WHERE edges.manifest_id = ? ORDER BY edges.ordinal`,
        )
        .all(id) as unknown as WorldEventRow[]
    ).map(mapWorldEvent);
    if (
      localEvents.length !== decoded.eventIds.length ||
      localEvents.some(
        (event, ordinal) =>
          event.eventId !== decoded.eventIds[ordinal] ||
          event.worldId !== decoded.worldId,
      )
    ) {
      throw new Error(
        `stored context manifest local events are invalid: ${id}`,
      );
    }
    const shares = (
      this.database
        .prepare(
          `SELECT grants.grant_id, grants.shared_event_id,
             grants.source_capsule_id, grants.source_world_id,
             grants.destination_world_id, grants.canonical_text,
             grants.content_hash, grants.status, grants.authority_epoch
           FROM context_manifest_shares AS edges
           JOIN context_share_grants AS grants
             ON grants.grant_id = edges.grant_id
            AND grants.destination_world_id = edges.destination_world_id
            AND grants.shared_event_id = edges.shared_event_id
           WHERE edges.manifest_id = ? ORDER BY edges.ordinal`,
        )
        .all(id) as {
        grant_id: string;
        shared_event_id: string;
        source_capsule_id: string;
        source_world_id: string;
        destination_world_id: string;
        canonical_text: string;
        content_hash: string;
        status: 'active' | 'revoked';
        authority_epoch: number;
      }[]
    ).map((share): ManifestShareRecord => ({
      grantId: shareGrantId(share.grant_id),
      eventId: eventId(share.shared_event_id),
      sourceCapsuleId: capsuleId(share.source_capsule_id),
      sourceWorldId: worldId(share.source_world_id),
      destinationWorldId: worldId(share.destination_world_id),
      canonicalText: share.canonical_text,
      contentHash: share.content_hash,
      status: share.status,
      authorityEpoch: share.authority_epoch,
    }));
    if (
      shares.length !== decoded.sharedEventIds.length ||
      shares.some(
        (share, ordinal) =>
          share.eventId !== decoded.sharedEventIds[ordinal] ||
          share.destinationWorldId !== decoded.worldId ||
          share.contentHash !== hashContextBytes(share.canonicalText),
      )
    ) {
      throw new Error(`stored context manifest shares are invalid: ${id}`);
    }
    if (
      options.requireActiveShares &&
      shares.some((share) => share.status !== 'active')
    ) {
      throw new Error(`stored context manifest has a revoked share: ${id}`);
    }
    return { record, manifest: decoded, localEvents, shares };
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
    return transaction(this.database, () =>
      this.insertCapsuleInTransaction(input),
    );
  }

  private insertCapsuleInTransaction(input: {
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
    this.database
      .prepare(
        `INSERT INTO context_capsules(
           capsule_id, branch_id, world_id, capsule_kind,
           view_manifest_hash, source_root_hash, policy_generation,
           summarizer_model, summarizer_prompt_hash, content_json,
           content_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    return transaction(this.database, () =>
      this.advanceContinuationHeadInTransaction(
        expectedRevision,
        input.branchId,
        updatedAt,
      ),
    );
  }

  private advanceContinuationHeadInTransaction(
    expectedRevision: number,
    targetBranchId: BranchId,
    updatedAt: number,
  ): ContinuationHead {
    const current = this.getContinuationHead();
    if (current.revision !== expectedRevision) {
      throw new StaleContinuationHeadError(expectedRevision);
    }
    const target = this.requireBranch(targetBranchId);
    if (target.status !== 'yielded') {
      throw new Error(`continuation branch has not yielded: ${targetBranchId}`);
    }
    this.database
      .prepare(
        `INSERT INTO context_continuation_advances(
           revision, predecessor_branch_id, predecessor_world_id,
           branch_id, world_id, advanced_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
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
        `UPDATE context_continuation_head
         SET branch_id = ?, world_id = ?, revision = revision + 1, updated_at = ?
         WHERE singleton = 1 AND revision = ?`,
      )
      .run(target.branchId, target.worldId, updatedAt, expectedRevision);
    if (result.changes !== 1) {
      throw new StaleContinuationHeadError(expectedRevision);
    }
    const coordinator = this.database
      .prepare(
        `UPDATE context_root_coordinator
         SET active_branch_id = NULL, active_world_id = NULL,
           base_revision = ?, predecessor_branch_id = ?,
           predecessor_world_id = ?, updated_at = ?
         WHERE singleton = 1 AND base_revision = ?
           AND predecessor_branch_id IS ?
           AND predecessor_world_id IS ?
           AND (
             active_branch_id IS NULL
             OR (active_branch_id = ? AND active_world_id = ?)
           )`,
      )
      .run(
        expectedRevision + 1,
        target.branchId,
        target.worldId,
        updatedAt,
        expectedRevision,
        current.branchId,
        current.worldId,
        target.branchId,
        target.worldId,
      );
    if (coordinator.changes !== 1) {
      throw new Error('context root coordinator rejected continuation advance');
    }
    return this.getContinuationHead();
  }

  completeCoordinatedBranch(input: {
    branchId: BranchId;
    viewManifestHash: string;
    privateCapsuleId: CapsuleId;
    rootReceiptCapsuleId: CapsuleId;
    sourceRootHash: string;
    privateContent: unknown;
    privateParentCapsuleIds?: readonly CapsuleId[];
    outcome: BranchReturnOutcome;
    commitments: readonly string[];
    blockers: readonly string[];
    artifactRefs: readonly string[];
    endedAt: number;
  }): CoordinatedBranchReturn {
    if (!['completed', 'interrupted', 'failed'].includes(input.outcome)) {
      throw new Error('invalid context branch return outcome');
    }
    const commitments = boundedStrings('commitments', input.commitments);
    const blockers = boundedStrings('blockers', input.blockers);
    const artifactRefs = boundedStrings('artifactRefs', input.artifactRefs);
    const endedAt = timestamp('endedAt', input.endedAt);
    return transaction(this.database, () => {
      const state = this.getRootCoordinatorState();
      const branch = this.requireBranch(input.branchId);
      if (
        state.activeBranchId !== branch.branchId ||
        state.activeWorldId !== branch.worldId
      ) {
        throw new Error(
          `context branch is not coordinator-active: ${branch.branchId}`,
        );
      }
      if (branch.status !== 'running') {
        throw new Error(`context branch is not running: ${branch.branchId}`);
      }
      const start = this.getBranchStart(branch.branchId);
      if (!start) throw new Error('context branch has no start receipt');
      const head = this.getContinuationHead();
      if (
        head.revision !== start.baseRevision ||
        head.branchId !== start.predecessorBranchId ||
        head.worldId !== start.predecessorWorldId ||
        state.baseRevision !== start.baseRevision ||
        state.predecessorBranchId !== start.predecessorBranchId ||
        state.predecessorWorldId !== start.predecessorWorldId
      ) {
        throw new Error(
          'context branch return does not match continuation head',
        );
      }
      const manifest = this.database
        .prepare(
          `SELECT manifest_hash, policy_generation FROM context_manifests
           WHERE branch_id = ? AND world_id = ?`,
        )
        .get(branch.branchId, branch.worldId) as
        { manifest_hash: string; policy_generation: number } | undefined;
      if (!manifest || manifest.manifest_hash !== input.viewManifestHash) {
        throw new Error(
          'context branch return does not match its view manifest',
        );
      }
      const effects = this.database
        .prepare(
          `SELECT effect_id, destination_world_id, effect_kind,
             authority_epoch, payload_hash, status, prepared_at, resolved_at
           FROM context_effects
           WHERE branch_id = ? ORDER BY prepared_at, effect_id`,
        )
        .all(branch.branchId) as {
        effect_id: string;
        destination_world_id: string;
        effect_kind: string;
        authority_epoch: number;
        payload_hash: string;
        status: EffectStatus;
        prepared_at: number;
        resolved_at: number | null;
      }[];
      const effectReceipts: RootReturnEffectReceipt[] = effects.map(
        (effect) => {
          if (effect.status === 'prepared') {
            throw new Error('context branch has a prepared effect');
          }
          if (effect.resolved_at === null) {
            throw new Error('resolved context effect has no resolution time');
          }
          return {
            effectId: effectId(effect.effect_id),
            destinationWorldId: worldId(effect.destination_world_id),
            kind: effect.effect_kind,
            authorityEpoch: effect.authority_epoch,
            payloadHash: effect.payload_hash,
            status: effect.status,
            preparedAt: effect.prepared_at,
            resolvedAt: effect.resolved_at,
          };
        },
      );
      const privateCapsule = this.insertCapsuleInTransaction({
        capsuleId: input.privateCapsuleId,
        branchId: branch.branchId,
        worldId: branch.worldId,
        kind: 'private',
        viewManifestHash: manifest.manifest_hash,
        sourceRootHash: input.sourceRootHash,
        policyGeneration: manifest.policy_generation,
        content: input.privateContent,
        parentCapsuleIds: input.privateParentCapsuleIds,
        createdAt: endedAt,
      });
      const rootContent: RootReturnReceiptV1 = {
        schemaVersion: 1,
        branchId: branch.branchId,
        worldId: branch.worldId,
        viewManifestHash: manifest.manifest_hash,
        outcome: input.outcome,
        authorityEpoch: branch.authorityEpoch,
        privateCapsuleId: privateCapsule.capsuleId,
        effects: effectReceipts,
        commitments,
        blockers,
        artifactRefs,
      };
      const rootReceipt = this.insertCapsuleInTransaction({
        capsuleId: input.rootReceiptCapsuleId,
        branchId: branch.branchId,
        worldId: branch.worldId,
        kind: 'root_receipt',
        viewManifestHash: manifest.manifest_hash,
        sourceRootHash: input.sourceRootHash,
        policyGeneration: manifest.policy_generation,
        content: rootContent,
        createdAt: endedAt,
      });
      const finished = this.finishBranch(branch.branchId, 'yielded', endedAt);
      const advanced = this.advanceContinuationHeadInTransaction(
        start.baseRevision,
        branch.branchId,
        endedAt,
      );
      return {
        branch: finished,
        privateCapsule,
        rootReceipt,
        head: advanced,
      };
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
