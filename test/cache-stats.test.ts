// Unit tests for prompt-cache accounting:
// - extractCacheTokens (src/llm.ts) — the one OpenAI-compat usage shape
// - createCacheStats (src/cache-stats.ts) — session counters + bust verdict
// No network. Run with: npm run test:unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCacheTokens } from '../src/llm/llm.js';

// ---------- extractCacheTokens ----------

test('extractCacheTokens: reads the OpenAI-compat prompt_tokens_details shape', () => {
  const usage = {
    prompt_tokens: 75229,
    completion_tokens: 134,
    total_tokens: 75363,
    prompt_tokens_details: { cached_tokens: 70800 },
  };
  assert.equal(extractCacheTokens(usage), 70800);
});

test('extractCacheTokens: reads a legitimate zero as zero', () => {
  assert.equal(extractCacheTokens({ prompt_tokens_details: { cached_tokens: 0 } }), 0);
});

test('extractCacheTokens: returns undefined (never 0) when the field is absent', () => {
  assert.equal(extractCacheTokens({ prompt_tokens: 10, completion_tokens: 2 }), undefined);
  assert.equal(extractCacheTokens({ prompt_tokens_details: {} }), undefined);
  assert.equal(extractCacheTokens({ prompt_tokens_details: null }), undefined);
});

test('extractCacheTokens: returns undefined for non-numeric or non-object input', () => {
  assert.equal(extractCacheTokens({ prompt_tokens_details: { cached_tokens: '70800' } }), undefined);
  assert.equal(extractCacheTokens({ prompt_tokens_details: { cached_tokens: NaN } }), undefined);
  assert.equal(extractCacheTokens(undefined), undefined);
  assert.equal(extractCacheTokens(null), undefined);
  assert.equal(extractCacheTokens('nope'), undefined);
});

// ---------- cache stats ----------

import { createCacheStats, CACHE_BUST_MIN_TOKENS } from '../src/llm/cache-stats.js';
import type { LLMUsage } from '../src/llm/llm.js';

/** Build an LLMUsage with the given prompt/cached split. Omit `cached` to model
 * a provider that reports no cache data at all. */
const usage = (prompt: number, cached?: number): LLMUsage => ({
  prompt_tokens: prompt,
  completion_tokens: 100,
  total_tokens: prompt + 100,
  ...(cached === undefined ? {} : { cached_tokens: cached }),
});

// ---------- baseline / first turn ----------

test('cache-stats: fresh snapshot is unsupported and all-zero', () => {
  const s = createCacheStats().snapshot();
  assert.equal(s.supported, false);
  assert.equal(s.lastCached, 0);
  assert.equal(s.lastNew, 0);
  assert.equal(s.lastRatio, 0);
  assert.equal(s.totalCached, 0);
  assert.equal(s.totalNew, 0);
  assert.equal(s.totalRatio, 0);
  assert.equal(s.bustCount, 0);
  assert.equal(s.bustTokens, 0);
  assert.equal(s.turns, 0);
});

test('cache-stats: turns counts every record() call, including unsupported ones', () => {
  const stats = createCacheStats();
  stats.record(usage(10_000)); // no cached_tokens
  stats.record(usage(10_000, 9_000));
  stats.record(usage(10_000)); // no cached_tokens again
  const s = stats.snapshot();
  assert.equal(s.turns, 3, 'every record() call counts, supported or not');
});

test('cache-stats: reset zeroes turns too', () => {
  const stats = createCacheStats();
  stats.record(usage(10_000, 9_000));
  stats.reset();
  assert.equal(stats.snapshot().turns, 0);
});

test('cache-stats: the first record never busts, however large the prompt', () => {
  const stats = createCacheStats();
  const r = stats.record(usage(500_000, 0));
  assert.equal(r.busted, false);
  assert.equal(r.rewritten, 0);
  assert.equal(stats.snapshot().bustCount, 0);
});

test('cache-stats: a supported record marks the snapshot supported and splits tokens', () => {
  const stats = createCacheStats();
  stats.record(usage(75_229, 70_800));
  const s = stats.snapshot();
  assert.equal(s.supported, true);
  assert.equal(s.lastCached, 70_800);
  assert.equal(s.lastNew, 4_429);
  assert.equal(Math.round(s.lastRatio * 100), 94);
  assert.equal(s.totalCached, 70_800);
  assert.equal(s.totalNew, 4_429);
});

// ---------- the bust rule ----------

test('cache-stats: full prefix coverage does not bust', () => {
  const stats = createCacheStats();
  stats.record(usage(10_000, 10_000));
  const r = stats.record(usage(12_000, 10_000));
  assert.equal(r.busted, false);
  assert.equal(r.rewritten, 0);
});

test('cache-stats: cached coverage loss above the threshold busts with an exact count', () => {
  const stats = createCacheStats();
  stats.record(usage(60_000, 60_000));
  const r = stats.record(usage(62_000, 12_688));
  assert.equal(r.busted, true);
  assert.equal(r.rewritten, 47_312);
  const s = stats.snapshot();
  assert.equal(s.bustCount, 1);
  assert.equal(s.bustTokens, 47_312);
});

