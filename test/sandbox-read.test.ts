// Unit tests for formatRead's from/to clamp — direct pure-function testing,
// mirroring test/sandbox-preview.test.ts's style for the sandbox output guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRead } from '../src/sandbox/read.js';

test('from past EOF clamps, never prints a reversed range', () => {
  const content = Array.from({ length: 68 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = formatRead('f.txt', content, { from: 140, to: 999 }, 100_000);
  assert.doesNotMatch(out, /showing 140-68/); // no reversed range
  assert.match(out, /showing 68-68/); // clamped to the last valid line
  assert.match(out, /line 68/);
});

test('an explicitly reversed range ({from > to}) also clamps instead of reversing', () => {
  const content = Array.from({ length: 68 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = formatRead('f.txt', content, { from: 50, to: 10 }, 100_000);
  assert.doesNotMatch(out, /showing 50-10/);
  assert.match(out, /showing 10-10/);
  assert.match(out, /line 10/);
});
