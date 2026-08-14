// compactor.ts — async, non-blocking context compaction with a frozen boundary.
//
// (monocontext): the ONE forgetting mechanism. There are no ratios, no pause,
// no hard-trim fallback. The loop triggers a cycle at compaction.trigger_tokens of
// real context; the compactor keeps a verbatim tail of ~compaction.keep_tokens and
// summarizes everything older IN THE BACKGROUND, swapping the summary in at a
// safe checkpoint (between turns).
//
// STATE:
// - running: whether a background summary call is in flight
// - boundaryIndex: index in messages at which the tail begins (walked backwards
// from the tail to ~keepTokens). Everything BEFORE it is summarized; AT/AFTER
// is preserved verbatim.
// - resultSummary: set when the background summary call resolves.
//
// PRIOR-SUMMARY CARRY (DECIDED #4): if messages[0] is the previous compaction
// summary, it is excluded from the serialized fold and passed to the summarizer
// as a labeled EARLIER MEMORY section OUTSIDE serializeHistory's byte cap, so it
// is re-condensed each cycle (blur) rather than truncated away (cliff).
//
// INVARIANTS (enforced + tested):
// - compaction never mutates messages mid-LLM-call — only at a checkpoint.
// - messages appended during compaction live at >= boundaryIndex, untouched.
// - boundary never orphans a tool message from its assistant tool_call.

import { type ChatMessage, type LLM, estimateSentTokens, SUMMARIZE_TAIL_REMINDER } from './llm.js';
import type { ContextTracker } from './context-tracker.js';
import { serializeHistory, createGuardedSummarizer } from './summarize.js';

export interface CompactorOpts {
  /** Verbatim tail size (tokens) kept unsummarized. Default 50000. */
  keepTokens?: number;
  /** Byte cap on the serialized RECENT fold body (scales with the trigger so an
 * 80k-token fold isn't silently truncated). Default 520000 (~4×(180k−50k)).
 * Deliberately computed with a LOOSE 4 chars/token upper bound, NOT the
 * calibrated ratio — see the comment at its default below. */
  foldSerializeCap?: number;
  /** Getter for the live calibrated chars-per-token ratio (default () => 4). */
  ratio?: () => number;
  /** Operator-log sink (rejected/failed summarize attempts, apply stats). */
  log?: (line: string) => void;
}

/** Summary quality-gate floor: min(SUMMARY_FLOOR_CAP, PER_MESSAGE × fold size)
 * chars. A summary below it counts as a failed attempt and retries — a
 * degenerate one-sentence "summary" is a successful API call but a
 * catastrophic memory loss (a 658-message fold, including the
 * carried prior summary, collapsed to 233 chars; same shape,
 * 308269f). Healthy folds run ~10–12k chars, so 2000 is a loose lower bound,
 * not a target; the per-message scale keeps small folds legitimately terse. */
export const SUMMARY_FLOOR_CAP = 2000;
export const SUMMARY_FLOOR_PER_MESSAGE = 10;

export interface Compactor {
  readonly running: boolean;
  readonly boundaryIndex: number;
  /** Kick off a background summary (returns immediately, does not block). */
  start(messages: ChatMessage[]): void;
  /** True once the background summary has landed and is ready to apply. */
  hasCompletedResult(): boolean;
  /** Promise that resolves when the in-flight summary finishes (or immediately if none). */
  done(): Promise<void>;
  /**
 * Atomically rebuild messages: [summaryMessage, ...messages.slice(boundary), notice].
 * Resets state. Returns the new messages array (caller assigns it).
 */
  applyCompaction(messages: ChatMessage[]): ChatMessage[];
  /** Last error from a summary attempt, if any (for logging). */
  lastError: string | null;
  /** Drop all state (used by clearContext so a summary that resolves AFTER the
 * clear cannot swap into the fresh history). */
  reset(): void;
}

const SUMMARY_PREFIX = '=== Summary of earlier conversation';

/** Walk backwards from the tail accumulating estimates until >= keepTokens.
 * Returns the index where the verbatim tail begins (fold = slice(0, i)). */
export function walkKeepBoundary(messages: ChatMessage[], keepTokens: number, ratio = 4): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += estimateSentTokens(messages[i], ratio);
    if (acc >= keepTokens) return i;
  }
  return 0; // everything fits within the keep budget — nothing to fold
}

/**
 * Nudge boundaryIndex so it never splits an assistant-with-tool_calls from its
 * tool results. If messages[boundary-1] is an assistant with tool_calls OR
 * messages[boundary] is a tool message, walk the boundary forward past the pair.
 */
export function enforcePairIntegrity(messages: ChatMessage[], boundary: number): number {
  let b = boundary;
  if (b > 0 && b < messages.length) {
    const before = messages[b - 1];
    if (before.role === 'assistant' && before.tool_calls && before.tool_calls.length > 0) {
      const ids = new Set(before.tool_calls.map((tc) => tc.id));
      while (b < messages.length && messages[b].role === 'tool' && ids.has(messages[b].tool_call_id!)) {
        b++;
      }
    }
  }
  while (b < messages.length && messages[b].role === 'tool') {
    b++;
  }
  return b;
}

