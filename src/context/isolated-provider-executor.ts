import { configForLlmRole, type MaterializedConfig } from '../config.js';
import type { LLM, StandaloneCompleteResult } from '../llm/llm.js';
import {
  ContextGraphStore,
  darkIsolatedProviderInvocationId,
  worldId,
  type DarkIsolatedProviderInvocationId,
  type EffectRecord,
  type IsolatedProviderExecutionAttemptRecord,
  type IsolatedProviderOutcomeRecord,
  type IsolatedProviderResponseEvidenceRecord,
  type WorldId,
} from '../store/context-graph.js';
import { exactMainIsolatedProviderTarget } from './resident-isolated-provider-binding.js';

export interface IsolatedProviderExecutionSnapshot {
  readonly attempt: IsolatedProviderExecutionAttemptRecord;
  readonly effect: EffectRecord | null;
  readonly response: IsolatedProviderResponseEvidenceRecord | null;
  readonly outcome: IsolatedProviderOutcomeRecord | null;
}

export type IsolatedProviderExecutionResult =
  | { readonly state: 'succeeded'; readonly snapshot: IsolatedProviderExecutionSnapshot }
  | { readonly state: 'failed'; readonly snapshot: IsolatedProviderExecutionSnapshot }
  | { readonly state: 'issuance_uncertain'; readonly snapshot: IsolatedProviderExecutionSnapshot }
  | { readonly state: 'issued_outcome_unknown'; readonly snapshot: IsolatedProviderExecutionSnapshot }
  | { readonly state: 'attempt_recorded'; readonly snapshot: IsolatedProviderExecutionSnapshot };

export interface IsolatedProviderExecutorOptions {
  readonly store: ContextGraphStore;
  readonly config: MaterializedConfig;
  readonly llm: LLM;
  readonly expectedWorldId: WorldId;
  readonly maxOutputBytes: number;
  readonly now?: () => number;
}

function assertExactResultTarget(
  result: StandaloneCompleteResult,
  target: ReturnType<typeof exactMainIsolatedProviderTarget>,
): void {
  if (
    result.model !== target.model ||
    result.providerType !== target.providerType ||
    result.apiSurface !== target.apiSurface ||
    result.apiEndpoint !== target.apiEndpoint ||
    result.toolContractVersion !== target.toolContractVersion ||
    (result.gateway ?? null) !== null ||
    (result.reasoningEffort ?? null) !== target.reasoningEffort
  ) {
    throw new Error('isolated provider result provenance does not match authorized target');
  }
}

function snapshot(
  store: ContextGraphStore,
  attempt: IsolatedProviderExecutionAttemptRecord,
): IsolatedProviderExecutionSnapshot {
  return {
    attempt,
    effect: store.getEffect(attempt.attempt.effectId),
    response: store.getIsolatedProviderResponse(attempt.attemptId),
    outcome: store.getIsolatedProviderOutcome(attempt.attemptId),
  };
}

function classifySnapshot(value: IsolatedProviderExecutionSnapshot): IsolatedProviderExecutionResult {
  if (value.outcome?.outcome.outcomeKind === 'visible_success') {
    return { state: 'succeeded', snapshot: value };
  }
  if (value.outcome?.outcome.phase === 'issuance_uncertain') {
    return { state: 'issuance_uncertain', snapshot: value };
  }
  if (value.outcome?.outcome.outcomeKind === 'visible_error') {
    return { state: 'failed', snapshot: value };
  }
  if (value.response !== null || value.effect?.status === 'observed' || value.effect?.status === 'failed') {
    return { state: 'issued_outcome_unknown', snapshot: value };
  }
  if (value.effect?.status === 'prepared' || value.effect?.status === 'uncertain') {
    return { state: 'issuance_uncertain', snapshot: value };
  }
  return { state: 'attempt_recorded', snapshot: value };
}

