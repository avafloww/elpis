import {
  HomeDiscordTextTransportError,
  type HomeDiscordTextTransport,
} from './home-discord-text-transport.js';
import {
  type ContextGraphStore,
  type HomeTextObservedCompletion,
  type HomeTextSpeechAttemptId,
  type HomeTextSpeechReceiptPhase,
  type HomeTextSpeechReceiptRecord,
} from '../store/context-graph.js';

export interface HomeDiscordTextExecutionResult {
  readonly state: HomeTextSpeechReceiptPhase;
  readonly receipt: HomeTextSpeechReceiptRecord;
  readonly completion: HomeTextObservedCompletion | null;
}

function executeHomeDiscordText(input: {
  store: ContextGraphStore;
  transport: HomeDiscordTextTransport;
  now: () => number;
  active: boolean;
}): (
  speechAttemptId: HomeTextSpeechAttemptId,
) => Promise<HomeDiscordTextExecutionResult> {
  return async (speechAttemptId) => {
    const existing = input.active
      ? input.store.getActiveHomeTextSpeechReceipt(speechAttemptId)
      : input.store.getHomeTextSpeechReceipt(speechAttemptId);
    if (existing) {
      return {
        state: existing.receipt.phase,
        receipt: existing,
        completion: null,
      };
    }
    const speech = input.active
      ? input.store.getActiveHomeTextSpeechAttemptById(speechAttemptId)
      : input.store.getHomeTextSpeechAttemptById(speechAttemptId);
    let evidence;
    try {
      evidence = await input.transport.send(
        {
          guildId: speech.attempt.guildId,
          channelId: speech.attempt.channelId,
          text: speech.attempt.visibleText,
          textBytes: speech.attempt.visibleBytes,
          textHash: speech.attempt.visibleHash,
          nonce: speech.attempt.discordNonce,
        },
        () => {
          const effectInput = {
            speechAttemptId,
            preparedAt: input.now(),
          };
          if (input.active) {
            input.store.prepareActiveHomeTextSpeechEffect(effectInput);
          } else {
            input.store.prepareHomeTextSpeechEffect(effectInput);
          }
        },
      );
    } catch (error) {
      if (!(error instanceof HomeDiscordTextTransportError)) throw error;
      const phase = error.disposition;
      const failureInput = {
        speechAttemptId,
        phase,
        resolvedAt: input.now(),
      };
      const receipt = input.active
        ? input.store.recordActiveHomeTextSpeechFailure(failureInput)
        : input.store.recordHomeTextSpeechFailure(failureInput);
      return { state: phase, receipt, completion: null };
    }

    try {
      const completionInput = {
        speechAttemptId,
        evidence: {
          schemaVersion: 1 as const,
          speechAttemptId,
          speechEffectId: speech.attempt.speechEffectId,
          messageId: evidence.messageId,
          guildId: evidence.guildId,
          channelId: evidence.channelId,
          discordNonce: evidence.nonce,
          statusCode: 200 as const,
          textBytes: evidence.textBytes,
          textHash: evidence.textHash,
          observedAt: evidence.observedAt,
        },
      };
      const completion = input.active
        ? input.store.completeObservedActiveHomeTextSpeech(completionInput)
        : input.store.completeObservedHomeTextSpeech(completionInput);
      return {
        state: 'observed',
        receipt: completion.speechReceipt,
        completion,
      };
    } catch {
      const failureInput = {
        speechAttemptId,
        phase: 'issuance_uncertain' as const,
        resolvedAt: input.now(),
      };
      const receipt = input.active
        ? input.store.recordActiveHomeTextSpeechFailure(failureInput)
        : input.store.recordHomeTextSpeechFailure(failureInput);
      return { state: 'issuance_uncertain', receipt, completion: null };
    }
  };
}

export function createHomeDiscordTextExecutor(input: {
  store: ContextGraphStore;
  transport: HomeDiscordTextTransport;
  now?: () => number;
}): (
  speechAttemptId: HomeTextSpeechAttemptId,
) => Promise<HomeDiscordTextExecutionResult> {
  return executeHomeDiscordText({
    store: input.store,
    transport: input.transport,
    now: input.now ?? Date.now,
    active: false,
  });
}

export function createActiveHomeDiscordTextExecutor(input: {
  store: ContextGraphStore;
  transport: HomeDiscordTextTransport;
  now?: () => number;
}): (
  speechAttemptId: HomeTextSpeechAttemptId,
) => Promise<HomeDiscordTextExecutionResult> {
  return executeHomeDiscordText({
    store: input.store,
    transport: input.transport,
    now: input.now ?? Date.now,
    active: true,
  });
}
