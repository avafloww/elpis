import { createHash } from 'node:crypto';

import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import { preview } from '../sandbox/preview.js';
import {
  branchId,
  ContextGraphStore,
  eventId,
  worldId,
  type ResidentCurrentWorldDarkRequestRecord,
} from '../store/context-graph.js';
import type { ResidentCurrentWorldScopeV1 } from './resident-world-profile-binding.js';

const MAX_EVENTS = 64;

function residentDarkBranchId(
  scope: ResidentCurrentWorldScopeV1,
  provenance: ResidentToolCallSnapshotV1,
) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        version: 1,
        batchId: provenance.batchId,
        batchSha256: provenance.batchSha256,
        callIndex: provenance.callIndex,
        argumentsSha256: provenance.argumentsSha256,
        worldId: scope.worldId,
        eventId: scope.eventId,
        sequence: scope.sequence,
      }),
      'utf8',
    )
    .digest('hex');
  return branchId(`branch:resident-dark-request:${hash}`);
}

export function formatResidentDarkRequestPresentation(
  record: ResidentCurrentWorldDarkRequestRecord,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('resident dark request preview budget is invalid');
  }
  const presentation = [
    'CURRENT WORLD DARK REQUEST ASSEMBLED — NON-RUNNABLE',
    `world_id: ${record.currentEvent.worldId}`,
    `ingress_event_id: ${record.currentEvent.eventId}`,
    `ingress_sequence: ${record.currentEvent.sequence}`,
    `queue_generation: ${record.admission.queueGeneration}`,
    `branch_id: ${record.assembly.branch.branchId}`,
    `attempt_selected_count: ${record.attempt.selectedCount}`,
    `attempt_sequence_range: ${record.attempt.firstSourceSequence}-${record.attempt.lastSourceSequence}`,
    `manifest_id: ${record.assembly.manifest.manifestId}`,
    `manifest_hash: ${record.assembly.manifest.hash}`,
    `request_view_id: ${record.assembly.requestView.requestViewId}`,
    `request_view_hash: ${record.assembly.requestView.viewHash}`,
    `resident_profile_binding_id: ${record.residentProfileBinding.bindingId}`,
    `profile_id: ${record.residentProfileBinding.profileId}`,
    `profile_hash: ${record.residentProfileBinding.profileHash}`,
    `profile_head_revision: ${record.residentProfileBinding.profileHeadRevision}`,
    `request_profile_binding_id: ${record.assembly.profileBinding.bindingId}`,
    `candidate_sha256: ${record.assembly.request.candidateHash}`,
    `candidate_bytes: ${record.assembly.request.candidateBytes}`,
    '',
    'PROVIDER-NEUTRAL CANDIDATE JSON',
    record.assembly.request.candidateJson,
    '',
    'This is a dark, tool-free request candidate only. It was not sent to a provider and grants no effect authority.',
  ].join('\n');
  if (
    preview(presentation, maxBytes) !==
    `string(${presentation.length} chars):\n${presentation}`
  ) {
    throw new Error(
      'resident dark request preview budget cannot present the exact candidate',
    );
  }
  return presentation;
}

export interface ResidentDarkRequestAssemblerOptions {
  store: ContextGraphStore;
  previewMaxBytes: number;
  redactForOutput: (text: string) => string;
  now?: () => number;
}

export function createResidentDarkRequestAssembler(
  options: ResidentDarkRequestAssemblerOptions,
): (
  scope: ResidentCurrentWorldScopeV1,
  provenance: ResidentToolCallSnapshotV1,
) => string {
  const now = options.now ?? Date.now;
  return (scope, provenance) => {
    if (provenance.toolName !== 'run') {
      throw new Error('resident dark request assembly requires run provenance');
    }
    const currentWorldId = worldId(scope.worldId);
    const currentEventId = eventId(scope.eventId);
    if (!Number.isSafeInteger(scope.sequence) || scope.sequence < 1) {
      throw new Error('resident dark request assembly sequence is invalid');
    }
    return options.store.assembleResidentCurrentWorldDarkRequest(
      {
        worldId: currentWorldId,
        eventId: currentEventId,
        sequence: scope.sequence,
        branchId: residentDarkBranchId(scope, provenance),
        maxEvents: MAX_EVENTS,
        assembledAt: now(),
      },
      (record) => {
        const presentation = formatResidentDarkRequestPresentation(
          record,
          options.previewMaxBytes,
        );
        if (options.redactForOutput(presentation) !== presentation) {
          throw new Error(
            'resident dark request cannot present the exact candidate because secret redaction would alter it',
          );
        }
        return presentation;
      },
    );
  };
}
