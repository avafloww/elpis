import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import { preview } from '../sandbox/preview.js';
import {
  ContextGraphStore,
  type ResidentSourceCandidateAuthorizationV1,
} from '../store/context-graph.js';
import { readPromptFacingSoulSnapshot } from '../store/soul.js';

export function formatResidentSourceAuthorizationPresentation(
  receipt: ResidentSourceCandidateAuthorizationV1,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('resident source authorization preview budget is invalid');
  }
  const presentation = [
    'SOURCE CANDIDATE AUTHORIZED — NOT PROFILED OR ACTIVE',
    `authorization_id: ${receipt.authorizationId}`,
    `candidate_id: ${receipt.candidateId}`,
    `soul_snapshot_id: ${receipt.soulSnapshotId}`,
    `scope_kind: ${receipt.scopeKind}`,
    `execution_context: ${receipt.executionContext}`,
    `activation_epoch: ${receipt.activationEpoch}`,
    `contract_artifact_id: ${receipt.contractArtifactId}`,
    `contract_content_hash: ${receipt.contractContentHash}`,
    `contract_content_bytes: ${receipt.contractContentBytes}`,
    `authorization_batch_id: ${receipt.authorizeBatchId}`,
    `authorization_batch_sha256: ${receipt.authorizeBatchSha256}`,
    `authorization_call: ${receipt.authorizeCallIndex}/${receipt.authorizeCallCount}`,
    `authorization_arguments_sha256: ${receipt.authorizeArgumentsSha256}`,
    '',
    'This receipt authorizes only the exact inspected identity source candidate.',
    'It creates no system-layer approval, profile, branch, provider call, effect authority, activation, or continuation advance.',
  ].join('\n');
  if (
    preview(presentation, maxBytes) !==
    `string(${presentation.length} chars):\n${presentation}`
  ) {
    throw new Error(
      'resident source authorization preview budget cannot present the exact receipt',
    );
  }
  return presentation;
}

export interface ResidentSourceCandidateAuthorizerOptions {
  store: ContextGraphStore;
  soulPath: string;
  previewMaxBytes: number;
  redactForOutput: (text: string) => string;
  now?: () => number;
}

export function createResidentSourceCandidateAuthorizer(
  options: ResidentSourceCandidateAuthorizerOptions,
): (candidateId: string, provenance: ResidentToolCallSnapshotV1) => string {
  const now = options.now ?? Date.now;
  return (candidateId, provenance) => {
    if (!/^resident-source-candidate:[0-9a-f]{64}$/.test(candidateId)) {
      throw new Error('resident source authorization candidate ID is invalid');
    }
    if (provenance.toolName !== 'run') {
      throw new Error('resident source authorization requires run provenance');
    }
    const freshSoul = readPromptFacingSoulSnapshot(options.soulPath);
    return options.store.authorizeResidentSourceCandidate(
      { candidateId, freshSoul, provenance, authorizedAt: now() },
      (receipt) => {
        const presentation = formatResidentSourceAuthorizationPresentation(
          receipt,
          options.previewMaxBytes,
        );
        if (options.redactForOutput(presentation) !== presentation) {
          throw new Error(
            'resident source authorization cannot present the exact receipt because secret redaction would alter it',
          );
        }
        return presentation;
      },
    );
  };
}
