import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { LLM_PROXY_PATHS } from '@elpis/gateway-protocol';

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
import {
  SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1,
  SCOPED_RUNTIME_CONTRACT_MIGRATION,
  SCOPED_RUNTIME_CONTRACT_MIGRATION_CHECKSUM,
  type ScopedRuntimeContractArtifactV1,
} from '../context/scoped-system.js';
import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import {
  parseSoul,
  SOUL_PROMPT_SNAPSHOT_MAX_BYTES,
  SOUL_PROMPT_SNAPSHOT_PARSER_GENERATION,
  type PromptFacingSoulSnapshot,
} from './soul.js';
import {
  assertLocalBranchRequestContentFits,
  buildMaterializedLocalBranchRequest,
  type MaterializedLocalBranchRequest,
} from '../context/candidate.js';

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
export type EventMessageProjectionId = ContextId<'EventMessageProjectionId'>;
export type SystemLayerProjectionId = ContextId<'SystemLayerProjectionId'>;
export type SystemLayerApprovalId = ContextId<'SystemLayerApprovalId'>;
export type ResidentIdentitySystemDerivationId =
  ContextId<'ResidentIdentitySystemDerivationId'>;
export type ResidentWorldProfileBindingId =
  ContextId<'ResidentWorldProfileBindingId'>;
export type DarkIsolatedProviderBindingId =
  ContextId<'DarkIsolatedProviderBindingId'>;
export type SystemProfileId = ContextId<'SystemProfileId'>;
export type SystemProfileRequestViewBindingId =
  ContextId<'SystemProfileRequestViewBindingId'>;
export type LocalBranchRequestViewId = ContextId<'LocalBranchRequestViewId'>;
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
export const systemLayerApprovalId = (
  value: string,
): SystemLayerApprovalId =>
  branded<'SystemLayerApprovalId'>(
    'systemLayerApprovalId',
    value,
    'system-layer-approval:',
  );
export const residentIdentitySystemDerivationId = (
  value: string,
): ResidentIdentitySystemDerivationId =>
  branded<'ResidentIdentitySystemDerivationId'>(
    'residentIdentitySystemDerivationId',
    value,
    'resident-identity-derivation:',
  );
export const residentWorldProfileBindingId = (
  value: string,
): ResidentWorldProfileBindingId =>
  branded<'ResidentWorldProfileBindingId'>(
    'residentWorldProfileBindingId',
    value,
    'resident-world-profile-binding:',
  );
export const darkIsolatedProviderBindingId = (
  value: string,
): DarkIsolatedProviderBindingId =>
  branded<'DarkIsolatedProviderBindingId'>(
    'darkIsolatedProviderBindingId',
    value,
    'dark-isolated-provider-binding:',
  );
export const systemProfileId = (value: string): SystemProfileId =>
  branded<'SystemProfileId'>('systemProfileId', value, 'system-profile:');
export const systemProfileRequestViewBindingId = (
  value: string,
): SystemProfileRequestViewBindingId =>
  branded<'SystemProfileRequestViewBindingId'>(
    'systemProfileRequestViewBindingId',
    value,
    'profile-view-binding:',
  );
