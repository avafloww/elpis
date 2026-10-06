import type {
  ActiveHomeProviderInvocationId,
  BranchRecoveryRecord,
  ContextGraphStore,
  DarkIsolatedProviderInvocationId,
  HomeTextSpeechAttemptId,
  HomeTextSpeechReceiptPhase,
  IsolatedProviderExecutionAttemptId,
  IsolatedProviderOutcomePhase,
} from '../store/context-graph.js';
import type { HomeDiscordTextExecutionResult } from './home-discord-text-executor.js';
import type { IsolatedProviderExecutionResult } from './isolated-provider-executor.js';

export type HomeTextOrchestrationResult =
  | { readonly state: 'not_authorized' }
  | {
      readonly state: 'observed';
      readonly invocationId: DarkIsolatedProviderInvocationId;
      readonly attemptId: IsolatedProviderExecutionAttemptId;
      readonly speechAttemptId: HomeTextSpeechAttemptId;
    }
  | {
      readonly state: 'provider_failed';
      readonly invocationId: DarkIsolatedProviderInvocationId;
      readonly attemptId: IsolatedProviderExecutionAttemptId;
      readonly phase: IsolatedProviderOutcomePhase;
      readonly recovery: BranchRecoveryRecord | null;
    }
  | {
      readonly state:
        'speech_pre_dispatch_rejected' | 'speech_issuance_uncertain';
      readonly invocationId: DarkIsolatedProviderInvocationId;
      readonly attemptId: IsolatedProviderExecutionAttemptId;
      readonly speechAttemptId: HomeTextSpeechAttemptId;
      readonly recovery: BranchRecoveryRecord | null;
    };

export interface HomeTextOrchestratorOptions {
  readonly store: ContextGraphStore;
  readonly executeProvider: (
    invocationId: DarkIsolatedProviderInvocationId,
  ) => Promise<IsolatedProviderExecutionResult>;
  readonly executeSpeech: (
    speechAttemptId: HomeTextSpeechAttemptId,
  ) => Promise<HomeDiscordTextExecutionResult>;
  readonly now?: () => number;
}

function speechState(
  phase: Exclude<HomeTextSpeechReceiptPhase, 'observed'>,
): 'speech_pre_dispatch_rejected' | 'speech_issuance_uncertain' {
  return phase === 'pre_dispatch_rejected'
    ? 'speech_pre_dispatch_rejected'
    : 'speech_issuance_uncertain';
}

function assertRecoveryChronology(
  store: ContextGraphStore,
  recoveredAt: number,
): void {
  const state = store.getRootCoordinatorState();
  const floor = [state.updatedAt];
  if (state.activeBranchId !== null) {
    const branch = store.getBranch(state.activeBranchId);
    if (!branch)
      throw new Error('active home text recovery branch disappeared');
    floor.push(branch.startedAt);
  }
  const active = store.getActiveHomeTextInvocation();
  if (active?.attempt) {
    const attempt = active.attempt;
    floor.push(attempt.attempt.authorizedAt);
    const effect = store.getEffect(attempt.attempt.effectId);
    if (effect) {
      floor.push(effect.preparedAt);
      if (effect.resolvedAt !== null) floor.push(effect.resolvedAt);
    }
    const response = store.getIsolatedProviderResponse(attempt.attemptId);
    if (response) floor.push(response.evidence.receivedAt);
    const outcome = store.getIsolatedProviderOutcome(attempt.attemptId);
    if (outcome) floor.push(outcome.outcome.completedAt);
    const speech = store.getHomeTextSpeechAttempt(attempt.attemptId);
    if (speech) {
      floor.push(speech.attempt.createdAt);
      const speechEffect = store.getEffect(speech.attempt.speechEffectId);
      if (speechEffect) {
        floor.push(speechEffect.preparedAt);
        if (speechEffect.resolvedAt !== null)
          floor.push(speechEffect.resolvedAt);
      }
      const receipt = store.getHomeTextSpeechReceipt(
        speech.attempt.speechAttemptId,
      );
      if (receipt) floor.push(receipt.receipt.resolvedAt);
    }
  }
  if (recoveredAt < Math.max(...floor)) {
    throw new Error('home text recovery timestamp precedes durable state');
  }
}

function recover(
  store: ContextGraphStore,
  recoveredAt: number,
): BranchRecoveryRecord | null {
  assertRecoveryChronology(store, recoveredAt);
  const branch = store.recoverCoordinatedBranch(recoveredAt);
  store.recoverPreparedEffects(recoveredAt);
  return branch;
}

function reconcileAndRecover(
  store: ContextGraphStore,
  recoveredAt: number,
): BranchRecoveryRecord | null {
  assertRecoveryChronology(store, recoveredAt);
  store.reconcileIsolatedProviderBeforeRecovery(recoveredAt);
  store.reconcileHomeTextSpeechBeforeRecovery(recoveredAt);
  return recover(store, recoveredAt);
}