test('cache-stats: cached coverage loss below the threshold does not bust', () => {
  const stats = createCacheStats();
  stats.record(usage(10_000, 10_000));
  const r = stats.record(usage(11_000, 10_000 - (CACHE_BUST_MIN_TOKENS - 1)));
  assert.equal(r.busted, false);
  assert.equal(r.rewritten, CACHE_BUST_MIN_TOKENS - 1);
  const s = stats.snapshot();
  assert.equal(s.bustCount, 0);
  assert.equal(s.bustTokens, 0, 'bustTokens only accumulates flagged busts');
});

test('cache-stats: one 1024-token provider step is tolerated', () => {
  const stats = createCacheStats();
  stats.record(usage(10_000, 10_000));
  const r = stats.record(usage(10_000, 8_976));
  assert.deepEqual(r, { busted: false, rewritten: 1_024 });
});

test('cache-stats: cached coverage loss at exactly the threshold busts', () => {
  const stats = createCacheStats();
  stats.record(usage(10_000, 10_000));
  const r = stats.record(usage(10_000, 10_000 - CACHE_BUST_MIN_TOKENS));
  assert.equal(r.busted, true);
  assert.equal(r.rewritten, CACHE_BUST_MIN_TOKENS);
});

test('cache-stats: removing a request-only tail does not fabricate prefix loss', () => {
  const stats = createCacheStats();
  stats.record(usage(101_220, 100_000));
  const r = stats.record(usage(101_500, 100_000));
  assert.deepEqual(r, { busted: false, rewritten: 0 });
});

test('cache-stats: structural rebaseline suppresses the next comparison without erasing totals', () => {
  const stats = createCacheStats();
  stats.record(usage(200_000, 190_000));
  stats.rebaseline();
  const r = stats.record(usage(40_000, 0));
  assert.deepEqual(r, { busted: false, rewritten: 0 });
  const s = stats.snapshot();
  assert.equal(s.turns, 2);
  assert.equal(s.totalCached, 190_000);
});

// ---------- unsupported provider ----------

test('cache-stats: usage without cached_tokens never busts and stays unsupported', () => {
  const stats = createCacheStats();
  stats.record(usage(10_000));
  const r = stats.record(usage(90_000));
  assert.equal(r.busted, false);
  assert.equal(r.rewritten, 0);
  const s = stats.snapshot();
  assert.equal(s.supported, false);
  assert.equal(s.totalCached, 0);
  assert.equal(s.totalNew, 0, 'unreported turns contribute nothing to the split');
});

test('cache-stats: a supported turn after unsupported turns cannot bust on a stale prompt', () => {
  const stats = createCacheStats();
  stats.record(usage(50_000));          // unsupported — no prev prompt recorded
  const r = stats.record(usage(52_000, 0));
  assert.equal(r.busted, false, 'first SUPPORTED turn is the baseline');
});

// ---------- totals + reset ----------

test('cache-stats: totals accumulate across turns and ratio reflects the sum', () => {
  const stats = createCacheStats();
  stats.record(usage(1_000, 500));
  stats.record(usage(1_000, 500));
  const s = stats.snapshot();
  assert.equal(s.totalCached, 1_000);
  assert.equal(s.totalNew, 1_000);
  assert.equal(s.totalRatio, 0.5);
});

test('cache-stats: reset zeroes counters and suppresses a bust on the next record', () => {
  const stats = createCacheStats();
  stats.record(usage(80_000, 79_000));
  stats.reset();
  const s = stats.snapshot();
  assert.equal(s.supported, false);
  assert.equal(s.totalCached, 0);
  assert.equal(s.bustCount, 0);
  const r = stats.record(usage(80_000, 0));
  assert.equal(r.busted, false, 'post-clear turn is a fresh baseline');
});

// ---------- agent wiring ----------

import { buildTestAgent } from './helpers.js';

test('agent: usageSnapshot exposes a well-formed cache block', () => {
  const h = buildTestAgent({ tmpPrefix: 'cache-snap-' });
  try {
    const cache = h.agent.usageSnapshot().cache;
    assert.ok(cache, 'usageSnapshot().cache is present');
    assert.equal(cache.supported, false);
    assert.equal(cache.bustCount, 0);
    assert.equal(cache.totalCached, 0);
    assert.equal(cache.lastRatio, 0);
  } finally {
    h.cleanup();
  }
});

test('agent: recordCacheUsage feeds the snapshot', () => {
  const h = buildTestAgent({ tmpPrefix: 'cache-record-' });
  try {
    h.agent.recordCacheUsage({
      prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_tokens: 900,
    });
    const cache = h.agent.usageSnapshot().cache;
    assert.equal(cache.supported, true);
    assert.equal(cache.lastCached, 900);
    assert.equal(cache.lastNew, 100);
  } finally {
    h.cleanup();
  }
});

