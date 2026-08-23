// Unit tests for jslex.blankLiterals — tolerant literal-blanking lexer.
// Split out of the former sandbox.test.ts monolith. Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankLiterals } from '../src/lib/jslex.js';

// ---------- jslex: blankLiterals ----------

test('jslex: blankLiterals blanks string/template/comment contents, preserves length and newlines', () => {
  const src = `const a = 'exec'; // execSync here\nconst b = "spawnSync";\nconst t = \`tpl \${call()} end\`;\n/* block\nexecSync */ real()`;
  const out = blankLiterals(src);
  assert.equal(out.length, src.length, 'length preserved');
  assert.equal(
    out.split('\n').length,
    src.split('\n').length,
    'newlines preserved',
  );
  assert.ok(!out.includes('exec'), 'string/comment contents blanked');
  assert.ok(!out.includes('call()'), 'template interpolation blanked');
  assert.ok(out.includes('real()'), 'code outside literals kept');
  assert.ok(out.includes("const a = '"), 'quotes themselves kept');
});

test('jslex: unterminated string at EOF blanks to the end (streaming tolerance)', () => {
  const out = blankLiterals('f("abc');
  assert.equal(out, 'f("   ');
});
