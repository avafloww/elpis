// Unit tests for src/lib/fill.ts — opt-in {{key}} substitution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fill } from '../src/lib/fill.js';

test('fill: substitutes named placeholders', () => {
  assert.equal(fill('a={{x}} b={{y}}', { x: 1, y: 'two' }), 'a=1 b=two');
});

test('fill: a placeholder used more than once is filled every time', () => {
  assert.equal(fill('{{n}}+{{n}}', { n: 2 }), '2+2');
});

test('fill: throws naming a placeholder with no matching key', () => {
  assert.throws(() => fill('{{a}}/{{b}}', { a: 1 }), /fill: no value for \{\{b\}\}/);
});

test('fill: throws naming a vars key no placeholder used (typo guard)', () => {
  assert.throws(() => fill('{{a}}', { a: 1, tiemout: 5 }), /fill: unused key "tiemout"/);
});

test('fill: leaves non-identifier double-brace content literal', () => {
 // `{{ x }}` (inner spaces) and `{{}}` are NOT placeholders; carry them verbatim.
  assert.equal(fill('{{ x }} {{}} end {{k}}', { k: 'K' }), '{{ x }} {{}} end K');
});

test('fill: carries source-code payload verbatim except real placeholders', () => {
  const out = fill('const t = `${a}`; timeout={{timeout}};', { timeout: 3000 });
  assert.equal(out, 'const t = `${a}`; timeout=3000;');
});