export function createIsolatedProviderExecutor(options: IsolatedProviderExecutorOptions): (
  invocationId: DarkIsolatedProviderInvocationId,
) => Promise<IsolatedProviderExecutionResult> {
  const expectedWorldId = worldId(options.expectedWorldId);
  const now = options.now ?? Date.now;
  return async (invocationValue) => {
    const invocationId = darkIsolatedProviderInvocationId(invocationValue);
    const existing = options.store.getIsolatedProviderExecutionAttemptForInvocation(invocationId);
    if (existing) {
      if (existing.attempt.worldId !== expectedWorldId) {
        throw new Error('isolated provider execution attempt belongs to another world');
      }
      return classifySnapshot(snapshot(options.store, existing));
    }
    const mainConfig = configForLlmRole(options.config, 'main');
    const directLlm = mainConfig.llm;
    const target = exactMainIsolatedProviderTarget(options.config);
    if (
      !('callTimeoutMs' in directLlm) ||
      !('streamIdleTimeoutMs' in directLlm)
    ) {
      throw new Error('isolated provider execution requires direct timeout configuration');
    }
    if (options.llm.model !== target.model) {
      throw new Error('configured provider model does not match authorized target');
    }
    if (!options.llm.completeStandalone) {
      throw new Error('configured provider has no standalone completion lane');
    }
    const completeStandalone = options.llm.completeStandalone.bind(options.llm);
    const begun = options.store.beginIsolatedProviderExecutionAttempt({
      invocationId,
      expectedWorldId,
      expectedTarget: target,
      callTimeoutMs: directLlm.callTimeoutMs,
      streamIdleTimeoutMs: directLlm.streamIdleTimeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      authorizedAt: now(),
    });
    if (!begun.fresh) return classifySnapshot(snapshot(options.store, begun.attempt));

    let effectPrepared = false;
    try {
      const result = await completeStandalone(
        begun.request.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        {
          cacheKey: begun.attempt.attempt.cacheNamespace,
          model: target.model,
          ...(target.reasoningEffort === null
            ? {}
            : { reasoningEffort: target.reasoningEffort }),
          callTimeoutMs: begun.attempt.attempt.callTimeoutMs,
          streamIdleTimeoutMs: begun.attempt.attempt.streamIdleTimeoutMs,
          maxOutputBytes: begun.attempt.attempt.maxOutputBytes,
          allowHistoricalToolMessages: false,
          retryUnauthorized: false,
          dispatchLifecycle: {
            beforeNetwork({ attempt }) {
              if (attempt !== 1) throw new Error('isolated provider attempted transport replay');
              options.store.prepareIsolatedProviderExecutionEffect(
                begun.attempt.attemptId,
                now(),
              );
              effectPrepared = true;
            },
            responseReceived({ attempt, status }) {
              if (attempt !== 1) throw new Error('isolated provider observed replayed response');
              options.store.recordIsolatedProviderResponse({
                attemptId: begun.attempt.attemptId,
                statusCode: status,
                receivedAt: now(),
              });
            },
          },
        },
      );
      if (!effectPrepared || options.store.getIsolatedProviderResponse(begun.attempt.attemptId) === null) {
        throw new Error('isolated provider completion lacked positive response evidence');
      }
      if (result.toolCalls && result.toolCalls.length > 0) {
        throw new Error('isolated provider returned forbidden tool calls');
      }
      assertExactResultTarget(result, target);
      options.store.recordIsolatedProviderOutcome({
        attemptId: begun.attempt.attemptId,
        outcomeKind: 'visible_success',
        phase: 'issued',
        visibleText: result.content,
        completedAt: now(),
      });
    } catch (error) {
      const existingOutcome = options.store.getIsolatedProviderOutcome(begun.attempt.attemptId);
      if (existingOutcome === null) {
        const response = options.store.getIsolatedProviderResponse(begun.attempt.attemptId);
        const phase = !effectPrepared
          ? 'pre_dispatch_rejected'
          : response === null
            ? 'issuance_uncertain'
            : 'issued';
        options.store.recordIsolatedProviderOutcome({
          attemptId: begun.attempt.attemptId,
          outcomeKind: 'visible_error',
          phase,
          visibleText:
            phase === 'pre_dispatch_rejected'
              ? 'provider request rejected before dispatch'
              : phase === 'issuance_uncertain'
                ? 'provider request outcome is uncertain'
                : 'provider request failed after response',
          completedAt: now(),
        });
      }
    }
    return classifySnapshot(snapshot(options.store, begun.attempt));
  };
}
