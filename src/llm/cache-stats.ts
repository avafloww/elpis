// cache-stats.ts — session-scoped prompt-cache accounting for the operator
// console and the Discord /cache command.
//
// WHY THIS EXISTS: prefix caching is the harness's biggest cost lever. The system
// prompt avoids volatile bytes and request-only projections stay stable enough
// to protect the cached prefix (see the load-bearing invariants in AGENTS.md).
// This module is the instrument for those invariants — when one
// regresses, a bust divider says so with a token count.
//
// NOTE the invariant is "no volatile byte in the per-turn rebuild", NOT "the
// same bytes every turn": the prompt is rebuilt each turn, and a new author or a
// newly-matched people/ file legitimately changes it. Those busts are real
// rewrites, correctly reported — not false positives to tune away.
//
// THE BUST RULE. The provider reports how much of each request came from cache.
// A bust is a LOSS OF OBSERVED CACHED COVERAGE, not a guess from total prompt
// size. Request-only tail messages (for example the Mind frontier) may disappear
// between calls without invalidating the stable prefix, so previous prompt size
// is not a valid expected-cache baseline:
//
// expected = min(previousCachedTokens, promptTokens)
// rewritten = max(0, expected − currentCachedTokens)
// busted = rewritten >= CACHE_BUST_MIN_TOKENS
//
// Structural rewrites such as compaction explicitly rebaseline before their next
// completion; they already have their own visible divider and are not cache bugs.
//
// SUPPORTED vs ZERO. `undefined` cached_tokens means the provider reports nothing
// (widget hidden, bust detection off); 0 means a real 100%-miss turn. Never
// conflate them — see extractCacheTokens in llm.ts.
//
// IN-MEMORY ONLY, deliberately: session-scoped like the context meter, reset on
// context clear. Nothing here touches agent.db or the transcript.

import type { LLMUsage } from './llm.js';

/** Rewritten-token floor for flagging a bust. Sits just above OpenAI-compat block
 * granularity: one 1,024-token coverage step is routine provider noise, while
 * losing two or more steps is worth a visible divider. Hardcoded on purpose — promote to config only if it
 * proves noisy in practice. */
export const CACHE_BUST_MIN_TOKENS = 2048;

/** Cache accounting as the rail, the /cache command, and UsageInfo render it. */
export interface CacheInfo {
  /** False until a completion reports `cached_tokens`. The console hides the
 * panel and bust detection stays off while false. */
  supported: boolean;
  /** Most recent completion: cached prompt tokens, and prompt − cached. */
  lastCached: number;
  lastNew: number;
  /** lastCached / (lastCached + lastNew); 0 when both are 0. */
  lastRatio: number;
  /** Session sums of the same two, and their ratio. */
  totalCached: number;
  totalNew: number;
  totalRatio: number;
  /** Flagged busts this session, and their cumulative rewritten tokens. */
  bustCount: number;
  bustTokens: number;
  /** Completions passed to `record()` this session, including ones with no
 * `cached_tokens` (which otherwise leave every other field at its prior
 * value). Lets a caller distinguish "no completions yet" (turns === 0) from
 * "provider reports no cache data" (turns > 0 but supported stays false) —
 * both of which look identical if you only look at `supported`. */
  turns: number;
}

export interface CacheStats {
  /** Record one MAIN-LOOP completion. Summarizer calls must NOT come here —
 * one-shot uncached prompts would smear the session ratio. Returns the bust
 * verdict for the caller to hand to the console. */
  record(usage: LLMUsage): { busted: boolean; rewritten: number };
  snapshot(): CacheInfo;
  /** Drop only the comparison baseline after an intentional structural rewrite. */
  rebaseline(): void;
  /** Wipe all counters AND the cached-coverage baseline (context clear). */
  reset(): void;
}

const ratio = (cached: number, fresh: number): number => {
  const total = cached + fresh;
  return total > 0 ? cached / total : 0;
};

export function createCacheStats(): CacheStats {
  let supported = false;
  let lastCached = 0;
  let lastNew = 0;
  let totalCached = 0;
  let totalNew = 0;
  let bustCount = 0;
  let bustTokens = 0;
  let turns = 0;
  /** Cached coverage of the previous SUPPORTED completion. Null means no
 * comparable baseline: first turn, structural rebaseline, or unsupported data. */
  let prevCachedTokens: number | null = null;

  return {
    record(usage: LLMUsage): { busted: boolean; rewritten: number } {
      turns++;
      const cached = usage.cached_tokens;
      if (cached === undefined) {
 // Provider reports nothing: contribute nothing, and drop the baseline so
 // a later supported turn can't bust against stale cached coverage.
        prevCachedTokens = null;
        return { busted: false, rewritten: 0 };
      }
      const prompt = usage.prompt_tokens;
      const capped = Math.max(0, Math.min(cached, prompt));
      const fresh = Math.max(0, prompt - capped);

      let rewritten = 0;
      if (prevCachedTokens !== null) {
        const expected = Math.min(prevCachedTokens, prompt);
        rewritten = Math.max(0, expected - capped);
      }
      const busted = rewritten >= CACHE_BUST_MIN_TOKENS;

      supported = true;
      lastCached = capped;
      lastNew = fresh;
      totalCached += capped;
      totalNew += fresh;
      if (busted) {
        bustCount++;
        bustTokens += rewritten;
      }
      prevCachedTokens = capped;
      return { busted, rewritten };
    },
    snapshot(): CacheInfo {
      return {
        supported,
        lastCached,
        lastNew,
        lastRatio: ratio(lastCached, lastNew),
        totalCached,
        totalNew,
        totalRatio: ratio(totalCached, totalNew),
        bustCount,
        bustTokens,
        turns,
      };
    },
    rebaseline(): void {
      prevCachedTokens = null;
    },
    reset(): void {
      supported = false;
      lastCached = 0;
      lastNew = 0;
      totalCached = 0;
      totalNew = 0;
      bustCount = 0;
      bustTokens = 0;
      turns = 0;
      prevCachedTokens = null;
    },
  };
}
