// summarize.ts — shared summarization infrastructure for the compactor.
//
// The context compactor (compactor.ts) serializes conversation history into a
// text block, then makes a background LLM summarize call that is epoch-guarded
// (a clear invalidates an in-flight result) and non-blocking (the caller never
// waits; it polls at a safe checkpoint). These helpers extract that logic.
//
// - serializeHistory: turns ChatMessage[] into a flat text block with
// per-message content + tool-call code, capped at every level.
// - createGuardedSummarizer: wraps a background llm.summarize call with
// bounded retries, an epoch guard, a minimum-length quality gate (a
// too-short summary counts as a failed attempt and retries; otherwise a large
// fold can collapse into a nearly empty continuation, and an onResult
// callback the consumer uses to store / process the result.

import type { ChatMessage, LLM } from './llm.js';
import { cap } from '../sandbox/preview.js';

/** Serialize a message history into a flat text block for a summarize call.
 * Includes assistant `content` (capped) AND tool-call code (capped) so the
 * summarizer can actually see what the agent did — for this agent, assistant
 * `content` is usually empty and the substance is in `tool_calls` code + tool
 * results. Total size is capped so the summarize call itself doesn't 400 by
 * sending nearly the whole context window. */
export function serializeHistory(
  messages: ChatMessage[],
  opts: { contentCap?: number; codeCap?: number; totalCap?: number } = {},
): string {
  const { contentCap = 2000, codeCap = 1500, totalCap = 60000 } = opts;
  const text = messages
    .map((m) => {
      let s = `[${m.role}] ${cap(m.content ?? '', contentCap)}`;
 // Include the model's reasoning_content so the summarizer sees what the
 // agent was thinking, not just what it said/did — this preserves the
 // decision rationale across compaction boundaries.
      if (m.role === 'assistant' && m.reasoning_content) {
        s += `\n[reasoning]\n${cap(m.reasoning_content, contentCap)}`;
      }
      for (const tc of m.tool_calls ?? []) {
        try {
          const args = JSON.parse(tc.function.arguments);
          if (typeof args.code === 'string') s += `\n[ran code]\n${cap(args.code, codeCap)}`;
        } catch { /* malformed args — skip */ }
      }
      return s;
    })
    .join('\n');
 // When over the cap, drop the OLDEST content and keep the NEWEST: the tail of
 // the conversation is what a resuming instance most needs, and the summarizer
 // already lists early user messages verbatim from what survives. Keeping the
 // head (slice(0, totalCap)) would silently discard the most recent activity
 // while the note claimed the opposite.
  return text.length > totalCap
    ? '[oldest history truncated]…\n' + text.slice(-totalCap)
    : text;
}

export interface GuardedSummarizer {
  readonly running: boolean;
  readonly lastError: string | null;
  /** Kick off a background summarize call (no-op if already running). Returns
 * immediately; the result is delivered via the `onResult` callback.
 * `minChars` is the quality gate: a summary shorter than it is treated as a
 * FAILED attempt (recorded in lastError, retried up to `retries`) — a
 * degenerate one-sentence "summary" is a successful API call but a
 * catastrophic memory loss, so success must mean more than non-empty. */
  start(input: string, startOpts?: { minChars?: number }): void;
  /** Resolves when the in-flight summarize call finishes (or immediately if
 * none). Used by callers that need to wait at a safe checkpoint. */
  done(): Promise<void>;
  /** Bump the epoch (invalidate any in-flight call) and clear state. */
  reset(): void;
}

/** Create an epoch-guarded background summarizer. The consumer provides an
 * `onResult` callback that runs inside the guard (after the epoch check, before
 * `running` flips false) to store or process the summary. If `onResult`
 * throws, the error is captured as `lastError` and treated as a failure.
 *
 * - retries: max summarize attempts (default 1 — single try). The compactor
 * passes 3.
 * - onResult: called with the summary string on success.
 * - log: optional operator-log sink for failed/rejected attempts (a rejection
 * is otherwise invisible until the escalation nudge fires). */
export function createGuardedSummarizer(
  llm: LLM,
  opts: { retries?: number; onResult?: (summary: string) => void; log?: (line: string) => void } = {},
): GuardedSummarizer {
  const maxAttempts = opts.retries ?? 1;
  let running = false;
  let inflight: Promise<void> | null = null;
  let lastError: string | null = null;
  let epoch = 0;

  return {
    get running() { return running; },
    get lastError() { return lastError; },
    start(input: string, startOpts: { minChars?: number } = {}): void {
      if (running) return;
      running = true;
      const minChars = startOpts.minChars ?? 0;
      const startEpoch = epoch;
      inflight = (async () => {
        let summary: string | null = null;
        let attempts = 0;
        while (attempts < maxAttempts && summary === null) {
          attempts++;
          try {
            summary = await llm.summarize(input);
            if (summary !== null && summary.length < minChars) {
              if (startEpoch !== epoch) return; // superseded by a reset
              lastError = `summary rejected: ${summary.length} chars < ${minChars} floor (attempt ${attempts}/${maxAttempts})`;
              opts.log?.(`summarize attempt ${attempts}/${maxAttempts} rejected: ${summary.length} chars < ${minChars} floor`);
              summary = null;
            }
          } catch (e) {
            if (startEpoch !== epoch) return; // superseded by a reset
            lastError = e instanceof Error ? e.message : String(e);
            opts.log?.(`summarize attempt ${attempts}/${maxAttempts} failed: ${lastError}`);
            summary = null;
          }
        }
        if (summary !== null) {
          if (startEpoch !== epoch) return; // superseded by a reset
 // Clear the failure record on success: with the quality gate, a
 // reject-then-succeed cycle is the intended happy path, and a stale
 // rejection here would be misreported by the escalation nudge as the
 // current cycle's failure.
          lastError = null;
          try {
            opts.onResult?.(summary);
          } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
          }
        }
        running = false;
      })();
    },
    async done(): Promise<void> {
      if (inflight) await inflight;
    },
    reset(): void {
      epoch++;
      running = false;
      lastError = null;
      inflight = null;
    },
  };
}
