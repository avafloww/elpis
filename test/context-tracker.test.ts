// Unit tests for ContextTracker.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextTracker } from '../src/llm/context-tracker.js';

// A density stub the tracker can divide by. ratio 4 = legacy char/4.
function densityAt(ratio: number) {
  return { estimate: (chars: number) => Math.ceil(chars / ratio) };
}

test('tracker: usableBudget subtracts reserve', () => {
  const t = createContextTracker(10000, 2000);
  assert.equal(t.maxContextTokens, 10000);
  assert.equal(t.usableBudget, 8000);
});

test('tracker: update sets currentTokens from usage', () => {
  const t = createContextTracker(10000, 2000);
  t.update({ prompt_tokens: 3000, completion_tokens: 500, total_tokens: 3500 });
  assert.equal(t.currentTokens, 3500);
  assert.equal(t.usageRatio(), 3500 / 8000);
});

test('tracker: estimateAppended adds char/4 estimate', () => {
  const t = createContextTracker(10000, 2000);
  t.update({ prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 });
  const before = t.currentTokens;
  t.estimateAppended('a'.repeat(40)); // 40 chars → 10 tokens
  assert.equal(t.currentTokens, before + 10);
});

test('tracker: recompute resets estimate from messages', () => {
  const t = createContextTracker(10000, 2000);
  t.update({
    prompt_tokens: 5000,
    completion_tokens: 1000,
    total_tokens: 6000,
  });
  // simulate compaction swap to a tiny history
  t.recompute([{ role: 'system', content: 'summary' }]);
  // crude: 'summary'(7) + 'system'(6) + 4 = ~17 chars → ~5 tokens
  assert.ok(t.currentTokens < 1000, 'ratio should drop after recompute');
  assert.ok(t.currentTokens > 0);
});

test('tracker: usageRatio clamps to >= 0', () => {
  const t = createContextTracker(10000, 2000);
  assert.equal(t.usageRatio(), 0);
});

test('tracker: usableBudget floor of 1 when reserve >= window', () => {
  const t = createContextTracker(100, 200);
  assert.equal(t.usableBudget, 1);
});

test('tracker: reset zeroes currentTokens', () => {
  const t = createContextTracker(10000, 2000);
  t.update({
    prompt_tokens: 4000,
    completion_tokens: 1000,
    total_tokens: 5000,
  });
  t.estimateAppended('a'.repeat(100));
  assert.ok(t.currentTokens > 0);
  t.reset();
  assert.equal(t.currentTokens, 0);
  assert.equal(t.usageRatio(), 0);
});

test('tracker: estimateAppended honors a non-4 density ratio', () => {
  const t = createContextTracker(10000, 2000, densityAt(2)); // 2 chars/token
  t.update({ prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 });
  const before = t.currentTokens;
  t.estimateAppended('a'.repeat(40)); // 40 chars / 2 = 20 tokens
  assert.equal(t.currentTokens, before + 20);
});

test('tracker: omitting density defaults to seed-4 (byte-identical char/4)', () => {
  const t = createContextTracker(10000, 2000); // no density arg
  t.update({ prompt_tokens: 1000, completion_tokens: 0, total_tokens: 1000 });
  const before = t.currentTokens;
  t.estimateAppended('a'.repeat(40)); // 40 / 4 = 10
  assert.equal(t.currentTokens, before + 10);
});
