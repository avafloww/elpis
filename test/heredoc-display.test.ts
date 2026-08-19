import assert from 'node:assert/strict';
import test from 'node:test';
import * as prettier from 'prettier';
import babel from 'prettier/plugins/babel';
import estree from 'prettier/plugins/estree';
import { protectDisplayHeredocs, restoreDisplayHeredocs } from '../src/lib/heredoc-display.js';

test('display heredoc protection preserves exact bodies and same-line trailers through Prettier', async () => {
  const raw = [
    "elpis.edit('x',<<<OLD",
    'a  \"quote\"  \\ slash',
    'OLD,<<<NEW',
    'b ${literal} `tick`',
    'NEW.trimEnd());',
  ].join('\n');
  const protectedCode = protectDisplayHeredocs(raw);
  assert.equal(protectedCode.error, undefined);
  assert.equal(protectedCode.heredocs.length, 2);
  const formatted = await prettier.format(protectedCode.code, { parser: 'babel', plugins: [babel, estree], singleQuote: true });
  const restored = restoreDisplayHeredocs(formatted, protectedCode.heredocs);
  assert.match(restored, /<<<OLD\na  "quote"  \\ slash\nOLD,/);
  assert.match(restored, /<<<NEW\nb \$\{literal\} `tick`\nNEW\.trimEnd\(\)/);
  assert.doesNotMatch(restored, /__ELPIS_HEREDOC_/);
});

test('display heredoc protection ignores markers inside literals, templates, and comments', () => {
  const raw = [
    "const a='<<<NOPE\\n'; const b=`<<<NOPE`; // <<<NOPE",
    '/* <<<NOPE */',
    'const c=<<<YES',
    'ok',
    'YES;',
  ].join('\n');
  const protectedCode = protectDisplayHeredocs(raw);
  assert.equal(protectedCode.heredocs.length, 1);
  assert.match(protectedCode.code, /<<<NOPE/);
  assert.match(protectedCode.heredocs[0].source, /^<<<YES\nok\nYES$/);
});

test('display heredoc protection fails closed on missing terminators', () => {
  const raw = 'const x=<<<NOPE\nbody';
  assert.deepEqual(protectDisplayHeredocs(raw), { code: raw, heredocs: [], error: 'heredoc <<<NOPE has no terminator' });
});