export function createHomeTextOrchestrator(
  options: HomeTextOrchestratorOptions,
): () => Promise<HomeTextOrchestrationResult> {
  const now = options.now ?? Date.now;
  return async () => {
    const active = options.store.getActiveHomeTextInvocation();
    if (!active) return { state: 'not_authorized' };
    const invocationId = active.invocation.invocationId;

    if (active.attempt) {
      const reconciledAt = now();
      assertRecoveryChronology(options.store, reconciledAt);
      options.store.reconcileIsolatedProviderBeforeRecovery(reconciledAt);
      options.store.reconcileHomeTextSpeechBeforeRecovery(reconciledAt);
      const outcome = options.store.getIsolatedProviderOutcome(
        active.attempt.attemptId,
      );
      if (!outcome) {
        throw new Error(
          'active home text provider attempt has no terminal outcome',
        );
      }
      const speech = options.store.getHomeTextSpeechAttempt(
        active.attempt.attemptId,
      );
      if (speech) {
        const receipt = options.store.getHomeTextSpeechReceipt(
          speech.attempt.speechAttemptId,
        );
        if (!receipt || receipt.receipt.phase === 'observed') {
          throw new Error('active home text speech reconciliation is invalid');
        }
        return {
          state: speechState(receipt.receipt.phase),
          invocationId,
          attemptId: active.attempt.attemptId,
          speechAttemptId: speech.attempt.speechAttemptId,
          recovery: recover(options.store, reconciledAt),
        };
      }
      return {
        state: 'provider_failed',
        invocationId,
        attemptId: active.attempt.attemptId,
        phase: outcome.outcome.phase,
        recovery: recover(options.store, reconciledAt),
      };
    }

    let providerResult: IsolatedProviderExecutionResult;
    try {
      providerResult = await options.executeProvider(invocationId);
    } catch (error) {
      const recoveredAt = now();
      reconcileAndRecover(options.store, recoveredAt);
      throw error;
    }

    const expectedAttempt = providerResult.snapshot.attempt;
    if (
      !providerResult.fresh ||
      expectedAttempt.attempt.invocationId !== invocationId
    ) {
      reconcileAndRecover(options.store, now());
      throw new Error('provider attempt was not created by this orchestration');
    }
    const refreshed = options.store.getActiveHomeTextInvocation();
    if (
      !refreshed ||
      refreshed.invocation.invocationId !== invocationId ||
      !refreshed.attempt ||
      refreshed.attempt.attemptId !== expectedAttempt.attemptId
    ) {
      reconcileAndRecover(options.store, now());
      throw new Error(
        'provider execution did not create the authorized attempt',
      );
    }
    const attemptId = refreshed.attempt.attemptId;
    let outcome = options.store.getIsolatedProviderOutcome(attemptId);
    if (!outcome) {
      const recoveredAt = now();
      assertRecoveryChronology(options.store, recoveredAt);
      options.store.reconcileIsolatedProviderBeforeRecovery(recoveredAt);
      outcome = options.store.getIsolatedProviderOutcome(attemptId);
      if (!outcome) {
        reconcileAndRecover(options.store, recoveredAt);
        throw new Error('home text provider attempt has no terminal outcome');
      }
    }

    if (outcome.outcome.outcomeKind === 'visible_success') {
      const speech = options.store.getHomeTextSpeechAttempt(attemptId);
      if (!speech) {
        reconcileAndRecover(options.store, now());
        throw new Error(
          'successful home text provider attempt has no speech barrier',
        );
      }
      try {
        await options.executeSpeech(speech.attempt.speechAttemptId);
      } catch (error) {
        reconcileAndRecover(options.store, now());
        throw error;
      }
      let receipt = options.store.getHomeTextSpeechReceipt(
        speech.attempt.speechAttemptId,
      );
      if (!receipt) {
        const recoveredAt = now();
        assertRecoveryChronology(options.store, recoveredAt);
        options.store.reconcileHomeTextSpeechBeforeRecovery(recoveredAt);
        receipt = options.store.getHomeTextSpeechReceipt(
          speech.attempt.speechAttemptId,
        );
        if (!receipt) {
          reconcileAndRecover(options.store, recoveredAt);
          throw new Error('home text speech execution has no terminal receipt');
        }
      }
      if (receipt.receipt.phase === 'observed') {
        return {
          state: 'observed',
          invocationId,
          attemptId,
          speechAttemptId: speech.attempt.speechAttemptId,
        };
      }
      const recoveredAt = now();
      return {
        state: speechState(receipt.receipt.phase),
        invocationId,
        attemptId,
        speechAttemptId: speech.attempt.speechAttemptId,
        recovery: recover(options.store, recoveredAt),
      };
    }

    const recoveredAt = now();
    assertRecoveryChronology(options.store, recoveredAt);
    options.store.reconcileHomeTextSpeechBeforeRecovery(recoveredAt);
    return {
      state: 'provider_failed',
      invocationId,
      attemptId,
      phase: outcome.outcome.phase,
      recovery: recover(options.store, recoveredAt),
    };
  };
}

