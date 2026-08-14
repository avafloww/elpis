// context-tracker.ts — tracks how full the context is, as a ratio of the
// usable budget (context_window − llm.completion_reserve_tokens).
//
// - currentTokens: after each completion, set from
// usage.prompt_tokens + usage.completion_tokens (authoritative — exactly
// the context that produced + included the latest turn).
// - between completions, for messages we append ourselves (tool results,
// freshly queued Discord messages), add a conservative estimate using
// calibrated chars-per-token (seed 4, so an omitted density is byte-identical
// to the old char/4) so we don't undercount before the next real usage
// lands. The estimate self-corrects on the next completion.

import { reasoningItemChars, type LLMUsage, type ReasoningItemParam, type AnthropicThinkingBlock } from './llm.js';

export interface ContextTracker {
  readonly maxContextTokens: number;
  readonly usableBudget: number;
  readonly currentTokens: number;
  /** Set from authoritative server usage after a completion. */
  update(usage: LLMUsage): void;
  /** Conservative calibrated chars-per-token estimate for messages we appended
 * between calls (seed 4, so an omitted density is byte-identical to the old
 * char/4). */
  estimateAppended(text: string): void;
  /** Recompute estimate after a structural change (e.g. compaction swap, boot
 * prime). Counts content + tool-call arguments (the substance of this agent's
 * turns lives in tool-call code, not `content`) + Responses-API
 * `reasoning_items` (replayed on every request); `reasoning_content` is
 * excluded to match what `prepareForApi` actually sends.
 *
 * NOT merged with llm.ts's `estimateSentTokens` / compactor.ts's former
 * `estimateTokens` despite the shared "char/4 AS SENT" shape: this ceils
 * ONCE over the summed char count across the whole array, where the other
 * two ceil PER MESSAGE inside a backward accumulation loop. Those give
 * different results in general (ceil(a/4)+ceil(b/4) != ceil((a+b)/4)), so
 * swapping this one over to the shared per-message estimator would be a
 * real (if small) behavior change, not just a dedup — left as-is on
 * purpose. */
  recompute(messages: { role: string; content: string; tool_calls?: { function: { arguments: string } }[]; reasoning_items?: ReasoningItemParam[]; thinking_blocks?: AnthropicThinkingBlock[] }[]): void;
  /** Zero out the token count (e.g. after a context clear). */
  reset(): void;
  /** currentTokens / usableBudget, clamped to [0, Infinity). */
  usageRatio(): number;
}

export function createContextTracker(
  maxContextTokens: number,
  completionReserveTokens: number,
  density: { estimate(chars: number): number } = { estimate: (chars: number) => Math.ceil(chars / 4) },
): ContextTracker {
  const usableBudget = Math.max(1, maxContextTokens - completionReserveTokens);
  let current = 0;

  return {
    maxContextTokens,
    usableBudget,
    get currentTokens() {
      return current;
    },
    update(usage: LLMUsage): void {
      current = usage.prompt_tokens + usage.completion_tokens;
    },
    estimateAppended(text: string): void {
      current += density.estimate(text.length);
    },
    recompute(messages): void {
 // crude estimate: calibrated chars-per-token over content + tool-call
 // arguments. The next real usage corrects it precisely, but this drops the
 // estimate immediately after a compaction swap and, at boot, counts
 // recovered tool-call code (which `content`-only counting missed — a
 // >trigger recovered history then read as under budget and didn't trigger
 // until the first real usage landed).
      let chars = 0;
      for (const m of messages) {
        chars += (m.content?.length ?? 0) + m.role.length + 4;
        for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length;
        for (const r of m.reasoning_items ?? []) chars += reasoningItemChars(r);
 // Anthropic thinking blocks are replayed on every request (like
 // reasoning_items), so count them too — else the Anthropic path
 // under-estimates real sent context between usage reports.
        for (const b of m.thinking_blocks ?? []) {
          chars += b.type === 'thinking' ? b.thinking.length + b.signature.length : b.data.length;
        }
      }
      current = density.estimate(chars);
    },
    reset(): void {
      current = 0;
    },
    usageRatio(): number {
      return current / usableBudget;
    },
  };
}
