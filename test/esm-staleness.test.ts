// Unit tests for sandbox/esm-staleness.ts — the ESM stale-require warning.
//
// The bug it exists for: require.cache eviction is a no-op for ES modules, so a
// rebuilt dist/ file keeps serving its first-loaded version with no error at
// all. Silent wrong answers are worse than loud failures.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStalenessTracker, isEsmPath } from '../src/sandbox/esm-staleness.js';

test('isEsmPath: .mjs is ESM, .cjs is not', () => {
  assert.equal(isEsmPath('/x/y.mjs'), true);
  assert.equal(isEsmPath('/x/y.cjs'), false);
});

test('isEsmPath: .js follows the nearest package.json type field', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'esmtype-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.writeFileSync(path.join(dir, 'a.js'), '');
  assert.equal(isEsmPath(path.join(dir, 'a.js')), true);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cjstype-'));
  fs.writeFileSync(path.join(dir2, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  fs.writeFileSync(path.join(dir2, 'b.js'), '');
  assert.equal(isEsmPath(path.join(dir2, 'b.js')), false);
});

test('tracker: silent on first require', () => {
  const t = createStalenessTracker(() => 100, () => true);
  assert.equal(t.check('/x/a.js'), null);
});

test('tracker: silent when the file has not changed', () => {
  const t = createStalenessTracker(() => 100, () => true);
  t.check('/x/a.js');
  assert.equal(t.check('/x/a.js'), null);
});

test('tracker: warns when a re-required ESM file changed on disk', () => {
  let mtime = 100;
  const t = createStalenessTracker(() => mtime, () => true);
  t.check('/x/a.js');
  mtime = 200;
  const w = t.check('/x/a.js');
  assert.ok(w, 'expected a warning');
  assert.match(w, /STALE/);
  assert.match(w, /subprocess/);
});

test('tracker: stays quiet for CJS, where the cache-bust actually works', () => {
  let mtime = 100;
  const t = createStalenessTracker(() => mtime, () => false);
  t.check('/x/a.cjs');
  mtime = 200;
  assert.equal(t.check('/x/a.cjs'), null);
});

test('tracker: a CJS file that changes twice never warns', () => {
  let mtime = 100;
  const t = createStalenessTracker(() => mtime, () => false);
  t.check('/x/a.cjs');
  mtime = 200; t.check('/x/a.cjs');
  mtime = 300;
  assert.equal(t.check('/x/a.cjs'), null);
});

test('tracker: unstattable path is ignored', () => {
  const t = createStalenessTracker(() => { throw new Error('nope'); }, () => true);
  assert.equal(t.check('/x/gone.js'), null);
});