export type ActiveHomeTextOrchestrationResult =
  | { readonly state: 'not_authorized' }
  | {
      readonly state: 'observed';
      readonly invocationId: ActiveHomeProviderInvocationId;
      readonly attemptId: IsolatedProviderExecutionAttemptId;
      readonly speechAttemptId: HomeTextSpeechAttemptId;
    }
  | {
      readonly state: 'provider_failed';
      readonly invocationId: ActiveHomeProviderInvocationId;
      readonly attemptId: IsolatedProviderExecutionAttemptId;
      readonly phase: IsolatedProviderOutcomePhase;
      readonly recovery: BranchRecoveryRecord | null;
    }
  | {
      readonly state:
        'speech_pre_dispatch_rejected' | 'speech_issuance_uncertain';
      readonly invocationId: ActiveHomeProviderInvocationId;
      readonly attemptId: IsolatedProviderExecutionAttemptId;
      readonly speechAttemptId: HomeTextSpeechAttemptId;
      readonly recovery: BranchRecoveryRecord | null;
    };

export interface ActiveHomeTextOrchestratorOptions {
  readonly store: ContextGraphStore;
  readonly executeProvider: (
    invocationId: ActiveHomeProviderInvocationId,
  ) => Promise<IsolatedProviderExecutionResult>;
  readonly executeSpeech: (
    speechAttemptId: HomeTextSpeechAttemptId,
  ) => Promise<HomeDiscordTextExecutionResult>;
  readonly now?: () => number;
}

function assertActiveRecoveryChronology(
  store: ContextGraphStore,
  recoveredAt: number,
): void {
  const state = store.getRootCoordinatorState();
  const floor = [state.updatedAt];
  if (state.activeBranchId !== null) {
    const branch = store.getBranch(state.activeBranchId);
    if (!branch) throw new Error('active provider recovery branch disappeared');
    floor.push(branch.startedAt);
  }
  const active = store.getActiveHomeProviderTextInvocation();
  if (active?.attempt) {
    const attempt = active.attempt;
    floor.push(attempt.attempt.authorizedAt);
    const effect = store.getEffect(attempt.attempt.effectId);
    if (effect) {
      floor.push(effect.preparedAt);
      if (effect.resolvedAt !== null) floor.push(effect.resolvedAt);
    }
    const response = store.getIsolatedProviderResponse(attempt.attemptId);
    if (response) floor.push(response.evidence.receivedAt);
    const outcome = store.getIsolatedProviderOutcome(attempt.attemptId);
    if (outcome) floor.push(outcome.outcome.completedAt);
    const speech = store.getActiveHomeTextSpeechAttempt(attempt.attemptId);
    if (speech) {
      floor.push(speech.attempt.createdAt);
      const speechEffect = store.getEffect(speech.attempt.speechEffectId);
      if (speechEffect) {
        floor.push(speechEffect.preparedAt);
        if (speechEffect.resolvedAt !== null)
          floor.push(speechEffect.resolvedAt);
      }
      const receipt = store.getActiveHomeTextSpeechReceipt(
        speech.attempt.speechAttemptId,
      );
      if (receipt) floor.push(receipt.receipt.resolvedAt);
    }
  }
  if (recoveredAt < Math.max(...floor)) {
    throw new Error(
      'active provider recovery timestamp precedes durable state',
    );
  }
}

function recoverActive(
  store: ContextGraphStore,
  recoveredAt: number,
): BranchRecoveryRecord | null {
  assertActiveRecoveryChronology(store, recoveredAt);
  const branch = store.recoverCoordinatedBranch(recoveredAt);
  store.recoverPreparedEffects(recoveredAt);
  return branch;
}

function reconcileActiveAndRecover(
  store: ContextGraphStore,
  recoveredAt: number,
): BranchRecoveryRecord | null {
  assertActiveRecoveryChronology(store, recoveredAt);
  store.reconcileIsolatedProviderBeforeRecovery(recoveredAt);
  store.reconcileActiveHomeTextSpeechBeforeRecovery(recoveredAt);
  return recoverActive(store, recoveredAt);
}

