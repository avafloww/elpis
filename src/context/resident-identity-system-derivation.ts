import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import { preview } from '../sandbox/preview.js';
import {
  ContextGraphStore,
  type ResidentIdentitySystemDerivationV1,
} from '../store/context-graph.js';
import { readPromptFacingSoulSnapshot } from '../store/soul.js';

export function formatResidentIdentitySystemDerivationPresentation(
  receipt: ResidentIdentitySystemDerivationV1,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('resident identity derivation preview budget is invalid');
  }
  const presentation = [
    'AUTHORIZED IDENTITY SYSTEM LAYERS DERIVED — NOT PROFILED OR ACTIVE',
    `derivation_id: ${receipt.derivationId}`,
    `authorization_id: ${receipt.authorizationId}`,
    `activation_epoch: ${receipt.activationEpoch}`,
    `authority_revision: ${receipt.authorityRevision}`,
    `predecessor_derivation_id: ${receipt.predecessorDerivationId ?? 'none'}`,
    `contract_artifact_id: ${receipt.contractArtifactId}`,
    `soul_snapshot_id: ${receipt.soulSnapshotId}`,
    `contract_layer_id: ${receipt.contractLayerId}`,
    `contract_approval_id: ${receipt.contractApprovalId}`,
    `identity_layer_id: ${receipt.identityLayerId}`,
    `identity_approval_id: ${receipt.identityApprovalId}`,
    `derivation_batch_id: ${receipt.deriveBatchId}`,
    `derivation_batch_sha256: ${receipt.deriveBatchSha256}`,
    `derivation_call: ${receipt.deriveCallIndex}/${receipt.deriveCallCount}`,
    `derivation_arguments_sha256: ${receipt.deriveArgumentsSha256}`,
    '',
    'This receipt creates exactly two immutable worldless system layers and their typed approvals from the authorized sources.',
    'It creates no profile, world, branch, request view, provider request, effect authority, activation, or continuation advance.',
  ].join('\n');
  if (
    preview(presentation, maxBytes) !==
    `string(${presentation.length} chars):\n${presentation}`
  ) {
    throw new Error(
      'resident identity derivation preview budget cannot present the exact receipt',
    );
  }
  return presentation;
}

export interface ResidentIdentitySystemDeriverOptions {
  store: ContextGraphStore;
  soulPath: string;
  previewMaxBytes: number;
  redactForOutput: (text: string) => string;
  now?: () => number;
}

export function createResidentIdentitySystemDeriver(
  options: ResidentIdentitySystemDeriverOptions,
): (authorizationId: string, provenance: ResidentToolCallSnapshotV1) => string {
  const now = options.now ?? Date.now;
  return (authorizationId, provenance) => {
    if (!/^resident-source-authorization:[0-9a-f]{64}$/.test(authorizationId)) {
      throw new Error(
        'resident identity derivation authorization ID is invalid',
      );
    }
    if (provenance.toolName !== 'run') {
      throw new Error('resident identity derivation requires run provenance');
    }
    const freshSoul = readPromptFacingSoulSnapshot(options.soulPath);
    return options.store.deriveResidentIdentitySystemLayers(
      { authorizationId, freshSoul, provenance, derivedAt: now() },
      (receipt) => {
        const presentation = formatResidentIdentitySystemDerivationPresentation(
          receipt,
          options.previewMaxBytes,
        );
        if (options.redactForOutput(presentation) !== presentation) {
          throw new Error(
            'resident identity derivation cannot present the exact receipt because secret redaction would alter it',
          );
        }
        return presentation;
      },
    );
  };
}
