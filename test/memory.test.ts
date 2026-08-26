// Unit tests for memory.ts: the dated-bullet stamp format shared across
// MEMORY.md / ponder/ / people/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendDatedBullet,
  createMemory,
  ensureFile,
  hardenAuthoredMemoryFiles,
  writePrivateFileAtomic,
} from '../src/store/memory.js';

function tmpFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mem-'));
  return path.join(dir, 'MEMORY.md');
}

test('memory.append (remember) stamps a date-only dated bullet', () => {
  const file = tmpFile();
  const memory = createMemory(file);
  memory.append('a fact worth keeping');
  const raw = fs.readFileSync(file, 'utf8');
  // `- [YYYY-MM-DD] text` — date only, no full-ISO time component.
  assert.match(raw, /^- \[\d{4}-\d{2}-\d{2}\] a fact worth keeping$/m);
  assert.doesNotMatch(raw, /\d{2}:\d{2}:\d{2}/, 'no HH:MM:SS full-ISO stamp');
});

test('appendDatedBullet stacks bullets without blank-line drift', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '# Header\n');
  appendDatedBullet(file, 'one', '2026-07-02');
  appendDatedBullet(file, 'two', '2026-07-02');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '# Header\n- [2026-07-02] one\n- [2026-07-02] two\n',
  );
});

test('memory hooks can guard reads and observe append/overwrite writes', () => {
  const file = tmpFile();
  const changed: string[] = [];
  const memory = createMemory(file, {
    read: () => 'bounded view',
    changed: (p) => changed.push(p),
  });
  assert.equal(memory.read(), 'bounded view');
  memory.append('one');
  memory.overwrite('two');
  assert.deepEqual(changed, [file, file]);
});

test('appendDatedBullet creates a missing file', () => {
  const file = tmpFile();
  appendDatedBullet(file, 'first', '2026-07-02');
  assert.equal(fs.readFileSync(file, 'utf8'), '\n- [2026-07-02] first\n');
});

test('non-missing read errors are not mistaken for empty memory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mem-read-'));
  assert.throws(() => appendDatedBullet(dir, 'must not replace directory'));
  assert.throws(() => createMemory(dir).read());
  assert.equal(fs.statSync(dir).isDirectory(), true);
});

test('memory writes atomically replace permissive files with mode 0600', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'old', { mode: 0o664 });
  fs.chmodSync(file, 0o664);
  const before = fs.statSync(file).ino;
  createMemory(file).overwrite('new');
  assert.equal(fs.readFileSync(file, 'utf8'), 'new');
  assert.notEqual(fs.statSync(file).ino, before);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    fs
      .readdirSync(path.dirname(file))
      .filter((name) => name.includes('.writing-')),
    [],
  );
});

test('failed atomic write preserves the prior file and cleans its temp', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mem-fail-'));
  const file = path.join(dir, 'MEMORY.md');
  fs.writeFileSync(file, 'keep me', { mode: 0o600 });
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => writePrivateFileAtomic(file, 'lose me'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep me');
    assert.deepEqual(
      fs.readdirSync(dir).filter((name) => name.includes('.writing-')),
      [],
    );
  } finally {
    fs.chmodSync(dir, 0o700);
  }
});

test('startup hardens authored memory files without touching unrelated data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-mem-mode-'));
  const exact = ['SOUL.md', 'MEMORY.md', 'NOW.md'].map((name) =>
    path.join(dir, name),
  );
  const nested = [
    path.join(dir, 'people', 'person.md'),
    path.join(dir, 'people', 'guild', 'person.md'),
    path.join(dir, 'ponder', 'question.md'),
  ];
  const unrelated = path.join(dir, 'library.md');
  for (const file of [...exact, ...nested, unrelated]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, file, { mode: 0o664 });
    fs.chmodSync(file, 0o664);
  }
  hardenAuthoredMemoryFiles(dir, exact);
  for (const file of [...exact, ...nested]) {
    assert.equal(fs.readFileSync(file, 'utf8'), file);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  for (const dirPath of [
    path.join(dir, 'people'),
    path.join(dir, 'people', 'guild'),
    path.join(dir, 'ponder'),
  ]) {
    assert.equal(fs.statSync(dirPath).mode & 0o777, 0o700);
  }
  assert.equal(fs.statSync(unrelated).mode & 0o777, 0o664);
});

test('ensureFile hardens an existing file without replacing its content', () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'mine', { mode: 0o664 });
  fs.chmodSync(file, 0o664);
  ensureFile(file, 'default');
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
