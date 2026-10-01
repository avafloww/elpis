import type { BuildIdentity } from '../build-identity.js';
import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import { preview } from '../sandbox/preview.js';
import {
  ContextGraphStore,
  hashContextBytes,
  normalizeExactIsolatedProviderTarget,
  type ExactIsolatedProviderTargetV1,
  type RecoveredIsolatedProviderBindingVerificationV1,
} from '../store/context-graph.js';

export interface ResidentRecoveredProviderBindingVerificationV1
  extends RecoveredIsolatedProviderBindingVerificationV1 {
  readonly build: {
    readonly version: string;
    readonly revision: string | null;
    readonly treeClean: boolean | null;
    readonly exactRelease: boolean;
    readonly state: BuildIdentity['state'];
  };
}

export interface ResidentRecoveredProviderBindingVerifierOptions {
  store: ContextGraphStore;
  target: ExactIsolatedProviderTargetV1;
  buildIdentity: BuildIdentity;
  previewMaxBytes: number;
  redactForOutput: (text: string) => string;
}

function verificationWithBuild(
  verification: RecoveredIsolatedProviderBindingVerificationV1,
  buildIdentity: BuildIdentity,
): ResidentRecoveredProviderBindingVerificationV1 {
  return Object.freeze({
    ...verification,
    build: Object.freeze({
      version: buildIdentity.version,
      revision: buildIdentity.revision,
      treeClean: buildIdentity.treeClean,
      exactRelease: buildIdentity.exactRelease,
      state: buildIdentity.state,
    }),
  });
}

export function formatResidentRecoveredProviderBindingPresentation(
  verification: ResidentRecoveredProviderBindingVerificationV1,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('recovered provider binding preview budget is invalid');
  }
  const verificationJson = JSON.stringify(verification);
  const verificationHash = hashContextBytes(verificationJson);
  const presentation = [
    'RECOVERED ISOLATED PROVIDER BINDING VERIFIED — HISTORICAL READ ONLY',
    `verification_sha256: ${verificationHash}`,
    `build_version: ${verification.build.version}`,
    `build_revision: ${verification.build.revision ?? 'unknown'}`,
    `build_state: ${verification.build.state}`,
    `migration_name: ${verification.migrationName}`,
    `migration_checksum: ${verification.migrationChecksum}`,
    `activation_epoch: ${verification.activationEpoch}`,
    `binding_sha256: ${verification.bindingHash}`,
    `target_sha256: ${verification.targetHash}`,
    `candidate_sha256: ${verification.candidateHash}`,
    `recovery_sha256: ${verification.recoveryHash}`,
    '',
    'EXACT VERIFICATION JSON',
    verificationJson,
    '',
    'This read-only verification strictly rematerialized the newest historical binding, matched the current boot-resolved target, and checked crash recovery with no branch effects, capsules, or continuation advance.',
    'It created no ingress, profile, request, binding, provider call, network authority, tool call, effect, capsule, activation, or continuation change.',
    'It does not prove that the current writer can create a fresh binding or that fresh social ingress can be captured.',
  ].join('\n');
  if (
    preview(presentation, maxBytes) !==
    `string(${presentation.length} chars):\n${presentation}`
  ) {
    throw new Error(
      'recovered provider binding preview budget cannot present the exact verification',
    );
  }
  return presentation;
}

export function createResidentRecoveredProviderBindingVerifier(
  options: ResidentRecoveredProviderBindingVerifierOptions,
): (provenance: ResidentToolCallSnapshotV1) => string {
  const target = normalizeExactIsolatedProviderTarget(options.target);
  return (provenance) => {
    if (provenance.toolName !== 'run') {
      throw new Error('recovered provider binding verification requires run provenance');
    }
    let verification: RecoveredIsolatedProviderBindingVerificationV1;
    try {
      verification = options.store.verifyLatestRecoveredIsolatedProviderBinding(target);
    } catch {
      throw new Error('recovered isolated provider binding verification failed');
    }
    const withBuild = verificationWithBuild(verification, options.buildIdentity);
    const presentation = formatResidentRecoveredProviderBindingPresentation(
      withBuild,
      options.previewMaxBytes,
    );
    if (options.redactForOutput(presentation) !== presentation) {
      throw new Error(
        'recovered provider binding cannot present the exact verification because secret redaction would alter it',
      );
    }
    return presentation;
  };
}
