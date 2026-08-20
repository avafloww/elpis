import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../src/sandbox/index.js';
import { routeRunProcessError, runScope, type RunScope } from '../src/sandbox/globals.js';
import type { SandboxDeps } from '../src/types.js';

function deps(send?: SandboxDeps['send'], onLateProcessError?: SandboxDeps['onLateProcessError']): SandboxDeps {
  return {
    config: {
      sandbox: { syncTimeoutMs: 1_000, asyncDeadlineMs: 1_000, persistentIdleGcMs: 1_000, previewMaxBytes: 2_048, logMaxBytes: 2_048 },
      kagi: { apiKey: null },
      bluesky: null,
      paths: { harnessRoot: '/tmp', dataDirectory: '/tmp' },
    },
    memory: { read: () => '', append: () => undefined, overwrite: () => undefined },
    logbuf: [],
    send,
    onLateProcessError,
  } as SandboxDeps;
}

test('real stale HTTP callback routes once while a real harness fault remains global', () => {
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sandbox-process-error-child.ts');
  const child = spawnSync(process.execPath, ['--import', 'tsx', fixture], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /"late":1/);
  assert.match(child.stdout, /"global":1/);
  assert.match(child.stdout, /"closed":true/);
});

test('run process errors route only while the owning scope trap is active', async () => {
  const seen: Array<{ kind: string; error: unknown }> = [];
  const scope: RunScope = {
    logbuf: [], childPids: new Set(), sends: [],
    processError: (kind, error) => { seen.push({ kind, error }); return true; },
  };
  const error = new Error('scoped boom');
  assert.equal(routeRunProcessError('uncaughtException', error), false);
  assert.equal(runScope.run(scope, () => routeRunProcessError('uncaughtException', error)), true);
  assert.deepEqual(seen, [{ kind: 'uncaughtException', error }]);
});

test('active asynchronous callback errors fail the run and suppress repeats from that failed scope', async () => {
  let captured: RunScope | undefined;
  const late: unknown[] = [];
  const sandbox = createSandbox(deps(async () => {
    captured = runScope.getStore();
    assert.equal(routeRunProcessError('uncaughtException', new Error('callback boom')), true);
  }, (event) => late.push(event)));
  const result = await sandbox.run(`await elpis.channel('console').send('trigger'); await new Promise(() => {})`);
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, 'runtime');
  assert.match(result.error ?? '', /asynchronous sandbox uncaughtException:.*callback boom/s);
  assert.ok(captured?.processError);
  assert.equal(captured!.processError!('uncaughtException', new Error('repeat')), true);
  assert.deepEqual(late, []);
});

test('completed run without a late reporter releases its trap to the global guard', async () => {
  let captured: RunScope | undefined;
  const sandbox = createSandbox(deps(async () => { captured = runScope.getStore(); }));
  const result = await sandbox.run(`await elpis.channel('console').send('capture'); 6`);
  assert.equal(result.ok, true);
  assert.equal(result.preview, '6');
  assert.ok(captured);
  assert.equal(captured!.processError, undefined);
});

test('completed run attributes one late callback error and suppresses repeats', async () => {
  let captured: RunScope | undefined;
  const late: Array<{ kind: string; error: unknown }> = [];
  const sandbox = createSandbox(deps(async () => { captured = runScope.getStore(); }, (event) => late.push(event)));
  const result = await sandbox.run(`await elpis.channel('console').send('capture'); 7`);
  assert.equal(result.ok, true);
  assert.equal(result.preview, '7');
  assert.ok(captured?.processError);
  const first = new Error('stale listener');
  assert.equal(captured!.processError!('uncaughtException', first), true);
  assert.equal(captured!.processError!('uncaughtException', new Error('repeat')), true);
  assert.deepEqual(late, [{ kind: 'uncaughtException', error: first }]);
});
