import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import { preview } from '../sandbox/preview.js';
import {
  ContextGraphStore,
  eventId,
  residentIdentitySystemDerivationId,
  worldId,
  type EventId,
  type ResidentWorldProfileBindingV1,
  type WorldId,
} from '../store/context-graph.js';

export interface ResidentCurrentWorldScopeV1 {
  readonly worldId: WorldId;
  readonly eventId: EventId;
  readonly sequence: number;
}

export function formatResidentWorldProfileBindingPresentation(
  receipt: ResidentWorldProfileBindingV1,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('resident world profile binding preview budget is invalid');
  }
  const presentation = [
    'CURRENT WORLD SYSTEM PROFILE BOUND — DARK AND NON-RUNNABLE',
    `binding_id: ${receipt.bindingId}`,
    `derivation_id: ${receipt.derivationId}`,
    `activation_epoch: ${receipt.activationEpoch}`,
    `world_id: ${receipt.worldId}`,
    `ingress_event_id: ${receipt.ingressEventId}`,
    `ingress_sequence: ${receipt.ingressSequence}`,
    `profile_id: ${receipt.profileId}`,
    `profile_hash: ${receipt.profileHash}`,
    `profile_head_revision: ${receipt.profileHeadRevision}`,
    `predecessor_profile_id: ${receipt.predecessorProfileId ?? 'none'}`,
    `binding_batch_id: ${receipt.bindBatchId}`,
    `binding_batch_sha256: ${receipt.bindBatchSha256}`,
    `binding_call: ${receipt.bindCallIndex}/${receipt.bindCallCount}`,
    `binding_arguments_sha256: ${receipt.bindArgumentsSha256}`,
    '',
    'This receipt selects one contract-and-identity-only system profile for the exact current social world and ingress event.',
    'It creates no branch, request view, provider request, effect authority, activation, or continuation advance.',
  ].join('\n');
  if (
    preview(presentation, maxBytes) !==
    `string(${presentation.length} chars):\n${presentation}`
  ) {
    throw new Error(
      'resident world profile binding preview budget cannot present the exact receipt',
    );
  }
  return presentation;
}

export interface ResidentWorldProfileBinderOptions {
  store: ContextGraphStore;
  previewMaxBytes: number;
  redactForOutput: (text: string) => string;
  now?: () => number;
}

export function createResidentWorldProfileBinder(
  options: ResidentWorldProfileBinderOptions,
): (
  derivationId: string,
  scope: ResidentCurrentWorldScopeV1,
  provenance: ResidentToolCallSnapshotV1,
) => string {
  const now = options.now ?? Date.now;
  return (derivationId, scope, provenance) => {
    if (!/^resident-identity-derivation:[0-9a-f]{64}$/.test(derivationId)) {
      throw new Error('resident world profile binding derivation ID is invalid');
    }
    if (provenance.toolName !== 'run') {
      throw new Error('resident world profile binding requires run provenance');
    }
    const currentWorldId = worldId(scope.worldId);
    const currentEventId = eventId(scope.eventId);
    if (!Number.isSafeInteger(scope.sequence) || scope.sequence < 1) {
      throw new Error('resident world profile binding sequence is invalid');
    }
    return options.store.bindResidentCurrentWorldProfile(
      {
        derivationId: residentIdentitySystemDerivationId(derivationId),
        worldId: currentWorldId,
        eventId: currentEventId,
        sequence: scope.sequence,
        provenance,
        boundAt: now(),
      },
      (receipt) => {
        const presentation = formatResidentWorldProfileBindingPresentation(
          receipt,
          options.previewMaxBytes,
        );
        if (options.redactForOutput(presentation) !== presentation) {
          throw new Error(
            'resident world profile binding cannot present the exact receipt because secret redaction would alter it',
          );
        }
        return presentation;
      },
    );
  };
}
