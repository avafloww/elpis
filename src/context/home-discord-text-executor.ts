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

export function createHomeDiscordTextExecutor(input: {
  store: ContextGraphStore;
  transport: HomeDiscordTextTransport;
  now?: () => number;
}): (
  speechAttemptId: HomeTextSpeechAttemptId,
) => Promise<HomeDiscordTextExecutionResult> {
  const now = input.now ?? Date.now;
  return async (speechAttemptId) => {
    const existing = input.store.getHomeTextSpeechReceipt(speechAttemptId);
    if (existing) {
      return {
        state: existing.receipt.phase,
        receipt: existing,
        completion: null,
      };
    }
    const speech = input.store.getHomeTextSpeechAttemptById(speechAttemptId);
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
          input.store.prepareHomeTextSpeechEffect({
            speechAttemptId,
            preparedAt: now(),
          });
        },
      );
    } catch (error) {
      if (!(error instanceof HomeDiscordTextTransportError)) throw error;
      const phase = error.disposition;
      const receipt = input.store.recordHomeTextSpeechFailure({
        speechAttemptId,
        phase,
        resolvedAt: now(),
      });
      return { state: phase, receipt, completion: null };
    }

    try {
      const completion = input.store.completeObservedHomeTextSpeech({
        speechAttemptId,
        evidence: {
          schemaVersion: 1,
          speechAttemptId,
          speechEffectId: speech.attempt.speechEffectId,
          messageId: evidence.messageId,
          guildId: evidence.guildId,
          channelId: evidence.channelId,
          discordNonce: evidence.nonce,
          statusCode: evidence.statusCode,
          textBytes: evidence.textBytes,
          textHash: evidence.textHash,
          observedAt: evidence.observedAt,
        },
      });
      return {
        state: 'observed',
        receipt: completion.speechReceipt,
        completion,
      };
    } catch {
      const receipt = input.store.recordHomeTextSpeechFailure({
        speechAttemptId,
        phase: 'issuance_uncertain',
        resolvedAt: now(),
      });
      return { state: 'issuance_uncertain', receipt, completion: null };
    }
  };
}