export function createActiveHomeTextOrchestrator(
  options: ActiveHomeTextOrchestratorOptions,
): () => Promise<ActiveHomeTextOrchestrationResult> {
  const now = options.now ?? Date.now;
  return async () => {
    const active = options.store.getActiveHomeProviderTextInvocation();
    if (!active) return { state: 'not_authorized' };
    const invocationId = active.invocation.invocationId;

    if (active.attempt) {
      const reconciledAt = now();
      assertActiveRecoveryChronology(options.store, reconciledAt);
      options.store.reconcileIsolatedProviderBeforeRecovery(reconciledAt);
      const outcome = options.store.getIsolatedProviderOutcome(
        active.attempt.attemptId,
      );
      if (!outcome) {
        throw new Error('active provider attempt has no terminal outcome');
      }
      const speech = options.store.getActiveHomeTextSpeechAttempt(
        active.attempt.attemptId,
      );
      if (speech) {
        options.store.reconcileActiveHomeTextSpeechBeforeRecovery(reconciledAt);
        const receipt = options.store.getActiveHomeTextSpeechReceipt(
          speech.attempt.speechAttemptId,
        );
        if (!receipt || receipt.receipt.phase === 'observed') {
          throw new Error('active speech reconciliation is invalid');
        }
        return {
          state: speechState(receipt.receipt.phase),
          invocationId,
          attemptId: active.attempt.attemptId,
          speechAttemptId: speech.attempt.speechAttemptId,
          recovery: recoverActive(options.store, reconciledAt),
        };
      }
      return {
        state: 'provider_failed',
        invocationId,
        attemptId: active.attempt.attemptId,
        phase: outcome.outcome.phase,
        recovery: recoverActive(options.store, reconciledAt),
      };
    }

    let providerResult: IsolatedProviderExecutionResult;
    try {
      providerResult = await options.executeProvider(invocationId);
    } catch (error) {
      reconcileActiveAndRecover(options.store, now());
      throw error;
    }

    const expectedAttempt = providerResult.snapshot.attempt;
    if (
      !providerResult.fresh ||
      expectedAttempt.attempt.invocationId !== invocationId
    ) {
      reconcileActiveAndRecover(options.store, now());
      throw new Error(
        'active provider attempt was not created by this orchestration',
      );
    }
    const refreshed = options.store.getActiveHomeProviderTextInvocation();
    if (
      !refreshed ||
      refreshed.invocation.invocationId !== invocationId ||
      !refreshed.attempt ||
      refreshed.attempt.attemptId !== expectedAttempt.attemptId
    ) {
      reconcileActiveAndRecover(options.store, now());
      throw new Error('provider execution did not create the active attempt');
    }
    const attemptId = refreshed.attempt.attemptId;
    let outcome = options.store.getIsolatedProviderOutcome(attemptId);
    if (!outcome) {
      const recoveredAt = now();
      assertActiveRecoveryChronology(options.store, recoveredAt);
      options.store.reconcileIsolatedProviderBeforeRecovery(recoveredAt);
      outcome = options.store.getIsolatedProviderOutcome(attemptId);
      if (!outcome) {
        reconcileActiveAndRecover(options.store, recoveredAt);
        throw new Error('active provider attempt has no terminal outcome');
      }
    }

    if (outcome.outcome.outcomeKind === 'visible_success') {
      const speech = options.store.getActiveHomeTextSpeechAttempt(attemptId);
      if (!speech) {
        reconcileActiveAndRecover(options.store, now());
        throw new Error(
          'successful active provider attempt has no speech barrier',
        );
      }
      try {
        await options.executeSpeech(speech.attempt.speechAttemptId);
      } catch (error) {
        reconcileActiveAndRecover(options.store, now());
        throw error;
      }
      let receipt = options.store.getActiveHomeTextSpeechReceipt(
        speech.attempt.speechAttemptId,
      );
      if (!receipt) {
        const recoveredAt = now();
        assertActiveRecoveryChronology(options.store, recoveredAt);
        options.store.reconcileActiveHomeTextSpeechBeforeRecovery(recoveredAt);
        receipt = options.store.getActiveHomeTextSpeechReceipt(
          speech.attempt.speechAttemptId,
        );
        if (!receipt) {
          reconcileActiveAndRecover(options.store, recoveredAt);
          throw new Error('active speech execution has no terminal receipt');
        }
      }
      if (receipt.receipt.phase === 'observed') {
        return {
          state: 'observed',
          invocationId,
          attemptId,
          speechAttemptId: speech.attempt.speechAttemptId,
        };
      }
      const recoveredAt = now();
      return {
        state: speechState(receipt.receipt.phase),
        invocationId,
        attemptId,
        speechAttemptId: speech.attempt.speechAttemptId,
        recovery: recoverActive(options.store, recoveredAt),
      };
    }

    const recoveredAt = now();
    assertActiveRecoveryChronology(options.store, recoveredAt);
    options.store.reconcileActiveHomeTextSpeechBeforeRecovery(recoveredAt);
    return {
      state: 'provider_failed',
      invocationId,
      attemptId,
      phase: outcome.outcome.phase,
      recovery: recoverActive(options.store, recoveredAt),
    };
  };
}