test('agent: clearContext resets cache stats', () => {
  const h = buildTestAgent({ tmpPrefix: 'cache-clear-' });
  try {
    h.agent.recordCacheUsage({
      prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_tokens: 900,
    });
    assert.equal(h.agent.usageSnapshot().cache.supported, true);
    h.agent.clearContext();
    const cache = h.agent.usageSnapshot().cache;
    assert.equal(cache.supported, false);
    assert.equal(cache.totalCached, 0);
  } finally {
    h.cleanup();
  }
});

// ---------- one-shot logging (F-cache-2: a missing cached_tokens is instrumented) ----------

/** A spy Logger — records every call by level, args joined into one string. */
function makeSpyLogger() {
  const calls: { level: string; text: string }[] = [];
  const record = (level: string) => (...a: unknown[]) => {
    calls.push({ level, text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') });
  };
  return { calls, logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') } };
}

test('agent: an uncached completion with no prior support logs info once, not warn', () => {
  const { calls, logger } = makeSpyLogger();
  const h = buildTestAgent({ tmpPrefix: 'cache-log-info-', config: { logger: logger as never } });
  try {
    h.agent.recordCacheUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 });
    h.agent.recordCacheUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 });
    const infoLines = calls.filter((c) => c.level === 'info' && /prompt cache/.test(c.text));
    const warnLines = calls.filter((c) => c.level === 'warn' && /prompt cache/.test(c.text));
    assert.equal(infoLines.length, 1, 'the no-cache-capability info line fires exactly once');
    assert.equal(warnLines.length, 0, 'no prior supported turn, so no anomaly warning');
  } finally {
    h.cleanup();
  }
});

test('agent: reporting going dark AFTER a supported turn logs a one-shot warn anomaly', () => {
  const { calls, logger } = makeSpyLogger();
  const h = buildTestAgent({ tmpPrefix: 'cache-log-warn-', config: { logger: logger as never } });
  try {
 // Turn 1: the provider reports cache data — establishes "supported".
    h.agent.recordCacheUsage({
      prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, cached_tokens: 900,
    });
    assert.equal(h.agent.usageSnapshot().cache.supported, true);

 // Turn 2: the same session suddenly reports nothing — the anomaly.
    h.agent.recordCacheUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 });
 // Turn 3: still nothing — the warn must not repeat.
    h.agent.recordCacheUsage({ prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 });

    const warnLines = calls.filter((c) => c.level === 'warn' && /prompt cache/.test(c.text));
    assert.equal(warnLines.length, 1, 'the went-dark anomaly warns exactly once');

 // `supported` reflects the historical high-water mark (unaffected by the
 // dark turns); `turns` still counts every completion, dark ones included.
    const cache = h.agent.usageSnapshot().cache;
    assert.equal(cache.supported, true);
    assert.equal(cache.turns, 3);
  } finally {
    h.cleanup();
  }
});

// ---------- agent -> console.cacheBusted wiring (F-cache-3) ----------

import type { ConsoleHub } from '../src/console/hub.js';

test('agent: a busting recordCacheUsage reaches console.cacheBusted with the rewritten count', () => {
  const busts: number[] = [];
  const stubConsole = { cacheBusted: (rewritten: number) => { busts.push(rewritten); } } as unknown as ConsoleHub;
  const h = buildTestAgent({ tmpPrefix: 'cache-hub-bust-', agentDeps: { console: stubConsole } });
  try {
 // Turn 1 establishes 60k of observed cached coverage.
    h.agent.recordCacheUsage({
      prompt_tokens: 60_000, completion_tokens: 10, total_tokens: 60_010, cached_tokens: 60_000,
    });
 // Turn 2 drops cached coverage to 12,688: loss 47,312.
    h.agent.recordCacheUsage({
      prompt_tokens: 62_000, completion_tokens: 10, total_tokens: 62_010, cached_tokens: 12_688,
    });
    assert.equal(busts.length, 1, 'cacheBusted is called exactly once for the one busting turn');
    assert.equal(busts[0], 47_312);
  } finally {
    h.cleanup();
  }
});

test('agent: a throwing console.cacheBusted is swallowed, never reaches the caller', () => {
  const stubConsole = {
    cacheBusted: () => { throw new Error('boom — observer-only, must not propagate'); },
  } as unknown as ConsoleHub;
  const h = buildTestAgent({ tmpPrefix: 'cache-hub-throw-', agentDeps: { console: stubConsole } });
  try {
    h.agent.recordCacheUsage({
      prompt_tokens: 60_000, completion_tokens: 10, total_tokens: 60_010, cached_tokens: 0,
    });
    assert.doesNotThrow(() => {
      h.agent.recordCacheUsage({
        prompt_tokens: 62_000, completion_tokens: 10, total_tokens: 62_010, cached_tokens: 12_688,
      });
    }, 'a throwing console must never propagate out of recordCacheUsage');
  } finally {
    h.cleanup();
  }
});
