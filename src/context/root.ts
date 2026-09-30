import type { MaterializedLocalBranchRequest } from './candidate.js';
import type {
  BranchId,
  BranchRecord,
  BranchStartRecord,
  ContextGraphStore,
  DarkPendingBranchAssemblyResult,
  EventMessageProjectionId,
  LocalBranchRequestViewRecord,
  ManifestRecord,
  SystemLayerProjectionId,
  WorldId,
} from '../store/context-graph.js';

export interface AssembleDarkLocalBranchInput {
  readonly store: ContextGraphStore;
  readonly expectedActivationEpoch: number;
  readonly expectedHeadRevision: number;
  readonly worldId: WorldId;
  readonly branchId: BranchId;
  readonly messageProjectionIds: readonly EventMessageProjectionId[];
  readonly systemLayerProjectionIds: readonly SystemLayerProjectionId[];
  readonly assembledAt: number;
}

export interface AssembleNextDarkPendingBranchInput {
  readonly store: ContextGraphStore;
  readonly expectedActivationEpoch: number;
  readonly expectedHeadRevision: number;
  readonly queueGeneration: number;
  readonly maxEvents: number;
  readonly branchId: BranchId;
  readonly systemLayerProjectionIds: readonly SystemLayerProjectionId[];
  readonly assembledAt: number;
}

export interface AssembledDarkLocalBranch {
  readonly branch: BranchRecord;
  readonly start: BranchStartRecord;
  readonly manifest: ManifestRecord;
  readonly requestView: LocalBranchRequestViewRecord;
  readonly request: MaterializedLocalBranchRequest;
}

/**
 * Atomically selects the current dark pending prefix, assembles its bounded
 * non-runnable request, and records one recoverable attempt.
 */
export function assembleNextDarkPendingBranch(
  input: AssembleNextDarkPendingBranchInput,
): DarkPendingBranchAssemblyResult {
  return input.store.assembleNextDarkPendingBranchRecords({
    expectedActivationEpoch: input.expectedActivationEpoch,
    expectedHeadRevision: input.expectedHeadRevision,
    queueGeneration: input.queueGeneration,
    maxEvents: input.maxEvents,
    branchId: input.branchId,
    systemLayerProjectionIds: input.systemLayerProjectionIds,
    assembledAt: input.assembledAt,
  });
}

/**
 * Atomically rehearses one local, tool-free branch assembly in dark mode.
 * It does not call a provider, execute tools, or advance the continuation head.
 */
export function assembleDarkLocalBranch(
  input: AssembleDarkLocalBranchInput,
): AssembledDarkLocalBranch {
  return input.store.assembleDarkLocalBranchRecords({
    expectedActivationEpoch: input.expectedActivationEpoch,
    expectedHeadRevision: input.expectedHeadRevision,
    worldId: input.worldId,
    branchId: input.branchId,
    messageProjectionIds: input.messageProjectionIds,
    systemLayerProjectionIds: input.systemLayerProjectionIds,
    assembledAt: input.assembledAt,
  });
}
