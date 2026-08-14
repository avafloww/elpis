// Unit tests for sandbox/parse-hints.ts — targeted pre-parse failure hints.
// Grounded in a real transcript audit: 7 of 10 tool failures in one 24h window
// were pre-parse syntax errors, all in three buckets covered here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delimiterProblem, parseFailureHints } from '../src/sandbox/parse-hints.js';

test('delimiterProblem: names an unclosed paren and the line it opened on', () => {
  const src = 'const a = 1;\nelpis.remember("a long note here"\n';
  const out = delimiterProblem(src);
  assert.ok(out, 'expected a problem');
  assert.match(out, /unclosed `\(`/);
  assert.match(out, /line 2/);
});

test('delimiterProblem: ignores brackets inside strings, templates and comments', () => {
  const src = 'const a = "((( [[[ {{{";\nconst b = `))) ]]]`;\n// {{{ (((\nfoo();\n';
  assert.equal(delimiterProblem(src), null);
});

test('delimiterProblem: reports a mismatched closer with both lines', () => {
  const src = 'foo(\n  bar[1\n);\n';
  const out = delimiterProblem(src);
  assert.ok(out);
  assert.match(out, /does not match/);
});

test('delimiterProblem: reports a stray closer', () => {
  const out = delimiterProblem('foo();\n)\n');
  assert.ok(out);
  assert.match(out, /closes nothing/);
});

test('delimiterProblem: returns null on balanced code', () => {
  assert.equal(delimiterProblem('function f(a) { return [a, {b: 1}]; }\n'), null);
});

test('parseFailureHints: unterminated string suggests a heredoc', () => {
  const src = "elpis.channel('x').send('i disappeared for a while\nand came back');\n";
  const hints = parseFailureHints(src, src, 'Unterminated string constant (1:51)');
  assert.ok(hints.some((h) => /cannot span multiple lines/.test(h)), hints.join(' | '));
});

test('parseFailureHints: nested backtick in a template literal is named', () => {
 // acorn trips just after the inner backtick that closed the template early.
  const src = 'elpis.memory.person("bramble", `switched to `model-x` today`);\n';
  const hints = parseFailureHints(src, src, 'Unexpected token (1:45)');
  assert.ok(hints.some((h) => /backtick/.test(h)), hints.join(' | '));
});

test('parseFailureHints: no backtick hint when the error is nowhere near one', () => {
  const src = 'const t = `hello`;\nfoo(]\n';
  const hints = parseFailureHints(src, src, 'Unexpected token (2:4)');
  assert.ok(!hints.some((h) => /backtick/.test(h)), hints.join(' | '));
});

test('parseFailureHints: unclosed delimiter hint comes first', () => {
  const src = 'elpis.remember("note"\n';
  const hints = parseFailureHints(src, src, 'Unexpected token (1:21)');
  assert.ok(hints.length > 0);
  assert.match(hints[0], /Likely cause/);
});

test('parseFailureHints: TypeScript syntax still detected', () => {
  const src = 'const x = foo as any;\n';
  const hints = parseFailureHints(src, src, 'Unexpected token (1:14)');
  assert.ok(hints.some((h) => /TypeScript/.test(h)), hints.join(' | '));
});

test('parseFailureHints: heredoc present falls back to the heredoc rules', () => {
  const raw = 'const a = <<<T\nbody\n';
  const hints = parseFailureHints(raw, raw, 'heredoc <<<T opened at line 1 has no terminator');
  assert.ok(hints.some((h) => /terminator begins with.*chain the next opener/.test(h)), hints.join(' | '));
});
