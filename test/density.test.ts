// Unit tests for DensityModel — calibrated chars-per-token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import { createDensityModel } from '../src/llm/density.js';
import { noopLogger } from '../src/lib/log.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-density-'));
  return openDatabase(dir);
}

test('density: seeds at 4.0 and estimates char/4 before any observation', () => {
  const d = createDensityModel(freshDb(), 'kimi-k3', noopLogger);
  assert.equal(d.ratio(), 4);
  assert.equal(d.estimate(40), 10);
  assert.equal(d.estimate(41), 11); // ceil
});

test('density: first accepted sample sets the ratio outright (no EWMA blend)', () => {
  const d = createDensityModel(freshDb(), 'kimi-k3', noopLogger);
  d.observe(35700, 10000); // 3.57 cpt
  assert.ok(Math.abs(d.ratio() - 3.57) < 1e-9, `ratio=${d.ratio()}`);
});

test('density: subsequent samples blend by EWMA alpha 0.1', () => {
  const d = createDensityModel(freshDb(), 'kimi-k3', noopLogger);
  d.observe(40000, 10000); // sets ratio = 4.0
  d.observe(30000, 10000); // sample 3.0 → 0.9*4 + 0.1*3 = 3.9
  assert.ok(Math.abs(d.ratio() - 3.9) < 1e-9, `ratio=${d.ratio()}`);
});

test('density: rejects samples with promptTokens < 1000', () => {
  const d = createDensityModel(freshDb(), 'kimi-k3', noopLogger);
  d.observe(2000, 999); // rejected → ratio unchanged
  assert.equal(d.ratio(), 4);
});

test('density: rejects non-finite / non-positive inputs', () => {
  const d = createDensityModel(freshDb(), 'kimi-k3', noopLogger);
  d.observe(NaN, 10000);
  d.observe(10000, 0);
  d.observe(-5, 10000);
  assert.equal(d.ratio(), 4);
});

test('density: clamps the ratio into [2, 6]', () => {
  const d = createDensityModel(freshDb(), 'kimi-k3', noopLogger);
  d.observe(100000, 10000); // raw 10.0 → clamp 6.0
  assert.equal(d.ratio(), 6);
  const d2 = createDensityModel(freshDb(), 'kimi-k3', noopLogger);
  d2.observe(5000, 10000);  // raw 0.5 → clamp 2.0
  assert.equal(d2.ratio(), 2);
});

test('density: persists per model and reloads on a new instance', () => {
  const db = freshDb();
  const a = createDensityModel(db, 'kimi-k3', noopLogger);
  a.observe(35700, 10000); // 3.57
 // A different model is independent (starts at seed).
  const other = createDensityModel(db, 'some-other-model', noopLogger);
  assert.equal(other.ratio(), 4);
 // A fresh instance for the same model reloads the persisted ratio.
  const b = createDensityModel(db, 'kimi-k3', noopLogger);
  assert.ok(Math.abs(b.ratio() - 3.57) < 1e-9, `reloaded ratio=${b.ratio()}`);
});

test('density: a corrupt persisted ratio degrades to the seed', () => {
  const db = freshDb();
  db.prepare(`INSERT INTO token_density (model, ratio, samples, updated_at) VALUES (?, ?, ?, ?)`)
    .run('kimi-k3', 999, 5, new Date().toISOString()); // out-of-range ratio
  const d = createDensityModel(db, 'kimi-k3', noopLogger);
 // clamped on load into [2,6]; never the raw 999
  assert.ok(d.ratio() >= 2 && d.ratio() <= 6, `ratio=${d.ratio()}`);
});
