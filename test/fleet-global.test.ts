// test/fleet-global.test.ts — tests for the elpis.fleet.* sandbox global
//. buildGlobals directly, like test/sandbox-state.test.ts, with a
// stub deps.fleet recording calls. elpis.fleet is always attached (scheduler-
// global idiom): each verb checks deps.fleet itself and throws 'fleet not
// wired' rather than leaving `elpis.fleet` undefined.
//
// The send-contract test below exercises the REAL
// src/fleet/index.ts registry instead of the stub — the dead-and-unrevivable
// path it pins (no live runner AND no saved sdk_session_id) lives in
// createFleet's send, not in the sandbox-global wrapper, so a stub can't
// reach it. Fixture mirrors test/fleet-readonly.test.ts's style: a REAL
// detached fake-fleet-runner.mjs over a real control socket + real
// events.jsonl + real agent.db, all under os.tmpdir. No SDK, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGlobals } from '../src/sandbox/globals.js';
import { SDK_EFFORT_LEVELS } from '../src/config.js';
import { openDatabase, type Database } from '../src/store/db.js';
import { noopLogger } from '../src/lib/log.js';
import { createFleet, type FleetHandle, type FleetOpts } from '../src/fleet/index.js';

const RUNNER = fileURLToPath(new URL('./fixtures/fake-fleet-runner.mjs', import.meta.url));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, ms = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await delay(15);
  }
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const NO_ALIASES = (): FleetOpts['fleet']['models'] => ({
  opus: { name: null, context: null },
  sonnet: { name: null, context: null },
  haiku: { name: null, context: null },
  fable: { name: null, context: null },
});

interface RegistryHarness {
  fleet: FleetHandle;
  db: Database;
  dataDir: string;
}

