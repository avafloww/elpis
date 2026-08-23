// Unit/e2e tests for the sandbox parse/run error UX: heredoc-aware pre-parse
// hints (no misleading "looks like TypeScript" hint when a `<<<` heredoc is
// the actual culprit) and a clean, actionable error for dynamic `import`,
// which the vm context does not support (ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING).
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/sandbox/index.js';
import { createBgRegistry } from '../src/sandbox/bg.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-import-'));
const memoryPath = path.join(tmp, 'memory.md');
fs.writeFileSync(memoryPath, '# Agent Memory\n');

const bgRegistry = createBgRegistry(tmp);

const deps = {
  config: {
    sandbox: {
      syncTimeoutMs: 3000,
      asyncDeadlineMs: 8000,
      previewMaxBytes: 2048,
      logMaxBytes: 2048,
    },
    kagi: { apiKey: null },
    paths: { harnessRoot: '/tmp/harness-root', dataDirectory: tmp },
  },
  memory: {
    read: () => fs.readFileSync(memoryPath, 'utf8'),
    append: (t: string) => fs.appendFileSync(memoryPath, `\n- [t] ${t}\n`),
    overwrite: (t: string) => fs.writeFileSync(memoryPath, t),
  },
  logbuf: [] as string[],
  bg: bgRegistry,
  inbound: null as unknown,
};

const sandbox = createSandbox(deps as Parameters<typeof createSandbox>[0]);

// ---------- 5b: heredoc-aware pre-parse hint (Findings 12, 11) ----------

test('heredoc: unsupported opener form (<<<-EOF) errors with a heredoc hint, not the generic TS hint', async () => {
  const r = await sandbox.run('const x = <<<-EOF\nhello\nEOF');
  assert.equal(r.ok, false);
  const err = r.error ?? '';
  assert.match(err, /heredoc|<<<TAG/);
  assert.doesNotMatch(err, /looks like TypeScript/);
});

test("heredoc: unsupported opener form (<<<'EOF') errors with a heredoc hint, not the generic TS hint", async () => {
  const r = await sandbox.run("const x = <<<'EOF'\nhello\nEOF");
  assert.equal(r.ok, false);
  const err = r.error ?? '';
  assert.match(err, /heredoc|<<<TAG/);
  assert.doesNotMatch(err, /looks like TypeScript/);
});

// ---------- 5c: dynamic import clean error (Finding 14) ----------

test('dynamic import(): surfaces a clean require()/.cjs error instead of the raw VM error code', async () => {
  const r = await sandbox.run('await import("./x.cjs")');
  assert.equal(r.ok, false);
  const err = r.error ?? '';
  assert.doesNotMatch(err, /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/);
  assert.match(err, /require\(/);
  assert.match(err, /\.cjs/);
});
