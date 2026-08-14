// Unit tests for the sandbox transform (persistence surgery + heredoc pre-parse).
// Split out of the former sandbox.test.ts monolith. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform, expandHeredocs } from '../src/sandbox/transform.js';

// ---------- transform unit tests ----------

test('transform: wraps in async IIFE and returns completion', () => {
  const { code, parsed } = transform('1 + 1');
  assert.equal(parsed, true);
  assert.match(code, /^\(async \(\) => \{/);
  assert.match(code, /return _completion/);
  assert.match(code, /_completion = \(1 \+ 1\)/);
});

test('transform: const becomes globalThis assignment', () => {
  const { code } = transform('const y = 10');
  assert.match(code, /globalThis\.y = \(10\)/);
});

test('transform: let with no initializer is idempotent', () => {
  const { code } = transform('let q');
  assert.match(code, /globalThis\.q = globalThis\.q/);
});

test('transform: var with initializer', () => {
  const { code } = transform('var w = 5');
  assert.match(code, /globalThis\.w = \(5\)/);
});

test('transform: destructuring object', () => {
  const { code } = transform('const { a, b } = E');
  assert.match(code, /__d0 = \(E\)/);
  assert.match(code, /\(\{ a, b \} = __d0\)/);
  assert.match(code, /globalThis\.a = a/);
  assert.match(code, /globalThis\.b = b/);
});

test('transform: destructuring array', () => {
  const { code } = transform('const [a, b] = E');
  assert.match(code, /__d0 = \(E\)/);
  assert.match(code, /\(\[a, b\] = __d0\)/);
  assert.match(code, /globalThis\.a = a/);
  assert.match(code, /globalThis\.b = b/);
});

test('transform: function declaration persists', () => {
  const { code } = transform('function f(){ return 42 }');
 // rewritten inline: globalThis.f = function f{ return 42 }
  assert.match(code, /globalThis\.f = function f\(\)\{ return 42 \}/);
});

test('transform: class declaration rewritten to assignment', () => {
  const { code } = transform('class C {}');
  assert.match(code, /globalThis\.C = class C \{\}/);
});

test('transform: parse failure returns original unwrapped', () => {
  const { code, parsed, error } = transform('const = ;');
  assert.equal(parsed, false);
  assert.ok(error);
 // unwrapped — original code returned as-is
  assert.equal(code, 'const = ;');
});

test('transform: multiple statements, last expr is completion', () => {
  const { code } = transform('const x = 1; x + 1');
  assert.match(code, /globalThis\.x = \(1\)/);
  assert.match(code, /_completion = \(x \+ 1\)/);
});

test('transform: statement with no trailing expr sets completion undefined', () => {
  const { code } = transform('const x = 1');
 // last node is the declaration, not an ExpressionStatement → _completion stays undefined
  assert.match(code, /let _completion = undefined/);
  assert.doesNotMatch(code, /_completion = \(const/);
});

// ---------- heredoc terminator tolerance (Finding 12) ----------

test('heredoc: TAG; terminator (natural end-of-statement) expands + parses', () => {
  const src = 'const x = <<<NOTES\nhello\nworld\nNOTES;\nconsole.log(x);';
  const { error } = transform(src);        // full pipeline, incl. acorn
  assert.equal(error, undefined);
});

test('heredoc: TAG, terminator (in a call) expands AND still parses', () => {
  const src = 'f(<<<NOTES\nhi\nNOTES,\n2);';
  const t = transform(src);
  assert.equal(t.error, undefined);        // dropping the comma → f("hi\n"\n2) → acorn error; this guards it
  assert.equal(t.parsed, true);
});

test('heredoc: TAG, keeps the comma in emitted code', () => {
  const { code } = expandHeredocs('f(<<<T\nhi\nT,\n2)');
  assert.match(code, /,\s*\n?\s*2\)/);     // comma survives after the string literal
});

test('heredoc: TAG); terminator closes the surrounding call', () => {
  const src = 'f(<<<NOTES\nhi\nNOTES);';
  const expanded = expandHeredocs(src);
  assert.equal(expanded.error, undefined);
  assert.match(expanded.code, /f\("hi\\n"\);/);
  assert.equal(transform(src).parsed, true);
});

test('heredoc: TAG,<<<NEXT chains adjacent blocks on one line', () => {
  const src = 'f(<<<OLD\nold\nOLD,<<<NEW\nnew\nNEW);';
  const expanded = expandHeredocs(src);
  assert.equal(expanded.error, undefined);
  assert.match(expanded.code, /f\("old\\n","new\\n"\);/);
  assert.equal(transform(src).parsed, true);
});

test('heredoc: arbitrary same-line argument continuation is preserved verbatim', () => {
  const src = 'elpis.fill(<<<MSG\nhello {{name}}\nMSG,{ name: "Aster" });';
  const expanded = expandHeredocs(src);
  assert.equal(expanded.error, undefined);
  assert.ok(expanded.code.endsWith(',{ name: "Aster" });'));
  assert.equal(transform(src).parsed, true);
});

test('heredoc: same-line method chain is preserved verbatim', () => {
  const src = 'const x = <<<TEXT\nhello\nTEXT.trimEnd();';
  const expanded = expandHeredocs(src);
  assert.equal(expanded.error, undefined);
  assert.ok(expanded.code.endsWith('.trimEnd();'));
  assert.equal(transform(src).parsed, true);
});

test('heredoc: a longer identifier beginning with the tag remains body content', () => {
  const src = 'const x = <<<TAG\nTAGGED stays inside\nTAG;';
  const expanded = expandHeredocs(src);
  assert.equal(expanded.error, undefined);
  assert.ok(expanded.code.includes('TAGGED stays inside'));
});
