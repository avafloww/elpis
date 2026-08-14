// test/state.test.ts — tests for the self-set transient state helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readState, writeState } from '../src/store/state.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
}

test('readState returns {} when state.json is missing', () => {
  const dir = tmpdir();
  try {
    assert.deepEqual(readState(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readState returns parsed object when state.json exists', () => {
  const dir = tmpdir();
  try {
    writeState(dir, { mood: 'curious', energy: 'high' });
    const s = readState(dir);
    assert.equal(s.mood, 'curious');
    assert.equal(s.energy, 'high');
    assert.equal(typeof s.__updated_at, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readState returns {} when state.json is malformed', () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), 'not json');
    assert.deepEqual(readState(dir), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeState atomically replaces the existing state and adds timestamp', () => {
  const dir = tmpdir();
  try {
    writeState(dir, { a: 1 });
    const first = readState(dir);
    assert.equal(first.a, 1);
    assert.equal(typeof first.__updated_at, 'string');

    writeState(dir, { a: 2, b: 3 });
    const second = readState(dir);
    assert.equal(second.a, 2);
    assert.equal(second.b, 3);
    assert.equal(typeof second.__updated_at, 'string');
    assert.ok(second.__updated_at >= first.__updated_at);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('writeState overwrites a stale __updated_at with a fresh timestamp', () => {
  const dir = tmpdir();
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ mood: 'x', __updated_at: 'OLD' }));
    writeState(dir, { mood: 'y' });
    const s = readState(dir);
    assert.equal(s.mood, 'y');
    assert.notEqual(s.__updated_at, 'OLD');
    assert.equal(typeof s.__updated_at, 'string');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