function registryHarness(t: { after: (fn: () => void) => void }): RegistryHarness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-global-'));
  const db = openDatabase(dataDir);
  const fleetConfig: FleetOpts['fleet'] = {
    enabled: true, maxConcurrent: 4, defaultModel: 'opus', defaultEffort: 'high',
    efforts: [...SDK_EFFORT_LEVELS],
    endpoint: { baseUrl: null, apiKey: null, authToken: null },
    models: NO_ALIASES(),
    idleTimeoutMs: 0, reapAfterMs: 14 * 86_400_000, env: {},
  };
  const fleet = createFleet({
    db, dataDirectory: dataDir, harnessRoot: dataDir, fleet: fleetConfig,
    logger: noopLogger, notify: () => {},
    runnerPath: RUNNER, nodePath: process.execPath,
  });
  t.after(() => {
    try { fleet.dispose(); } catch { /* ignore */ }
    for (const row of fleet.list()) {
      const pid = row.pid as number | null;
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return { fleet, db, dataDir };
}

function sessionRow(db: Database, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM fleet_sessions WHERE id = ?').get(id) as Record<string, unknown>;
}

const baseConfig = {
  paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
  sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 },
  kagi: { apiKey: null },
};

function makeStubFleet() {
  const calls: { verb: string; args: unknown[] }[] = [];
  const stub = {
    run: (...args: unknown[]) => { calls.push({ verb: 'run', args }); return Promise.resolve({ id: 'f1', name: 'sess', cwd: '/tmp', model: 'haiku' }); },
    send: (...args: unknown[]) => { calls.push({ verb: 'send', args }); return Promise.resolve({ ok: true, note: 'sent' }); },
    interrupt: (...args: unknown[]) => { calls.push({ verb: 'interrupt', args }); return Promise.resolve({ ok: true, note: 'interrupted' }); },
    list: (...args: unknown[]) => { calls.push({ verb: 'list', args }); return []; },
    status: (...args: unknown[]) => { calls.push({ verb: 'status', args }); return { state: 'idle' }; },
    tail: (...args: unknown[]) => { calls.push({ verb: 'tail', args }); return 'recent activity'; },
    diff: (...args: unknown[]) => { calls.push({ verb: 'diff', args }); return Promise.resolve({ ok: true, session: 'sess', worktrees: [] }); },
    dismiss: (...args: unknown[]) => { calls.push({ verb: 'dismiss', args }); return Promise.resolve({ ok: true, note: 'dismissed' }); },
  };
  return { stub, calls };
}

test('elpis.fleet.run forwards prompt + opts to deps.fleet.run', async () => {
  const { stub, calls } = makeStubFleet();
  const g = buildGlobals({ config: baseConfig, fleet: stub as never } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  const result = await elpis.fleet.run('x', { model: 'haiku' });
  assert.deepEqual(result, { id: 'f1', name: 'sess', cwd: '/tmp', model: 'haiku' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { verb: 'run', args: ['x', { model: 'haiku' }] });
});

test('elpis.fleet.send/interrupt/list/status/tail/diff/dismiss forward to deps.fleet', async () => {
  const { stub, calls } = makeStubFleet();
  const g = buildGlobals({ config: baseConfig, fleet: stub as never } as never);
  const elpis = g.elpis as {
    fleet: {
      send: (ref: string, text: string) => Promise<unknown>;
      interrupt: (ref: string) => Promise<unknown>;
      list: () => unknown;
      status: (ref: string) => unknown;
      tail: (ref: string, n?: number) => unknown;
      diff: (ref: string, opts?: unknown) => Promise<unknown>;
      dismiss: (ref: string, opts?: unknown) => Promise<unknown>;
    };
  };
  await elpis.fleet.send('f1', 'go on');
  await elpis.fleet.interrupt('f1');
  elpis.fleet.list();
  elpis.fleet.status('f1');
  elpis.fleet.tail('f1', 10);
  await elpis.fleet.diff('f1', { worktree: 'w1' });
  await elpis.fleet.dismiss('f1', { force: true });
  assert.deepEqual(calls.map((c) => c.verb), ['send', 'interrupt', 'list', 'status', 'tail', 'diff', 'dismiss']);
 // send forwards its optional { readOnly } opts through to deps.fleet — a bare
 // two-arg call lands as a third `undefined` (the default opts object).
  assert.deepEqual(calls[0].args, ['f1', 'go on', undefined]);
  assert.deepEqual(calls[4].args, ['f1', 10]);
  assert.deepEqual(calls[5].args, ['f1', { worktree: 'w1' }]);
  assert.deepEqual(calls[6].args, ['f1', { force: true }]);
});

test('elpis.fleet.run without deps.fleet throws "not wired"', async () => {
  const g = buildGlobals({ config: baseConfig } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  await assert.rejects(() => elpis.fleet.run('x'), /not wired/);
});

test('elpis.fleet.status/list/tail/dismiss without deps.fleet also throw "not wired"', () => {
  const g = buildGlobals({ config: baseConfig } as never);
  const elpis = g.elpis as {
    fleet: {
      list: () => unknown;
      status: (ref: string) => unknown;
      tail: (ref: string, n?: number) => unknown;
    };
  };
  assert.throws(() => elpis.fleet.list(), /not wired/);
  assert.throws(() => elpis.fleet.status('f1'), /not wired/);
  assert.throws(() => elpis.fleet.tail('f1'), /not wired/);
});

test('fleet.enabled: false in config yields a disabled-by-config error, not "not wired"', async () => {
  const config = { ...baseConfig, fleet: { efforts: [...SDK_EFFORT_LEVELS], enabled: false } };
  const g = buildGlobals({ config } as never);
  const elpis = g.elpis as {
    fleet: { run: (p: string, o?: unknown) => Promise<unknown>; list: () => unknown };
  };
  await assert.rejects(() => elpis.fleet.run('x'), /unavailable.*fleet.enabled: false/);
  await assert.rejects(() => Promise.resolve(elpis.fleet.list()), /unavailable.*fleet.enabled: false/);
});

test('an off-list effort is rejected by the GLOBAL before deps.fleet is called', async () => {
  const { stub, calls } = makeStubFleet();
  const g = buildGlobals({ config: baseConfig, fleet: stub as never } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  await assert.rejects(() => elpis.fleet.run('x', { effort: 'colossal' }), /low\|medium\|high\|xhigh\|max/);
  assert.equal(calls.length, 0, 'deps.fleet.run must not be reached when the effort guard rejects');
});

test('an off-list effort is rejected even without deps.fleet (global guard runs first)', async () => {
  const g = buildGlobals({ config: baseConfig } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  await assert.rejects(() => elpis.fleet.run('x', { effort: 'colossal' }), /low\|medium\|high\|xhigh\|max/);
});

test('with no fleet config the guard falls back to the SDK effort levels', async () => {
  const { stub, calls } = makeStubFleet();
  const g = buildGlobals({ config: baseConfig, fleet: stub as never } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  for (const e of SDK_EFFORT_LEVELS) await elpis.fleet.run('x', { effort: e });
  assert.equal(calls.length, SDK_EFFORT_LEVELS.length);
});

test('the guard honors a NARROWED fleet.efforts — an SDK level the endpoint lacks is rejected', async () => {
  const { stub, calls } = makeStubFleet();
  const config = { ...baseConfig, fleet: { efforts: ['low', 'high'] } };
  const g = buildGlobals({ config, fleet: stub as never } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  await elpis.fleet.run('x', { effort: 'high' });
  await assert.rejects(() => elpis.fleet.run('x', { effort: 'xhigh' }), /effort must be low\|high/);
  assert.equal(calls.length, 1);
});

test('the guard honors a RENAMED level set from a custom endpoint', async () => {
  const { stub, calls } = makeStubFleet();
  const config = { ...baseConfig, fleet: { efforts: ['fast', 'deep'] } };
  const g = buildGlobals({ config, fleet: stub as never } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  await elpis.fleet.run('x', { effort: 'deep' });
  await assert.rejects(() => elpis.fleet.run('x', { effort: 'high' }), /effort must be fast\|deep/);
  assert.equal(calls.length, 1);
});

test('fleet.efforts: [] means the endpoint takes no effort parameter — any value is rejected', async () => {
  const { stub, calls } = makeStubFleet();
  const config = { ...baseConfig, fleet: { efforts: [] as string[] } };
  const g = buildGlobals({ config, fleet: stub as never } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  await assert.rejects(() => elpis.fleet.run('x', { effort: 'high' }), /takes no effort parameter/);
 // ...but omitting effort entirely still works — the registry sends none.
  await elpis.fleet.run('x');
  assert.equal(calls.length, 1);
});

test('effort: null passes the guard (an explicit "send no effort")', async () => {
  const { stub, calls } = makeStubFleet();
  const g = buildGlobals({ config: baseConfig, fleet: stub as never } as never);
  const elpis = g.elpis as { fleet: { run: (p: string, o?: unknown) => Promise<unknown> } };
  await elpis.fleet.run('x', { effort: null });
  assert.equal(calls.length, 1);
});

test('fleet.send throws on the no-live-runner-AND-no-saved-SDK-session path (retro 16)', async (t) => {
  const h = registryHarness(t);
  const res = await h.fleet.run('go', { name: 'dead-session' });
 // Kill the runner before it ever finishes a turn, so sdk_session_id is
 // never persisted — this is the dead-and-unrevivable path: no live pid,
 // and nothing to resume from either.
  const pid = sessionRow(h.db, res.id).runner_pid as number;
  process.kill(pid, 'SIGKILL');
  await waitUntil(() => !pidAlive(pid));
  await delay(50);
  assert.equal(sessionRow(h.db, res.id).sdk_session_id, null, 'no SDK session was ever saved');

  await assert.rejects(
    () => h.fleet.send('dead-session', 'hi'),
    /no saved SDK session and no live runner/,
  );
});
