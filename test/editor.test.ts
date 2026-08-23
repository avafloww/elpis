// Unit tests for src/lib/editor.ts — string-replace core for self-editing.
// These helpers exist so the agent can edit its own source safely instead of
// via raw string replacement. Tests double as documentation of intended use.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replace, nearMiss } from '../src/lib/editor.js';

// ---------------------------------------------------------------------------
// replace (the single string-replace core behind elpis.edit)
// ---------------------------------------------------------------------------

test('replace: substitutes a unique substring and reports one hunk', () => {
  const r = replace('const MAX = 5;\n', 'MAX = 5', 'MAX = 8');
  assert.equal(r.source, 'const MAX = 8;\n');
  assert.equal(r.count, 1);
  assert.equal(r.hunks[0].from, 1);
  assert.deepEqual(r.hunks[0].removed, ['const MAX = 5;']);
  assert.deepEqual(r.hunks[0].inserted, ['const MAX = 8;']);
});

test('replace: a non-unique needle throws with the occurrence count and lines', () => {
  assert.throws(
    () => replace('x = 1;\ny = 1;\n', '= 1;', '= 2;'),
    /not unique — 2 occurrences \(lines 1, 2\).*replaceAll: true/s,
  );
});

test('replace: { all: true } replaces every occurrence', () => {
  const r = replace('a\nfoo\nb\nfoo\n', 'foo', 'bar', { all: true });
  assert.equal(r.source, 'a\nbar\nb\nbar\n');
  assert.equal(r.count, 2);
});

test('replace: not-found throws with a line-numbered near-miss window', () => {
  const src = 'alpha\nconst timeout = 5000;\ngamma\n';
  let msg = '';
  try {
    replace(src, 'const timeuot = 5000;', 'x');
  } catch (e) {
    msg = String((e as Error).message);
  }
  assert.match(msg, /not found/);
  assert.match(msg, /closest match near line 2/);
  assert.match(msg, /^\s*2: const timeout = 5000;$/m); // the near-miss line carries its NN: number
});

test('replace: empty oldString and old===new throw', () => {
  assert.throws(() => replace('x', '', 'y'), /non-empty/);
  assert.throws(() => replace('x', 'x', 'x'), /must differ/);
});

test('nearMiss: renders ~2 lines of context around the closest line', () => {
  const src = 'l1\nl2\ntarget line here\nl4\nl5\n';
  const w = nearMiss(src, 'target len here');
  assert.match(w, /closest match near line 3/);
  assert.match(w, /^\s*1: l1$/m); // capped window includes context above
  assert.match(w, /^\s*5: l5$/m); // and below
});
