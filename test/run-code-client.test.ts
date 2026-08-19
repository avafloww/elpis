import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import * as prettier from 'prettier';
import babel from 'prettier/plugins/babel';
import estree from 'prettier/plugins/estree';
import typescript from 'prettier/plugins/typescript';
import { protectDisplayHeredocs } from '../src/lib/heredoc-display.js';

function load(window: Record<string, unknown>): any {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/console/public/run-code.js'), 'utf8');
  vm.runInNewContext(source, { window, Set, JSON, Error });
  return window.ElpisRunCode;
}

function formatterWindow(): Record<string, unknown> {
  return { prettier, prettierPlugins: { babel, estree, typescript } };
}

test('run-card formatter prettifies dense JavaScript by default', async () => {
  const api = load(formatterWindow());
  const result = await api.formatSource({ code: 'const x={a:1,b:[2,3]};x.b.map(n=>n*2)' });
  assert.equal(result.formatted, true);
  assert.equal(result.language, 'javascript');
  assert.match(result.source, /const x = \{ a: 1, b: \[2, 3\] \}/);
  assert.match(result.source, /x\.b\.map\(\(n\) => n \* 2\)$/);
  assert.doesNotMatch(result.source, /;$/);
});

test('run-card formatter falls back to the TypeScript parser', async () => {
  const api = load(formatterWindow());
  const result = await api.formatSource({ code: 'const x:number={a:1}.a' });
  assert.equal(result.formatted, true);
  assert.equal(result.language, 'typescript');
  assert.equal(result.source, 'const x: number = { a: 1 }.a');
});

test('run-card formatter leaves the final expression visibly value-bearing', async () => {
  const api = load(formatterWindow());
  const result = await api.formatSource({ code: 'const x={a:1};({x})' });
  assert.equal(result.source, 'const x = { a: 1 };\n({ x })');
});

test('run-card formatter restores exact heredoc bodies after formatting', async () => {
  const raw = ["elpis.edit('x',<<<BODY", 'raw  `text`  ${literal}', 'BODY.trimEnd())'].join('\n');
  const display = protectDisplayHeredocs(raw);
  assert.equal(display.error, undefined);
  const api = load(formatterWindow());
  const result = await api.formatSource({ code: raw, display: { code: display.code, heredocs: display.heredocs } });
  assert.equal(result.formatted, true);
  assert.match(result.highlightSource, /__ELPIS_HEREDOC_0__/);
  assert.equal(result.heredocs.length, 1);
  assert.match(result.source, /<<<BODY\nraw  `text`  \$\{literal\}\nBODY\.trimEnd\(\)/);
  assert.doesNotMatch(result.source, /__ELPIS_HEREDOC_/);
});

test('run-card formatter restores multiple heredocs without interpreting replacement dollars', async () => {
  const raw = [
    "elpis.edit('a',<<<FIRST",
    "replace('$&', '$`', \"$'\")",
    'FIRST,<<<SECOND',
    'second body',
    'SECOND);',
    '({ done: true })',
  ].join('\n');
  const display = protectDisplayHeredocs(raw);
  assert.equal(display.error, undefined);
  const api = load(formatterWindow());
  const result = await api.formatSource({ code: raw, display: { code: display.code, heredocs: display.heredocs } });
  assert.equal(result.formatted, true);
  assert.match(result.source, /<<<FIRST\nreplace\('\$&', '\$`', "\$'"\)\nFIRST, <<<SECOND\nsecond body\nSECOND\);/);
  assert.match(result.source, /\(\{ done: true \}\)$/);
  assert.doesNotMatch(result.source, /__ELPIS_HEREDOC_/);
});

test('run-card formatter preserves raw source when dependencies are unavailable', async () => {
  const api = load({});
  const raw = 'const  x={a:1}';
  const result = await api.formatSource({ code: raw });
  assert.equal(result.source, raw);
  assert.equal(result.language, 'javascript');
  assert.equal(result.formatted, false);
});
