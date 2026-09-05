import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSandbox } from '../src/sandbox/index.js';
import { makeConfig } from './helpers.js';
import type { SandboxDeps } from '../src/types.js';

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-grep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = makeConfig();
  config.paths.dataDirectory = dir;
  config.paths.harnessRoot = dir;
  const sandbox = createSandbox({
    config,
    memory: {
      read: () => '',
      append: () => undefined,
      overwrite: () => undefined,
    },
    logbuf: [],
  } as unknown as SandboxDeps);
  return { dir, sandbox };
}

test('grep reports invalid patterns as errors with failed receipts', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'sample.txt'), 'sample\n');
  const result = await f.sandbox.run(
    `await elpis.grep('[', { path: ${JSON.stringify(f.dir)} })`,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /grep failed/);
  assert.doesNotMatch(result.error ?? '', /no matches/);
  assert.equal(result.operationReceipts?.[0]?.ok, false);
  assert.equal(result.operationReceipts?.[0]?.code, 2);
  assert.ok(result.operationReceipts?.[0]?.stderr);
});

test('grep reports missing inputs instead of claiming no matches', async (t) => {
  const f = fixture(t);
  const result = await f.sandbox.run(
    `await elpis.grep('sample', { path: ${JSON.stringify(path.join(f.dir, 'absent'))} })`,
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /grep failed/);
  assert.equal(result.operationReceipts?.[0]?.ok, false);
});

test('grep does not confuse an output-filter failure with no matches', async (t) => {
  const f = fixture(t);
  const bin = path.join(f.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'awk'), '#!/bin/sh\nexit 1\n', {
    mode: 0o700,
  });
  fs.writeFileSync(path.join(f.dir, 'sample.txt'), 'sample\n');
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
  try {
    const result = await f.sandbox.run(
      `await elpis.grep('absent', { path: ${JSON.stringify(path.join(f.dir, 'sample.txt'))} })`,
    );
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /grep failed/);
    assert.equal(result.operationReceipts?.[0]?.code, 1);
    assert.equal(result.operationReceipts?.[0]?.ok, false);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test('grep treats genuine no-match as a successful query', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'sample.txt'), 'sample\n');
  const result = await f.sandbox.run(
    `await elpis.grep('absent', { path: ${JSON.stringify(f.dir)} })`,
  );
  assert.equal(result.ok, true, result.error);
  assert.match(result.preview ?? '', /no matches/);
  assert.equal(result.operationReceipts?.[0]?.ok, true);
});

test('grep retains fixed, regex, case, glob, and quoted pattern behavior', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.dir, 'sample.txt'),
    "alpha\nbeta\n[a]\n-n\ncan't\n",
  );
  fs.writeFileSync(path.join(f.dir, 'other.log'), 'alpha\n');
  for (const [pattern, options, expected] of [
    ['alpha|beta', { glob: '*.txt' }, 'alpha'],
    ['ALPHA', { ignoreCase: true, glob: '*.txt' }, 'alpha'],
    ['[a]', { fixed: true }, '[a]'],
    ['-n', { fixed: true }, '-n'],
    ["can't", { fixed: true }, "can't"],
  ] as const) {
    const result = await f.sandbox.run(
      `await elpis.grep(${JSON.stringify(pattern)}, ${JSON.stringify({ path: f.dir, ...options })})`,
    );
    assert.equal(result.ok, true, result.error);
    assert.ok(result.operationReceipts?.[0]?.stdout?.includes(expected));
    if ('glob' in options)
      assert.ok(!result.operationReceipts?.[0]?.stdout?.includes('other.log'));
  }
});

test('grep caps global output without converting truncation into an error', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'many.txt'), 'needle\n'.repeat(25000));
  const result = await f.sandbox.run(
    `(await elpis.grep('needle', { path: ${JSON.stringify(f.dir)}, max: 2 })).split('\\n').length`,
  );
  assert.equal(result.ok, true, result.error);
  assert.equal(result.preview, '2');
  assert.equal(result.operationReceipts?.[0]?.ok, true);
});
