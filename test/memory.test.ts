// Unit tests for memory.ts: the dated-bullet stamp format shared across
// MEMORY.md / ponder/ / people/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMemory, appendDatedBullet } from '../src/store/memory.js';

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

test('appendDatedBullet creates a missing file', () => {
  const file = tmpFile();
  appendDatedBullet(file, 'first', '2026-07-02');
  assert.equal(fs.readFileSync(file, 'utf8'), '\n- [2026-07-02] first\n');
});
