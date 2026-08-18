import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createSandbox } from '../src/sandbox/index.js';
import { makeConfig } from './helpers.js';
import type { SandboxDeps } from '../src/types.js';

function deps(surface: 'core' | 'full'): SandboxDeps {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), `sandbox-${surface}-`));
  const config = makeConfig({ paths: { ...makeConfig().paths, dataDirectory, harnessRoot: dataDirectory } });
  const registrations: unknown[] = [];
  return {
    surface,
    config,
    memory: { read: () => '', append: () => undefined, overwrite: () => undefined },
    logbuf: [],
    sandboxRegistry: {
      create: (mindId) => { const value = { alias: `mind-${mindId}-sandbox`, mindId }; registrations.push(value); return value; },
      get: (ref) => ({ alias: ref }),
      getByMind: (mindId) => registrations.find((value: any) => value.mindId === mindId) ?? null,
      list: () => registrations,
    },
  } as unknown as SandboxDeps;
}

const CORE_KEYS = [
  'channel', 'fill', 'focus', 'inbound', 'memory', 'mind', 'ponder', 'preview',
  'remember', 'sandbox', 'schedule', 'sleep', 'timeout', 'wait',
];

test('core sandbox exposes only the core elpis allowlist and no host globals', async () => {
  const sandbox = createSandbox(deps('core'));
  const keys = await sandbox.run('Object.keys(elpis).sort()');
  assert.equal(keys.ok, true);
  assert.match(keys.preview ?? '', new RegExp(CORE_KEYS.join('.*')));
  const count = await sandbox.run('Object.keys(elpis).length');
  assert.equal(count.preview, String(CORE_KEYS.length));
  const hosts = await sandbox.run(`({
    fs: typeof fs,
    process: typeof process,
    require: typeof require,
    Buffer: typeof Buffer,
    harnessRoot: typeof HARNESS_ROOT,
    dataDir: typeof DATA_DIR,
    lastValue: typeof _,
  })`);
  assert.equal(hosts.ok, true);
  for (const name of ['fs', 'process', 'require', 'Buffer', 'harnessRoot', 'dataDir', 'lastValue']) {
    assert.match(hosts.preview ?? '', new RegExp(`${name}: "undefined"`));
  }
});

test('core sandbox has no last-value mechanics and can bootstrap a persistent registration', async () => {
  const sandbox = createSandbox(deps('core'));
  const first = await sandbox.run('21 * 2');
  assert.equal(first.preview, '42');
  assert.equal(first.savedAs, undefined);
  const absent = await sandbox.run('typeof _');
  assert.match(absent.preview ?? '', /"undefined"/);
  const created = await sandbox.run('elpis.sandbox.create({ mindId: 7 })');
  assert.match(created.preview ?? '', /mind-7-sandbox/);
  const found = await sandbox.run('elpis.sandbox.forMind(7)');
  assert.match(found.preview ?? '', /mind-7-sandbox/);
});

test('sandbox failures distinguish preparse from uncaught runtime errors', async () => {
  const sandbox = createSandbox(deps('core'));
  const preparse = await sandbox.run('const bad =');
  assert.equal(preparse.failureKind, 'preparse');
  const runtime = await sandbox.run('throw new Error("boom")');
  assert.equal(runtime.failureKind, 'runtime');
  const caught = await sandbox.run('(() => { try { throw new Error("caught") } catch { return "kept" } })()');
  assert.equal(caught.ok, true);
  assert.match(caught.preview ?? '', /"kept"/);
});

test('full sandbox retains compatibility last-value state', async () => {
  const sandbox = createSandbox(deps('full'));
  const first = await sandbox.run('6 * 7');
  assert.equal(first.savedAs, '_');
  assert.equal((await sandbox.run('_')).preview, '42');
  assert.match((await sandbox.run('typeof fs')).preview ?? '', /"object"/);
});
