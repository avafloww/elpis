import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { transform } from '../src/sandbox/transform.js';

function evaluator() {
  const context = vm.createContext({});
  return async (source: string) => {
    const result = transform(source);
    assert.equal(result.parsed, true, result.error);
    return structuredClone(await vm.runInContext(result.code, context));
  };
}

for (const { declaration, read, expected } of [
  { declaration: 'const value = 10', read: 'value + 1', expected: 11 },
  { declaration: 'let value = 1; value++', read: 'value', expected: 2 },
  { declaration: 'var value = 5', read: 'value * 2', expected: 10 },
  {
    declaration:
      'const { a, nested: { b = 2 }, ...rest } = { a: 1, nested: {}, c: 3 }',
    read: '[a, b, rest.c]',
    expected: [1, 2, 3],
  },
  {
    declaration: 'const [a, , b = 3, ...rest] = [1, 2, undefined, 4]',
    read: '[a, b, ...rest]',
    expected: [1, 3, 4],
  },
  {
    declaration:
      'function factorial(n) { return n < 2 ? 1 : n * factorial(n - 1) }',
    read: 'factorial(4)',
    expected: 24,
  },
  {
    declaration:
      'class Counter { value = 0; increment() { return ++this.value } }',
    read: 'const counter = new Counter(); counter.increment(); counter.increment()',
    expected: 2,
  },
]) {
  test(`transformed bindings survive the next evaluation: ${declaration}`, async () => {
    const evaluate = evaluator();
    await evaluate(declaration);
    assert.deepEqual(await evaluate(read), expected);
  });
}

test('uninitialized declarations preserve an assigned value across evaluations', async () => {
  const evaluate = evaluator();
  assert.equal(await evaluate('let value'), undefined);
  await evaluate('value = 9');
  await evaluate('let value');
  assert.equal(await evaluate('value'), 9);
});

test('completion returns the last expression, awaits promises, and stays local to each evaluation', async () => {
  const evaluate = evaluator();
  assert.equal(await evaluate('const value = 1; value + 1'), 2);
  assert.equal(await evaluate('await Promise.resolve(value + 2)'), 3);
  assert.equal(await evaluate('Promise.resolve(value + 3)'), 4);
  assert.equal(await evaluate('const other = 5'), undefined);
  assert.equal(await evaluate('typeof _completion'), 'undefined');
});

test('parse failure returns original input for diagnostics', () => {
  const source = 'const = ;';
  const result = transform(source);
  assert.equal(result.parsed, false);
  assert.ok(result.error);
  assert.equal(result.code, source);
});

for (const { name, source, expected } of [
  {
    name: 'semicolon terminator',
    source: 'const text = <<<TEXT\nhello\nworld\nTEXT;\ntext',
    expected: 'hello\nworld\n',
  },
  {
    name: 'comma and following argument',
    source: 'Array.of(<<<TEXT\nhi\nTEXT,\n2)',
    expected: ['hi\n', 2],
  },
  {
    name: 'closing call',
    source: 'String(<<<TEXT\nhi\nTEXT);',
    expected: 'hi\n',
  },
  {
    name: 'adjacent blocks',
    source: 'Array.of(<<<OLD\nold\nOLD,<<<NEW\nnew\nNEW);',
    expected: ['old\n', 'new\n'],
  },
  {
    name: 'same-line argument continuation',
    source: 'Array.of(<<<TEXT\nhello\nTEXT,{ name: "Aster" });',
    expected: ['hello\n', { name: 'Aster' }],
  },
  {
    name: 'same-line method chain',
    source: 'const text = <<<TEXT\nhello\nTEXT.trimEnd();\ntext',
    expected: 'hello',
  },
  {
    name: 'longer identifier stays inside the body',
    source: 'const text = <<<TAG\nTAGGED stays inside\nTAG;\ntext',
    expected: 'TAGGED stays inside\n',
  },
]) {
  test(`heredoc execution preserves ${name}`, async () => {
    assert.deepEqual(await evaluator()(source), expected);
  });
}
