// test/soul.test.ts — the agent-name derivation from SOUL.md frontmatter
// (src/store/soul.ts). The load-bearing property: the body split is
// BYTE-PRESERVING — a SOUL.md without frontmatter passes through untouched,
// and adding `---\nname: X\n---\n\n` in front of existing content yields a
// body identical to the original file (so the injected prompt bytes do not
// change and the prefix cache survives).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseSoul,
  readAgentName,
  readPromptFacingSoulSnapshot,
  DEFAULT_AGENT_NAME,
  SOUL_PROMPT_SNAPSHOT_MAX_BYTES,
  SOUL_PROMPT_SNAPSHOT_PARSER_GENERATION,
} from '../src/store/soul.js';

test('no frontmatter: body is the input, byte for byte; name is null', () => {
  const raw = '# Soul\n\nI am someone.\n';
  const parsed = parseSoul(raw);
  assert.equal(parsed.name, null);
  assert.equal(parsed.reanchor, null);
  assert.equal(parsed.body, raw);
});

test('frontmatter name is extracted and the body matches the pre-frontmatter file exactly', () => {
  const original = '# Soul\n\nI am someone.\n\nTrailing structure kept.\n';
  const parsed = parseSoul(`---\nname: Echo\n---\n\n${original}`);
  assert.equal(parsed.name, 'Echo');
  assert.equal(parsed.body, original);
});

test('optional reanchor is normalized, bounded, and does not alter body bytes', () => {
  const original = '# Soul\n\nbody\n';
  const parsed = parseSoul(
    `---\nname: Echo\nreanchor: Again   is truer than forever.\n---\n\n${original}`,
  );
  assert.equal(parsed.reanchor, 'Again is truer than forever.');
  assert.equal(parsed.body, original);
  assert.equal(
    parseSoul(
      '---\nreanchor: one two three four five six seven eight nine ten eleven\n---\nbody\n',
    ).reanchor,
    null,
  );
  assert.equal(
    parseSoul(`---\nreanchor: ${'界'.repeat(41)}\n---\nbody\n`).reanchor,
    null,
  );
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

test('prompt-facing snapshot binds exact source bytes and parsed body bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-snapshot-'));
  const soulPath = path.join(dir, 'SOUL.md');
  const body = '# Soul\r\n\r\nA body.\r\n\r\n';
  const raw = `---\r\nname: Echo\r\nreanchor: Return gently.\r\n---\r\n\r\n${body}`;
  fs.writeFileSync(soulPath, raw);

  const snapshot = readPromptFacingSoulSnapshot(soulPath);
  assert.equal(
    snapshot.parserGeneration,
    SOUL_PROMPT_SNAPSHOT_PARSER_GENERATION,
  );
  assert.equal(snapshot.sourceFile, raw);
  assert.equal(snapshot.sourceFileBytes, Buffer.byteLength(raw));
  assert.equal(
    snapshot.sourceFileHash,
    createHash('sha256').update(raw).digest('hex'),
  );
  assert.equal(snapshot.body, body);
  assert.equal(snapshot.bodyBytes, Buffer.byteLength(body));
  assert.equal(
    snapshot.bodyHash,
    createHash('sha256').update(body).digest('hex'),
  );
  assert.notEqual(snapshot.sourceFileHash, snapshot.bodyHash);
  assert.ok(!snapshot.body.includes('name: Echo'));
  assert.ok(!snapshot.body.includes('reanchor:'));
  assert.ok(Object.isFrozen(snapshot));
});

test('prompt-facing snapshot matches live prompt semantics for a UTF-8 BOM', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-snapshot-bom-'));
  const soulPath = path.join(dir, 'SOUL.md');
  const raw = '\uFEFF---\nname: Echo\n---\n\n# Soul\n';
  fs.writeFileSync(soulPath, raw);

  const expectedBody = parseSoul(fs.readFileSync(soulPath, 'utf8')).body;
  const snapshot = readPromptFacingSoulSnapshot(soulPath);
  assert.equal(snapshot.sourceFile, raw);
  assert.equal(snapshot.body, expectedBody);
  assert.equal(snapshot.body, raw);
  assert.ok(snapshot.body.startsWith('\uFEFF---'));
});

test('prompt-facing snapshot fails closed on unusable source files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-snapshot-fail-'));
  const missing = path.join(dir, 'missing.md');
  assert.throws(
    () => readPromptFacingSoulSnapshot(missing),
    /snapshot unavailable/,
  );
  assert.throws(
    () => readPromptFacingSoulSnapshot(dir),
    /must be a regular file/,
  );

  const emptyPath = path.join(dir, 'empty.md');
  fs.writeFileSync(emptyPath, '---\nname: Echo\n---\n\n');
  assert.throws(() => readPromptFacingSoulSnapshot(emptyPath), /body is empty/);

  const invalidPath = path.join(dir, 'invalid.md');
  fs.writeFileSync(invalidPath, Buffer.from([0xff]));
  assert.throws(
    () => readPromptFacingSoulSnapshot(invalidPath),
    /not valid UTF-8/,
  );

  const oversizedPath = path.join(dir, 'oversized.md');
  fs.writeFileSync(
    oversizedPath,
    Buffer.alloc(SOUL_PROMPT_SNAPSHOT_MAX_BYTES + 1, 0x61),
  );
  assert.throws(
    () => readPromptFacingSoulSnapshot(oversizedPath),
    /exceeds the byte limit/,
  );

  const targetPath = path.join(dir, 'target.md');
  const linkPath = path.join(dir, 'link.md');
  fs.writeFileSync(targetPath, '# Soul\n');
  fs.symlinkSync(targetPath, linkPath);
  assert.throws(
    () => readPromptFacingSoulSnapshot(linkPath),
    /snapshot unavailable/,
  );
});

test('prompt-facing snapshot rejects a FIFO without blocking', (t) => {
  if (process.platform === 'win32') {
    t.skip('FIFOs are not available on Windows');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-snapshot-fifo-'));
  const fifoPath = path.join(dir, 'SOUL.md');
  const made = spawnSync('mkfifo', [fifoPath], { encoding: 'utf8' });
  if (made.status !== 0) {
    t.skip('mkfifo is unavailable');
    return;
  }
  const moduleUrl = pathToFileURL(
    path.resolve(process.cwd(), 'src/store/soul.ts'),
  ).href;
  const script = `
    import { readPromptFacingSoulSnapshot } from ${JSON.stringify(moduleUrl)};
    try {
      readPromptFacingSoulSnapshot(${JSON.stringify(fifoPath)});
      process.exit(2);
    } catch (error) {
      if (/must be a regular file/.test(String(error))) process.exit(0);
      console.error(String(error));
      process.exit(3);
    }
  `;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 1_000 },
  );
  assert.equal(result.error, undefined, String(result.error));
  assert.equal(result.status, 0, result.stderr);
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
