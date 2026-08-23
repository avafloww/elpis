// test/soul.test.ts — the agent-name derivation from SOUL.md frontmatter
// (src/store/soul.ts). The load-bearing property: the body split is
// BYTE-PRESERVING — a SOUL.md without frontmatter passes through untouched,
// and adding `---\nname: X\n---\n\n` in front of existing content yields a
// body identical to the original file (so the injected prompt bytes do not
// change and the prefix cache survives).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseSoul,
  readAgentName,
  DEFAULT_AGENT_NAME,
} from '../src/store/soul.js';

test('no frontmatter: body is the input, byte for byte; name is null', () => {
  const raw = '# Soul\n\nI am someone.\n';
  const parsed = parseSoul(raw);
  assert.equal(parsed.name, null);
  assert.equal(parsed.body, raw);
});

test('frontmatter name is extracted and the body matches the pre-frontmatter file exactly', () => {
  const original = '# Soul\n\nI am someone.\n\nTrailing structure kept.\n';
  const parsed = parseSoul(`---\nname: Echo\n---\n\n${original}`);
  assert.equal(parsed.name, 'Echo');
  assert.equal(parsed.body, original);
});

test('no blank line after the envelope also yields the exact body', () => {
  const parsed = parseSoul('---\nname: Echo\n---\n# Soul\n');
  assert.equal(parsed.name, 'Echo');
  assert.equal(parsed.body, '# Soul\n');
});

test('quoted names are unquoted; blank or missing name is null', () => {
  assert.equal(
    parseSoul('---\nname: "Ada Lovelace"\n---\nbody\n').name,
    'Ada Lovelace',
  );
  assert.equal(parseSoul('---\nname:\n---\nbody\n').name, null);
  assert.equal(parseSoul('---\nother: x\n---\nbody\n').name, null);
});

test('a file OPENING with a decorative ruler is not an envelope — the body passes through untouched', () => {
  const raw = '---\n\nI open with a ruler.\n\n---\nmore text\n';
  const parsed = parseSoul(raw);
  assert.equal(parsed.name, null);
  assert.equal(parsed.body, raw);
});

test('a CRLF envelope still yields the name and strips cleanly', () => {
  const parsed = parseSoul('---\r\nname: Echo\r\n---\r\n\r\n# Soul\r\n');
  assert.equal(parsed.name, 'Echo');
  assert.equal(parsed.body, '# Soul\r\n');
});

test('a dashed ruler mid-file is not an envelope', () => {
  const raw = '# Soul\n\n---\n\nsection two\n---\nmore\n';
  const parsed = parseSoul(raw);
  assert.equal(parsed.name, null);
  assert.equal(parsed.body, raw);
});

test('readAgentName: file, fallback on no name, fallback on missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-test-'));
  const soulPath = path.join(dir, 'SOUL.md');
  fs.writeFileSync(soulPath, '---\nname: Echo\n---\n\n# Soul\n');
  assert.equal(readAgentName(soulPath), 'Echo');
  fs.writeFileSync(soulPath, '# Soul\n');
  assert.equal(readAgentName(soulPath), DEFAULT_AGENT_NAME);
  assert.equal(readAgentName(path.join(dir, 'missing.md')), DEFAULT_AGENT_NAME);
});
