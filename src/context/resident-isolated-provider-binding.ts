import type { MaterializedConfig } from '../config.js';
import { configForLlmRole, isResolvedGatewayConfig } from '../config.js';
import type { ResidentToolCallSnapshotV1 } from '../kernel/resident-run-provenance.js';
import { generationIdentityForConfig } from '../llm/provenance.js';
import { preview } from '../sandbox/preview.js';
import {
  ContextGraphStore,
  eventId,
  normalizeExactIsolatedProviderTarget,
  worldId,
  type DarkIsolatedProviderBindingRecord,
  type ExactIsolatedProviderTargetV1,
} from '../store/context-graph.js';
import type { ResidentCurrentWorldScopeV1 } from './resident-world-profile-binding.js';

export function exactMainIsolatedProviderTarget(
  config: MaterializedConfig,
): ExactIsolatedProviderTargetV1 {
  const main = configForLlmRole(config, 'main');
  const identity = generationIdentityForConfig(main);
  if (isResolvedGatewayConfig(main)) {
    const target = main.llm.target;
    if (!identity.gateway) {
      throw new Error('Gateway main target has no generation authority');
    }
    return normalizeExactIsolatedProviderTarget({
      schemaVersion: 1,
      role: 'main',
      targetRef: target.modelRef,
      providerType: identity.providerType,
      model: identity.model,
      apiSurface: identity.apiSurface,
      apiEndpoint: identity.apiEndpoint,
      gateway: identity.gateway,
      reasoningEffort: target.reasoningEffort,
      reasoningSummary: target.reasoningSummary,
      reasoningContext: target.reasoningContext,
      externalThinking: target.externalThinking,
      toolContractVersion: identity.toolContractVersion,
      wireContractGeneration: 1,
    });
  }
  const target = main.llm.registry.targets.main;
  return normalizeExactIsolatedProviderTarget({
    schemaVersion: 1,
    role: 'main',
    targetRef: target.ref,
    providerType: identity.providerType,
    model: identity.model,
    apiSurface: identity.apiSurface,
    apiEndpoint: identity.apiEndpoint,
    gateway: null,
    reasoningEffort: main.llm.reasoningEffort,
    reasoningSummary: main.llm.reasoningSummary,
    reasoningContext: main.llm.reasoningContext,
    externalThinking: main.llm.externalThinking,
    toolContractVersion: identity.toolContractVersion,
    wireContractGeneration: 1,
  });
}

export function formatResidentIsolatedProviderBindingPresentation(
  record: DarkIsolatedProviderBindingRecord,
  maxBytes: number,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('isolated provider binding preview budget is invalid');
  }
  const presentation = [
    'DARK ISOLATED PROVIDER BINDING RECORDED — NOT RUNNABLE',
    `binding_id: ${record.bindingId}`,
    `world_id: ${record.binding.worldId}`,
    `branch_id: ${record.binding.branchId}`,
    `request_view_id: ${record.binding.requestViewId}`,
    `request_view_hash: ${record.binding.requestViewHash}`,
    `candidate_sha256: ${record.binding.candidateHash}`,
    `candidate_bytes: ${record.binding.candidateBytes}`,
    `target_ref: ${record.binding.target.targetRef}`,
    `target_provider_type: ${record.binding.target.providerType}`,
    `target_model: ${record.binding.target.model}`,
    `target_api_surface: ${record.binding.target.apiSurface}`,
    `target_api_endpoint: ${record.binding.target.apiEndpoint}`,
    `target_sha256: ${record.targetHash}`,
    `cache_namespace: ${record.binding.cacheNamespace}`,
    '',
    'EXACT BINDING JSON',
    record.bindingJson,
    '',
    'This immutable receipt records one credential-free target for the existing dark request. It did not dispatch a provider request and grants no network, tool, effect, activation, or continuation authority.',
  ].join('\n');
  if (
    preview(presentation, maxBytes) !==
    `string(${presentation.length} chars):\n${presentation}`
  ) {
    throw new Error(
      'isolated provider binding preview budget cannot present the exact receipt',
    );
  }
  return presentation;
}

export interface ResidentIsolatedProviderBinderOptions {
  store: ContextGraphStore;
  target: ExactIsolatedProviderTargetV1;
  previewMaxBytes: number;
  redactForOutput: (text: string) => string;
  now?: () => number;
}

export function createResidentIsolatedProviderBinder(
  options: ResidentIsolatedProviderBinderOptions,
): (
  scope: ResidentCurrentWorldScopeV1,
  provenance: ResidentToolCallSnapshotV1,
) => string {
  const target = normalizeExactIsolatedProviderTarget(options.target);
  const now = options.now ?? Date.now;
  return (scope, provenance) => {
    if (provenance.toolName !== 'run') {
      throw new Error('isolated provider binding requires run provenance');
    }
    if (!Number.isSafeInteger(scope.sequence) || scope.sequence < 1) {
      throw new Error('isolated provider binding sequence is invalid');
    }
    return options.store.bindResidentDarkRequestToIsolatedProvider(
      {
        worldId: worldId(scope.worldId),
        eventId: eventId(scope.eventId),
        sequence: scope.sequence,
        target,
        provenance,
        boundAt: now(),
      },
      (record) => {
        const presentation = formatResidentIsolatedProviderBindingPresentation(
          record,
          options.previewMaxBytes,
        );
        if (options.redactForOutput(presentation) !== presentation) {
          throw new Error(
            'isolated provider binding cannot present the exact receipt because secret redaction would alter it',
          );
        }
        return presentation;
      },
    );
  };
}
