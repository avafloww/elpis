// test/native.test.ts — tests for the native first-person note helper. The
// note file, title, and signature all derive from the agent name passed in
// (SOUL.md frontmatter at the call site) — nothing is hardcoded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendNativeNote } from '../src/store/native.js';

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-test-'));
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  return dir;
}

function readFile(dataDir: string, slug = 'echo') {
  return fs.readFileSync(path.join(dataDir, 'notes', `${slug}-native.md`), 'utf8');
}

test('creates file with header if missing, named after the agent slug', () => {
  const dir = tmpdir();
  const res = appendNativeNote(dir, 'chose to keep a record.', 'Echo');
  assert.equal(res.ok, true);
  assert.equal(res.path, path.join(dir, 'notes', 'echo-native.md'));
  const content = readFile(dir);
  assert.match(content, /# Echo — native notes/);
  assert.match(content, /One sentence per heartbeat/);
  assert.match(content, /Signed by Echo\./);
  assert.match(content, /Echo: chose to keep a record\./);
});

test('appends to existing file', () => {
  const dir = tmpdir();
  appendNativeNote(dir, 'first note.', 'Echo');
  appendNativeNote(dir, 'second note.', 'Echo');
  const content = readFile(dir);
  const matches = content.match(/Echo:/g);
  assert.equal(matches?.length, 2);
  assert.match(content, /second note\./);
});

test('trims whitespace from input', () => {
  const dir = tmpdir();
  appendNativeNote(dir, '   spaced out   ', 'Echo');
  const content = readFile(dir);
  assert.match(content, /Echo: spaced out$/m);
});

test('slugifies a multi-word name for the file path only', () => {
  const dir = tmpdir();
  const res = appendNativeNote(dir, 'note.', 'Ada Lovelace');
  assert.equal(res.path, path.join(dir, 'notes', 'ada-lovelace-native.md'));
  assert.match(readFile(dir, 'ada-lovelace'), /Ada Lovelace: note\./);
});
