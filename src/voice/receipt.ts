import type { VoiceDelivery } from '../types.js';

/** One voice response may run for at most the configured one-hour session cap. */
export const MAX_VOICE_PLAYED_MS = 60 * 60 * 1000;
/** Keep restored speech receipts useful without trusting unbounded JSONL input. */
export const MAX_VOICE_TRANSCRIPT_BYTES = 32 * 1024;

/** Rebuild a voice receipt from its public fields, dropping malformed,
 * oversized, or impossible persisted values. */
export function normalizeVoiceDelivery(
  value: unknown,
): VoiceDelivery | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  if (
    raw.status !== 'played' &&
    raw.status !== 'interrupted' &&
    raw.status !== 'failed'
  )
    return undefined;
  if (
    typeof raw.transcript !== 'string' ||
    Buffer.byteLength(raw.transcript, 'utf8') > MAX_VOICE_TRANSCRIPT_BYTES
  )
    return undefined;
  if (
    typeof raw.playedMs !== 'number' ||
    !Number.isSafeInteger(raw.playedMs) ||
    raw.playedMs < 0 ||
    raw.playedMs > MAX_VOICE_PLAYED_MS
  )
    return undefined;
  return {
    status: raw.status,
    transcript: raw.transcript,
    playedMs: raw.playedMs,
  };
}
