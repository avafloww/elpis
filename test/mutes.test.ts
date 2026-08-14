import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type Database } from '../src/store/db.js';
import { createMuteStore } from '../src/store/mutes.js';

function freshStore(): { store: ReturnType<typeof createMuteStore>; db: Database; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mutes-'));
  const db = openDatabase(dir);
  return { store: createMuteStore(db), db, dir };
}

function cleanup(db: Database, dir: string): void {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

test('mutes: set/get/clear round-trip', () => {
  const { store: s, db, dir } = freshStore();
  assert.equal(s.get('100'), null);
  s.set('100', 'mute', 'self', 'asked to stop');
  const row = s.get('100')!;
  assert.equal(row.type, 'mute');
  assert.equal(row.setBy, 'self');
  assert.equal(row.reason, 'asked to stop');
  assert.equal(s.clear('100'), true);
  assert.equal(s.get('100'), null);
  assert.equal(s.clear('100'), false);
  cleanup(db, dir);
});

test('mutes: one row per channel — deafen replaces mute', () => {
  const { store: s, db, dir } = freshStore();
  s.set('100', 'mute', 'self', null);
  s.set('100', 'deafen', 'operator', 'funky server');
  const row = s.get('100')!;
  assert.equal(row.type, 'deafen');
  assert.equal(row.setBy, 'operator');
  assert.equal(s.all().length, 1);
  cleanup(db, dir);
});