export const localBranchRequestViewId = (
  value: string,
): LocalBranchRequestViewId =>
  branded<'LocalBranchRequestViewId'>(
    'localBranchRequestViewId',
    value,
    'branch-request-view:',
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

export type DarkIngressWakeClass = 'text_user_turn';

export interface DarkIngressGenerationRecord {
  readonly queueGeneration: number;
  readonly firstAdmissibleSequence: number;
  readonly activationEpoch: number;
}

export interface DarkIngressAdmissionRecord {
  readonly eventId: EventId;
  readonly worldId: WorldId;
  readonly sourceSequence: number;
  readonly activationEpoch: number;
  readonly queueGeneration: number;
  readonly wakeClass: DarkIngressWakeClass;
  readonly messageRendererGeneration: number;
  readonly admittedAt: number;
}

export interface DarkInboundAdmissionReceipt {
  readonly generation: DarkIngressGenerationRecord;
  readonly event: WorldEventRecord;
  readonly admission: DarkIngressAdmissionRecord;
}

export interface DarkPendingInspectionItem {
  readonly eventId: EventId;
  readonly sourceSequence: number;
  readonly projectionId: EventMessageProjectionId;
}

export type DarkPendingInspection =
  | { readonly status: 'empty' }
  | {
      readonly status: 'blocked';
      readonly reason: 'activation_mismatch';
      readonly expectedActivationEpoch: number;
      readonly actualMode: ContextGraphMode;
      readonly actualActivationEpoch: number;
    }
  | {
      readonly status: 'blocked';
      readonly reason: 'generation_mismatch';
      readonly eventId: EventId;
      readonly worldId: WorldId;
      readonly sourceSequence: number;
      readonly expectedActivationEpoch: number;
      readonly actualActivationEpoch: number;
      readonly expectedQueueGeneration: number;
      readonly actualQueueGeneration: number;
    }
  | {
      readonly status: 'blocked';
      readonly reason: 'projection_unavailable';
      readonly eventId: EventId;
      readonly worldId: WorldId;
      readonly sourceSequence: number;
      readonly messageRendererGeneration: number;
    }
  | {
      readonly status: 'ready';
      readonly worldId: WorldId;
      readonly messageRendererGeneration: number;
      readonly items: readonly DarkPendingInspectionItem[];
      readonly stopReason:
        | 'end'
        | 'limit'
        | 'world_boundary'
        | 'renderer_boundary'
        | 'generation_boundary'
        | 'projection_unavailable';
    };

export interface DarkPendingBranchAttemptRecord {
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly requestViewId: LocalBranchRequestViewId;
  readonly activationEpoch: number;
  readonly queueGeneration: number;
  readonly maxEvents: number;
  readonly selectedCount: number;
  readonly firstSourceSequence: number;
  readonly lastSourceSequence: number;
  readonly assembledAt: number;
}

export interface DarkPendingBranchAbandonmentRecord {
  readonly branchId: BranchId;
  readonly abandonedAt: number;
  readonly reason: 'coordinator_recovery';
}

export type DarkPendingBranchAssemblyResult =
  | Exclude<DarkPendingInspection, { readonly status: 'ready' }>
  | {
      readonly status: 'assembled';
      readonly attempt: DarkPendingBranchAttemptRecord;
      readonly assembly: DarkLocalBranchAssemblyRecord;
    };

export interface ResidentCurrentWorldDarkRequestRecord {
  readonly currentEvent: WorldEventRecord;
  readonly admission: DarkIngressAdmissionRecord;
  readonly residentProfileBinding: ResidentWorldProfileBindingV1;
  readonly attempt: DarkPendingBranchAttemptRecord;
  readonly assembly: DarkLocalBranchAssemblyRecord;
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

export type SystemLayerApprovalRole =
  | 'scoped_runtime_contract'
  | 'identity'
  | 'integrated_self'
  | 'world_policy';
export type SystemLayerApprovalBasisKind =
  | 'authored_scoped_contract'
  | 'soul_snapshot'
  | 'accepted_self_delta'
  | 'routing_policy';

export interface SystemLayerApprovalRecord {
  readonly approvalId: SystemLayerApprovalId;
  readonly layerId: SystemLayerProjectionId;
  readonly role: SystemLayerApprovalRole;
  readonly basisKind: SystemLayerApprovalBasisKind;
  readonly basisRef: string;
  readonly basisHash: string;
  readonly approvalGeneration: number;
  readonly approvedAt: number;
}

export interface SystemProfileV1 {
  readonly schemaVersion: 1;
  readonly worldId: WorldId;
  readonly activationEpoch: number;
  readonly systemRendererGeneration: number;
  readonly policyGeneration: number;
  readonly approvals: {
    readonly scopedRuntimeContract: SystemLayerApprovalId;
    readonly identity: SystemLayerApprovalId;
    readonly integratedSelf: SystemLayerApprovalId | null;
    readonly worldPolicy: SystemLayerApprovalId | null;
  };
}

export interface SystemProfileRecord {
  readonly profileId: SystemProfileId;
  readonly profile: SystemProfileV1;
  readonly profileJson: string;
  readonly profileHash: string;
  readonly createdAt: number;
}

export interface SystemProfileHead {
  readonly worldId: WorldId;
  readonly activationEpoch: number;
  readonly revision: number;
  readonly predecessorProfileId: SystemProfileId | null;
  readonly profileId: SystemProfileId;
  readonly advancedAt: number;
}

export interface SystemProfileRequestViewBindingV1 {
  readonly schemaVersion: 1;
  readonly requestViewId: LocalBranchRequestViewId;
  readonly requestViewHash: string;
  readonly worldId: WorldId;
  readonly activationEpoch: number;
  readonly profileId: SystemProfileId;
  readonly profileHash: string;
  readonly profileHeadRevision: number;
  readonly boundAt: number;
}

export interface SystemProfileRequestViewBindingRecord {
  readonly bindingId: SystemProfileRequestViewBindingId;
  readonly binding: SystemProfileRequestViewBindingV1;
  readonly bindingJson: string;
  readonly bindingHash: string;
}

export interface LocalBranchRequestViewV1 {
  readonly schemaVersion: 1;
  readonly executionMode: 'dark';
  readonly scope: 'local-only';
  readonly runnable: false;
  readonly toolMode: 'none';
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly manifestId: ManifestId;
  readonly manifestHash: string;
  readonly messageRendererGeneration: number;
  readonly systemRendererGeneration: number;
  readonly policyGeneration: number;
  readonly systemLayerProjectionIds: readonly SystemLayerProjectionId[];
  readonly messageProjectionIds: readonly EventMessageProjectionId[];
}

export interface LocalBranchRequestViewRecord {
  readonly requestViewId: LocalBranchRequestViewId;
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly manifestId: ManifestId;
  readonly manifestHash: string;
  readonly view: LocalBranchRequestViewV1;
  readonly viewJson: string;
  readonly viewHash: string;
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

export interface DarkLocalBranchAssemblyRecord {
  readonly branch: BranchRecord;
  readonly start: BranchStartRecord;
  readonly manifest: ManifestRecord;
  readonly requestView: LocalBranchRequestViewRecord;
  readonly profileBinding: SystemProfileRequestViewBindingRecord;
  readonly request: MaterializedLocalBranchRequest;
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

export interface ResidentSoulSourceSnapshotV1 {
  readonly snapshotId: string;
  readonly schemaVersion: 1;
  readonly parserGeneration: number;
  readonly sourceFile: string;
  readonly sourceFileHash: string;
  readonly sourceFileBytes: number;
  readonly body: string;
  readonly bodyHash: string;
  readonly bodyBytes: number;
  readonly capturedAt: number;
}

export interface ResidentSourceInspectionCandidateV1 {
  readonly candidateId: string;
  readonly schemaVersion: 1;
  readonly scopeKind: 'private_integrated_self_candidate';
  readonly executionContext: 'legacy_monocontext_resident';
  readonly activationEpoch: number;
  readonly contractArtifactId: string;
  readonly contractMigrationChecksum: string;
  readonly contractContentHash: string;
  readonly contractContentBytes: number;
  readonly soulSnapshotId: string;
  readonly inspectBatchId: string;
  readonly inspectBatchSha256: string;
  readonly inspectCallIndex: number;
  readonly inspectCallCount: number;
  readonly inspectToolName: 'run';
  readonly inspectArgumentsSha256: string;
  readonly observedAt: number;
}

export interface ResidentSourceInspectionCaptureV1 {
  readonly soul: ResidentSoulSourceSnapshotV1;
  readonly candidate: ResidentSourceInspectionCandidateV1;
}

export interface ResidentSourceCandidateAuthorizationV1 {
  readonly authorizationId: string;
  readonly schemaVersion: 1;
  readonly authorizationKind: 'resident_source_candidate';
  readonly scopeKind: 'private_integrated_self_source';
  readonly executionContext: 'legacy_monocontext_resident';
  readonly candidateId: string;
  readonly activationEpoch: number;
  readonly contractArtifactId: string;
  readonly contractMigrationChecksum: string;
  readonly contractContentHash: string;
  readonly contractContentBytes: number;
  readonly soulSnapshotId: string;
  readonly authorizeBatchId: string;
  readonly authorizeBatchSha256: string;
  readonly authorizeCallIndex: number;
  readonly authorizeCallCount: number;
  readonly authorizeToolName: 'run';
  readonly authorizeArgumentsSha256: string;
  readonly authorizedAt: number;
}

export interface ResidentIdentitySystemDerivationV1 {
  readonly derivationId: ResidentIdentitySystemDerivationId;
  readonly schemaVersion: 1;
  readonly derivationKind: 'authorized_resident_identity_layers';
  readonly activationEpoch: number;
  readonly authorityRevision: number;
  readonly predecessorDerivationId: ResidentIdentitySystemDerivationId | null;
  readonly authorizationId: string;
  readonly contractArtifactId: string;
  readonly soulSnapshotId: string;
  readonly contractLayerId: SystemLayerProjectionId;
  readonly contractApprovalId: SystemLayerApprovalId;
  readonly identityLayerId: SystemLayerProjectionId;
  readonly identityApprovalId: SystemLayerApprovalId;
  readonly deriveBatchId: string;
  readonly deriveBatchSha256: string;
  readonly deriveCallIndex: number;
  readonly deriveCallCount: number;
  readonly deriveToolName: 'run';
  readonly deriveArgumentsSha256: string;
  readonly derivedAt: number;
}

export interface ResidentWorldProfileBindingV1 {
  readonly bindingId: ResidentWorldProfileBindingId;
  readonly schemaVersion: 1;
  readonly bindingKind: 'resident_current_world_profile';
  readonly activationEpoch: number;
  readonly derivationId: ResidentIdentitySystemDerivationId;
  readonly worldId: WorldId;
  readonly ingressEventId: EventId;
  readonly ingressSequence: number;
  readonly profileId: SystemProfileId;
  readonly profileHash: string;
  readonly profileHeadRevision: 1;
  readonly predecessorProfileId: null;
  readonly bindBatchId: string;
  readonly bindBatchSha256: string;
  readonly bindCallIndex: number;
  readonly bindCallCount: number;
  readonly bindToolName: 'run';
  readonly bindArgumentsSha256: string;
  readonly boundAt: number;
}

export interface ExactIsolatedProviderTargetV1 {
  readonly schemaVersion: 1;
  readonly role: 'main';
  readonly targetRef: string;
  readonly providerType:
    | 'openai-compatible'
    | 'anthropic-oauth'
    | 'codex-oauth';
  readonly model: string;
  readonly apiSurface:
    | 'responses'
    | 'chat-completions'
    | 'anthropic-messages'
    | 'codex-responses';
  readonly apiEndpoint: string;
  readonly gateway: null | {
    readonly authority: string;
    readonly modelRef: string;
    readonly targetGeneration: string;
  };
  readonly reasoningEffort: string | null;
  readonly reasoningSummary: string | null;
  readonly reasoningContext: string | null;
  readonly externalThinking: boolean;
  readonly toolContractVersion: string;
  readonly wireContractGeneration: 1;
}

export interface DarkIsolatedProviderBindingV1 {
  readonly schemaVersion: 1;
  readonly executionMode: 'dark';
  readonly runnable: false;
  readonly networkAuthority: 'none';
  readonly toolMode: 'none';
  readonly historicalToolMessages: false;
  readonly activationEpoch: number;
  readonly branchId: BranchId;
  readonly worldId: WorldId;
  readonly authorityEpoch: number;
  readonly residentProfileBindingId: ResidentWorldProfileBindingId;
  readonly requestProfileBindingId: SystemProfileRequestViewBindingId;
  readonly requestProfileBindingHash: string;
  readonly profileId: SystemProfileId;
  readonly profileHash: string;
  readonly profileHeadRevision: number;
  readonly manifestId: ManifestId;
  readonly manifestHash: string;
  readonly requestViewId: LocalBranchRequestViewId;
  readonly requestViewHash: string;
  readonly candidateHash: string;
  readonly candidateBytes: number;
  readonly target: ExactIsolatedProviderTargetV1;
  readonly targetHash: string;
  readonly laneKind: 'isolated-standalone';
  readonly cacheNamespace: string;
  readonly bindBatchId: string;
  readonly bindBatchSha256: string;
  readonly bindCallIndex: number;
  readonly bindCallCount: number;
  readonly bindToolName: 'run';
  readonly bindArgumentsSha256: string;
  readonly boundAt: number;
}

export interface DarkIsolatedProviderBindingRecord {
  readonly bindingId: DarkIsolatedProviderBindingId;
  readonly binding: DarkIsolatedProviderBindingV1;
  readonly targetJson: string;
  readonly targetHash: string;
  readonly bindingJson: string;
  readonly bindingHash: string;
}

export class StaleContinuationHeadError extends Error {
  constructor(expectedRevision: number) {
    super(`continuation head is not at revision ${expectedRevision}`);
    this.name = 'StaleContinuationHeadError';
  }
}

export class StaleSystemProfileHeadError extends Error {
  constructor(expectedRevision: number) {
    super(`system profile head is not at revision ${expectedRevision}`);
    this.name = 'StaleSystemProfileHeadError';
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

function residentSoulSnapshotId(input: {
  parserGeneration: number;
  sourceFileHash: string;
  sourceFileBytes: number;
  bodyHash: string;
  bodyBytes: number;
}): string {
  return `resident-soul-snapshot:${hashContextBytes(
    serialize({
      schemaVersion: 1,
      parserGeneration: input.parserGeneration,
      sourceFileHash: input.sourceFileHash,
      sourceFileBytes: input.sourceFileBytes,
      bodyHash: input.bodyHash,
      bodyBytes: input.bodyBytes,
    }),
  )}`;
}

function residentSourceCandidateId(input: {
  activationEpoch: number;
  soulSnapshotId: string;
  provenance: ResidentToolCallSnapshotV1;
}): string {
  return `resident-source-candidate:${hashContextBytes(
    serialize({
      schemaVersion: 1,
      scopeKind: 'private_integrated_self_candidate',
      executionContext: 'legacy_monocontext_resident',
      activationEpoch: input.activationEpoch,
      contractArtifactId: SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.artifactId,
      contractMigrationChecksum: SCOPED_RUNTIME_CONTRACT_MIGRATION_CHECKSUM,
      contractContentHash: SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.contentHash,
      contractContentBytes: SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.contentBytes,
      soulSnapshotId: input.soulSnapshotId,
      inspectBatchId: input.provenance.batchId,
      inspectBatchSha256: input.provenance.batchSha256,
      inspectCallIndex: input.provenance.callIndex,
      inspectCallCount: input.provenance.callCount,
      inspectToolName: input.provenance.toolName,
      inspectArgumentsSha256: input.provenance.argumentsSha256,
    }),
  )}`;
}

function residentSourceAuthorizationId(input: {
  candidate: ResidentSourceInspectionCandidateV1;
  provenance: ResidentToolCallSnapshotV1;
}): string {
  return `resident-source-authorization:${hashContextBytes(
    serialize({
      schemaVersion: 1,
      authorizationKind: 'resident_source_candidate',
      scopeKind: 'private_integrated_self_source',
      executionContext: 'legacy_monocontext_resident',
      candidateId: input.candidate.candidateId,
      activationEpoch: input.candidate.activationEpoch,
      contractArtifactId: input.candidate.contractArtifactId,
      contractMigrationChecksum: input.candidate.contractMigrationChecksum,
      contractContentHash: input.candidate.contractContentHash,
      contractContentBytes: input.candidate.contractContentBytes,
      soulSnapshotId: input.candidate.soulSnapshotId,
      authorizeBatchId: input.provenance.batchId,
      authorizeBatchSha256: input.provenance.batchSha256,
      authorizeCallIndex: input.provenance.callIndex,
      authorizeCallCount: input.provenance.callCount,
      authorizeToolName: input.provenance.toolName,
      authorizeArgumentsSha256: input.provenance.argumentsSha256,
    }),
  )}`;
}

function residentIdentitySystemDerivationIdentity(input: {
  activationEpoch: number;
  authorityRevision: number;
  predecessorDerivationId: ResidentIdentitySystemDerivationId | null;
  authorizationId: string;
  contractArtifactId: string;
  soulSnapshotId: string;
  contractLayerId: SystemLayerProjectionId;
  contractApprovalId: SystemLayerApprovalId;
  identityLayerId: SystemLayerProjectionId;
  identityApprovalId: SystemLayerApprovalId;
  provenance: ResidentToolCallSnapshotV1;
}): ResidentIdentitySystemDerivationId {
  return residentIdentitySystemDerivationId(
    `resident-identity-derivation:${hashContextBytes(
      serialize({
        schemaVersion: 1,
        derivationKind: 'authorized_resident_identity_layers',
        activationEpoch: input.activationEpoch,
        authorityRevision: input.authorityRevision,
        predecessorDerivationId: input.predecessorDerivationId,
        authorizationId: input.authorizationId,
        contractArtifactId: input.contractArtifactId,
        soulSnapshotId: input.soulSnapshotId,
        contractLayerId: input.contractLayerId,
        contractApprovalId: input.contractApprovalId,
        identityLayerId: input.identityLayerId,
        identityApprovalId: input.identityApprovalId,
        deriveBatchId: input.provenance.batchId,
        deriveBatchSha256: input.provenance.batchSha256,
        deriveCallIndex: input.provenance.callIndex,
        deriveCallCount: input.provenance.callCount,
        deriveToolName: input.provenance.toolName,
        deriveArgumentsSha256: input.provenance.argumentsSha256,
      }),
    )}`,
  );
}

function residentWorldProfileBindingIdentity(input: {
  activationEpoch: number;
  derivationId: ResidentIdentitySystemDerivationId;
  worldId: WorldId;
  ingressEventId: EventId;
  ingressSequence: number;
  profileId: SystemProfileId;
  profileHash: string;
  profileHeadRevision: 1;
  predecessorProfileId: null;
  provenance: ResidentToolCallSnapshotV1;
}): ResidentWorldProfileBindingId {
  return residentWorldProfileBindingId(
    `resident-world-profile-binding:${hashContextBytes(
      serialize({
        schemaVersion: 1,
        bindingKind: 'resident_current_world_profile',
        activationEpoch: input.activationEpoch,
        derivationId: input.derivationId,
        worldId: input.worldId,
        ingressEventId: input.ingressEventId,
        ingressSequence: input.ingressSequence,
        profileId: input.profileId,
        profileHash: input.profileHash,
        profileHeadRevision: input.profileHeadRevision,
        predecessorProfileId: input.predecessorProfileId,
        bindBatchId: input.provenance.batchId,
        bindBatchSha256: input.provenance.batchSha256,
        bindCallIndex: input.provenance.callIndex,
        bindCallCount: input.provenance.callCount,
        bindToolName: input.provenance.toolName,
        bindArgumentsSha256: input.provenance.argumentsSha256,
      }),
    )}`,
  );
}

function boundedProviderText(label: string, value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export function normalizeExactIsolatedProviderTarget(
  input: ExactIsolatedProviderTargetV1,
): ExactIsolatedProviderTargetV1 {
  if (
    input.schemaVersion !== 1 ||
    input.role !== 'main' ||
    input.wireContractGeneration !== 1 ||
    typeof input.externalThinking !== 'boolean'
  ) {
    throw new Error('isolated provider target contract is invalid');
  }
  const providerType = input.providerType;
  const apiSurface = input.apiSurface;
  if (
    !(
      (providerType === 'openai-compatible' &&
        ['responses', 'chat-completions'].includes(apiSurface)) ||
      (providerType === 'anthropic-oauth' && apiSurface === 'anthropic-messages') ||
      (providerType === 'codex-oauth' && apiSurface === 'codex-responses')
    )
  ) {
    throw new Error('isolated provider target surface is incompatible');
  }
  const targetRef = boundedProviderText('isolated provider targetRef', input.targetRef, 512);
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(targetRef)) {
    throw new Error('isolated provider targetRef is not canonical');
  }
  const model = boundedProviderText('isolated provider model', input.model, 512);
  const endpointText = boundedProviderText(
    'isolated provider apiEndpoint',
    input.apiEndpoint,
    2048,
  );
  const endpoint = new URL(endpointText);
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.search !== '' ||
    endpoint.hash !== '' ||
    endpoint.href !== endpointText
  ) {
    throw new Error('isolated provider endpoint is not canonical');
  }
  const optional = (label: string, value: string | null): string | null =>
    value === null ? null : boundedProviderText(label, value, 512);
  let gateway: ExactIsolatedProviderTargetV1['gateway'] = null;
  if (input.gateway !== null) {
    const authority = boundedProviderText(
      'isolated provider gateway authority',
      input.gateway.authority,
      2048,
    );
    const authorityUrl = new URL(authority);
    const modelRef = boundedProviderText(
      'isolated provider gateway modelRef',
      input.gateway.modelRef,
      512,
    );
    const targetGeneration = boundedProviderText(
      'isolated provider gateway targetGeneration',
      input.gateway.targetGeneration,
      128,
    );
    const generationMatch = /^egt1\.([A-Za-z0-9_-]{22})$/.exec(targetGeneration);
    const generationBytes = generationMatch
      ? Buffer.from(generationMatch[1], 'base64url')
      : null;
    if (
      authorityUrl.protocol !== 'https:' ||
      authorityUrl.username !== '' ||
      authorityUrl.password !== '' ||
      authorityUrl.pathname !== '/' ||
      authorityUrl.search !== '' ||
      authorityUrl.hash !== '' ||
      authorityUrl.href !== authorityUrl.origin + '/' ||
      endpoint.href !== new URL(LLM_PROXY_PATHS.request, authority).href ||
      modelRef !== targetRef ||
      generationBytes === null ||
      generationBytes.byteLength !== 16 ||
      generationBytes.toString('base64url') !== generationMatch![1]
    ) {
      throw new Error('isolated provider Gateway target is not canonical');
    }
    gateway = Object.freeze({ authority, modelRef, targetGeneration });
  }
  return Object.freeze({
    schemaVersion: 1,
    role: 'main',
    targetRef,
    providerType,
    model,
    apiSurface,
    apiEndpoint: endpointText,
    gateway,
    reasoningEffort: optional(
      'isolated provider reasoningEffort',
      input.reasoningEffort,
    ),
    reasoningSummary: optional(
      'isolated provider reasoningSummary',
      input.reasoningSummary,
    ),
    reasoningContext: optional(
      'isolated provider reasoningContext',
      input.reasoningContext,
    ),
    externalThinking: input.externalThinking,
    toolContractVersion: boundedProviderText(
      'isolated provider toolContractVersion',
      input.toolContractVersion,
      512,
    ),
    wireContractGeneration: 1,
  });
}

function darkIsolatedProviderBindingIdentity(
  bindingJson: string,
): DarkIsolatedProviderBindingId {
  return darkIsolatedProviderBindingId(
    `dark-isolated-provider-binding:${hashContextBytes(bindingJson)}`,
  );
}

function isolatedProviderCacheNamespace(input: {
  manifestCacheNamespace: string;
  requestViewHash: string;
  targetHash: string;
}): string {
  return `context-dark:${hashContextBytes(serialize(input))}`;
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
  if (
    typeof value !== 'string' ||
    !SYSTEM_LAYER_KINDS.has(value as SystemLayerKind)
  ) {
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

const SYSTEM_LAYER_APPROVAL_RULES: Readonly<
  Record<
    SystemLayerApprovalRole,
    {
      readonly basisKind: SystemLayerApprovalBasisKind;
      readonly kind: SystemLayerKind;
      readonly visibility: SystemLayerVisibility;
      readonly worldScoped: boolean;
      readonly sourceKind: string;
    }
  >
> = Object.freeze({
  scoped_runtime_contract: Object.freeze({
    basisKind: 'authored_scoped_contract',
    kind: 'runtime_contract',
    visibility: 'global_contract',
    worldScoped: false,
    sourceKind: 'authored_scoped_contract',
  }),
  identity: Object.freeze({
    basisKind: 'soul_snapshot',
    kind: 'identity',
    visibility: 'integrated_self',
    worldScoped: false,
    sourceKind: 'soul_snapshot',
  }),
  integrated_self: Object.freeze({
    basisKind: 'accepted_self_delta',
    kind: 'integrated_self',
    visibility: 'integrated_self',
    worldScoped: false,
    sourceKind: 'accepted_self_delta',
  }),
  world_policy: Object.freeze({
    basisKind: 'routing_policy',
    kind: 'world_policy',
    visibility: 'world',
    worldScoped: true,
    sourceKind: 'routing_policy',
  }),
});

function systemLayerApprovalRole(value: unknown): SystemLayerApprovalRole {
  if (
    typeof value !== 'string' ||
    !Object.hasOwn(SYSTEM_LAYER_APPROVAL_RULES, value)
  ) {
    throw new Error('system layer approval role is invalid');
  }
  return value as SystemLayerApprovalRole;
}

function systemLayerApprovalBasisKind(
  value: unknown,
): SystemLayerApprovalBasisKind {
  if (
    typeof value !== 'string' ||
    !Object.values(SYSTEM_LAYER_APPROVAL_RULES).some(
      (rule) => rule.basisKind === value,
    )
  ) {
    throw new Error('system layer approval basis kind is invalid');
  }
  return value as SystemLayerApprovalBasisKind;
}

function systemLayerApprovalBasisRef(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('system layer approval basis ref is invalid');
  }
  return value;
}

function systemLayerApprovalMatches(
  layer: SystemLayerProjectionRecord,
  role: SystemLayerApprovalRole,
): boolean {
  const rule = SYSTEM_LAYER_APPROVAL_RULES[role];
  return (
    layer.kind === rule.kind &&
    layer.visibility === rule.visibility &&
    (layer.worldId !== null) === rule.worldScoped &&
    layer.sourceKind === rule.sourceKind
  );
}

function systemLayerApprovalIdentity(input: {
  layerId: SystemLayerProjectionId;
  role: SystemLayerApprovalRole;
  basisKind: SystemLayerApprovalBasisKind;
  basisRef: string;
  basisHash: string;
  approvalGeneration: number;
}): SystemLayerApprovalId {
  const hash = hashContextBytes(serialize({ schemaVersion: 1, ...input }));
  return systemLayerApprovalId(`system-layer-approval:${hash}`);
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
  const hash = hashContextBytes(serialize({ schemaVersion: 1, ...input }));
  return systemLayerProjectionId(`system-layer:${hash}`);
}

function normalizeSystemProfile(value: unknown): SystemProfileV1 {
  const profile = shadowPlanObject(value, 'system profile');
  exactShadowPlanKeys(
    profile,
    [
      'schemaVersion',
      'worldId',
      'activationEpoch',
      'systemRendererGeneration',
      'policyGeneration',
      'approvals',
    ],
    'system profile',
  );
  const approvals = shadowPlanObject(profile.approvals, 'system profile approvals');
  exactShadowPlanKeys(
    approvals,
    ['scopedRuntimeContract', 'identity', 'integratedSelf', 'worldPolicy'],
    'system profile approvals',
  );
  if (profile.schemaVersion !== 1 || !isWorldId(profile.worldId)) {
    throw new Error('system profile identity is invalid');
  }
  const activationEpoch = generation(
    'activationEpoch',
    profile.activationEpoch as number,
  );
  const systemRendererGeneration = generation(
    'systemRendererGeneration',
    profile.systemRendererGeneration as number,
  );
  const policyGeneration = generation(
    'policyGeneration',
    profile.policyGeneration as number,
  );
  if (systemRendererGeneration < 1 || policyGeneration < 1) {
    throw new Error('system profile generations are invalid');
  }
  return {
    schemaVersion: 1,
    worldId: worldId(profile.worldId),
    activationEpoch,
    systemRendererGeneration,
    policyGeneration,
    approvals: {
      scopedRuntimeContract: systemLayerApprovalId(
        String(approvals.scopedRuntimeContract),
      ),
      identity: systemLayerApprovalId(String(approvals.identity)),
      integratedSelf:
        approvals.integratedSelf === null
          ? null
          : systemLayerApprovalId(String(approvals.integratedSelf)),
      worldPolicy:
        approvals.worldPolicy === null
          ? null
          : systemLayerApprovalId(String(approvals.worldPolicy)),
    },
  };
}

function systemProfileIdentity(profile: SystemProfileV1): SystemProfileId {
  return systemProfileId(
    `system-profile:${hashContextBytes(serialize(profile))}`,
  );
}

function normalizeSystemProfileRequestViewBinding(
  value: unknown,
): SystemProfileRequestViewBindingV1 {
  const binding = shadowPlanObject(
    value,
    'system profile request view binding',
  );
  exactShadowPlanKeys(
    binding,
    [
      'schemaVersion',
      'requestViewId',
      'requestViewHash',
      'worldId',
      'activationEpoch',
      'profileId',
      'profileHash',
      'profileHeadRevision',
      'boundAt',
    ],
    'system profile request view binding',
  );
  if (
    binding.schemaVersion !== 1 ||
    typeof binding.requestViewId !== 'string' ||
    typeof binding.requestViewHash !== 'string' ||
    !isWorldId(binding.worldId) ||
    typeof binding.profileId !== 'string' ||
    typeof binding.profileHash !== 'string'
  ) {
    throw new Error('system profile request view binding identity is invalid');
  }
  const activationEpoch = generation(
    'activationEpoch',
    binding.activationEpoch as number,
  );
  const profileHeadRevision = generation(
    'profileHeadRevision',
    binding.profileHeadRevision as number,
  );
  if (profileHeadRevision < 1) {
    throw new Error('system profile request view binding revision is invalid');
  }
  return {
    schemaVersion: 1,
    requestViewId: localBranchRequestViewId(binding.requestViewId),
    requestViewHash: sha256('requestViewHash', binding.requestViewHash),
    worldId: worldId(binding.worldId),
    activationEpoch,
    profileId: systemProfileId(binding.profileId),
    profileHash: sha256('profileHash', binding.profileHash),
    profileHeadRevision,
    boundAt: timestamp('boundAt', binding.boundAt as number),
  };
}

function systemProfileRequestViewBindingIdentity(
  binding: SystemProfileRequestViewBindingV1,
): SystemProfileRequestViewBindingId {
  return systemProfileRequestViewBindingId(
    `profile-view-binding:${hashContextBytes(serialize(binding))}`,
  );
}

function normalizeLocalBranchRequestView(
  value: unknown,
): LocalBranchRequestViewV1 {
  const view = shadowPlanObject(value, 'local branch request view');
  exactShadowPlanKeys(
    view,
    [
      'schemaVersion',
      'executionMode',
      'scope',
      'runnable',
      'toolMode',
      'branchId',
      'worldId',
      'manifestId',
      'manifestHash',
      'messageRendererGeneration',
      'systemRendererGeneration',
      'policyGeneration',
      'systemLayerProjectionIds',
      'messageProjectionIds',
    ],
    'local branch request view',
  );
  if (
    view.schemaVersion !== 1 ||
    view.executionMode !== 'dark' ||
    view.scope !== 'local-only' ||
    view.runnable !== false ||
    view.toolMode !== 'none' ||
    !isBranchId(view.branchId) ||
    !isWorldId(view.worldId) ||
    typeof view.manifestId !== 'string' ||
    typeof view.manifestHash !== 'string'
  ) {
    throw new Error('local branch request view identity is invalid');
  }
  const normalizedManifestId = manifestId(view.manifestId);
  const manifestHash = sha256('manifestHash', view.manifestHash);
  const messageRendererGeneration = generation(
    'messageRendererGeneration',
    view.messageRendererGeneration as number,
  );
  const systemRendererGeneration = generation(
    'systemRendererGeneration',
    view.systemRendererGeneration as number,
  );
  const policyGeneration = generation(
    'policyGeneration',
    view.policyGeneration as number,
  );
  if (
    messageRendererGeneration < 1 ||
    systemRendererGeneration < 1 ||
    policyGeneration < 1 ||
    !Array.isArray(view.systemLayerProjectionIds) ||
    view.systemLayerProjectionIds.length < 1 ||
    view.systemLayerProjectionIds.length > 64 ||
    !Array.isArray(view.messageProjectionIds) ||
    view.messageProjectionIds.length > 4096
  ) {
    throw new Error('local branch request view metadata is invalid');
  }
  const systemLayerProjectionIds = view.systemLayerProjectionIds.map((id) =>
    systemLayerProjectionId(String(id)),
  );
  const messageProjectionIds = view.messageProjectionIds.map((id) =>
    eventMessageProjectionId(String(id)),
  );
  if (
    new Set(systemLayerProjectionIds).size !==
      systemLayerProjectionIds.length ||
    new Set(messageProjectionIds).size !== messageProjectionIds.length
  ) {
    throw new Error('local branch request view references must be unique');
  }
  return {
    schemaVersion: 1,
    executionMode: 'dark',
    scope: 'local-only',
    runnable: false,
    toolMode: 'none',
    branchId: branchId(view.branchId),
    worldId: worldId(view.worldId),
    manifestId: normalizedManifestId,
    manifestHash,
    messageRendererGeneration,
    systemRendererGeneration,
    policyGeneration,
    systemLayerProjectionIds,
    messageProjectionIds,
  };
}

function localBranchRequestViewIdentity(
  view: LocalBranchRequestViewV1,
): LocalBranchRequestViewId {
  return localBranchRequestViewId(
    `branch-request-view:${hashContextBytes(serialize(view))}`,
  );
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
  const localProjectionIds = isV2 || isV3 ? plan.localMessageProjectionIds : [];
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
      (plan.blockers.includes('render_projection_mismatch') &&
        !saysIncomplete) ||
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

interface DarkIngressGenerationRow {
  queue_generation: number;
  first_admissible_sequence: number;
  activation_epoch: number;
}

interface DarkIngressAdmissionRow {
  event_id: string;
  world_id: string;
  source_sequence: number;
  activation_epoch: number;
  queue_generation: number;
  wake_class: string;
  message_renderer_generation: number;
  admitted_at: number;
}

interface DarkPendingInspectionRow extends DarkIngressAdmissionRow {
  projection_id: string | null;
  projection_source_event_id: string | null;
  projection_world_id: string | null;
  projection_renderer_generation: number | null;
}

interface DarkPendingBranchAttemptRow {
  branch_id: string;
  world_id: string;
  request_view_id: string;
  activation_epoch: number;
  queue_generation: number;
  max_events: number;
  selected_count: number;
  first_source_sequence: number;
  last_source_sequence: number;
  assembled_at: number;
}

interface DarkPendingBranchAbandonmentRow {
  branch_id: string;
  abandoned_at: number;
  reason: string;
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

interface ResidentSoulSourceSnapshotRow {
  snapshot_id: string;
  schema_version: number;
  parser_generation: number;
  source_file_blob: Uint8Array;
  source_file_hash: string;
  source_file_bytes: number;
  body_blob: Uint8Array;
  body_hash: string;
  body_bytes: number;
  captured_at: number;
}

interface ResidentSourceInspectionCandidateRow {
  candidate_id: string;
  schema_version: number;
  scope_kind: string;
  execution_context: string;
  activation_epoch: number;
  contract_artifact_id: string;
  contract_migration_checksum: string;
  contract_content_hash: string;
  contract_content_bytes: number;
  soul_snapshot_id: string;
  inspect_batch_id: string;
  inspect_batch_sha256: string;
  inspect_call_index: number;
  inspect_call_count: number;
  inspect_tool_name: string;
  inspect_arguments_sha256: string;
  observed_at: number;
}

interface ResidentSourceCandidateAuthorizationRow {
  authorization_id: string;
  schema_version: number;
  authorization_kind: string;
  scope_kind: string;
  execution_context: string;
  candidate_id: string;
  activation_epoch: number;
  contract_artifact_id: string;
  contract_migration_checksum: string;
  contract_content_hash: string;
  contract_content_bytes: number;
  soul_snapshot_id: string;
  authorize_batch_id: string;
  authorize_batch_sha256: string;
  authorize_call_index: number;
  authorize_call_count: number;
  authorize_tool_name: string;
  authorize_arguments_sha256: string;
  authorized_at: number;
}

interface ResidentIdentitySystemDerivationRow {
  derivation_id: string;
  schema_version: number;
  derivation_kind: string;
  activation_epoch: number;
  authority_revision: number;
  predecessor_derivation_id: string | null;
  authorization_id: string;
  contract_artifact_id: string;
  soul_snapshot_id: string;
  contract_layer_id: string;
  contract_approval_id: string;
  identity_layer_id: string;
  identity_approval_id: string;
  derive_batch_id: string;
  derive_batch_sha256: string;
  derive_call_index: number;
  derive_call_count: number;
  derive_tool_name: string;
  derive_arguments_sha256: string;
  derived_at: number;
}

interface ResidentWorldProfileBindingRow {
  binding_id: string;
  schema_version: number;
  binding_kind: string;
  activation_epoch: number;
  derivation_id: string;
  world_id: string;
  ingress_event_id: string;
  ingress_sequence: number;
  profile_id: string;
  profile_hash: string;
  profile_head_revision: number;
  predecessor_profile_id: string | null;
  bind_batch_id: string;
  bind_batch_sha256: string;
  bind_call_index: number;
  bind_call_count: number;
  bind_tool_name: string;
  bind_arguments_sha256: string;
  bound_at: number;
}

interface DarkIsolatedProviderBindingRow {
  binding_id: string;
  schema_version: number;
  execution_mode: string;
  runnable: number;
  network_authority: string;
  tool_mode: string;
  historical_tool_messages: number;
  activation_epoch: number;
  branch_id: string;
  world_id: string;
  authority_epoch: number;
  resident_profile_binding_id: string;
  request_profile_binding_id: string;
  request_profile_binding_hash: string;
  profile_id: string;
  profile_hash: string;
  profile_head_revision: number;
  manifest_id: string;
  manifest_hash: string;
  request_view_id: string;
  request_view_hash: string;
  candidate_hash: string;
  candidate_bytes: number;
  target_provider_type: string;
  target_model: string;
  target_api_surface: string;
  target_api_endpoint: string;
  target_json: string;
  target_hash: string;
  cache_namespace: string;
  bind_batch_id: string;
  bind_batch_sha256: string;
  bind_call_index: number;
  bind_call_count: number;
  bind_tool_name: string;
  bind_arguments_sha256: string;
  binding_json: string;
  binding_hash: string;
  bound_at: number;
}

interface ScopedRuntimeContractArtifactRow {
  artifact_id: string;
  schema_version: number;
  system_renderer_generation: number;
  policy_generation: number;
  source_kind: string;
  source_hash: string;
  content_text: string;
  content_hash: string;
  content_bytes: number;
  introduced_by_migration: string;
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

interface SystemLayerApprovalRow {
  approval_id: string;
  layer_id: string;
  approval_role: string;
  basis_kind: string;
  basis_ref: string;
  basis_hash: string;
  approval_generation: number;
  approved_at: number;
}

interface SystemProfileRow {
  profile_id: string;
  world_id: string;
  activation_epoch: number;
  system_renderer_generation: number;
  policy_generation: number;
  scoped_runtime_contract_approval_id: string;
  identity_approval_id: string;
  integrated_self_approval_id: string | null;
  world_policy_approval_id: string | null;
  profile_json: string;
  profile_hash: string;
  created_at: number;
}

interface SystemProfileAdvanceRow {
  world_id: string;
  activation_epoch: number;
  revision: number;
  predecessor_profile_id: string | null;
  profile_id: string;
  advanced_at: number;
}

interface SystemProfileRequestViewBindingRow {
  binding_id: string;
  request_view_id: string;
  world_id: string;
  activation_epoch: number;
  profile_id: string;
  profile_head_revision: number;
  request_view_hash: string;
  profile_hash: string;
  binding_json: string;
  binding_hash: string;
  bound_at: number;
}

interface LocalBranchRequestViewRow {
  request_view_id: string;
  branch_id: string;
  world_id: string;
  manifest_id: string;
  manifest_hash: string;
  view_json: string;
  view_hash: string;
  message_renderer_generation: number;
  system_renderer_generation: number;
  policy_generation: number;
  system_layer_count: number;
  message_projection_count: number;
  tool_mode: string;
  runnable: number;
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

function mapDarkIngressGeneration(
  row: DarkIngressGenerationRow,
): DarkIngressGenerationRecord {
  const queueGeneration = generation('queueGeneration', row.queue_generation);
  const firstAdmissibleSequence = generation(
    'firstAdmissibleSequence',
    row.first_admissible_sequence,
  );
  if (queueGeneration < 1 || firstAdmissibleSequence < 1) {
    throw new Error('stored dark ingress generation is invalid');
  }
  return {
    queueGeneration,
    firstAdmissibleSequence,
    activationEpoch: generation('activationEpoch', row.activation_epoch),
  };
}

function mapDarkIngressAdmission(
  row: DarkIngressAdmissionRow,
): DarkIngressAdmissionRecord {
  if (row.wake_class !== 'text_user_turn') {
    throw new Error(
      `stored dark ingress admission is invalid: ${row.event_id}`,
    );
  }
  const sourceSequence = generation('sourceSequence', row.source_sequence);
  const queueGeneration = generation('queueGeneration', row.queue_generation);
  const messageRendererGeneration = generation(
    'messageRendererGeneration',
    row.message_renderer_generation,
  );
  if (
    sourceSequence < 1 ||
    queueGeneration < 1 ||
    messageRendererGeneration < 1
  ) {
    throw new Error(
      `stored dark ingress admission is invalid: ${row.event_id}`,
    );
  }
  return {
    eventId: eventId(row.event_id),
    worldId: worldId(row.world_id),
    sourceSequence,
    activationEpoch: generation('activationEpoch', row.activation_epoch),
    queueGeneration,
    wakeClass: row.wake_class,
    messageRendererGeneration,
    admittedAt: timestamp('admittedAt', row.admitted_at),
  };
}

function mapDarkPendingBranchAttempt(
  row: DarkPendingBranchAttemptRow,
): DarkPendingBranchAttemptRecord {
  const activationEpoch = generation('activationEpoch', row.activation_epoch);
  const queueGeneration = generation('queueGeneration', row.queue_generation);
  const maxEvents = generation('maxEvents', row.max_events);
  const selectedCount = generation('selectedCount', row.selected_count);
  const firstSourceSequence = generation(
    'firstSourceSequence',
    row.first_source_sequence,
  );
  const lastSourceSequence = generation(
    'lastSourceSequence',
    row.last_source_sequence,
  );
  if (
    queueGeneration < 1 ||
    maxEvents < 1 ||
    maxEvents > 1_024 ||
    selectedCount < 1 ||
    selectedCount > maxEvents ||
    firstSourceSequence < 1 ||
    lastSourceSequence < firstSourceSequence
  ) {
    throw new Error(
      `stored dark pending branch attempt is invalid: ${row.branch_id}`,
    );
  }
  return {
    branchId: branchId(row.branch_id),
    worldId: worldId(row.world_id),
    requestViewId: localBranchRequestViewId(row.request_view_id),
    activationEpoch,
    queueGeneration,
    maxEvents,
    selectedCount,
    firstSourceSequence,
    lastSourceSequence,
    assembledAt: timestamp('assembledAt', row.assembled_at),
  };
}

function mapDarkPendingBranchAbandonment(
  row: DarkPendingBranchAbandonmentRow,
): DarkPendingBranchAbandonmentRecord {
  if (row.reason !== 'coordinator_recovery') {
    throw new Error(
      `stored dark pending branch abandonment is invalid: ${row.branch_id}`,
    );
  }
  return {
    branchId: branchId(row.branch_id),
    abandonedAt: timestamp('abandonedAt', row.abandoned_at),
    reason: row.reason,
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
    throw new Error(
      `stored system layer projection is invalid: ${row.layer_id}`,
    );
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

function mapSystemLayerApproval(
  row: SystemLayerApprovalRow,
  layer: SystemLayerProjectionRecord,
): SystemLayerApprovalRecord {
  const role = systemLayerApprovalRole(row.approval_role);
  const basisKind = systemLayerApprovalBasisKind(row.basis_kind);
  const basisRef = systemLayerApprovalBasisRef(row.basis_ref);
  const basisHash = sha256('basisHash', row.basis_hash);
  const approvalGeneration = generation(
    'approvalGeneration',
    row.approval_generation,
  );
  const approvalId = systemLayerApprovalId(row.approval_id);
  const approvedAt = timestamp('approvedAt', row.approved_at);
  if (
    approvedAt < layer.createdAt ||
    approvalGeneration < 1 ||
    row.layer_id !== layer.layerId ||
    !systemLayerApprovalMatches(layer, role) ||
    basisKind !== SYSTEM_LAYER_APPROVAL_RULES[role].basisKind ||
    basisHash !== layer.sourceHash ||
    systemLayerApprovalIdentity({
      layerId: layer.layerId,
      role,
      basisKind,
      basisRef,
      basisHash,
      approvalGeneration,
    }) !== approvalId
  ) {
    throw new Error(
      `stored system layer approval is invalid: ${row.approval_id}`,
    );
  }
  return {
    approvalId,
    layerId: layer.layerId,
    role,
    basisKind,
    basisRef,
    basisHash,
    approvalGeneration,
    approvedAt,
  };
}

function mapSystemProfile(row: SystemProfileRow): SystemProfileRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.profile_json);
  } catch (error) {
    throw new Error(`stored system profile is invalid: ${row.profile_id}`, {
      cause: error,
    });
  }
  const profile = normalizeSystemProfile(parsed);
  const profileJson = serialize(profile);
  const profileHash = sha256('profileHash', row.profile_hash);
  if (
    row.world_id !== profile.worldId ||
    row.activation_epoch !== profile.activationEpoch ||
    row.system_renderer_generation !== profile.systemRendererGeneration ||
    row.policy_generation !== profile.policyGeneration ||
    row.scoped_runtime_contract_approval_id !==
      profile.approvals.scopedRuntimeContract ||
    row.identity_approval_id !== profile.approvals.identity ||
    row.integrated_self_approval_id !== profile.approvals.integratedSelf ||
    row.world_policy_approval_id !== profile.approvals.worldPolicy ||
    row.profile_json !== profileJson ||
    hashContextBytes(profileJson) !== profileHash ||
    systemProfileIdentity(profile) !== row.profile_id
  ) {
    throw new Error(`stored system profile is invalid: ${row.profile_id}`);
  }
  return {
    profileId: systemProfileId(row.profile_id),
    profile,
    profileJson,
    profileHash,
    createdAt: timestamp('createdAt', row.created_at),
  };
}

function mapSystemProfileHead(row: SystemProfileAdvanceRow): SystemProfileHead {
  const revision = generation('revision', row.revision);
  if (revision < 1) {
    throw new Error('stored system profile head revision is invalid');
  }
  return {
    worldId: worldId(row.world_id),
    activationEpoch: generation('activationEpoch', row.activation_epoch),
    revision,
    predecessorProfileId:
      row.predecessor_profile_id === null
        ? null
        : systemProfileId(row.predecessor_profile_id),
    profileId: systemProfileId(row.profile_id),
    advancedAt: timestamp('advancedAt', row.advanced_at),
  };
}

function mapSystemProfileRequestViewBinding(
  row: SystemProfileRequestViewBindingRow,
): SystemProfileRequestViewBindingRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.binding_json);
  } catch (error) {
    throw new Error(
      `stored system profile request view binding is invalid: ${row.binding_id}`,
      { cause: error },
    );
  }
  const binding = normalizeSystemProfileRequestViewBinding(parsed);
  const bindingJson = serialize(binding);
  const bindingHash = sha256('bindingHash', row.binding_hash);
  if (
    row.request_view_id !== binding.requestViewId ||
    row.world_id !== binding.worldId ||
    row.activation_epoch !== binding.activationEpoch ||
    row.profile_id !== binding.profileId ||
    row.profile_head_revision !== binding.profileHeadRevision ||
    row.request_view_hash !== binding.requestViewHash ||
    row.profile_hash !== binding.profileHash ||
    row.bound_at !== binding.boundAt ||
    row.binding_json !== bindingJson ||
    hashContextBytes(bindingJson) !== bindingHash ||
    systemProfileRequestViewBindingIdentity(binding) !== row.binding_id
  ) {
    throw new Error(
      `stored system profile request view binding is invalid: ${row.binding_id}`,
    );
  }
  return {
    bindingId: systemProfileRequestViewBindingId(row.binding_id),
    binding,
    bindingJson,
    bindingHash,
  };
}

function mapLocalBranchRequestView(
  row: LocalBranchRequestViewRow,
): LocalBranchRequestViewRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.view_json);
  } catch (error) {
    throw new Error(
      `stored local branch request view is invalid: ${row.request_view_id}`,
      { cause: error },
    );
  }
  const view = normalizeLocalBranchRequestView(parsed);
  const viewJson = serialize(view);
  const viewHash = sha256('viewHash', row.view_hash);
  const createdAt = timestamp('createdAt', row.created_at);
  if (
    row.tool_mode !== 'none' ||
    row.runnable !== 0 ||
    row.branch_id !== view.branchId ||
    row.world_id !== view.worldId ||
    row.manifest_id !== view.manifestId ||
    row.manifest_hash !== view.manifestHash ||
    row.message_renderer_generation !== view.messageRendererGeneration ||
    row.system_renderer_generation !== view.systemRendererGeneration ||
    row.policy_generation !== view.policyGeneration ||
    row.system_layer_count !== view.systemLayerProjectionIds.length ||
    row.message_projection_count !== view.messageProjectionIds.length ||
    row.view_json !== viewJson ||
    hashContextBytes(viewJson) !== viewHash ||
    localBranchRequestViewIdentity(view) !== row.request_view_id
  ) {
    throw new Error(
      `stored local branch request view is invalid: ${row.request_view_id}`,
    );
  }
  return {
    requestViewId: localBranchRequestViewId(row.request_view_id),
    branchId: view.branchId,
    worldId: view.worldId,
    manifestId: view.manifestId,
    manifestHash: view.manifestHash,
    view,
    viewJson,
    viewHash,
    createdAt,
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

function decodeResidentSourceBytes(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new Error(`stored resident ${label} is not valid UTF-8`);
  }
}

function hashBuffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeResidentSoulSnapshot(input: {
  snapshotId?: string;
  schemaVersion?: number;
  parserGeneration: number;
  sourceFile: string;
  sourceFileHash: string;
  sourceFileBytes: number;
  body: string;
  bodyHash: string;
  bodyBytes: number;
  capturedAt: number;
}): ResidentSoulSourceSnapshotV1 {
  const parserGeneration = generation(
    'resident soul parserGeneration',
    input.parserGeneration,
  );
  if (parserGeneration !== SOUL_PROMPT_SNAPSHOT_PARSER_GENERATION) {
    throw new Error('resident soul parserGeneration is unsupported');
  }
  const sourceBytes = Buffer.from(input.sourceFile, 'utf8');
  const bodyBytes = Buffer.from(input.body, 'utf8');
  if (
    sourceBytes.length > SOUL_PROMPT_SNAPSHOT_MAX_BYTES ||
    bodyBytes.length > SOUL_PROMPT_SNAPSHOT_MAX_BYTES
  ) {
    throw new Error('resident SOUL source snapshot exceeds the byte limit');
  }
  const sourceFileHash = sha256(
    'resident soul sourceFileHash',
    input.sourceFileHash,
  );
  const bodyHash = sha256('resident soul bodyHash', input.bodyHash);
  if (
    input.sourceFileBytes !== sourceBytes.length ||
    input.bodyBytes !== bodyBytes.length ||
    hashBuffer(sourceBytes) !== sourceFileHash ||
    hashBuffer(bodyBytes) !== bodyHash ||
    parseSoul(input.sourceFile).body !== input.body ||
    !input.body.trim()
  ) {
    throw new Error('resident SOUL source snapshot is inconsistent');
  }
  const snapshotId = residentSoulSnapshotId({
    parserGeneration,
    sourceFileHash,
    sourceFileBytes: sourceBytes.length,
    bodyHash,
    bodyBytes: bodyBytes.length,
  });
  if (input.snapshotId !== undefined && input.snapshotId !== snapshotId)
    throw new Error('resident SOUL source snapshot identity is invalid');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1)
    throw new Error('resident SOUL source snapshot schema is unsupported');
  return Object.freeze({
    snapshotId,
    schemaVersion: 1,
    parserGeneration,
    sourceFile: input.sourceFile,
    sourceFileHash,
    sourceFileBytes: sourceBytes.length,
    body: input.body,
    bodyHash,
    bodyBytes: bodyBytes.length,
    capturedAt: timestamp('resident soul capturedAt', input.capturedAt),
  });
}

function mapResidentSoulSnapshot(
  row: ResidentSoulSourceSnapshotRow,
): ResidentSoulSourceSnapshotV1 {
  const sourceBytes = Buffer.from(row.source_file_blob);
  const bodyBytes = Buffer.from(row.body_blob);
  return normalizeResidentSoulSnapshot({
    snapshotId: row.snapshot_id,
    schemaVersion: row.schema_version,
    parserGeneration: row.parser_generation,
    sourceFile: decodeResidentSourceBytes(sourceBytes, 'SOUL source file'),
    sourceFileHash: row.source_file_hash,
    sourceFileBytes: row.source_file_bytes,
    body: decodeResidentSourceBytes(bodyBytes, 'SOUL prompt body'),
    bodyHash: row.body_hash,
    bodyBytes: row.body_bytes,
    capturedAt: row.captured_at,
  });
}

function sameResidentSoulSource(
  left: ResidentSoulSourceSnapshotV1,
  right: ResidentSoulSourceSnapshotV1,
): boolean {
  return (
    left.snapshotId === right.snapshotId &&
    left.parserGeneration === right.parserGeneration &&
    left.sourceFile === right.sourceFile &&
    left.sourceFileHash === right.sourceFileHash &&
    left.sourceFileBytes === right.sourceFileBytes &&
    left.body === right.body &&
    left.bodyHash === right.bodyHash &&
    left.bodyBytes === right.bodyBytes
  );
}

function normalizeResidentInspectionProvenance(
  input: ResidentToolCallSnapshotV1,
): ResidentToolCallSnapshotV1 {
  if (
    input.version !== 1 ||
    typeof input.batchId !== 'string' ||
    !/^resident-tool-batch:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.batchId,
    ) ||
    !Number.isSafeInteger(input.callIndex) ||
    !Number.isSafeInteger(input.callCount) ||
    input.callIndex < 0 ||
    input.callCount < 1 ||
    input.callCount > 64 ||
    input.callIndex >= input.callCount ||
    input.toolName !== 'run'
  ) {
    throw new Error('resident source inspection provenance is invalid');
  }
  return Object.freeze({
    version: 1,
    batchId: input.batchId,
    batchSha256: sha256('resident inspection batchSha256', input.batchSha256),
    callIndex: input.callIndex,
    callCount: input.callCount,
    toolName: 'run',
    argumentsSha256: sha256(
      'resident inspection argumentsSha256',
      input.argumentsSha256,
    ),
  });
}

function normalizeResidentAuthorizationProvenance(
  input: ResidentToolCallSnapshotV1,
): ResidentToolCallSnapshotV1 {
  if (
    input.version !== 1 ||
    typeof input.batchId !== 'string' ||
    !/^resident-tool-batch:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.batchId,
    ) ||
    !Number.isSafeInteger(input.callIndex) ||
    !Number.isSafeInteger(input.callCount) ||
    input.callIndex < 0 ||
    input.callCount < 1 ||
    input.callCount > 64 ||
    input.callIndex >= input.callCount ||
    input.toolName !== 'run'
  ) {
    throw new Error('resident source authorization provenance is invalid');
  }
  return Object.freeze({
    version: 1,
    batchId: input.batchId,
    batchSha256: sha256('resident authorization batchSha256', input.batchSha256),
    callIndex: input.callIndex,
    callCount: input.callCount,
    toolName: 'run',
    argumentsSha256: sha256(
      'resident authorization argumentsSha256',
      input.argumentsSha256,
    ),
  });
}

function normalizeResidentIdentityDerivationProvenance(
  input: ResidentToolCallSnapshotV1,
): ResidentToolCallSnapshotV1 {
  const provenance = normalizeResidentAuthorizationProvenance(input);
  return Object.freeze({
    ...provenance,
    batchSha256: sha256(
      'resident identity derivation batchSha256',
      provenance.batchSha256,
    ),
    argumentsSha256: sha256(
      'resident identity derivation argumentsSha256',
      provenance.argumentsSha256,
    ),
  });
}

function normalizeResidentWorldProfileBindingProvenance(
  input: ResidentToolCallSnapshotV1,
): ResidentToolCallSnapshotV1 {
  const provenance = normalizeResidentAuthorizationProvenance(input);
  return Object.freeze({
    ...provenance,
    batchSha256: sha256(
      'resident world profile binding batchSha256',
      provenance.batchSha256,
    ),
    argumentsSha256: sha256(
      'resident world profile binding argumentsSha256',
      provenance.argumentsSha256,
    ),
  });
}

function normalizeDarkIsolatedProviderBindingProvenance(
  input: ResidentToolCallSnapshotV1,
): ResidentToolCallSnapshotV1 {
  const provenance = normalizeResidentAuthorizationProvenance(input);
  return Object.freeze({
    ...provenance,
    batchSha256: sha256(
      'dark isolated provider binding batchSha256',
      provenance.batchSha256,
    ),
    argumentsSha256: sha256(
      'dark isolated provider binding argumentsSha256',
      provenance.argumentsSha256,
    ),
  });
}

function mapResidentInspectionCandidate(
  row: ResidentSourceInspectionCandidateRow,
): ResidentSourceInspectionCandidateV1 {
  if (
    row.schema_version !== 1 ||
    row.scope_kind !== 'private_integrated_self_candidate' ||
    row.execution_context !== 'legacy_monocontext_resident' ||
    row.contract_artifact_id !==
      SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.artifactId ||
    row.contract_migration_checksum !==
      SCOPED_RUNTIME_CONTRACT_MIGRATION_CHECKSUM ||
    row.contract_content_hash !==
      SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.contentHash ||
    row.contract_content_bytes !==
      SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.contentBytes
  ) {
    throw new Error('stored resident source inspection candidate is invalid');
  }
  const provenance = normalizeResidentInspectionProvenance({
    version: 1,
    batchId: row.inspect_batch_id,
    batchSha256: row.inspect_batch_sha256,
    callIndex: row.inspect_call_index,
    callCount: row.inspect_call_count,
    toolName: row.inspect_tool_name,
    argumentsSha256: row.inspect_arguments_sha256,
  });
  const activationEpoch = generation(
    'resident inspection activationEpoch',
    row.activation_epoch,
  );
  const candidateId = residentSourceCandidateId({
    activationEpoch,
    soulSnapshotId: row.soul_snapshot_id,
    provenance,
  });
  if (row.candidate_id !== candidateId)
    throw new Error(
      'stored resident source inspection candidate identity is invalid',
    );
  return Object.freeze({
    candidateId,
    schemaVersion: 1,
    scopeKind: 'private_integrated_self_candidate',
    executionContext: 'legacy_monocontext_resident',
    activationEpoch,
    contractArtifactId: row.contract_artifact_id,
    contractMigrationChecksum: row.contract_migration_checksum,
    contractContentHash: row.contract_content_hash,
    contractContentBytes: row.contract_content_bytes,
    soulSnapshotId: row.soul_snapshot_id,
    inspectBatchId: provenance.batchId,
    inspectBatchSha256: provenance.batchSha256,
    inspectCallIndex: provenance.callIndex,
    inspectCallCount: provenance.callCount,
    inspectToolName: 'run',
    inspectArgumentsSha256: provenance.argumentsSha256,
    observedAt: timestamp('resident inspection observedAt', row.observed_at),
  });
}

function mapResidentSourceAuthorization(
  row: ResidentSourceCandidateAuthorizationRow,
  candidate: ResidentSourceInspectionCandidateV1,
): ResidentSourceCandidateAuthorizationV1 {
  if (
    row.schema_version !== 1 ||
    row.authorization_kind !== 'resident_source_candidate' ||
    row.scope_kind !== 'private_integrated_self_source' ||
    row.execution_context !== 'legacy_monocontext_resident' ||
    row.candidate_id !== candidate.candidateId ||
    row.activation_epoch !== candidate.activationEpoch ||
    row.contract_artifact_id !== candidate.contractArtifactId ||
    row.contract_migration_checksum !== candidate.contractMigrationChecksum ||
    row.contract_content_hash !== candidate.contractContentHash ||
    row.contract_content_bytes !== candidate.contractContentBytes ||
    row.soul_snapshot_id !== candidate.soulSnapshotId
  ) {
    throw new Error('stored resident source candidate authorization is invalid');
  }
  const provenance = normalizeResidentAuthorizationProvenance({
    version: 1,
    batchId: row.authorize_batch_id,
    batchSha256: row.authorize_batch_sha256,
    callIndex: row.authorize_call_index,
    callCount: row.authorize_call_count,
    toolName: row.authorize_tool_name,
    argumentsSha256: row.authorize_arguments_sha256,
  });
  if (provenance.batchId === candidate.inspectBatchId) {
    throw new Error(
      'stored resident source candidate authorization reuses its inspection batch',
    );
  }
  const authorizationId = residentSourceAuthorizationId({ candidate, provenance });
  if (row.authorization_id !== authorizationId) {
    throw new Error(
      'stored resident source candidate authorization identity is invalid',
    );
  }
  const authorizedAt = timestamp(
    'resident source authorization authorizedAt',
    row.authorized_at,
  );
  if (authorizedAt < candidate.observedAt) {
    throw new Error(
      'stored resident source candidate authorization chronology is invalid',
    );
  }
  return Object.freeze({
    authorizationId,
    schemaVersion: 1,
    authorizationKind: 'resident_source_candidate',
    scopeKind: 'private_integrated_self_source',
    executionContext: 'legacy_monocontext_resident',
    candidateId: candidate.candidateId,
    activationEpoch: candidate.activationEpoch,
    contractArtifactId: candidate.contractArtifactId,
    contractMigrationChecksum: candidate.contractMigrationChecksum,
    contractContentHash: candidate.contractContentHash,
    contractContentBytes: candidate.contractContentBytes,
    soulSnapshotId: candidate.soulSnapshotId,
    authorizeBatchId: provenance.batchId,
    authorizeBatchSha256: provenance.batchSha256,
    authorizeCallIndex: provenance.callIndex,
    authorizeCallCount: provenance.callCount,
    authorizeToolName: 'run',
    authorizeArgumentsSha256: provenance.argumentsSha256,
    authorizedAt,
  });
}

function mapResidentIdentitySystemDerivation(
  row: ResidentIdentitySystemDerivationRow,
  authorization: ResidentSourceCandidateAuthorizationV1,
): ResidentIdentitySystemDerivationV1 {
  if (
    row.schema_version !== 1 ||
    row.derivation_kind !== 'authorized_resident_identity_layers' ||
    row.authorization_id !== authorization.authorizationId ||
    row.activation_epoch !== authorization.activationEpoch ||
    row.contract_artifact_id !== authorization.contractArtifactId ||
    row.soul_snapshot_id !== authorization.soulSnapshotId
  ) {
    throw new Error('stored resident identity system derivation is invalid');
  }
  const provenance = normalizeResidentIdentityDerivationProvenance({
    version: 1,
    batchId: row.derive_batch_id,
    batchSha256: row.derive_batch_sha256,
    callIndex: row.derive_call_index,
    callCount: row.derive_call_count,
    toolName: row.derive_tool_name,
    argumentsSha256: row.derive_arguments_sha256,
  });
  if (provenance.batchId === authorization.authorizeBatchId) {
    throw new Error(
      'stored resident identity system derivation reuses its authorization batch',
    );
  }
  const activationEpoch = generation(
    'resident identity derivation activationEpoch',
    row.activation_epoch,
  );
  const authorityRevision = generation(
    'resident identity derivation authorityRevision',
    row.authority_revision,
  );
  if (authorityRevision < 1) {
    throw new Error('stored resident identity system derivation revision is invalid');
  }
  const predecessorDerivationId =
    row.predecessor_derivation_id === null
      ? null
      : residentIdentitySystemDerivationId(row.predecessor_derivation_id);
  const contractLayerId = systemLayerProjectionId(row.contract_layer_id);
  const contractApprovalId = systemLayerApprovalId(row.contract_approval_id);
  const identityLayerId = systemLayerProjectionId(row.identity_layer_id);
  const identityApprovalId = systemLayerApprovalId(row.identity_approval_id);
  const derivationId = residentIdentitySystemDerivationIdentity({
    activationEpoch,
    authorityRevision,
    predecessorDerivationId,
    authorizationId: authorization.authorizationId,
    contractArtifactId: authorization.contractArtifactId,
    soulSnapshotId: authorization.soulSnapshotId,
    contractLayerId,
    contractApprovalId,
    identityLayerId,
    identityApprovalId,
    provenance,
  });
  if (row.derivation_id !== derivationId) {
    throw new Error('stored resident identity system derivation identity is invalid');
  }
  const derivedAt = timestamp(
    'resident identity derivation derivedAt',
    row.derived_at,
  );
  if (derivedAt < authorization.authorizedAt) {
    throw new Error(
      'stored resident identity system derivation chronology is invalid',
    );
  }
  return Object.freeze({
    derivationId,
    schemaVersion: 1,
    derivationKind: 'authorized_resident_identity_layers',
    activationEpoch,
    authorityRevision,
    predecessorDerivationId,
    authorizationId: authorization.authorizationId,
    contractArtifactId: authorization.contractArtifactId,
    soulSnapshotId: authorization.soulSnapshotId,
    contractLayerId,
    contractApprovalId,
    identityLayerId,
    identityApprovalId,
    deriveBatchId: provenance.batchId,
    deriveBatchSha256: provenance.batchSha256,
    deriveCallIndex: provenance.callIndex,
    deriveCallCount: provenance.callCount,
    deriveToolName: 'run',
    deriveArgumentsSha256: provenance.argumentsSha256,
    derivedAt,
  });
}

function mapResidentWorldProfileBinding(
  row: ResidentWorldProfileBindingRow,
  derivation: ResidentIdentitySystemDerivationV1,
  event: WorldEventRecord,
  profile: SystemProfileRecord,
): ResidentWorldProfileBindingV1 {
  if (
    row.schema_version !== 1 ||
    row.binding_kind !== 'resident_current_world_profile' ||
    row.derivation_id !== derivation.derivationId ||
    row.activation_epoch !== derivation.activationEpoch ||
    row.world_id !== event.worldId ||
    row.ingress_event_id !== event.eventId ||
    row.ingress_sequence !== event.sequence ||
    !['inbound:discord', 'inbound:signal'].includes(event.kind) ||
    row.profile_id !== profile.profileId ||
    row.profile_hash !== profile.profileHash ||
    profile.profile.worldId !== event.worldId ||
    profile.profile.activationEpoch !== derivation.activationEpoch ||
    profile.profile.approvals.scopedRuntimeContract !==
      derivation.contractApprovalId ||
    profile.profile.approvals.identity !== derivation.identityApprovalId ||
    profile.profile.approvals.integratedSelf !== null ||
    profile.profile.approvals.worldPolicy !== null ||
    row.profile_head_revision !== 1 ||
    row.predecessor_profile_id !== null
  ) {
    throw new Error('stored resident world profile binding is invalid');
  }
  const provenance = normalizeResidentWorldProfileBindingProvenance({
    version: 1,
    batchId: row.bind_batch_id,
    batchSha256: row.bind_batch_sha256,
    callIndex: row.bind_call_index,
    callCount: row.bind_call_count,
    toolName: row.bind_tool_name,
    argumentsSha256: row.bind_arguments_sha256,
  });
  if (provenance.batchId === derivation.deriveBatchId) {
    throw new Error(
      'stored resident world profile binding reuses its derivation batch',
    );
  }
  const activationEpoch = generation(
    'resident world profile binding activationEpoch',
    row.activation_epoch,
  );
  const ingressSequence = generation(
    'resident world profile binding ingressSequence',
    row.ingress_sequence,
  );
  const boundAt = timestamp(
    'resident world profile binding boundAt',
    row.bound_at,
  );
  if (
    ingressSequence < 1 ||
    boundAt < derivation.derivedAt ||
    boundAt < event.recordedAt ||
    profile.createdAt !== boundAt
  ) {
    throw new Error('stored resident world profile binding chronology is invalid');
  }
  const bindingId = residentWorldProfileBindingIdentity({
    activationEpoch,
    derivationId: derivation.derivationId,
    worldId: event.worldId,
    ingressEventId: event.eventId,
    ingressSequence,
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    profileHeadRevision: 1,
    predecessorProfileId: null,
    provenance,
  });
  if (row.binding_id !== bindingId) {
    throw new Error('stored resident world profile binding identity is invalid');
  }
  return Object.freeze({
    bindingId,
    schemaVersion: 1,
    bindingKind: 'resident_current_world_profile',
    activationEpoch,
    derivationId: derivation.derivationId,
    worldId: event.worldId,
    ingressEventId: event.eventId,
    ingressSequence,
    profileId: profile.profileId,
    profileHash: profile.profileHash,
    profileHeadRevision: 1,
    predecessorProfileId: null,
    bindBatchId: provenance.batchId,
    bindBatchSha256: provenance.batchSha256,
    bindCallIndex: provenance.callIndex,
    bindCallCount: provenance.callCount,
    bindToolName: 'run',
    bindArgumentsSha256: provenance.argumentsSha256,
    boundAt,
  });
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

  getScopedRuntimeContractArtifact(): ScopedRuntimeContractArtifactV1 {
    const expected = SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1;
    const row = this.database
      .prepare(
        'SELECT * FROM context_scoped_runtime_contract_artifacts WHERE artifact_id = ?',
      )
      .get(expected.artifactId) as
      | ScopedRuntimeContractArtifactRow
      | undefined;
    if (
      !row ||
      row.schema_version !== expected.schemaVersion ||
      row.system_renderer_generation !== expected.systemRendererGeneration ||
      row.policy_generation !== expected.policyGeneration ||
      row.source_kind !== expected.sourceKind ||
      row.source_hash !== expected.sourceHash ||
      row.content_text !== expected.content ||
      row.content_hash !== expected.contentHash ||
      row.content_bytes !== expected.contentBytes ||
      row.introduced_by_migration !== expected.introducedByMigration
    ) {
      throw new Error('scoped runtime contract artifact is missing or invalid');
    }
    return expected;
  }

  getResidentSoulSourceSnapshot(
    snapshotId: string,
  ): ResidentSoulSourceSnapshotV1 | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_resident_soul_source_snapshots WHERE snapshot_id = ?',
      )
      .get(snapshotId) as ResidentSoulSourceSnapshotRow | undefined;
    return row ? mapResidentSoulSnapshot(row) : null;
  }

  getResidentSourceInspectionCandidate(
    candidateId: string,
  ): ResidentSourceInspectionCaptureV1 | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_resident_source_inspection_candidates WHERE candidate_id = ?',
      )
      .get(candidateId) as ResidentSourceInspectionCandidateRow | undefined;
    if (!row) return null;
    this.getScopedRuntimeContractArtifact();
    const receipt = this.database
      .prepare(
        `SELECT checksum FROM elpis_migrations
         WHERE component = 'core' AND name = ?`,
      )
      .get(SCOPED_RUNTIME_CONTRACT_MIGRATION) as
      { checksum: string } | undefined;
    if (receipt?.checksum !== SCOPED_RUNTIME_CONTRACT_MIGRATION_CHECKSUM) {
      throw new Error('scoped runtime contract migration receipt is invalid');
    }
    const candidate = mapResidentInspectionCandidate(row);
    const soul = this.getResidentSoulSourceSnapshot(candidate.soulSnapshotId);
    if (!soul || soul.capturedAt > candidate.observedAt) {
      throw new Error(
        'stored resident source inspection candidate has invalid SOUL lineage',
      );
    }
    return Object.freeze({ soul, candidate });
  }

  getResidentSourceCandidateAuthorization(
    authorizationId: string,
  ): ResidentSourceCandidateAuthorizationV1 | null {
    const row = this.database
      .prepare(
        `SELECT * FROM context_resident_source_candidate_authorizations
         WHERE authorization_id = ?`,
      )
      .get(authorizationId) as
      | ResidentSourceCandidateAuthorizationRow
      | undefined;
    if (!row) return null;
    const capture = this.getResidentSourceInspectionCandidate(row.candidate_id);
    if (!capture) {
      throw new Error(
        'stored resident source candidate authorization has no candidate',
      );
    }
    return mapResidentSourceAuthorization(row, capture.candidate);
  }

  getResidentIdentitySystemDerivation(
    id: ResidentIdentitySystemDerivationId,
  ): ResidentIdentitySystemDerivationV1 | null {
    const row = this.database
      .prepare(
        `SELECT * FROM context_resident_identity_system_derivations
         WHERE derivation_id = ?`,
      )
      .get(id) as ResidentIdentitySystemDerivationRow | undefined;
    if (!row) return null;
    const authorization = this.getResidentSourceCandidateAuthorization(
      row.authorization_id,
    );
    if (!authorization) {
      throw new Error(
        'stored resident identity system derivation has no authorization',
      );
    }
    const receipt = mapResidentIdentitySystemDerivation(row, authorization);
    const soul = this.getResidentSoulSourceSnapshot(receipt.soulSnapshotId);
    const artifact = this.getScopedRuntimeContractArtifact();
    const contractLayer = this.getSystemLayerProjection(receipt.contractLayerId);
    const contractApproval = this.getSystemLayerApproval(
      receipt.contractApprovalId,
    );
    const identityLayer = this.getSystemLayerProjection(receipt.identityLayerId);
    const identityApproval = this.getSystemLayerApproval(
      receipt.identityApprovalId,
    );
    if (
      !soul ||
      artifact.artifactId !== receipt.contractArtifactId ||
      !contractLayer ||
      contractLayer.kind !== 'runtime_contract' ||
      contractLayer.visibility !== 'global_contract' ||
      contractLayer.worldId !== null ||
      contractLayer.rendererGeneration !== artifact.systemRendererGeneration ||
      contractLayer.policyGeneration !== artifact.policyGeneration ||
      contractLayer.sourceKind !== artifact.sourceKind ||
      contractLayer.sourceHash !== artifact.sourceHash ||
      contractLayer.content !== artifact.content ||
      contractLayer.contentHash !== artifact.contentHash ||
      contractLayer.contentBytes !== artifact.contentBytes ||
      contractLayer.createdAt > receipt.derivedAt ||
      !contractApproval ||
      contractApproval.layerId !== contractLayer.layerId ||
      contractApproval.role !== 'scoped_runtime_contract' ||
      contractApproval.basisKind !== 'authored_scoped_contract' ||
      contractApproval.basisRef !== artifact.artifactId ||
      contractApproval.basisHash !== artifact.sourceHash ||
      contractApproval.approvalGeneration !== 1 ||
      contractApproval.approvedAt !== contractLayer.createdAt ||
      !identityLayer ||
      identityLayer.kind !== 'identity' ||
      identityLayer.visibility !== 'integrated_self' ||
      identityLayer.worldId !== null ||
      identityLayer.rendererGeneration !== artifact.systemRendererGeneration ||
      identityLayer.policyGeneration !== artifact.policyGeneration ||
      identityLayer.sourceKind !== 'soul_snapshot' ||
      identityLayer.sourceHash !== soul.sourceFileHash ||
      identityLayer.content !== soul.body ||
      identityLayer.contentHash !== soul.bodyHash ||
      identityLayer.contentBytes !== soul.bodyBytes ||
      identityLayer.createdAt > receipt.derivedAt ||
      !identityApproval ||
      identityApproval.layerId !== identityLayer.layerId ||
      identityApproval.role !== 'identity' ||
      identityApproval.basisKind !== 'soul_snapshot' ||
      identityApproval.basisRef !== soul.snapshotId ||
      identityApproval.basisHash !== soul.sourceFileHash ||
      identityApproval.approvalGeneration !== 1 ||
      identityApproval.approvedAt !== identityLayer.createdAt
    ) {
      throw new Error(
        'stored resident identity system derivation layer lineage is invalid',
      );
    }
    const validateLayerOrigin = (
      layerId: SystemLayerProjectionId,
      approvalId: SystemLayerApprovalId,
      createdAt: number,
      layerColumn: 'contract_layer_id' | 'identity_layer_id',
      approvalColumn: 'contract_approval_id' | 'identity_approval_id',
    ) => {
      const origin = this.database
        .prepare(
          `SELECT derivation_id, authority_revision, derived_at
           FROM context_resident_identity_system_derivations
           WHERE ${layerColumn} = ? AND ${approvalColumn} = ?
           ORDER BY authority_revision ASC
           LIMIT 1`,
        )
        .get(layerId, approvalId) as
        | {
            derivation_id: string;
            authority_revision: number;
            derived_at: number;
          }
        | undefined;
      if (
        !origin ||
        origin.authority_revision > receipt.authorityRevision ||
        origin.derived_at !== createdAt
      ) {
        throw new Error(
          'stored resident identity system derivation layer origin is invalid',
        );
      }
      if (origin.derivation_id === receipt.derivationId) {
        if (createdAt !== receipt.derivedAt) {
          throw new Error(
            'stored resident identity system derivation layer origin is invalid',
          );
        }
        return;
      }
      if (
        origin.authority_revision >= receipt.authorityRevision ||
        !this.getResidentIdentitySystemDerivation(
          residentIdentitySystemDerivationId(origin.derivation_id),
        )
      ) {
        throw new Error(
          'stored resident identity system derivation layer origin is invalid',
        );
      }
    };
    validateLayerOrigin(
      contractLayer.layerId,
      contractApproval.approvalId,
      contractLayer.createdAt,
      'contract_layer_id',
      'contract_approval_id',
    );
    validateLayerOrigin(
      identityLayer.layerId,
      identityApproval.approvalId,
      identityLayer.createdAt,
      'identity_layer_id',
      'identity_approval_id',
    );
    if (receipt.authorityRevision === 1) {
      if (receipt.predecessorDerivationId !== null) {
        throw new Error(
          'stored resident identity system derivation predecessor is invalid',
        );
      }
    } else {
      if (receipt.predecessorDerivationId === null) {
        throw new Error(
          'stored resident identity system derivation predecessor is invalid',
        );
      }
      const predecessor = this.database
        .prepare(
          `SELECT activation_epoch, authority_revision, derived_at
           FROM context_resident_identity_system_derivations
           WHERE derivation_id = ?`,
        )
        .get(receipt.predecessorDerivationId) as
        | Pick<
            ResidentIdentitySystemDerivationRow,
            'activation_epoch' | 'authority_revision' | 'derived_at'
          >
        | undefined;
      if (
        !predecessor ||
        predecessor.activation_epoch !== receipt.activationEpoch ||
        predecessor.authority_revision !== receipt.authorityRevision - 1 ||
        predecessor.derived_at > receipt.derivedAt
      ) {
        throw new Error(
          'stored resident identity system derivation predecessor is invalid',
        );
      }
    }
    return receipt;
  }

  getResidentWorldProfileBinding(
    id: ResidentWorldProfileBindingId,
  ): ResidentWorldProfileBindingV1 | null {
    const row = this.database
      .prepare(
        `SELECT * FROM context_resident_world_profile_bindings
         WHERE binding_id = ?`,
      )
      .get(id) as ResidentWorldProfileBindingRow | undefined;
    if (!row) return null;
    const derivation = this.getResidentIdentitySystemDerivation(
      residentIdentitySystemDerivationId(row.derivation_id),
    );
    const event = this.getWorldEvent(eventId(row.ingress_event_id));
    const profile = this.getSystemProfile(systemProfileId(row.profile_id));
    if (!derivation || !event || !profile) {
      throw new Error('stored resident world profile binding lineage is missing');
    }
    const receipt = mapResidentWorldProfileBinding(
      row,
      derivation,
      event,
      profile,
    );
    const sourceBatches = this.database
      .prepare(
        `SELECT d.derive_batch_id, a.authorize_batch_id, c.inspect_batch_id
         FROM context_resident_identity_system_derivations d
         JOIN context_resident_source_candidate_authorizations a
           ON a.authorization_id = d.authorization_id
         JOIN context_resident_source_inspection_candidates c
           ON c.candidate_id = a.candidate_id
         WHERE d.derivation_id = ?`,
      )
      .get(receipt.derivationId) as
      | {
          derive_batch_id: string;
          authorize_batch_id: string;
          inspect_batch_id: string;
        }
      | undefined;
    if (
      !sourceBatches ||
      receipt.bindBatchId === sourceBatches.derive_batch_id ||
      receipt.bindBatchId === sourceBatches.authorize_batch_id ||
      receipt.bindBatchId === sourceBatches.inspect_batch_id
    ) {
      throw new Error(
        'stored resident world profile binding source batches are invalid',
      );
    }
    const head = this.getSystemProfileHeadPrefix(
      receipt.worldId,
      receipt.activationEpoch,
      receipt.profileHeadRevision,
    );
    if (
      !head ||
      head.revision !== 1 ||
      head.profileId !== receipt.profileId ||
      head.predecessorProfileId !== null ||
      head.advancedAt !== receipt.boundAt
    ) {
      throw new Error('stored resident world profile binding head is invalid');
    }
    return receipt;
  }

  getDarkIsolatedProviderBinding(
    id: DarkIsolatedProviderBindingId,
  ): DarkIsolatedProviderBindingRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM context_dark_isolated_provider_bindings
         WHERE binding_id = ?`,
      )
      .get(id) as DarkIsolatedProviderBindingRow | undefined;
    if (!row) return null;
    if (
      row.schema_version !== 1 ||
      row.execution_mode !== 'dark' ||
      row.runnable !== 0 ||
      row.network_authority !== 'none' ||
      row.tool_mode !== 'none' ||
      row.historical_tool_messages !== 0
    ) {
      throw new Error('stored dark isolated provider binding mode is invalid');
    }
    let parsedTarget: unknown;
    try {
      parsedTarget = JSON.parse(row.target_json);
    } catch (error) {
      throw new Error('stored dark isolated provider target is invalid', {
        cause: error,
      });
    }
    const target = normalizeExactIsolatedProviderTarget(
      parsedTarget as ExactIsolatedProviderTargetV1,
    );
    const targetJson = serialize(target);
    const targetHash = sha256('dark isolated provider targetHash', row.target_hash);
    if (
      row.target_json !== targetJson ||
      hashContextBytes(targetJson) !== targetHash ||
      row.target_provider_type !== target.providerType ||
      row.target_model !== target.model ||
      row.target_api_surface !== target.apiSurface ||
      row.target_api_endpoint !== target.apiEndpoint
    ) {
      throw new Error('stored dark isolated provider target is invalid');
    }
    const provenance = normalizeDarkIsolatedProviderBindingProvenance({
      version: 1,
      batchId: row.bind_batch_id,
      batchSha256: row.bind_batch_sha256,
      callIndex: row.bind_call_index,
      callCount: row.bind_call_count,
      toolName: row.bind_tool_name,
      argumentsSha256: row.bind_arguments_sha256,
    });
    const branch = this.getBranch(branchId(row.branch_id));
    const attempt = this.getDarkPendingBranchAttempt(branchId(row.branch_id));
    const requestView = this.getLocalBranchRequestView(
      localBranchRequestViewId(row.request_view_id),
    );
    const requestBinding = this.getSystemProfileRequestViewBinding(
      systemProfileRequestViewBindingId(row.request_profile_binding_id),
    );
    const residentBinding = this.getResidentWorldProfileBinding(
      residentWorldProfileBindingId(row.resident_profile_binding_id),
    );
    if (!branch || !attempt || !requestView || !requestBinding || !residentBinding) {
      throw new Error('stored dark isolated provider binding lineage is missing');
    }
    if (
      attempt.branchId !== branch.branchId ||
      attempt.worldId !== branch.worldId ||
      attempt.requestViewId !== requestView.requestViewId ||
      requestView.branchId !== branch.branchId ||
      requestView.worldId !== branch.worldId ||
      requestBinding.binding.requestViewId !== requestView.requestViewId ||
      requestBinding.binding.requestViewHash !== requestView.viewHash ||
      requestBinding.binding.worldId !== branch.worldId ||
      requestBinding.binding.activationEpoch !== attempt.activationEpoch ||
      residentBinding.worldId !== branch.worldId ||
      residentBinding.activationEpoch !== attempt.activationEpoch ||
      residentBinding.profileId !== requestBinding.binding.profileId ||
      residentBinding.profileHash !== requestBinding.binding.profileHash ||
      residentBinding.profileHeadRevision !==
        requestBinding.binding.profileHeadRevision
    ) {
      throw new Error('stored dark isolated provider binding lineage is invalid');
    }
    const manifest = this.getManifestProjection(requestView.manifestId, {
      requireActiveShares: true,
    });
    if (!manifest) {
      throw new Error('stored dark isolated provider binding manifest is missing');
    }
    const request = this.materializeStoredLocalBranchRequest(requestView);
    const cacheNamespace = isolatedProviderCacheNamespace({
      manifestCacheNamespace: manifest.record.cacheNamespace,
      requestViewHash: requestView.viewHash,
      targetHash,
    });
    const activationEpoch = generation(
      'dark isolated provider binding activationEpoch',
      row.activation_epoch,
    );
    const authorityEpoch = generation(
      'dark isolated provider binding authorityEpoch',
      row.authority_epoch,
    );
    const profileHeadRevision = generation(
      'dark isolated provider binding profileHeadRevision',
      row.profile_head_revision,
    );
    const candidateBytes = generation(
      'dark isolated provider binding candidateBytes',
      row.candidate_bytes,
    );
    const boundAt = timestamp(
      'dark isolated provider binding boundAt',
      row.bound_at,
    );
    const binding: DarkIsolatedProviderBindingV1 = Object.freeze({
      schemaVersion: 1,
      executionMode: 'dark',
      runnable: false,
      networkAuthority: 'none',
      toolMode: 'none',
      historicalToolMessages: false,
      activationEpoch,
      branchId: branch.branchId,
      worldId: branch.worldId,
      authorityEpoch,
      residentProfileBindingId: residentBinding.bindingId,
      requestProfileBindingId: requestBinding.bindingId,
      requestProfileBindingHash: requestBinding.bindingHash,
      profileId: requestBinding.binding.profileId,
      profileHash: requestBinding.binding.profileHash,
      profileHeadRevision,
      manifestId: manifest.record.manifestId,
      manifestHash: manifest.record.hash,
      requestViewId: requestView.requestViewId,
      requestViewHash: requestView.viewHash,
      candidateHash: request.candidateHash,
      candidateBytes,
      target,
      targetHash,
      laneKind: 'isolated-standalone',
      cacheNamespace,
      bindBatchId: provenance.batchId,
      bindBatchSha256: provenance.batchSha256,
      bindCallIndex: provenance.callIndex,
      bindCallCount: provenance.callCount,
      bindToolName: 'run',
      bindArgumentsSha256: provenance.argumentsSha256,
      boundAt,
    });
    const bindingJson = serialize(binding);
    const bindingHash = sha256('dark isolated provider bindingHash', row.binding_hash);
    if (
      row.activation_epoch !== attempt.activationEpoch ||
      row.world_id !== branch.worldId ||
      row.authority_epoch !== branch.authorityEpoch ||
      row.request_profile_binding_hash !== requestBinding.bindingHash ||
      row.profile_id !== requestBinding.binding.profileId ||
      row.profile_hash !== requestBinding.binding.profileHash ||
      row.profile_head_revision !== requestBinding.binding.profileHeadRevision ||
      row.manifest_id !== manifest.record.manifestId ||
      row.manifest_hash !== manifest.record.hash ||
      row.request_view_hash !== requestView.viewHash ||
      row.candidate_hash !== request.candidateHash ||
      row.candidate_bytes !== request.candidateBytes ||
      row.cache_namespace !== cacheNamespace ||
      boundAt < attempt.assembledAt ||
      row.binding_json !== bindingJson ||
      hashContextBytes(bindingJson) !== bindingHash ||
      darkIsolatedProviderBindingIdentity(bindingJson) !== id
    ) {
      throw new Error('stored dark isolated provider binding is invalid');
    }
    return {
      bindingId: id,
      binding,
      targetJson,
      targetHash,
      bindingJson,
      bindingHash,
    };
  }

  createResidentSourceInspectionCandidate(input: {
    soul: PromptFacingSoulSnapshot;
    provenance: ResidentToolCallSnapshotV1;
    observedAt: number;
  }): ResidentSourceInspectionCaptureV1;
  /** The optional finalizer runs synchronously after strict reread but before
   * commit, so an unpresentable resident review rolls back new source rows. */
  createResidentSourceInspectionCandidate<T>(
    input: {
      soul: PromptFacingSoulSnapshot;
      provenance: ResidentToolCallSnapshotV1;
      observedAt: number;
    },
    finalize: (capture: ResidentSourceInspectionCaptureV1) => T,
  ): T;
  createResidentSourceInspectionCandidate<T>(
    input: {
      soul: PromptFacingSoulSnapshot;
      provenance: ResidentToolCallSnapshotV1;
      observedAt: number;
    },
    finalize?: (capture: ResidentSourceInspectionCaptureV1) => T,
  ): ResidentSourceInspectionCaptureV1 | T {
    const observedAt = timestamp(
      'resident inspection observedAt',
      input.observedAt,
    );
    const soul = normalizeResidentSoulSnapshot({
      parserGeneration: input.soul.parserGeneration,
      sourceFile: input.soul.sourceFile,
      sourceFileHash: input.soul.sourceFileHash,
      sourceFileBytes: input.soul.sourceFileBytes,
      body: input.soul.body,
      bodyHash: input.soul.bodyHash,
      bodyBytes: input.soul.bodyBytes,
      capturedAt: observedAt,
    });
    const provenance = normalizeResidentInspectionProvenance(input.provenance);
    const finish = (capture: ResidentSourceInspectionCaptureV1) =>
      finalize ? finalize(capture) : capture;

    return transaction(this.database, () => {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new Error('resident source inspection requires dark graph mode');
      }
      this.getScopedRuntimeContractArtifact();
      const migration = this.database
        .prepare(
          `SELECT checksum FROM elpis_migrations
           WHERE component = 'core' AND name = ?`,
        )
        .get(SCOPED_RUNTIME_CONTRACT_MIGRATION) as
        { checksum: string } | undefined;
      if (migration?.checksum !== SCOPED_RUNTIME_CONTRACT_MIGRATION_CHECKSUM) {
        throw new Error('scoped runtime contract migration receipt is invalid');
      }

      const candidateId = residentSourceCandidateId({
        activationEpoch: activation.epoch,
        soulSnapshotId: soul.snapshotId,
        provenance,
      });
      const prior = this.database
        .prepare(
          `SELECT candidate_id
           FROM context_resident_source_inspection_candidates
           WHERE inspect_batch_id = ? AND inspect_call_index = ?`,
        )
        .get(provenance.batchId, provenance.callIndex) as
        { candidate_id: string } | undefined;
      if (prior) {
        if (prior.candidate_id !== candidateId) {
          throw new Error(
            'resident source inspection call already captured different sources',
          );
        }
        const existing = this.getResidentSourceInspectionCandidate(candidateId);
        if (!existing)
          throw new Error('resident source inspection candidate disappeared');
        if (!sameResidentSoulSource(existing.soul, soul)) {
          throw new Error(
            'resident source inspection call already captured different sources',
          );
        }
        return finish(existing);
      }

      const storedSoul = this.getResidentSoulSourceSnapshot(soul.snapshotId);
      if (storedSoul) {
        if (!sameResidentSoulSource(storedSoul, soul)) {
          throw new Error('resident SOUL source snapshot identity conflict');
        }
      } else {
        this.database
          .prepare(
            `INSERT INTO context_resident_soul_source_snapshots(
               snapshot_id, schema_version, parser_generation,
               source_file_blob, source_file_hash, source_file_bytes,
               body_blob, body_hash, body_bytes, captured_at
             ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            soul.snapshotId,
            soul.parserGeneration,
            Buffer.from(soul.sourceFile, 'utf8'),
            soul.sourceFileHash,
            soul.sourceFileBytes,
            Buffer.from(soul.body, 'utf8'),
            soul.bodyHash,
            soul.bodyBytes,
            soul.capturedAt,
          );
      }

      this.database
        .prepare(
          `INSERT INTO context_resident_source_inspection_candidates(
             candidate_id, schema_version, scope_kind, execution_context,
             activation_epoch, contract_artifact_id,
             contract_migration_checksum, contract_content_hash,
             contract_content_bytes, soul_snapshot_id, inspect_batch_id,
             inspect_batch_sha256, inspect_call_index, inspect_call_count,
             inspect_tool_name, inspect_arguments_sha256, observed_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          candidateId,
          'private_integrated_self_candidate',
          'legacy_monocontext_resident',
          activation.epoch,
          SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.artifactId,
          SCOPED_RUNTIME_CONTRACT_MIGRATION_CHECKSUM,
          SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.contentHash,
          SCOPED_RUNTIME_CONTRACT_ARTIFACT_V1.contentBytes,
          soul.snapshotId,
          provenance.batchId,
          provenance.batchSha256,
          provenance.callIndex,
          provenance.callCount,
          provenance.toolName,
          provenance.argumentsSha256,
          observedAt,
        );
      const created = this.getResidentSourceInspectionCandidate(candidateId);
      if (!created)
        throw new Error('resident source inspection candidate was not stored');
      return finish(created);
    });
  }

  authorizeResidentSourceCandidate(input: {
    candidateId: string;
    freshSoul: PromptFacingSoulSnapshot;
    provenance: ResidentToolCallSnapshotV1;
    authorizedAt: number;
  }): ResidentSourceCandidateAuthorizationV1;
  authorizeResidentSourceCandidate<T>(
    input: {
      candidateId: string;
      freshSoul: PromptFacingSoulSnapshot;
      provenance: ResidentToolCallSnapshotV1;
      authorizedAt: number;
    },
    finalize: (receipt: ResidentSourceCandidateAuthorizationV1) => T,
  ): T;
  authorizeResidentSourceCandidate<T>(
    input: {
      candidateId: string;
      freshSoul: PromptFacingSoulSnapshot;
      provenance: ResidentToolCallSnapshotV1;
      authorizedAt: number;
    },
    finalize?: (receipt: ResidentSourceCandidateAuthorizationV1) => T,
  ): ResidentSourceCandidateAuthorizationV1 | T {
    if (!/^resident-source-candidate:[0-9a-f]{64}$/.test(input.candidateId)) {
      throw new Error('resident source authorization candidateId is invalid');
    }
    const authorizedAt = timestamp(
      'resident source authorization authorizedAt',
      input.authorizedAt,
    );
    const freshSoul = normalizeResidentSoulSnapshot({
      parserGeneration: input.freshSoul.parserGeneration,
      sourceFile: input.freshSoul.sourceFile,
      sourceFileHash: input.freshSoul.sourceFileHash,
      sourceFileBytes: input.freshSoul.sourceFileBytes,
      body: input.freshSoul.body,
      bodyHash: input.freshSoul.bodyHash,
      bodyBytes: input.freshSoul.bodyBytes,
      capturedAt: authorizedAt,
    });
    const provenance = normalizeResidentAuthorizationProvenance(input.provenance);
    const finish = (receipt: ResidentSourceCandidateAuthorizationV1) =>
      finalize ? finalize(receipt) : receipt;

    return transaction(this.database, () => {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new Error('resident source authorization requires dark graph mode');
      }
      const capture = this.getResidentSourceInspectionCandidate(input.candidateId);
      if (!capture) {
        throw new Error('resident source authorization candidate does not exist');
      }
      const { candidate, soul } = capture;
      if (candidate.activationEpoch !== activation.epoch) {
        throw new Error(
          'resident source authorization candidate has a stale activation epoch',
        );
      }
      if (candidate.inspectBatchId === provenance.batchId) {
        throw new Error(
          'resident source authorization requires a different assistant batch than inspection',
        );
      }
      if (!sameResidentSoulSource(soul, freshSoul)) {
        throw new Error(
          'resident source authorization requires the current exact inspected SOUL source',
        );
      }
      const authorizationId = residentSourceAuthorizationId({
        candidate,
        provenance,
      });
      const priorCall = this.database
        .prepare(
          `SELECT authorization_id
           FROM context_resident_source_candidate_authorizations
           WHERE authorize_batch_id = ? AND authorize_call_index = ?`,
        )
        .get(provenance.batchId, provenance.callIndex) as
        | { authorization_id: string }
        | undefined;
      if (priorCall) {
        if (priorCall.authorization_id !== authorizationId) {
          throw new Error(
            'resident source authorization call already authorized different sources',
          );
        }
        const existing = this.getResidentSourceCandidateAuthorization(
          authorizationId,
        );
        if (!existing) {
          throw new Error('resident source candidate authorization disappeared');
        }
        return finish(existing);
      }
      const priorCandidate = this.database
        .prepare(
          `SELECT authorization_id
           FROM context_resident_source_candidate_authorizations
           WHERE candidate_id = ?`,
        )
        .get(candidate.candidateId) as
        | { authorization_id: string }
        | undefined;
      if (priorCandidate) {
        throw new Error(
          'resident source candidate was already authorized by a different call',
        );
      }

      this.database
        .prepare(
          `INSERT INTO context_resident_source_candidate_authorizations(
             authorization_id, schema_version, authorization_kind, scope_kind,
             execution_context, candidate_id, activation_epoch,
             contract_artifact_id, contract_migration_checksum,
             contract_content_hash, contract_content_bytes, soul_snapshot_id,
             authorize_batch_id, authorize_batch_sha256, authorize_call_index,
             authorize_call_count, authorize_tool_name,
             authorize_arguments_sha256, authorized_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          authorizationId,
          'resident_source_candidate',
          'private_integrated_self_source',
          'legacy_monocontext_resident',
          candidate.candidateId,
          candidate.activationEpoch,
          candidate.contractArtifactId,
          candidate.contractMigrationChecksum,
          candidate.contractContentHash,
          candidate.contractContentBytes,
          candidate.soulSnapshotId,
          provenance.batchId,
          provenance.batchSha256,
          provenance.callIndex,
          provenance.callCount,
          provenance.toolName,
          provenance.argumentsSha256,
          authorizedAt,
        );
      const created = this.getResidentSourceCandidateAuthorization(
        authorizationId,
      );
      if (!created) {
        throw new Error('resident source candidate authorization was not stored');
      }
      return finish(created);
    });
  }

  deriveResidentIdentitySystemLayers(input: {
    authorizationId: string;
    freshSoul: PromptFacingSoulSnapshot;
    provenance: ResidentToolCallSnapshotV1;
    derivedAt: number;
  }): ResidentIdentitySystemDerivationV1;
  deriveResidentIdentitySystemLayers<T>(
    input: {
      authorizationId: string;
      freshSoul: PromptFacingSoulSnapshot;
      provenance: ResidentToolCallSnapshotV1;
      derivedAt: number;
    },
    finalize: (receipt: ResidentIdentitySystemDerivationV1) => T,
  ): T;
  deriveResidentIdentitySystemLayers<T>(
    input: {
      authorizationId: string;
      freshSoul: PromptFacingSoulSnapshot;
      provenance: ResidentToolCallSnapshotV1;
      derivedAt: number;
    },
    finalize?: (receipt: ResidentIdentitySystemDerivationV1) => T,
  ): ResidentIdentitySystemDerivationV1 | T {
    if (!/^resident-source-authorization:[0-9a-f]{64}$/.test(input.authorizationId)) {
      throw new Error(
        'resident identity system derivation authorizationId is invalid',
      );
    }
    const derivedAt = timestamp(
      'resident identity system derivation derivedAt',
      input.derivedAt,
    );
    const freshSoul = normalizeResidentSoulSnapshot({
      parserGeneration: input.freshSoul.parserGeneration,
      sourceFile: input.freshSoul.sourceFile,
      sourceFileHash: input.freshSoul.sourceFileHash,
      sourceFileBytes: input.freshSoul.sourceFileBytes,
      body: input.freshSoul.body,
      bodyHash: input.freshSoul.bodyHash,
      bodyBytes: input.freshSoul.bodyBytes,
      capturedAt: derivedAt,
    });
    const provenance = normalizeResidentIdentityDerivationProvenance(
      input.provenance,
    );
    const finish = (receipt: ResidentIdentitySystemDerivationV1) =>
      finalize ? finalize(receipt) : receipt;

    return transaction(this.database, () => {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new Error(
          'resident identity system derivation requires dark graph mode',
        );
      }
      const authorization = this.getResidentSourceCandidateAuthorization(
        input.authorizationId,
      );
      if (!authorization) {
        throw new Error(
          'resident identity system derivation authorization does not exist',
        );
      }
      if (authorization.activationEpoch !== activation.epoch) {
        throw new Error(
          'resident identity system derivation authorization has a stale activation epoch',
        );
      }
      const capture = this.getResidentSourceInspectionCandidate(
        authorization.candidateId,
      );
      if (!capture) {
        throw new Error(
          'resident identity system derivation candidate does not exist',
        );
      }
      if (
        provenance.batchId === authorization.authorizeBatchId ||
        provenance.batchId === capture.candidate.inspectBatchId
      ) {
        throw new Error(
          'resident identity system derivation requires a later distinct assistant batch',
        );
      }
      if (!sameResidentSoulSource(capture.soul, freshSoul)) {
        throw new Error(
          'resident identity system derivation requires the current exact authorized SOUL source',
        );
      }
      if (derivedAt < authorization.authorizedAt) {
        throw new Error(
          'resident identity system derivation predates its authorization',
        );
      }

      const priorCall = this.database
        .prepare(
          `SELECT derivation_id, authorization_id, derive_batch_sha256,
                  derive_call_count, derive_tool_name, derive_arguments_sha256
           FROM context_resident_identity_system_derivations
           WHERE derive_batch_id = ? AND derive_call_index = ?`,
        )
        .get(provenance.batchId, provenance.callIndex) as
        | {
            derivation_id: string;
            authorization_id: string;
            derive_batch_sha256: string;
            derive_call_count: number;
            derive_tool_name: string;
            derive_arguments_sha256: string;
          }
        | undefined;
      if (priorCall) {
        if (
          priorCall.authorization_id !== authorization.authorizationId ||
          priorCall.derive_batch_sha256 !== provenance.batchSha256 ||
          priorCall.derive_call_count !== provenance.callCount ||
          priorCall.derive_tool_name !== provenance.toolName ||
          priorCall.derive_arguments_sha256 !== provenance.argumentsSha256
        ) {
          throw new Error(
            'resident identity system derivation call already derived different sources',
          );
        }
        const existing = this.getResidentIdentitySystemDerivation(
          residentIdentitySystemDerivationId(priorCall.derivation_id),
        );
        if (!existing || existing.activationEpoch !== activation.epoch) {
          throw new Error('resident identity system derivation disappeared');
        }
        return finish(existing);
      }
      const priorAuthorization = this.database
        .prepare(
          `SELECT derivation_id
           FROM context_resident_identity_system_derivations
           WHERE authorization_id = ?`,
        )
        .get(authorization.authorizationId) as
        | { derivation_id: string }
        | undefined;
      if (priorAuthorization) {
        throw new Error(
          'resident identity authorization was already derived by a different call',
        );
      }

      const artifact = this.getScopedRuntimeContractArtifact();
      const last = this.database
        .prepare(
          `SELECT derivation_id, authority_revision, derived_at
           FROM context_resident_identity_system_derivations
           WHERE activation_epoch = ?
           ORDER BY authority_revision DESC
           LIMIT 1`,
        )
        .get(activation.epoch) as
        | {
            derivation_id: string;
            authority_revision: number;
            derived_at: number;
          }
        | undefined;
      if (last && last.derived_at > derivedAt) {
        throw new Error(
          'resident identity system derivation predates its predecessor',
        );
      }
      const authorityRevision = (last?.authority_revision ?? 0) + 1;
      const predecessorDerivationId = last
        ? residentIdentitySystemDerivationId(last.derivation_id)
        : null;
      const contractLayerId = systemLayerIdentity({
        kind: 'runtime_contract',
        visibility: 'global_contract',
        worldId: null,
        rendererGeneration: artifact.systemRendererGeneration,
        policyGeneration: artifact.policyGeneration,
        sourceKind: artifact.sourceKind,
        sourceHash: artifact.sourceHash,
        contentHash: artifact.contentHash,
        contentBytes: artifact.contentBytes,
      });
      const identityLayerId = systemLayerIdentity({
        kind: 'identity',
        visibility: 'integrated_self',
        worldId: null,
        rendererGeneration: artifact.systemRendererGeneration,
        policyGeneration: artifact.policyGeneration,
        sourceKind: 'soul_snapshot',
        sourceHash: capture.soul.sourceFileHash,
        contentHash: capture.soul.bodyHash,
        contentBytes: capture.soul.bodyBytes,
      });
      const contractApprovalId = systemLayerApprovalIdentity({
        layerId: contractLayerId,
        role: 'scoped_runtime_contract',
        basisKind: 'authored_scoped_contract',
        basisRef: artifact.artifactId,
        basisHash: artifact.sourceHash,
        approvalGeneration: 1,
      });
      const identityApprovalId = systemLayerApprovalIdentity({
        layerId: identityLayerId,
        role: 'identity',
        basisKind: 'soul_snapshot',
        basisRef: capture.soul.snapshotId,
        basisHash: capture.soul.sourceFileHash,
        approvalGeneration: 1,
      });
      const contractLayerExists =
        this.getSystemLayerProjection(contractLayerId) !== null;
      const contractApprovalExists =
        this.getSystemLayerApproval(contractApprovalId) !== null;
      const identityLayerExists =
        this.getSystemLayerProjection(identityLayerId) !== null;
      const identityApprovalExists =
        this.getSystemLayerApproval(identityApprovalId) !== null;
      const verifyReceiptedPair = (
        layerId: SystemLayerProjectionId,
        approvalId: SystemLayerApprovalId,
        layerExists: boolean,
        approvalExists: boolean,
        layerColumn: 'contract_layer_id' | 'identity_layer_id',
        approvalColumn: 'contract_approval_id' | 'identity_approval_id',
      ) => {
        if (!layerExists && !approvalExists) return;
        if (!layerExists || !approvalExists) {
          throw new Error(
            'resident identity system derivation refuses preexisting unreceipted target rows',
          );
        }
        const origin = this.database
          .prepare(
            `SELECT derivation_id
             FROM context_resident_identity_system_derivations
             WHERE ${layerColumn} = ? AND ${approvalColumn} = ?
             ORDER BY authority_revision ASC
             LIMIT 1`,
          )
          .get(layerId, approvalId) as { derivation_id: string } | undefined;
        if (
          !origin ||
          !this.getResidentIdentitySystemDerivation(
            residentIdentitySystemDerivationId(origin.derivation_id),
          )
        ) {
          throw new Error(
            'resident identity system derivation refuses preexisting unreceipted target rows',
          );
        }
      };
      verifyReceiptedPair(
        contractLayerId,
        contractApprovalId,
        contractLayerExists,
        contractApprovalExists,
        'contract_layer_id',
        'contract_approval_id',
      );
      verifyReceiptedPair(
        identityLayerId,
        identityApprovalId,
        identityLayerExists,
        identityApprovalExists,
        'identity_layer_id',
        'identity_approval_id',
      );
      const derivationId = residentIdentitySystemDerivationIdentity({
        activationEpoch: activation.epoch,
        authorityRevision,
        predecessorDerivationId,
        authorizationId: authorization.authorizationId,
        contractArtifactId: artifact.artifactId,
        soulSnapshotId: capture.soul.snapshotId,
        contractLayerId,
        contractApprovalId,
        identityLayerId,
        identityApprovalId,
        provenance,
      });

      if (!contractLayerExists) {
        this.createSystemLayerProjection({
          kind: 'runtime_contract',
          visibility: 'global_contract',
          worldId: null,
          rendererGeneration: artifact.systemRendererGeneration,
          policyGeneration: artifact.policyGeneration,
          sourceKind: artifact.sourceKind,
          sourceHash: artifact.sourceHash,
          content: artifact.content,
          createdAt: derivedAt,
        });
        this.approveSystemLayer({
          layerId: contractLayerId,
          role: 'scoped_runtime_contract',
          basisRef: artifact.artifactId,
          approvalGeneration: 1,
          approvedAt: derivedAt,
        });
      }
      if (!identityLayerExists) {
        this.createSystemLayerProjection({
          kind: 'identity',
          visibility: 'integrated_self',
          worldId: null,
          rendererGeneration: artifact.systemRendererGeneration,
          policyGeneration: artifact.policyGeneration,
          sourceKind: 'soul_snapshot',
          sourceHash: capture.soul.sourceFileHash,
          content: capture.soul.body,
          createdAt: derivedAt,
        });
        this.approveSystemLayer({
          layerId: identityLayerId,
          role: 'identity',
          basisRef: capture.soul.snapshotId,
          approvalGeneration: 1,
          approvedAt: derivedAt,
        });
      }
      this.database
        .prepare(
          `INSERT INTO context_resident_identity_system_derivations(
             derivation_id, schema_version, derivation_kind,
             activation_epoch, authority_revision, predecessor_derivation_id,
             authorization_id, contract_artifact_id, soul_snapshot_id,
             contract_layer_id, contract_approval_id, identity_layer_id,
             identity_approval_id, derive_batch_id, derive_batch_sha256,
             derive_call_index, derive_call_count, derive_tool_name,
             derive_arguments_sha256, derived_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          derivationId,
          'authorized_resident_identity_layers',
          activation.epoch,
          authorityRevision,
          predecessorDerivationId,
          authorization.authorizationId,
          artifact.artifactId,
          capture.soul.snapshotId,
          contractLayerId,
          contractApprovalId,
          identityLayerId,
          identityApprovalId,
          provenance.batchId,
          provenance.batchSha256,
          provenance.callIndex,
          provenance.callCount,
          provenance.toolName,
          provenance.argumentsSha256,
          derivedAt,
        );
      const created = this.getResidentIdentitySystemDerivation(derivationId);
      if (!created) {
        throw new Error('resident identity system derivation was not stored');
      }
      return finish(created);
    });
  }

  bindResidentCurrentWorldProfile(input: {
    derivationId: ResidentIdentitySystemDerivationId;
    worldId: WorldId;
    eventId: EventId;
    sequence: number;
    provenance: ResidentToolCallSnapshotV1;
    boundAt: number;
  }): ResidentWorldProfileBindingV1;
  bindResidentCurrentWorldProfile<T>(
    input: {
      derivationId: ResidentIdentitySystemDerivationId;
      worldId: WorldId;
      eventId: EventId;
      sequence: number;
      provenance: ResidentToolCallSnapshotV1;
      boundAt: number;
    },
    finalize: (receipt: ResidentWorldProfileBindingV1) => T,
  ): T;
  bindResidentCurrentWorldProfile<T>(
    input: {
      derivationId: ResidentIdentitySystemDerivationId;
      worldId: WorldId;
      eventId: EventId;
      sequence: number;
      provenance: ResidentToolCallSnapshotV1;
      boundAt: number;
    },
    finalize?: (receipt: ResidentWorldProfileBindingV1) => T,
  ): ResidentWorldProfileBindingV1 | T {
    const derivationIdValue = residentIdentitySystemDerivationId(
      input.derivationId,
    );
    const targetWorldId = worldId(input.worldId);
    const ingressEventId = eventId(input.eventId);
    const ingressSequence = generation(
      'resident world profile binding sequence',
      input.sequence,
    );
    if (ingressSequence < 1) {
      throw new Error('resident world profile binding sequence is invalid');
    }
    const provenance = normalizeResidentWorldProfileBindingProvenance(
      input.provenance,
    );
    const boundAt = timestamp(
      'resident world profile binding boundAt',
      input.boundAt,
    );
    const finish = (receipt: ResidentWorldProfileBindingV1) =>
      finalize ? finalize(receipt) : receipt;

    return transaction(this.database, () => {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new Error('resident world profile binding requires dark graph mode');
      }
      const derivation = this.getResidentIdentitySystemDerivation(
        derivationIdValue,
      );
      if (!derivation) {
        throw new Error('resident world profile binding derivation does not exist');
      }
      if (derivation.activationEpoch !== activation.epoch) {
        throw new Error(
          'resident world profile binding derivation has a stale activation epoch',
        );
      }
      const latest = this.database
        .prepare(
          `SELECT derivation_id
           FROM context_resident_identity_system_derivations
           WHERE activation_epoch = ?
           ORDER BY authority_revision DESC
           LIMIT 1`,
        )
        .get(activation.epoch) as { derivation_id: string } | undefined;
      if (!latest || latest.derivation_id !== derivation.derivationId) {
        throw new Error(
          'resident world profile binding requires the current identity derivation',
        );
      }
      const sourceBatches = this.database
        .prepare(
          `SELECT d.derive_batch_id, a.authorize_batch_id, c.inspect_batch_id
           FROM context_resident_identity_system_derivations d
           JOIN context_resident_source_candidate_authorizations a
             ON a.authorization_id = d.authorization_id
           JOIN context_resident_source_inspection_candidates c
             ON c.candidate_id = a.candidate_id
           WHERE d.derivation_id = ?`,
        )
        .get(derivation.derivationId) as
        | {
            derive_batch_id: string;
            authorize_batch_id: string;
            inspect_batch_id: string;
          }
        | undefined;
      if (
        !sourceBatches ||
        provenance.batchId === sourceBatches.derive_batch_id ||
        provenance.batchId === sourceBatches.authorize_batch_id ||
        provenance.batchId === sourceBatches.inspect_batch_id
      ) {
        throw new Error(
          'resident world profile binding requires a later distinct assistant batch',
        );
      }
      const event = this.getWorldEvent(ingressEventId);
      if (
        !event ||
        event.worldId !== targetWorldId ||
        event.sequence !== ingressSequence ||
        !['inbound:discord', 'inbound:signal'].includes(event.kind)
      ) {
        throw new Error(
          'resident world profile binding requires exact current social ingress lineage',
        );
      }
      if (
        boundAt < derivation.derivedAt ||
        boundAt < event.recordedAt
      ) {
        throw new Error('resident world profile binding chronology is invalid');
      }

      const contract = this.requireSystemProfileApproval(
        derivation.contractApprovalId,
        'scoped_runtime_contract',
      );
      this.requireSystemProfileApproval(
        derivation.identityApprovalId,
        'identity',
      );
      const profile: SystemProfileV1 = {
        schemaVersion: 1,
        worldId: targetWorldId,
        activationEpoch: activation.epoch,
        systemRendererGeneration: contract.layer.rendererGeneration,
        policyGeneration: contract.layer.policyGeneration,
        approvals: {
          scopedRuntimeContract: derivation.contractApprovalId,
          identity: derivation.identityApprovalId,
          integratedSelf: null,
          worldPolicy: null,
        },
      };
      this.validateSystemProfileLineage(profile, boundAt);
      const profileJson = serialize(profile);
      const profileHash = hashContextBytes(profileJson);
      const profileIdValue = systemProfileIdentity(profile);
      const bindingId = residentWorldProfileBindingIdentity({
        activationEpoch: activation.epoch,
        derivationId: derivation.derivationId,
        worldId: targetWorldId,
        ingressEventId,
        ingressSequence,
        profileId: profileIdValue,
        profileHash,
        profileHeadRevision: 1,
        predecessorProfileId: null,
        provenance,
      });

      const priorCall = this.database
        .prepare(
          `SELECT * FROM context_resident_world_profile_bindings
           WHERE bind_batch_id = ? AND bind_call_index = ?`,
        )
        .get(provenance.batchId, provenance.callIndex) as
        | ResidentWorldProfileBindingRow
        | undefined;
      if (priorCall) {
        if (
          priorCall.binding_id !== bindingId ||
          priorCall.derivation_id !== derivation.derivationId ||
          priorCall.world_id !== targetWorldId ||
          priorCall.ingress_event_id !== ingressEventId ||
          priorCall.ingress_sequence !== ingressSequence ||
          priorCall.profile_id !== profileIdValue ||
          priorCall.profile_hash !== profileHash ||
          priorCall.bind_batch_sha256 !== provenance.batchSha256 ||
          priorCall.bind_call_count !== provenance.callCount ||
          priorCall.bind_tool_name !== provenance.toolName ||
          priorCall.bind_arguments_sha256 !== provenance.argumentsSha256
        ) {
          throw new Error(
            'resident world profile binding call already bound different lineage',
          );
        }
        const existing = this.getResidentWorldProfileBinding(bindingId);
        if (!existing || existing.activationEpoch !== activation.epoch) {
          throw new Error('resident world profile binding disappeared');
        }
        return finish(existing);
      }
      const priorWorld = this.database
        .prepare(
          `SELECT binding_id FROM context_resident_world_profile_bindings
           WHERE activation_epoch = ? AND world_id = ?`,
        )
        .get(activation.epoch, targetWorldId) as
        | { binding_id: string }
        | undefined;
      if (priorWorld) {
        throw new Error(
          'resident world profile was already bound by a different call',
        );
      }
      if (
        this.getSystemProfile(profileIdValue) ||
        this.getSystemProfileHead(targetWorldId, activation.epoch)
      ) {
        throw new Error(
          'resident world profile binding refuses preexisting unreceipted target rows',
        );
      }

      this.database
        .prepare(
          `INSERT INTO context_system_profiles(
             profile_id, world_id, activation_epoch,
             system_renderer_generation, policy_generation,
             scoped_runtime_contract_approval_id, identity_approval_id,
             integrated_self_approval_id, world_policy_approval_id,
             profile_json, profile_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          profileIdValue,
          profile.worldId,
          profile.activationEpoch,
          profile.systemRendererGeneration,
          profile.policyGeneration,
          profile.approvals.scopedRuntimeContract,
          profile.approvals.identity,
          profileJson,
          profileHash,
          boundAt,
        );
      this.database
        .prepare(
          `INSERT INTO context_system_profile_advances(
             world_id, activation_epoch, revision,
             predecessor_profile_id, profile_id, advanced_at
           ) VALUES (?, ?, 1, NULL, ?, ?)`,
        )
        .run(targetWorldId, activation.epoch, profileIdValue, boundAt);
      this.database
        .prepare(
          `INSERT INTO context_resident_world_profile_bindings(
             binding_id, schema_version, binding_kind, activation_epoch,
             derivation_id, world_id, ingress_event_id, ingress_sequence,
             profile_id, profile_hash, profile_head_revision,
             predecessor_profile_id, bind_batch_id, bind_batch_sha256,
             bind_call_index, bind_call_count, bind_tool_name,
             bind_arguments_sha256, bound_at
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bindingId,
          'resident_current_world_profile',
          activation.epoch,
          derivation.derivationId,
          targetWorldId,
          ingressEventId,
          ingressSequence,
          profileIdValue,
          profileHash,
          provenance.batchId,
          provenance.batchSha256,
          provenance.callIndex,
          provenance.callCount,
          provenance.toolName,
          provenance.argumentsSha256,
          boundAt,
        );
      const created = this.getResidentWorldProfileBinding(bindingId);
      if (!created) {
        throw new Error('resident world profile binding was not stored');
      }
      return finish(created);
    });
  }

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

  getDarkIngressGeneration(
    queueGeneration: number,
  ): DarkIngressGenerationRecord | null {
    const id = generation('queueGeneration', queueGeneration);
    if (id < 1) throw new Error('queueGeneration must be positive');
    const row = this.database
      .prepare(
        `SELECT queue_generation, first_admissible_sequence, activation_epoch
         FROM context_dark_ingress_generations WHERE queue_generation = ?`,
      )
      .get(id) as DarkIngressGenerationRow | undefined;
    return row ? mapDarkIngressGeneration(row) : null;
  }

  getDarkIngressAdmission(id: EventId): DarkIngressAdmissionRecord | null {
    const row = this.database
      .prepare(
        `SELECT event_id, world_id, source_sequence, activation_epoch,
                queue_generation, wake_class, message_renderer_generation,
                admitted_at
         FROM context_dark_ingress_admissions WHERE event_id = ?`,
      )
      .get(id) as DarkIngressAdmissionRow | undefined;
    return row ? mapDarkIngressAdmission(row) : null;
  }

  getDarkPendingBranchAttempt(
    id: BranchId,
  ): DarkPendingBranchAttemptRecord | null {
    const row = this.database
      .prepare(
        `SELECT branch_id, world_id, request_view_id, activation_epoch,
                queue_generation, max_events, selected_count,
                first_source_sequence, last_source_sequence, assembled_at
         FROM context_dark_pending_branch_attempts WHERE branch_id = ?`,
      )
      .get(id) as unknown as DarkPendingBranchAttemptRow | undefined;
    if (!row) return null;
    const attempt = mapDarkPendingBranchAttempt(row);
    const binding = this.getSystemProfileRequestViewBindingForView(
      attempt.requestViewId,
    );
    if (
      !binding ||
      binding.binding.worldId !== attempt.worldId ||
      binding.binding.activationEpoch !== attempt.activationEpoch
    ) {
      throw new Error(
        `stored context dark pending branch attempt lacks profile binding: ${id}`,
      );
    }
    return attempt;
  }

  getDarkPendingBranchAbandonment(
    id: BranchId,
  ): DarkPendingBranchAbandonmentRecord | null {
    const row = this.database
      .prepare(
        `SELECT branch_id, abandoned_at, reason
         FROM context_dark_pending_branch_abandonments WHERE branch_id = ?`,
      )
      .get(id) as unknown as DarkPendingBranchAbandonmentRow | undefined;
    return row ? mapDarkPendingBranchAbandonment(row) : null;
  }

  inspectNextDarkPendingBatch(input: {
    expectedActivationEpoch: number;
    queueGeneration: number;
    maxEvents: number;
  }): DarkPendingInspection {
    const expectedActivationEpoch = generation(
      'expectedActivationEpoch',
      input.expectedActivationEpoch,
    );
    const queueGeneration = generation(
      'queueGeneration',
      input.queueGeneration,
    );
    const maxEvents = generation('maxEvents', input.maxEvents);
    if (queueGeneration < 1) {
      throw new Error('queueGeneration must be positive');
    }
    if (maxEvents < 1 || maxEvents > 1_024) {
      throw new Error('maxEvents must be between 1 and 1024');
    }

    const activation = this.getActivationState();
    if (
      activation.mode !== 'dark' ||
      activation.epoch !== expectedActivationEpoch
    ) {
      return {
        status: 'blocked',
        reason: 'activation_mismatch',
        expectedActivationEpoch,
        actualMode: activation.mode,
        actualActivationEpoch: activation.epoch,
      };
    }

    const rows = this.database
      .prepare(
        `SELECT
           a.event_id,
           a.world_id,
           a.source_sequence,
           a.activation_epoch,
           a.queue_generation,
           a.wake_class,
           a.message_renderer_generation,
           a.admitted_at,
           p.projection_id,
           p.source_event_id AS projection_source_event_id,
           p.world_id AS projection_world_id,
           p.renderer_generation AS projection_renderer_generation
         FROM context_dark_ingress_admissions AS a
         LEFT JOIN context_event_message_projections AS p
           ON p.source_event_id = a.event_id
          AND p.renderer_generation = a.message_renderer_generation
         ORDER BY a.source_sequence ASC
         LIMIT ?`,
      )
      .all(maxEvents + 1) as unknown as DarkPendingInspectionRow[];
    if (rows.length === 0) return { status: 'empty' };

    const first = mapDarkIngressAdmission(rows[0]!);
    if (
      first.activationEpoch !== expectedActivationEpoch ||
      first.queueGeneration !== queueGeneration
    ) {
      return {
        status: 'blocked',
        reason: 'generation_mismatch',
        eventId: first.eventId,
        worldId: first.worldId,
        sourceSequence: first.sourceSequence,
        expectedActivationEpoch,
        actualActivationEpoch: first.activationEpoch,
        expectedQueueGeneration: queueGeneration,
        actualQueueGeneration: first.queueGeneration,
      };
    }

    const projectionIdFor = (
      row: DarkPendingInspectionRow,
      admission: DarkIngressAdmissionRecord,
    ): EventMessageProjectionId | null => {
      if (
        row.projection_id === null &&
        row.projection_source_event_id === null &&
        row.projection_world_id === null &&
        row.projection_renderer_generation === null
      ) {
        return null;
      }
      if (
        row.projection_id === null ||
        row.projection_source_event_id !== admission.eventId ||
        row.projection_world_id !== admission.worldId ||
        row.projection_renderer_generation !==
          admission.messageRendererGeneration
      ) {
        throw new Error(
          `stored dark ingress projection metadata is invalid: ${admission.eventId}`,
        );
      }
      return eventMessageProjectionId(row.projection_id);
    };

    const firstProjectionId = projectionIdFor(rows[0]!, first);
    if (!firstProjectionId) {
      return {
        status: 'blocked',
        reason: 'projection_unavailable',
        eventId: first.eventId,
        worldId: first.worldId,
        sourceSequence: first.sourceSequence,
        messageRendererGeneration: first.messageRendererGeneration,
      };
    }

    const items: DarkPendingInspectionItem[] = [];
    let stopReason: Extract<
      DarkPendingInspection,
      { status: 'ready' }
    >['stopReason'] = 'end';
    for (let index = 0; index < rows.length; index += 1) {
      if (index === maxEvents) {
        stopReason = 'limit';
        break;
      }
      const row = rows[index]!;
      const admission = mapDarkIngressAdmission(row);
      if (
        admission.activationEpoch !== expectedActivationEpoch ||
        admission.queueGeneration !== queueGeneration
      ) {
        stopReason = 'generation_boundary';
        break;
      }
      if (admission.worldId !== first.worldId) {
        stopReason = 'world_boundary';
        break;
      }
      if (
        admission.messageRendererGeneration !== first.messageRendererGeneration
      ) {
        stopReason = 'renderer_boundary';
        break;
      }
      const projectionId = projectionIdFor(row, admission);
      if (!projectionId) {
        stopReason = 'projection_unavailable';
        break;
      }
      items.push({
        eventId: admission.eventId,
        sourceSequence: admission.sourceSequence,
        projectionId,
      });
    }
    return {
      status: 'ready',
      worldId: first.worldId,
      messageRendererGeneration: first.messageRendererGeneration,
      items,
      stopReason,
    };
  }

  admitDarkInboundEvent(input: {
    expectedActivationEpoch: number;
    queueGeneration: number;
    wakeClass: DarkIngressWakeClass;
    messageRendererGeneration: number;
    event: {
      eventId: EventId;
      worldId: WorldId;
      kind: string;
      payload: unknown;
      occurredAt: number;
      recordedAt: number;
    };
    admittedAt: number;
  }): DarkInboundAdmissionReceipt {
    const expectedActivationEpoch = generation(
      'expectedActivationEpoch',
      input.expectedActivationEpoch,
    );
    const queueGeneration = generation(
      'queueGeneration',
      input.queueGeneration,
    );
    const messageRendererGeneration = generation(
      'messageRendererGeneration',
      input.messageRendererGeneration,
    );
    if (queueGeneration < 1) {
      throw new Error('queueGeneration must be positive');
    }
    if (messageRendererGeneration < 1) {
      throw new Error('messageRendererGeneration must be positive');
    }
    if (input.wakeClass !== 'text_user_turn') {
      throw new Error('unsupported dark ingress wake class');
    }
    const occurredAt = timestamp('occurredAt', input.event.occurredAt);
    const recordedAt = timestamp('recordedAt', input.event.recordedAt);
    const admittedAt = timestamp('admittedAt', input.admittedAt);
    const payloadJson = serialize(input.event.payload);
    const payloadHash = hashContextBytes(payloadJson);

    return transaction(this.database, () => {
      const existingEvent = this.getWorldEvent(input.event.eventId);
      const existingAdmission = this.getDarkIngressAdmission(
        input.event.eventId,
      );
      if (existingEvent || existingAdmission) {
        if (
          !existingEvent ||
          !existingAdmission ||
          existingEvent.worldId !== input.event.worldId ||
          existingEvent.kind !== input.event.kind ||
          existingEvent.payloadJson !== payloadJson ||
          existingEvent.payloadHash !== payloadHash ||
          existingEvent.occurredAt !== occurredAt ||
          existingEvent.recordedAt !== recordedAt ||
          existingAdmission.worldId !== input.event.worldId ||
          existingAdmission.sourceSequence !== existingEvent.sequence ||
          existingAdmission.activationEpoch !== expectedActivationEpoch ||
          existingAdmission.queueGeneration !== queueGeneration ||
          existingAdmission.wakeClass !== input.wakeClass ||
          existingAdmission.messageRendererGeneration !==
            messageRendererGeneration ||
          existingAdmission.admittedAt !== admittedAt
        ) {
          throw new Error(
            `context dark ingress admission conflict: ${input.event.eventId}`,
          );
        }
        const existingGeneration =
          this.getDarkIngressGeneration(queueGeneration);
        if (
          !existingGeneration ||
          existingGeneration.activationEpoch !== expectedActivationEpoch ||
          existingEvent.sequence < existingGeneration.firstAdmissibleSequence
        ) {
          throw new Error(
            `context dark ingress generation conflict: ${queueGeneration}`,
          );
        }
        return {
          generation: existingGeneration,
          event: existingEvent,
          admission: existingAdmission,
        };
      }

      const activation = this.getActivationState();
      if (
        activation.mode !== 'dark' ||
        activation.epoch !== expectedActivationEpoch
      ) {
        throw new StaleActivationStateError(expectedActivationEpoch);
      }
      const queue = this.getDarkIngressGeneration(queueGeneration);
      if (!queue || queue.activationEpoch !== expectedActivationEpoch) {
        throw new Error(
          `context dark ingress generation is unavailable: ${queueGeneration}`,
        );
      }
      const event = this.appendWorldEvent({
        eventId: input.event.eventId,
        worldId: input.event.worldId,
        kind: input.event.kind,
        payload: input.event.payload,
        occurredAt,
        recordedAt,
      });
      if (event.sequence < queue.firstAdmissibleSequence) {
        throw new Error('context dark ingress event predates its generation');
      }
      this.database
        .prepare(
          `INSERT INTO context_dark_ingress_admissions(
             event_id, world_id, source_sequence, activation_epoch,
             queue_generation, wake_class, message_renderer_generation,
             admitted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.eventId,
          event.worldId,
          event.sequence,
          expectedActivationEpoch,
          queueGeneration,
          input.wakeClass,
          messageRendererGeneration,
          admittedAt,
        );
      const admission = this.getDarkIngressAdmission(event.eventId);
      if (!admission) {
        throw new Error('context dark ingress admission was not persisted');
      }
      return { generation: queue, event, admission };
    });
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
        throw new Error(
          `system layer projection identity conflict: ${layerId}`,
        );
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

  approveSystemLayer(input: {
    layerId: SystemLayerProjectionId;
    role: SystemLayerApprovalRole;
    basisRef: string;
    approvalGeneration: number;
    approvedAt: number;
  }): SystemLayerApprovalRecord {
    const layer = this.getSystemLayerProjection(input.layerId);
    if (!layer) {
      throw new Error(`system layer projection not found: ${input.layerId}`);
    }
    const role = systemLayerApprovalRole(input.role);
    if (!systemLayerApprovalMatches(layer, role)) {
      throw new Error('system layer approval role does not match layer scope');
    }
    const basisKind = SYSTEM_LAYER_APPROVAL_RULES[role].basisKind;
    const basisRef = systemLayerApprovalBasisRef(input.basisRef);
    const approvalGeneration = generation(
      'approvalGeneration',
      input.approvalGeneration,
    );
    if (approvalGeneration < 1) {
      throw new Error('system layer approval generation is invalid');
    }
    const approvedAt = timestamp('approvedAt', input.approvedAt);
    if (approvedAt < layer.createdAt) {
      throw new Error('system layer approval predates its layer');
    }
    const basisHash = layer.sourceHash;
    const approvalId = systemLayerApprovalIdentity({
      layerId: layer.layerId,
      role,
      basisKind,
      basisRef,
      basisHash,
      approvalGeneration,
    });
    const collision = this.database
      .prepare(
        `SELECT approval_id FROM context_system_layer_approvals
         WHERE approval_id = ? OR (layer_id = ? AND approval_generation = ?)`,
      )
      .get(
        approvalId,
        layer.layerId,
        approvalGeneration,
      ) as unknown as { approval_id: string } | undefined;
    if (collision) {
      const existing = this.getSystemLayerApproval(
        systemLayerApprovalId(collision.approval_id),
      );
      if (
        !existing ||
        existing.approvalId !== approvalId ||
        existing.layerId !== layer.layerId ||
        existing.role !== role ||
        existing.basisKind !== basisKind ||
        existing.basisRef !== basisRef ||
        existing.basisHash !== basisHash ||
        existing.approvalGeneration !== approvalGeneration ||
        existing.approvedAt !== approvedAt
      ) {
        throw new Error(
          `system layer approval identity conflict: ${collision.approval_id}`,
        );
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO context_system_layer_approvals(
           approval_id, layer_id, approval_role, basis_kind, basis_ref,
           basis_hash, approval_generation, approved_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        approvalId,
        layer.layerId,
        role,
        basisKind,
        basisRef,
        basisHash,
        approvalGeneration,
        approvedAt,
      );
    return this.getSystemLayerApproval(approvalId)!;
  }

  getSystemLayerApproval(
    id: SystemLayerApprovalId,
  ): SystemLayerApprovalRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_system_layer_approvals WHERE approval_id = ?',
      )
      .get(id) as unknown as SystemLayerApprovalRow | undefined;
    if (!row) return null;
    const layer = this.getSystemLayerProjection(
      systemLayerProjectionId(row.layer_id),
    );
    if (!layer) {
      throw new Error(`stored system layer approval has no layer: ${row.approval_id}`);
    }
    return mapSystemLayerApproval(row, layer);
  }

  private requireSystemProfileApproval(
    id: SystemLayerApprovalId,
    role: SystemLayerApprovalRole,
  ): {
    approval: SystemLayerApprovalRecord;
    layer: SystemLayerProjectionRecord;
  } {
    const approval = this.getSystemLayerApproval(id);
    if (!approval || approval.role !== role) {
      throw new Error(`system profile ${role} approval is invalid`);
    }
    const layer = this.getSystemLayerProjection(approval.layerId);
    if (!layer) {
      throw new Error(`system profile ${role} layer is missing`);
    }
    return { approval, layer };
  }

  private validateSystemProfileLineage(
    profile: SystemProfileV1,
    createdAt: number,
  ): void {
    if (profile.worldId === LEGACY_WORLD_ID) {
      throw new Error('system profile cannot target the legacy world');
    }
    const refs: readonly [
      SystemLayerApprovalRole,
      SystemLayerApprovalId | null,
    ][] = [
      ['scoped_runtime_contract', profile.approvals.scopedRuntimeContract],
      ['identity', profile.approvals.identity],
      ['integrated_self', profile.approvals.integratedSelf],
      ['world_policy', profile.approvals.worldPolicy],
    ];
    for (const [role, approvalId] of refs) {
      if (approvalId === null) continue;
      const { approval, layer } = this.requireSystemProfileApproval(approvalId, role);
      if (
        approval.approvedAt > createdAt ||
        layer.rendererGeneration !== profile.systemRendererGeneration ||
        layer.policyGeneration !== profile.policyGeneration ||
        (role === 'world_policy'
          ? layer.worldId !== profile.worldId
          : layer.worldId !== null)
      ) {
        throw new Error(`system profile ${role} lineage is invalid`);
      }
    }
  }

  createSystemProfile(input: {
    worldId: WorldId;
    scopedRuntimeContractApprovalId: SystemLayerApprovalId;
    identityApprovalId: SystemLayerApprovalId;
    integratedSelfApprovalId?: SystemLayerApprovalId | null;
    worldPolicyApprovalId?: SystemLayerApprovalId | null;
    createdAt: number;
  }): SystemProfileRecord {
    const targetWorldId = worldId(input.worldId);
    const activation = this.getActivationState();
    if (activation.mode !== 'dark') {
      throw new StaleActivationStateError(activation.epoch);
    }
    const contract = this.requireSystemProfileApproval(
      input.scopedRuntimeContractApprovalId,
      'scoped_runtime_contract',
    );
    const profile: SystemProfileV1 = {
      schemaVersion: 1,
      worldId: targetWorldId,
      activationEpoch: activation.epoch,
      systemRendererGeneration: contract.layer.rendererGeneration,
      policyGeneration: contract.layer.policyGeneration,
      approvals: {
        scopedRuntimeContract: input.scopedRuntimeContractApprovalId,
        identity: input.identityApprovalId,
        integratedSelf: input.integratedSelfApprovalId ?? null,
        worldPolicy: input.worldPolicyApprovalId ?? null,
      },
    };
    const createdAt = timestamp('createdAt', input.createdAt);
    this.validateSystemProfileLineage(profile, createdAt);
    const profileJson = serialize(profile);
    const profileHash = hashContextBytes(profileJson);
    const profileId = systemProfileIdentity(profile);
    const existing = this.getSystemProfile(profileId);
    if (existing) {
      if (
        existing.profileJson !== profileJson ||
        existing.profileHash !== profileHash ||
        existing.createdAt !== createdAt
      ) {
        throw new Error(`system profile identity conflict: ${profileId}`);
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO context_system_profiles(
           profile_id, world_id, activation_epoch,
           system_renderer_generation, policy_generation,
           scoped_runtime_contract_approval_id, identity_approval_id,
           integrated_self_approval_id, world_policy_approval_id,
           profile_json, profile_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        profile.worldId,
        profile.activationEpoch,
        profile.systemRendererGeneration,
        profile.policyGeneration,
        profile.approvals.scopedRuntimeContract,
        profile.approvals.identity,
        profile.approvals.integratedSelf,
        profile.approvals.worldPolicy,
        profileJson,
        profileHash,
        createdAt,
      );
    return this.getSystemProfile(profileId)!;
  }

  getSystemProfile(id: SystemProfileId): SystemProfileRecord | null {
    const row = this.database
      .prepare('SELECT * FROM context_system_profiles WHERE profile_id = ?')
      .get(id) as unknown as SystemProfileRow | undefined;
    if (!row) return null;
    const record = mapSystemProfile(row);
    this.validateSystemProfileLineage(record.profile, record.createdAt);
    return record;
  }

  private getSystemProfileHeadPrefix(
    targetWorldId: WorldId,
    activationEpoch: number,
    throughRevision: number | null,
  ): SystemProfileHead | null {
    const normalizedWorldId = worldId(targetWorldId);
    const normalizedEpoch = generation('activationEpoch', activationEpoch);
    const normalizedRevision =
      throughRevision === null
        ? null
        : generation('profileHeadRevision', throughRevision);
    if (normalizedRevision !== null && normalizedRevision < 1) {
      throw new Error('system profile head revision is invalid');
    }
    const rows = this.database
      .prepare(
        `SELECT * FROM context_system_profile_advances
         WHERE world_id = ? AND activation_epoch = ?
           AND (? IS NULL OR revision <= ?)
         ORDER BY revision ASC`,
      )
      .all(
        normalizedWorldId,
        normalizedEpoch,
        normalizedRevision,
        normalizedRevision,
      ) as unknown as SystemProfileAdvanceRow[];
    if (rows.length === 0) return null;
    let previous: SystemProfileHead | null = null;
    for (const row of rows) {
      const head = mapSystemProfileHead(row);
      const profile = this.getSystemProfile(head.profileId);
      if (
        !profile ||
        profile.profile.worldId !== head.worldId ||
        profile.profile.activationEpoch !== head.activationEpoch ||
        profile.createdAt > head.advancedAt
      ) {
        throw new Error('stored system profile head target is invalid');
      }
      if (
        head.revision !== (previous?.revision ?? 0) + 1 ||
        head.predecessorProfileId !== (previous?.profileId ?? null)
      ) {
        throw new Error('stored system profile head predecessor is invalid');
      }
      if (previous && head.advancedAt < previous.advancedAt) {
        throw new Error('stored system profile head chronology is invalid');
      }
      previous = head;
    }
    if (
      normalizedRevision !== null &&
      previous?.revision !== normalizedRevision
    ) {
      throw new Error('stored system profile head revision is missing');
    }
    return previous;
  }

  getSystemProfileHead(
    targetWorldId: WorldId,
    activationEpoch: number,
  ): SystemProfileHead | null {
    return this.getSystemProfileHeadPrefix(
      targetWorldId,
      activationEpoch,
      null,
    );
  }

  advanceSystemProfileHead(input: {
    worldId: WorldId;
    expectedRevision: number;
    expectedProfileId: SystemProfileId | null;
    profileId: SystemProfileId;
    advancedAt: number;
  }): SystemProfileHead {
    return transaction(this.database, () => {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new StaleActivationStateError(activation.epoch);
      }
      const expectedRevision = generation(
        'expectedRevision',
        input.expectedRevision,
      );
      const targetWorldId = worldId(input.worldId);
      const current = this.getSystemProfileHead(
        targetWorldId,
        activation.epoch,
      );
      if (
        (current?.revision ?? 0) !== expectedRevision ||
        (current?.profileId ?? null) !== input.expectedProfileId
      ) {
        throw new StaleSystemProfileHeadError(expectedRevision);
      }
      const target = this.getSystemProfile(input.profileId);
      if (
        !target ||
        target.profile.worldId !== targetWorldId ||
        target.profile.activationEpoch !== activation.epoch
      ) {
        throw new Error('system profile head target is invalid');
      }
      this.database
        .prepare(
          `INSERT INTO context_system_profile_advances(
             world_id, activation_epoch, revision,
             predecessor_profile_id, profile_id, advanced_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          targetWorldId,
          activation.epoch,
          expectedRevision + 1,
          current?.profileId ?? null,
          target.profileId,
          timestamp('advancedAt', input.advancedAt),
        );
      return this.getSystemProfileHead(targetWorldId, activation.epoch)!;
    });
  }

  private systemProfileLayerIds(
    profile: SystemProfileV1,
  ): readonly SystemLayerProjectionId[] {
    const layers = [
      this.requireSystemProfileApproval(
        profile.approvals.scopedRuntimeContract,
        'scoped_runtime_contract',
      ).layer.layerId,
      this.requireSystemProfileApproval(
        profile.approvals.identity,
        'identity',
      ).layer.layerId,
    ];
    if (profile.approvals.integratedSelf !== null) {
      layers.push(
        this.requireSystemProfileApproval(
          profile.approvals.integratedSelf,
          'integrated_self',
        ).layer.layerId,
      );
    }
    if (profile.approvals.worldPolicy !== null) {
      layers.push(
        this.requireSystemProfileApproval(
          profile.approvals.worldPolicy,
          'world_policy',
        ).layer.layerId,
      );
    }
    return layers;
  }

  createSystemProfileRequestViewBinding(input: {
    requestViewId: LocalBranchRequestViewId;
    expectedProfileId: SystemProfileId;
    expectedProfileHeadRevision: number;
    boundAt: number;
  }): SystemProfileRequestViewBindingRecord {
    return transaction(this.database, () =>
      this.createSystemProfileRequestViewBindingInTransaction(input),
    );
  }

  private createSystemProfileRequestViewBindingInTransaction(input: {
    requestViewId: LocalBranchRequestViewId;
    expectedProfileId: SystemProfileId;
    expectedProfileHeadRevision: number;
    boundAt: number;
  }): SystemProfileRequestViewBindingRecord {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new StaleActivationStateError(activation.epoch);
      }
      const requestView = this.getLocalBranchRequestView(input.requestViewId);
      if (!requestView) {
        throw new Error(`local branch request view not found: ${input.requestViewId}`);
      }
      const profileHeadRevision = generation(
        'expectedProfileHeadRevision',
        input.expectedProfileHeadRevision,
      );
      const expectedProfileId = systemProfileId(input.expectedProfileId);
      const boundAt = timestamp('boundAt', input.boundAt);
      const existingForView =
        this.getSystemProfileRequestViewBindingForView(requestView.requestViewId);
      if (existingForView) {
        if (
          existingForView.binding.worldId !== requestView.worldId ||
          existingForView.binding.activationEpoch !== activation.epoch ||
          existingForView.binding.profileId !== expectedProfileId ||
          existingForView.binding.profileHeadRevision !== profileHeadRevision ||
          existingForView.binding.boundAt !== boundAt
        ) {
          throw new Error(
            `system profile request view binding identity conflict: ${existingForView.bindingId}`,
          );
        }
        return existingForView;
      }
      const head = this.getSystemProfileHead(
        requestView.worldId,
        activation.epoch,
      );
      if (
        !head ||
        head.revision !== profileHeadRevision ||
        head.profileId !== expectedProfileId
      ) {
        throw new StaleSystemProfileHeadError(profileHeadRevision);
      }
      const profile = this.getSystemProfile(head.profileId);
      if (!profile) {
        throw new Error('system profile request view binding profile is missing');
      }
      const layerIds = this.systemProfileLayerIds(profile.profile);
      if (
        profile.profile.systemRendererGeneration !==
          requestView.view.systemRendererGeneration ||
        profile.profile.policyGeneration !== requestView.view.policyGeneration ||
        layerIds.length !== requestView.view.systemLayerProjectionIds.length ||
        layerIds.some(
          (layerId, ordinal) =>
            layerId !== requestView.view.systemLayerProjectionIds[ordinal],
        )
      ) {
        throw new Error('system profile request view binding layers are invalid');
      }
      if (
        profile.createdAt > head.advancedAt ||
        head.advancedAt > requestView.createdAt ||
        requestView.createdAt > boundAt
      ) {
        throw new Error('system profile request view binding chronology is invalid');
      }
      const binding = normalizeSystemProfileRequestViewBinding({
        schemaVersion: 1,
        requestViewId: requestView.requestViewId,
        requestViewHash: requestView.viewHash,
        worldId: requestView.worldId,
        activationEpoch: activation.epoch,
        profileId: profile.profileId,
        profileHash: profile.profileHash,
        profileHeadRevision: head.revision,
        boundAt,
      });
      const bindingJson = serialize(binding);
      const bindingHash = hashContextBytes(bindingJson);
      const bindingId = systemProfileRequestViewBindingIdentity(binding);
      const collision = this.database
        .prepare(
          `SELECT binding_id FROM context_system_profile_request_view_bindings
           WHERE binding_id = ? OR request_view_id = ?`,
        )
        .get(bindingId, requestView.requestViewId) as unknown as
        | { binding_id: string }
        | undefined;
      if (collision) {
        const existing = this.getSystemProfileRequestViewBinding(
          systemProfileRequestViewBindingId(collision.binding_id),
        );
        if (
          !existing ||
          existing.bindingId !== bindingId ||
          existing.bindingJson !== bindingJson ||
          existing.bindingHash !== bindingHash
        ) {
          throw new Error(
            `system profile request view binding identity conflict: ${collision.binding_id}`,
          );
        }
        return existing;
      }
      this.database
        .prepare(
          `INSERT INTO context_system_profile_request_view_bindings(
             binding_id, request_view_id, world_id, activation_epoch,
             profile_id, profile_head_revision, request_view_hash, profile_hash,
             binding_json, binding_hash, bound_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          bindingId,
          binding.requestViewId,
          binding.worldId,
          binding.activationEpoch,
          binding.profileId,
          binding.profileHeadRevision,
          binding.requestViewHash,
          binding.profileHash,
          bindingJson,
          bindingHash,
          binding.boundAt,
        );
      return this.getSystemProfileRequestViewBinding(bindingId)!;
  }

  getSystemProfileRequestViewBinding(
    id: SystemProfileRequestViewBindingId,
  ): SystemProfileRequestViewBindingRecord | null {
    const row = this.database
      .prepare(
        `SELECT * FROM context_system_profile_request_view_bindings
         WHERE binding_id = ?`,
      )
      .get(id) as unknown as SystemProfileRequestViewBindingRow | undefined;
    if (!row) return null;
    const record = mapSystemProfileRequestViewBinding(row);
    const requestView = this.getLocalBranchRequestView(
      record.binding.requestViewId,
    );
    const profile = this.getSystemProfile(record.binding.profileId);
    const head = this.getSystemProfileHeadPrefix(
      record.binding.worldId,
      record.binding.activationEpoch,
      record.binding.profileHeadRevision,
    );
    if (
      !requestView ||
      !profile ||
      !head ||
      requestView.worldId !== record.binding.worldId ||
      requestView.viewHash !== record.binding.requestViewHash ||
      profile.profileHash !== record.binding.profileHash ||
      profile.profile.worldId !== record.binding.worldId ||
      profile.profile.activationEpoch !== record.binding.activationEpoch ||
      head.profileId !== profile.profileId ||
      profile.profile.systemRendererGeneration !==
        requestView.view.systemRendererGeneration ||
      profile.profile.policyGeneration !== requestView.view.policyGeneration ||
      profile.createdAt > head.advancedAt ||
      head.advancedAt > requestView.createdAt ||
      requestView.createdAt > record.binding.boundAt
    ) {
      throw new Error(`stored system profile request view binding lineage is invalid: ${id}`);
    }
    const layerIds = this.systemProfileLayerIds(profile.profile);
    if (
      layerIds.length !== requestView.view.systemLayerProjectionIds.length ||
      layerIds.some(
        (layerId, ordinal) =>
          layerId !== requestView.view.systemLayerProjectionIds[ordinal],
      )
    ) {
      throw new Error(`stored system profile request view binding layers are invalid: ${id}`);
    }
    return record;
  }

  getSystemProfileRequestViewBindingForView(
    requestViewId: LocalBranchRequestViewId,
  ): SystemProfileRequestViewBindingRecord | null {
    const row = this.database
      .prepare(
        `SELECT binding_id FROM context_system_profile_request_view_bindings
         WHERE request_view_id = ?`,
      )
      .get(requestViewId) as unknown as { binding_id: string } | undefined;
    return row
      ? this.getSystemProfileRequestViewBinding(
          systemProfileRequestViewBindingId(row.binding_id),
        )
      : null;
  }

  private validateLocalBranchRequestEventOrder(
    events: readonly WorldEventRecord[],
  ): void {
    let previousSequence = -1;
    for (const event of events) {
      if (event.sequence <= previousSequence) {
        throw new Error('local branch request manifest event order is invalid');
      }
      previousSequence = event.sequence;
    }
  }

  private validateLocalBranchRequestSystemLayers(input: {
    worldId: WorldId;
    rendererGeneration: number;
    policyGeneration: number;
    layerIds: readonly SystemLayerProjectionId[];
  }): void {
    const order: Readonly<Record<SystemLayerKind, number>> = {
      runtime_contract: 0,
      identity: 1,
      integrated_self: 2,
      world_policy: 3,
      private_frontier: 4,
      legacy_memory: 5,
      legacy_focus: 6,
      runtime_hint: 7,
    };
    let previousOrder = -1;
    let hasIdentity = false;
    for (const layerId of input.layerIds) {
      const layer = this.getSystemLayerProjection(layerId);
      if (
        !layer ||
        layer.rendererGeneration !== input.rendererGeneration ||
        layer.policyGeneration !== input.policyGeneration ||
        order[layer.kind] <= previousOrder ||
        (layer.visibility === 'global_contract' &&
          (layer.worldId !== null || layer.kind !== 'runtime_contract')) ||
        (layer.visibility === 'integrated_self' &&
          (layer.worldId !== null ||
            (layer.kind !== 'identity' && layer.kind !== 'integrated_self'))) ||
        (layer.visibility === 'world' &&
          (layer.worldId !== input.worldId || layer.kind !== 'world_policy')) ||
        (layer.visibility !== 'global_contract' &&
          layer.visibility !== 'integrated_self' &&
          layer.visibility !== 'world')
      ) {
        throw new Error(
          `local branch request system layer is invalid: ${layerId}`,
        );
      }
      previousOrder = order[layer.kind];
      hasIdentity ||=
        layer.kind === 'identity' || layer.kind === 'integrated_self';
    }
    const first = this.getSystemLayerProjection(input.layerIds[0]!);
    if (first?.kind !== 'runtime_contract' || !hasIdentity) {
      throw new Error('local branch request system projection is incomplete');
    }
  }

  createLocalBranchRequestView(input: {
    branchId: BranchId;
    worldId: WorldId;
    manifestId: ManifestId;
    systemRendererGeneration: number;
    systemLayerProjectionIds: readonly SystemLayerProjectionId[];
    messageProjectionIds: readonly EventMessageProjectionId[];
    createdAt: number;
  }): LocalBranchRequestViewRecord {
    return transaction(this.database, () =>
      this.createLocalBranchRequestViewInTransaction(input),
    );
  }

  private createLocalBranchRequestViewInTransaction(input: {
    branchId: BranchId;
    worldId: WorldId;
    manifestId: ManifestId;
    systemRendererGeneration: number;
    systemLayerProjectionIds: readonly SystemLayerProjectionId[];
    messageProjectionIds: readonly EventMessageProjectionId[];
    createdAt: number;
  }): LocalBranchRequestViewRecord {
    const branch = this.getBranch(input.branchId);
    const start = this.getBranchStart(input.branchId);
    const coordinator = this.getRootCoordinatorState();
    const head = this.getContinuationHead();
    if (
      !branch ||
      branch.status !== 'running' ||
      branch.worldId !== input.worldId ||
      !start ||
      start.worldId !== input.worldId ||
      start.startedAt !== branch.startedAt ||
      coordinator.activeBranchId !== input.branchId ||
      coordinator.activeWorldId !== input.worldId ||
      coordinator.baseRevision !== start.baseRevision ||
      coordinator.predecessorBranchId !== start.predecessorBranchId ||
      coordinator.predecessorWorldId !== start.predecessorWorldId ||
      head.revision !== start.baseRevision ||
      head.branchId !== start.predecessorBranchId ||
      head.worldId !== start.predecessorWorldId
    ) {
      throw new Error(
        'local branch request view requires the active coordinated branch',
      );
    }
    const projection = this.getManifestProjection(input.manifestId, {
      requireActiveShares: true,
    });
    if (
      !projection ||
      projection.record.branchId !== input.branchId ||
      projection.record.worldId !== input.worldId ||
      projection.shares.length !== 0 ||
      projection.manifest.sharedEventIds.length !== 0
    ) {
      throw new Error('local branch request view manifest is invalid');
    }
    this.validateLocalBranchRequestEventOrder(projection.localEvents);
    if (
      input.messageProjectionIds.length !== projection.localEvents.length ||
      new Set(input.messageProjectionIds).size !==
        input.messageProjectionIds.length
    ) {
      throw new Error('local branch request message coverage is incomplete');
    }
    input.messageProjectionIds.forEach((projectionId, ordinal) => {
      const message = this.getEventMessageProjection(projectionId);
      const event = projection.localEvents[ordinal];
      if (
        !message ||
        !event ||
        message.sourceEventId !== event.eventId ||
        message.worldId !== input.worldId ||
        message.rendererGeneration !== projection.record.projectionGeneration
      ) {
        throw new Error('local branch request message lineage is invalid');
      }
    });
    const systemRendererGeneration = generation(
      'systemRendererGeneration',
      input.systemRendererGeneration,
    );
    if (systemRendererGeneration < 1) {
      throw new Error('systemRendererGeneration must be positive');
    }
    const systemLayerProjectionIds = [...input.systemLayerProjectionIds];
    if (
      systemLayerProjectionIds.length < 1 ||
      systemLayerProjectionIds.length > 64 ||
      new Set(systemLayerProjectionIds).size !== systemLayerProjectionIds.length
    ) {
      throw new Error(
        'local branch request system layer references are invalid',
      );
    }
    this.validateLocalBranchRequestSystemLayers({
      worldId: input.worldId,
      rendererGeneration: systemRendererGeneration,
      policyGeneration: projection.record.policyGeneration,
      layerIds: systemLayerProjectionIds,
    });
    const view = normalizeLocalBranchRequestView({
      schemaVersion: 1,
      executionMode: 'dark',
      scope: 'local-only',
      runnable: false,
      toolMode: 'none',
      branchId: input.branchId,
      worldId: input.worldId,
      manifestId: input.manifestId,
      manifestHash: projection.record.hash,
      messageRendererGeneration: projection.record.projectionGeneration,
      systemRendererGeneration,
      policyGeneration: projection.record.policyGeneration,
      systemLayerProjectionIds,
      messageProjectionIds: [...input.messageProjectionIds],
    });
    const viewJson = serialize(view);
    const viewHash = hashContextBytes(viewJson);
    const requestViewId = localBranchRequestViewIdentity(view);
    const existing = this.getLocalBranchRequestView(requestViewId);
    if (existing) {
      if (existing.viewJson !== viewJson || existing.viewHash !== viewHash) {
        throw new Error(
          `local branch request view identity conflict: ${requestViewId}`,
        );
      }
      return existing;
    }
    this.database
      .prepare(
        `INSERT INTO context_local_branch_request_views(
             request_view_id, branch_id, world_id, manifest_id, manifest_hash,
             view_json, view_hash, message_renderer_generation,
             system_renderer_generation, policy_generation, system_layer_count,
             message_projection_count, tool_mode, runnable, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', 0, ?)`,
      )
      .run(
        requestViewId,
        input.branchId,
        input.worldId,
        input.manifestId,
        projection.record.hash,
        viewJson,
        viewHash,
        projection.record.projectionGeneration,
        systemRendererGeneration,
        projection.record.policyGeneration,
        systemLayerProjectionIds.length,
        input.messageProjectionIds.length,
        timestamp('createdAt', input.createdAt),
      );
    const systemStatement = this.database.prepare(
      `INSERT INTO context_local_branch_request_system_layers(
           request_view_id, layer_id, world_id, ordinal
         ) VALUES (?, ?, ?, ?)`,
    );
    systemLayerProjectionIds.forEach((layerId, ordinal) =>
      systemStatement.run(requestViewId, layerId, input.worldId, ordinal),
    );
    const messageStatement = this.database.prepare(
      `INSERT INTO context_local_branch_request_messages(
           request_view_id, projection_id, world_id, ordinal
         ) VALUES (?, ?, ?, ?)`,
    );
    input.messageProjectionIds.forEach((projectionId, ordinal) =>
      messageStatement.run(requestViewId, projectionId, input.worldId, ordinal),
    );
    return this.getLocalBranchRequestView(requestViewId)!;
  }

  getLocalBranchRequestView(
    id: LocalBranchRequestViewId,
  ): LocalBranchRequestViewRecord | null {
    const row = this.database
      .prepare(
        'SELECT * FROM context_local_branch_request_views WHERE request_view_id = ?',
      )
      .get(id) as unknown as LocalBranchRequestViewRow | undefined;
    if (!row) return null;
    const record = mapLocalBranchRequestView(row);
    const manifest = this.getManifestProjection(record.manifestId, {
      requireActiveShares: true,
    });
    const branch = this.getBranch(record.branchId);
    const start = this.getBranchStart(record.branchId);
    if (
      !manifest ||
      !branch ||
      !start ||
      start.worldId !== record.worldId ||
      start.startedAt !== branch.startedAt ||
      manifest.record.branchId !== record.branchId ||
      manifest.record.worldId !== record.worldId ||
      manifest.record.hash !== record.manifestHash ||
      manifest.record.projectionGeneration !==
        record.view.messageRendererGeneration ||
      manifest.record.policyGeneration !== record.view.policyGeneration ||
      manifest.shares.length !== 0 ||
      manifest.manifest.sharedEventIds.length !== 0
    ) {
      throw new Error(
        `stored local branch request view manifest is invalid: ${id}`,
      );
    }
    this.validateLocalBranchRequestEventOrder(manifest.localEvents);
    const systemLayerProjectionIds = (
      this.database
        .prepare(
          `SELECT layer_id FROM context_local_branch_request_system_layers
           WHERE request_view_id = ? ORDER BY ordinal`,
        )
        .all(id) as { layer_id: string }[]
    ).map((edge) => systemLayerProjectionId(edge.layer_id));
    const messageProjectionIds = (
      this.database
        .prepare(
          `SELECT projection_id FROM context_local_branch_request_messages
           WHERE request_view_id = ? ORDER BY ordinal`,
        )
        .all(id) as { projection_id: string }[]
    ).map((edge) => eventMessageProjectionId(edge.projection_id));
    if (
      systemLayerProjectionIds.length !==
        record.view.systemLayerProjectionIds.length ||
      systemLayerProjectionIds.some(
        (layerId, ordinal) =>
          layerId !== record.view.systemLayerProjectionIds[ordinal],
      ) ||
      messageProjectionIds.length !== record.view.messageProjectionIds.length ||
      messageProjectionIds.some(
        (projectionId, ordinal) =>
          projectionId !== record.view.messageProjectionIds[ordinal],
      ) ||
      messageProjectionIds.length !== manifest.localEvents.length
    ) {
      throw new Error(
        `stored local branch request view edges are invalid: ${id}`,
      );
    }
    this.validateLocalBranchRequestSystemLayers({
      worldId: record.worldId,
      rendererGeneration: record.view.systemRendererGeneration,
      policyGeneration: record.view.policyGeneration,
      layerIds: systemLayerProjectionIds,
    });
    messageProjectionIds.forEach((projectionId, ordinal) => {
      const message = this.getEventMessageProjection(projectionId);
      const event = manifest.localEvents[ordinal];
      if (
        !message ||
        !event ||
        message.sourceEventId !== event.eventId ||
        message.worldId !== record.worldId ||
        message.rendererGeneration !== record.view.messageRendererGeneration
      ) {
        throw new Error(
          `stored local branch request view message lineage is invalid: ${id}`,
        );
      }
    });
    return record;
  }

  private materializeStoredLocalBranchRequest(
    requestView: LocalBranchRequestViewRecord,
  ): MaterializedLocalBranchRequest {
    const systemLayers = requestView.view.systemLayerProjectionIds.map((id) => {
      const layer = this.getSystemLayerProjection(id);
      if (!layer) throw new Error(`local branch request system layer disappeared: ${id}`);
      return layer;
    });
    const messages = requestView.view.messageProjectionIds.map((id) => {
      const projection = this.getEventMessageProjection(id);
      if (!projection) throw new Error(`local branch request message disappeared: ${id}`);
      return projection.message;
    });
    return buildMaterializedLocalBranchRequest({
      requestViewId: requestView.requestViewId,
      messages: [
        {
          role: 'system',
          content: systemLayers.map((layer) => layer.content).join(''),
        },
        ...messages,
      ],
    });
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
      } else if (!(
        (layer.kind === 'runtime_contract' &&
          layer.visibility === 'global_contract') ||
        ((layer.kind === 'identity' || layer.kind === 'integrated_self') &&
          layer.visibility === 'integrated_self') ||
        (layer.kind === 'world_policy' && layer.visibility === 'world')
      )) {
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

  assembleDarkLocalBranchRecords(input: {
    expectedActivationEpoch: number;
    expectedHeadRevision: number;
    worldId: WorldId;
    branchId: BranchId;
    messageProjectionIds: readonly EventMessageProjectionId[];
    assembledAt: number;
  }): DarkLocalBranchAssemblyRecord {
    const expectedActivationEpoch = generation(
      'expectedActivationEpoch',
      input.expectedActivationEpoch,
    );
    const expectedHeadRevision = generation(
      'expectedHeadRevision',
      input.expectedHeadRevision,
    );
    const assembledAt = timestamp('assembledAt', input.assembledAt);
    return transaction(this.database, () =>
      this.assembleDarkLocalBranchRecordsInTransaction(
        input,
        expectedActivationEpoch,
        expectedHeadRevision,
        assembledAt,
      ),
    );
  }

  private rereadResidentCurrentWorldDarkRequest(input: {
    worldId: WorldId;
    currentEvent: WorldEventRecord;
    branchId: BranchId;
    maxEvents: number;
    activationEpoch: number;
    queueGeneration: number;
    residentProfileBinding: ResidentWorldProfileBindingV1;
    admission: DarkIngressAdmissionRecord;
  }): ResidentCurrentWorldDarkRequestRecord | null {
    const attempt = this.getDarkPendingBranchAttempt(input.branchId);
    if (!attempt) return null;
    if (
      input.admission.worldId !== input.worldId ||
      input.admission.sourceSequence !== input.currentEvent.sequence ||
      input.admission.activationEpoch !== input.activationEpoch ||
      input.admission.queueGeneration !== input.queueGeneration ||
      attempt.worldId !== input.worldId ||
      attempt.activationEpoch !== input.activationEpoch ||
      attempt.queueGeneration !== input.queueGeneration ||
      attempt.maxEvents !== input.maxEvents ||
      attempt.lastSourceSequence !== input.currentEvent.sequence
    ) {
      throw new Error(
        'resident dark request current event was admitted by a different assembly',
      );
    }
    const branch = this.getBranch(input.branchId);
    const start = this.getBranchStart(input.branchId);
    const requestView = this.getLocalBranchRequestView(attempt.requestViewId);
    if (
      !branch ||
      branch.status !== 'running' ||
      branch.worldId !== input.worldId ||
      !start ||
      start.worldId !== input.worldId ||
      !requestView ||
      requestView.branchId !== branch.branchId ||
      requestView.worldId !== input.worldId
    ) {
      throw new Error('resident dark request stored assembly lineage is invalid');
    }
    const coordinator = this.getRootCoordinatorState();
    if (
      coordinator.activeBranchId !== branch.branchId ||
      coordinator.activeWorldId !== branch.worldId ||
      coordinator.baseRevision !== start.baseRevision
    ) {
      throw new Error('resident dark request stored coordinator lineage is invalid');
    }
    const manifestProjection = this.getManifestProjection(
      requestView.manifestId,
      { requireActiveShares: true },
    );
    const profileBinding = this.getSystemProfileRequestViewBindingForView(
      requestView.requestViewId,
    );
    if (
      !manifestProjection ||
      manifestProjection.record.branchId !== branch.branchId ||
      !profileBinding ||
      profileBinding.binding.profileId !== input.residentProfileBinding.profileId ||
      profileBinding.binding.profileHeadRevision !==
        input.residentProfileBinding.profileHeadRevision
    ) {
      throw new Error('resident dark request stored request lineage is invalid');
    }
    const systemLayers = requestView.view.systemLayerProjectionIds.map((id) => {
      const layer = this.getSystemLayerProjection(id);
      if (!layer) {
        throw new Error(`resident dark request system layer disappeared: ${id}`);
      }
      return layer;
    });
    const messageProjections = requestView.view.messageProjectionIds.map((id) => {
      const projection = this.getEventMessageProjection(id);
      if (!projection) {
        throw new Error(`resident dark request message disappeared: ${id}`);
      }
      return projection;
    });
    const request = buildMaterializedLocalBranchRequest({
      requestViewId: requestView.requestViewId,
      messages: [
        {
          role: 'system',
          content: systemLayers.map((layer) => layer.content).join(''),
        },
        ...messageProjections.map((projection) => ({
          role: projection.message.role,
          content: projection.message.content,
        })),
      ],
    });
    return {
      currentEvent: input.currentEvent,
      admission: input.admission,
      residentProfileBinding: input.residentProfileBinding,
      attempt,
      assembly: {
        branch,
        start,
        manifest: manifestProjection.record,
        requestView,
        profileBinding,
        request,
      },
    };
  }

  assembleResidentCurrentWorldDarkRequest(input: {
    worldId: WorldId;
    eventId: EventId;
    sequence: number;
    branchId: BranchId;
    maxEvents: number;
    assembledAt: number;
  }): ResidentCurrentWorldDarkRequestRecord;
  assembleResidentCurrentWorldDarkRequest<T>(
    input: {
      worldId: WorldId;
      eventId: EventId;
      sequence: number;
      branchId: BranchId;
      maxEvents: number;
      assembledAt: number;
    },
    finalize: (record: ResidentCurrentWorldDarkRequestRecord) => T,
  ): T;
  assembleResidentCurrentWorldDarkRequest<T>(
    input: {
      worldId: WorldId;
      eventId: EventId;
      sequence: number;
      branchId: BranchId;
      maxEvents: number;
      assembledAt: number;
    },
    finalize?: (record: ResidentCurrentWorldDarkRequestRecord) => T,
  ): ResidentCurrentWorldDarkRequestRecord | T {
    const targetWorldId = worldId(input.worldId);
    const currentEventId = eventId(input.eventId);
    const currentSequence = generation('currentSequence', input.sequence);
    const maxEvents = generation('maxEvents', input.maxEvents);
    const assembledAt = timestamp('assembledAt', input.assembledAt);
    if (currentSequence < 1) throw new Error('currentSequence must be positive');
    if (maxEvents < 1 || maxEvents > 1_024) {
      throw new Error('maxEvents must be between 1 and 1024');
    }
    const finish = (record: ResidentCurrentWorldDarkRequestRecord) =>
      finalize ? finalize(record) : record;

    return transaction(this.database, () => {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new Error('resident dark request assembly requires dark graph mode');
      }
      const currentEvent = this.getWorldEvent(currentEventId);
      if (
        !currentEvent ||
        currentEvent.worldId !== targetWorldId ||
        currentEvent.sequence !== currentSequence ||
        !['inbound:discord', 'inbound:signal'].includes(currentEvent.kind)
      ) {
        throw new Error(
          'resident dark request assembly requires exact current social ingress lineage',
        );
      }
      const bindingRow = this.database
        .prepare(
          `SELECT binding_id FROM context_resident_world_profile_bindings
           WHERE activation_epoch = ? AND world_id = ?`,
        )
        .get(activation.epoch, targetWorldId) as
        | { binding_id: string }
        | undefined;
      if (!bindingRow) {
        throw new Error('resident dark request assembly requires a bound world profile');
      }
      const residentProfileBinding = this.getResidentWorldProfileBinding(
        residentWorldProfileBindingId(bindingRow.binding_id),
      );
      if (!residentProfileBinding) {
        throw new Error('resident dark request world profile binding disappeared');
      }
      const profileHead = this.getSystemProfileHead(
        targetWorldId,
        activation.epoch,
      );
      if (
        !profileHead ||
        profileHead.profileId !== residentProfileBinding.profileId ||
        profileHead.revision !== residentProfileBinding.profileHeadRevision
      ) {
        throw new Error(
          'resident dark request assembly requires the accepted world profile head',
        );
      }
      const projection = this.getEventMessageProjectionForSource(
        currentEventId,
        1,
      );
      if (!projection || projection.worldId !== targetWorldId) {
        throw new Error(
          'resident dark request assembly requires the current text projection',
        );
      }
      const generationRow = this.database
        .prepare(
          `SELECT queue_generation, first_admissible_sequence, activation_epoch
           FROM context_dark_ingress_generations
           ORDER BY queue_generation DESC LIMIT 1`,
        )
        .get() as DarkIngressGenerationRow | undefined;
      if (!generationRow) {
        throw new Error('resident dark request ingress generation is unavailable');
      }
      const queue = mapDarkIngressGeneration(generationRow);
      if (
        queue.activationEpoch !== activation.epoch ||
        currentSequence < queue.firstAdmissibleSequence
      ) {
        throw new Error('resident dark request ingress generation is stale');
      }
      const existingAdmission = this.getDarkIngressAdmission(currentEventId);
      if (existingAdmission) {
        const replay = this.rereadResidentCurrentWorldDarkRequest({
          worldId: targetWorldId,
          currentEvent,
          branchId: input.branchId,
          maxEvents,
          activationEpoch: activation.epoch,
          queueGeneration: queue.queueGeneration,
          residentProfileBinding,
          admission: existingAdmission,
        });
        if (!replay) {
          throw new Error(
            'resident dark request current event was already admitted by another path',
          );
        }
        return finish(replay);
      }
      this.database
        .prepare(
          `INSERT INTO context_dark_ingress_admissions(
             event_id, world_id, source_sequence, activation_epoch,
             queue_generation, wake_class, message_renderer_generation,
             admitted_at
           ) VALUES (?, ?, ?, ?, ?, 'text_user_turn', ?, ?)`,
        )
        .run(
          currentEvent.eventId,
          currentEvent.worldId,
          currentEvent.sequence,
          activation.epoch,
          queue.queueGeneration,
          projection.rendererGeneration,
          assembledAt,
        );
      const admission = this.getDarkIngressAdmission(currentEventId);
      if (!admission) {
        throw new Error('resident dark request admission was not persisted');
      }
      const inspection = this.inspectNextDarkPendingBatch({
        expectedActivationEpoch: activation.epoch,
        queueGeneration: queue.queueGeneration,
        maxEvents,
      });
      if (inspection.status !== 'ready' || inspection.items.length < 1) {
        throw new Error(
          `resident dark request frontier is not ready: ${inspection.status}`,
        );
      }
      const last = inspection.items[inspection.items.length - 1]!;
      if (
        inspection.worldId !== targetWorldId ||
        last.eventId !== currentEventId ||
        last.sourceSequence !== currentSequence
      ) {
        throw new Error(
          'resident dark request frontier does not terminate at the current ingress',
        );
      }
      const head = this.getContinuationHead();
      const assembly = this.assembleDarkLocalBranchRecordsInTransaction(
        {
          expectedActivationEpoch: activation.epoch,
          expectedHeadRevision: head.revision,
          worldId: targetWorldId,
          branchId: input.branchId,
          messageProjectionIds: inspection.items.map((item) => item.projectionId),
          assembledAt,
        },
        activation.epoch,
        head.revision,
        assembledAt,
      );
      if (
        assembly.profileBinding.binding.profileId !==
          residentProfileBinding.profileId ||
        assembly.profileBinding.binding.profileHeadRevision !==
          residentProfileBinding.profileHeadRevision
      ) {
        throw new Error('resident dark request profile binding changed during assembly');
      }
      this.database
        .prepare(
          `INSERT INTO context_dark_pending_branch_attempts(
             branch_id, world_id, request_view_id, activation_epoch,
             queue_generation, max_events, selected_count,
             first_source_sequence, last_source_sequence, assembled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assembly.branch.branchId,
          assembly.branch.worldId,
          assembly.requestView.requestViewId,
          activation.epoch,
          queue.queueGeneration,
          maxEvents,
          inspection.items.length,
          inspection.items[0]!.sourceSequence,
          last.sourceSequence,
          assembledAt,
        );
      const attempt = this.getDarkPendingBranchAttempt(
        assembly.branch.branchId,
      );
      if (!attempt) {
        throw new Error('resident dark request attempt was not persisted');
      }
      return finish({
        currentEvent,
        admission,
        residentProfileBinding,
        attempt,
        assembly,
      });
    });
  }

  bindResidentDarkRequestToIsolatedProvider(input: {
    worldId: WorldId;
    eventId: EventId;
    sequence: number;
    target: ExactIsolatedProviderTargetV1;
    provenance: ResidentToolCallSnapshotV1;
    boundAt: number;
  }): DarkIsolatedProviderBindingRecord;
  bindResidentDarkRequestToIsolatedProvider<T>(
    input: {
      worldId: WorldId;
      eventId: EventId;
      sequence: number;
      target: ExactIsolatedProviderTargetV1;
      provenance: ResidentToolCallSnapshotV1;
      boundAt: number;
    },
    finalize: (record: DarkIsolatedProviderBindingRecord) => T,
  ): T;
  bindResidentDarkRequestToIsolatedProvider<T>(
    input: {
      worldId: WorldId;
      eventId: EventId;
      sequence: number;
      target: ExactIsolatedProviderTargetV1;
      provenance: ResidentToolCallSnapshotV1;
      boundAt: number;
    },
    finalize?: (record: DarkIsolatedProviderBindingRecord) => T,
  ): DarkIsolatedProviderBindingRecord | T {
    const targetWorldId = worldId(input.worldId);
    const currentEventId = eventId(input.eventId);
    const currentSequence = generation(
      'dark isolated provider binding sequence',
      input.sequence,
    );
    const target = normalizeExactIsolatedProviderTarget(input.target);
    const provenance = normalizeDarkIsolatedProviderBindingProvenance(
      input.provenance,
    );
    const boundAt = timestamp('dark isolated provider binding boundAt', input.boundAt);
    const finish = (record: DarkIsolatedProviderBindingRecord) =>
      finalize ? finalize(record) : record;

    return transaction(this.database, () => {
      const activation = this.getActivationState();
      if (activation.mode !== 'dark') {
        throw new Error('isolated provider binding requires dark graph mode');
      }
      const currentEvent = this.getWorldEvent(currentEventId);
      if (
        !currentEvent ||
        currentEvent.worldId !== targetWorldId ||
        currentEvent.sequence !== currentSequence ||
        !['inbound:discord', 'inbound:signal'].includes(currentEvent.kind)
      ) {
        throw new Error('isolated provider binding requires exact current social ingress');
      }
      const coordinator = this.getRootCoordinatorState();
      if (
        coordinator.activeBranchId === null ||
        coordinator.activeWorldId !== targetWorldId
      ) {
        throw new Error('isolated provider binding requires an active current-world branch');
      }
      const attempt = this.getDarkPendingBranchAttempt(coordinator.activeBranchId);
      const admission = this.getDarkIngressAdmission(currentEventId);
      if (
        !attempt ||
        !admission ||
        attempt.worldId !== targetWorldId ||
        attempt.activationEpoch !== activation.epoch ||
        attempt.lastSourceSequence !== currentSequence ||
        admission.worldId !== targetWorldId ||
        admission.sourceSequence !== currentSequence
      ) {
        throw new Error('isolated provider binding pending attempt lineage is invalid');
      }
      const residentRow = this.database
        .prepare(
          `SELECT binding_id FROM context_resident_world_profile_bindings
           WHERE activation_epoch = ? AND world_id = ?`,
        )
        .get(activation.epoch, targetWorldId) as
        | { binding_id: string }
        | undefined;
      if (!residentRow) {
        throw new Error('isolated provider binding requires a resident world profile');
      }
      const residentProfileBinding = this.getResidentWorldProfileBinding(
        residentWorldProfileBindingId(residentRow.binding_id),
      );
      if (!residentProfileBinding) {
        throw new Error('isolated provider binding resident profile disappeared');
      }
      const darkRequest = this.rereadResidentCurrentWorldDarkRequest({
        worldId: targetWorldId,
        currentEvent,
        branchId: coordinator.activeBranchId,
        maxEvents: attempt.maxEvents,
        activationEpoch: activation.epoch,
        queueGeneration: attempt.queueGeneration,
        residentProfileBinding,
        admission,
      });
      if (!darkRequest) {
        throw new Error('isolated provider binding dark request disappeared');
      }
      const { branch, manifest, requestView, profileBinding, request } =
        darkRequest.assembly;
      const targetJson = serialize(target);
      const targetHash = hashContextBytes(targetJson);
      const cacheNamespace = isolatedProviderCacheNamespace({
        manifestCacheNamespace: manifest.cacheNamespace,
        requestViewHash: requestView.viewHash,
        targetHash,
      });
      const priorCall = this.database
        .prepare(
          `SELECT binding_id FROM context_dark_isolated_provider_bindings
           WHERE bind_batch_id = ? AND bind_call_index = ?`,
        )
        .get(provenance.batchId, provenance.callIndex) as
        | { binding_id: string }
        | undefined;
      const replay = priorCall
        ? this.getDarkIsolatedProviderBinding(
            darkIsolatedProviderBindingId(priorCall.binding_id),
          )
        : null;
      if (priorCall && !replay) {
        throw new Error('isolated provider binding disappeared');
      }
      if (!replay && boundAt < attempt.assembledAt) {
        throw new Error('isolated provider binding pending attempt lineage is invalid');
      }
      const receiptBoundAt = replay?.binding.boundAt ?? boundAt;
      const binding: DarkIsolatedProviderBindingV1 = Object.freeze({
        schemaVersion: 1,
        executionMode: 'dark',
        runnable: false,
        networkAuthority: 'none',
        toolMode: 'none',
        historicalToolMessages: false,
        activationEpoch: activation.epoch,
        branchId: branch.branchId,
        worldId: branch.worldId,
        authorityEpoch: branch.authorityEpoch,
        residentProfileBindingId: residentProfileBinding.bindingId,
        requestProfileBindingId: profileBinding.bindingId,
        requestProfileBindingHash: profileBinding.bindingHash,
        profileId: profileBinding.binding.profileId,
        profileHash: profileBinding.binding.profileHash,
        profileHeadRevision: profileBinding.binding.profileHeadRevision,
        manifestId: manifest.manifestId,
        manifestHash: manifest.hash,
        requestViewId: requestView.requestViewId,
        requestViewHash: requestView.viewHash,
        candidateHash: request.candidateHash,
        candidateBytes: request.candidateBytes,
        target,
        targetHash,
        laneKind: 'isolated-standalone',
        cacheNamespace,
        bindBatchId: provenance.batchId,
        bindBatchSha256: provenance.batchSha256,
        bindCallIndex: provenance.callIndex,
        bindCallCount: provenance.callCount,
        bindToolName: 'run',
        bindArgumentsSha256: provenance.argumentsSha256,
        boundAt: receiptBoundAt,
      });
      const bindingJson = serialize(binding);
      const bindingHash = hashContextBytes(bindingJson);
      const bindingId = darkIsolatedProviderBindingIdentity(bindingJson);
      if (replay) {
        if (priorCall!.binding_id !== bindingId) {
          throw new Error('isolated provider binding call already bound different lineage');
        }
        return finish(replay);
      }
      const priorBranch = this.database
        .prepare(
          `SELECT binding_id FROM context_dark_isolated_provider_bindings
           WHERE branch_id = ?`,
        )
        .get(branch.branchId) as { binding_id: string } | undefined;
      if (priorBranch) {
        throw new Error('isolated provider request was already bound by a different call');
      }
      this.database
        .prepare(
          `INSERT INTO context_dark_isolated_provider_bindings(
             binding_id, schema_version, execution_mode, runnable,
             network_authority, tool_mode, historical_tool_messages,
             activation_epoch, branch_id, world_id, authority_epoch,
             resident_profile_binding_id, request_profile_binding_id,
             request_profile_binding_hash, profile_id, profile_hash,
             profile_head_revision, manifest_id, manifest_hash,
             request_view_id, request_view_hash, candidate_hash,
             candidate_bytes, target_provider_type, target_model,
             target_api_surface, target_api_endpoint, target_json, target_hash,
             cache_namespace, bind_batch_id, bind_batch_sha256,
             bind_call_index, bind_call_count, bind_tool_name,
             bind_arguments_sha256, binding_json, binding_hash, bound_at
           ) VALUES (
             ?, 1, 'dark', 0, 'none', 'none', 0,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           )`,
        )
        .run(
          bindingId,
          activation.epoch,
          branch.branchId,
          branch.worldId,
          branch.authorityEpoch,
          residentProfileBinding.bindingId,
          profileBinding.bindingId,
          profileBinding.bindingHash,
          profileBinding.binding.profileId,
          profileBinding.binding.profileHash,
          profileBinding.binding.profileHeadRevision,
          manifest.manifestId,
          manifest.hash,
          requestView.requestViewId,
          requestView.viewHash,
          request.candidateHash,
          request.candidateBytes,
          target.providerType,
          target.model,
          target.apiSurface,
          target.apiEndpoint,
          targetJson,
          targetHash,
          cacheNamespace,
          provenance.batchId,
          provenance.batchSha256,
          provenance.callIndex,
          provenance.callCount,
          provenance.toolName,
          provenance.argumentsSha256,
          bindingJson,
          bindingHash,
          boundAt,
        );
      const created = this.getDarkIsolatedProviderBinding(bindingId);
      if (!created) throw new Error('isolated provider binding was not stored');
      return finish(created);
    });
  }

  assembleNextDarkPendingBranchRecords(input: {
    expectedActivationEpoch: number;
    expectedHeadRevision: number;
    queueGeneration: number;
    maxEvents: number;
    branchId: BranchId;
    assembledAt: number;
  }): DarkPendingBranchAssemblyResult {
    const expectedActivationEpoch = generation(
      'expectedActivationEpoch',
      input.expectedActivationEpoch,
    );
    const expectedHeadRevision = generation(
      'expectedHeadRevision',
      input.expectedHeadRevision,
    );
    const queueGeneration = generation(
      'queueGeneration',
      input.queueGeneration,
    );
    const maxEvents = generation('maxEvents', input.maxEvents);
    const assembledAt = timestamp('assembledAt', input.assembledAt);
    if (queueGeneration < 1) {
      throw new Error('queueGeneration must be positive');
    }
    if (maxEvents < 1 || maxEvents > 1_024) {
      throw new Error('maxEvents must be between 1 and 1024');
    }

    return transaction(this.database, () => {
      const inspection = this.inspectNextDarkPendingBatch({
        expectedActivationEpoch,
        queueGeneration,
        maxEvents,
      });
      if (inspection.status !== 'ready') return inspection;
      if (inspection.items.length < 1) {
        throw new Error('dark pending inspection returned an empty ready batch');
      }
      const assembly = this.assembleDarkLocalBranchRecordsInTransaction(
        {
          expectedActivationEpoch,
          expectedHeadRevision,
          worldId: inspection.worldId,
          branchId: input.branchId,
          messageProjectionIds: inspection.items.map(
            (item) => item.projectionId,
          ),
          assembledAt,
        },
        expectedActivationEpoch,
        expectedHeadRevision,
        assembledAt,
      );
      this.database
        .prepare(
          `INSERT INTO context_dark_pending_branch_attempts(
             branch_id, world_id, request_view_id, activation_epoch,
             queue_generation, max_events, selected_count,
             first_source_sequence, last_source_sequence, assembled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          assembly.branch.branchId,
          assembly.branch.worldId,
          assembly.requestView.requestViewId,
          expectedActivationEpoch,
          queueGeneration,
          maxEvents,
          inspection.items.length,
          inspection.items[0]!.sourceSequence,
          inspection.items[inspection.items.length - 1]!.sourceSequence,
          assembledAt,
        );
      const attempt = this.getDarkPendingBranchAttempt(
        assembly.branch.branchId,
      );
      if (!attempt) {
        throw new Error('dark pending branch attempt was not persisted');
      }
      return { status: 'assembled', attempt, assembly };
    });
  }

  private assembleDarkLocalBranchRecordsInTransaction(
    input: {
      expectedActivationEpoch: number;
      expectedHeadRevision: number;
      worldId: WorldId;
      branchId: BranchId;
      messageProjectionIds: readonly EventMessageProjectionId[];
      assembledAt: number;
    },
    expectedActivationEpoch: number,
    expectedHeadRevision: number,
    assembledAt: number,
  ): DarkLocalBranchAssemblyRecord {
    const activation = this.getActivationState();
    if (
      activation.mode !== 'dark' ||
      activation.epoch !== expectedActivationEpoch
    ) {
      throw new StaleActivationStateError(expectedActivationEpoch);
    }

    const profileHead = this.getSystemProfileHead(
      input.worldId,
      expectedActivationEpoch,
    );
    if (!profileHead) {
      throw new Error(`current system profile head not found: ${input.worldId}`);
    }
    const systemProfile = this.getSystemProfile(profileHead.profileId);
    if (!systemProfile) {
      throw new Error('current system profile is missing');
    }
    const systemLayerProjectionIds = this.systemProfileLayerIds(
      systemProfile.profile,
    );

    const messageProjectionIds = [...input.messageProjectionIds];
    if (
      messageProjectionIds.length < 1 ||
      messageProjectionIds.length > 4096 ||
      new Set(messageProjectionIds).size !== messageProjectionIds.length
    ) {
      throw new Error(
        'dark local branch assembly requires unique local message projections',
      );
    }
    const messageProjections = messageProjectionIds.map((projectionId) => {
      const projection = this.getEventMessageProjection(projectionId);
      if (!projection) {
        throw new Error(
          'dark local branch message projection is missing: ' + projectionId,
        );
      }
      return projection;
    });
    const localEvents = messageProjections.map((projection) => {
      const source = this.getWorldEvent(projection.sourceEventId);
      if (
        !source ||
        source.worldId !== input.worldId ||
        projection.worldId !== input.worldId ||
        !source.kind.startsWith('inbound:')
      ) {
        throw new Error(
          'dark local branch message lineage is invalid: ' +
            projection.projectionId,
        );
      }
      return source;
    });
    this.validateLocalBranchRequestEventOrder(localEvents);
    const messageRendererGenerations = new Set(
      messageProjections.map((projection) => projection.rendererGeneration),
    );
    if (messageRendererGenerations.size !== 1) {
      throw new Error(
        'dark local branch message renderer generation is inconsistent',
      );
    }
    const messageRendererGeneration = messageProjections[0]!.rendererGeneration;

    if (
      systemLayerProjectionIds.length < 1 ||
      systemLayerProjectionIds.length > 64 ||
      new Set(systemLayerProjectionIds).size !== systemLayerProjectionIds.length
    ) {
      throw new Error('dark local branch system layer references are invalid');
    }
    const systemLayers = systemLayerProjectionIds.map((layerId) => {
      const layer = this.getSystemLayerProjection(layerId);
      if (!layer) {
        throw new Error(
          'dark local branch system layer is missing: ' + layerId,
        );
      }
      return layer;
    });
    const systemRendererGenerations = new Set(
      systemLayers.map((layer) => layer.rendererGeneration),
    );
    const policyGenerations = new Set(
      systemLayers.map((layer) => layer.policyGeneration),
    );
    if (systemRendererGenerations.size !== 1 || policyGenerations.size !== 1) {
      throw new Error(
        'dark local branch system layer generations are inconsistent',
      );
    }
    const systemRendererGeneration = systemLayers[0]!.rendererGeneration;
    const policyGeneration = systemLayers[0]!.policyGeneration;
    this.validateLocalBranchRequestSystemLayers({
      worldId: input.worldId,
      rendererGeneration: systemRendererGeneration,
      policyGeneration,
      layerIds: systemLayerProjectionIds,
    });

    const authorityRow = this.database
      .prepare(
        'SELECT COALESCE(MAX(authority_epoch), 0) AS maximum FROM context_branches',
      )
      .get() as { maximum: number };
    if (
      !Number.isSafeInteger(authorityRow.maximum) ||
      authorityRow.maximum < 0 ||
      authorityRow.maximum >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error('dark local branch authority state is invalid');
    }
    const authorityEpoch = authorityRow.maximum + 1;
    const opened = this.beginCoordinatedBranchInTransaction({
      branchId: input.branchId,
      worldId: input.worldId,
      expectedRevision: expectedHeadRevision,
      authorityEpoch,
      startedAt: assembledAt,
    });
    const viewManifest = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: opened.branch.worldId,
      parentBranchId: opened.branch.parentBranchId,
      authorityEpoch: opened.branch.authorityEpoch,
      eventIds: localEvents.map((event) => event.eventId),
      sharedEventIds: [],
      policyGeneration,
    });
    const canonicalManifestId = manifestId('manifest:' + viewManifest.hash);
    const manifest = this.createManifestInTransaction({
      manifestId: canonicalManifestId,
      branchId: opened.branch.branchId,
      worldId: opened.branch.worldId,
      manifest: viewManifest,
      projectionGeneration: messageRendererGeneration,
      shareGrantIds: [],
      createdAt: assembledAt,
    });
    const requestView = this.createLocalBranchRequestViewInTransaction({
      branchId: opened.branch.branchId,
      worldId: opened.branch.worldId,
      manifestId: manifest.manifestId,
      systemRendererGeneration,
      systemLayerProjectionIds,
      messageProjectionIds,
      createdAt: assembledAt,
    });
    assertLocalBranchRequestContentFits([
      ...systemLayers.map((layer) => layer.content),
      ...messageProjections.map((projection) => projection.message.content),
    ]);
    const request = buildMaterializedLocalBranchRequest({
      requestViewId: requestView.requestViewId,
      messages: [
        {
          role: 'system',
          content: systemLayers.map((layer) => layer.content).join(''),
        },
        ...messageProjections.map((projection) => ({
          role: projection.message.role,
          content: projection.message.content,
        })),
      ],
    });
    const profileBinding =
      this.createSystemProfileRequestViewBindingInTransaction({
        requestViewId: requestView.requestViewId,
        expectedProfileId: profileHead.profileId,
        expectedProfileHeadRevision: profileHead.revision,
        boundAt: assembledAt,
      });
    return {
      branch: opened.branch,
      start: opened.start,
      manifest,
      requestView,
      profileBinding,
      request,
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
    return transaction(this.database, () =>
      this.beginCoordinatedBranchInTransaction(input),
    );
  }

  private beginCoordinatedBranchInTransaction(input: {
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
    const head = this.getContinuationHead();
    if (head.revision !== expectedRevision) {
      throw new StaleContinuationHeadError(expectedRevision);
    }
    const state = this.getRootCoordinatorState();
    if (state.activeBranchId !== null) {
      throw new Error(`context branch already active: ${state.activeBranchId}`);
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
        localParent === undefined ? undefined : branchId(localParent.branch_id),
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
      const pendingAttempt = this.getDarkPendingBranchAttempt(branch.branchId);
      if (
        pendingAttempt !== null &&
        this.getDarkPendingBranchAbandonment(branch.branchId) === null
      ) {
        this.database
          .prepare(
            `INSERT INTO context_dark_pending_branch_abandonments(
               branch_id, abandoned_at, reason
             ) VALUES (?, ?, 'coordinator_recovery')`,
          )
          .run(branch.branchId, at);
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
    return transaction(this.database, () =>
      this.createManifestInTransaction(input),
    );
  }

  private createManifestInTransaction(input: {
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
    const branch = this.getBranch(record.branchId);
    if (
      !branch ||
      branch.worldId !== record.worldId ||
      decoded.branchId !== record.branchId ||
      decoded.worldId !== record.worldId ||
      decoded.parentBranchId !== branch.parentBranchId ||
      decoded.authorityEpoch !== branch.authorityEpoch ||
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