function summaryMessage(text: string, replaced: number): ChatMessage {
  return {
    role: 'system',
    channel: 'internal',
    content: `${SUMMARY_PREFIX} (${replaced} earlier messages compacted) ===\n${text}`,
  };
}

/** In-the-moment compaction notice appended at the TAIL of the rebuilt history. */
function compactionNotice(replaced: number): ChatMessage {
  return {
    role: 'user',
    channel: 'internal',
    content: `[harness: context compacted — ${replaced} earlier messages were folded into the summary at the top of your context. If you were mid-thread, skim that summary before continuing; anything not in it or in MEMORY.md is gone.]`,
  };
}

export function createCompactor(llm: LLM, tracker: ContextTracker, opts: CompactorOpts = {}): Compactor {
  const keepTokens = opts.keepTokens ?? 50000;
 // foldSerializeCap intentionally uses a LOOSE 4 chars/token upper bound, NOT
 // the calibrated ratio: it's a safety ceiling on the serialized fold, so a
 // generous over-estimate (fewer truncations) is correct here; tightening to
 // the real ~3.57 density would shrink the cap and truncate more folds.
  const foldSerializeCap = opts.foldSerializeCap ?? 520000;
  const ratioFn = opts.ratio ?? (() => 4);
  let boundaryIndex = 0;
  let resultSummary: string | null = null;
  const summarizer = createGuardedSummarizer(llm, {
    retries: 3,
    onResult: (summary) => { resultSummary = summary; },
    log: opts.log,
  });

  return {
    get running() { return summarizer.running; },
    get boundaryIndex() { return boundaryIndex; },
    get lastError() { return summarizer.lastError; },
    start(messages: ChatMessage[]): void {
      if (summarizer.running) return;
      const walked = walkKeepBoundary(messages, keepTokens, ratioFn());
      boundaryIndex = enforcePairIntegrity(messages, walked);
 // Prior-summary carry (#4): if the head is a previous summary, exclude it
 // from the serialized fold and pass it as a separate EARLIER MEMORY section.
      let priorSummary: string | null = null;
      let foldStart = 0;
      const head = messages[0];
      if (head && head.role === 'system' && head.content.startsWith(SUMMARY_PREFIX)) {
        priorSummary = head.content;
        foldStart = 1;
      }
      const foldSlice = messages.slice(foldStart, boundaryIndex);
 // Skip-guard: nothing worth summarizing (e.g. one giant message forms the
 // whole tail, or only the prior summary would be folded).
      if (foldSlice.length === 0) {
        boundaryIndex = 0;
        return;
      }
      resultSummary = null;
      const recent = serializeHistory(foldSlice, { totalCap: foldSerializeCap });
      const body = priorSummary
        ? `=== EARLIER MEMORY (a previous compaction summary — integrate and condense; older detail may blur, but people-facts and promises must not vanish) ===\n${priorSummary}\n\n=== RECENT CONVERSATION TO FOLD IN ===\n${recent}`
        : recent;
 // Instruction sandwich: restate the task AFTER the (huge) fold body so
 // the recency-weighted position works for the summary, not against it —
 // see SUMMARIZE_TAIL_REMINDER's comment for the observed failure.
      const input = `${body}\n\n${SUMMARIZE_TAIL_REMINDER}`;
 // Deliberately keyed on message COUNT while the body is capped in CHARS:
 // at real configs the cap (~600k) exceeds the fold (~535k) so truncation
 // is not in play, and a fold big enough to matter serializes far past
 // the 2000-char cap anyway (~12 chars/message of scaffolding alone).
      const minChars = Math.min(SUMMARY_FLOOR_CAP, SUMMARY_FLOOR_PER_MESSAGE * foldSlice.length);
      summarizer.start(input, { minChars });
    },
    hasCompletedResult(): boolean {
      return !summarizer.running && resultSummary !== null;
    },
    async done(): Promise<void> {
      await summarizer.done();
    },
    applyCompaction(messages: ChatMessage[]): ChatMessage[] {
      const summary = resultSummary;
      if (summary === null) return messages;
      const kept = messages.slice(boundaryIndex);
      opts.log?.(`compaction applied | replaced=${boundaryIndex} | summary_chars=${summary.length}`);
      const next = [summaryMessage(summary, boundaryIndex), ...kept, compactionNotice(boundaryIndex)];
      resultSummary = null;
      boundaryIndex = 0;
      tracker.recompute(next);
      return next;
    },
    reset(): void {
      summarizer.reset();
      resultSummary = null;
      boundaryIndex = 0;
      tracker.recompute([]);
    },
  };
}
