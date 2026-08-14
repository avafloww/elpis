// Unit tests for the background-jobs registry (A3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createBgRegistry, type BgRegistry } from '../src/sandbox/bg.js';
import { buildGlobals } from '../src/sandbox/globals.js';
import { makeConfig } from './helpers.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bg-test-'));
}

/** Wait for a job to reach a non-running state by polling the registry's live
 * exit event. Returns when the job's `running` flag flips false. We poll the
 * in-memory map (not real timers) and yield to the event loop so the child's
 * 'exit' callback fires. */
async function awaitExit(reg: BgRegistry, id: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = reg.get(id);
    if (j && !j.running) return;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`job ${id} did not exit within ${timeoutMs}ms`);
}

test('elpis.bg.start: detaches a job and writes to a log file', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { id, pid, logFile } = reg.start('echo hello-from-bg');
  assert.ok(pid > 0);
  assert.ok(fs.existsSync(logFile));
  await awaitExit(reg, id);
  const log = fs.readFileSync(logFile, 'utf8');
  assert.match(log, /hello-from-bg/);
});

test('elpis.bg.start: sleep-then-echo job, status flips to exited', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { id } = reg.start('sleep 1 && echo done');
  await awaitExit(reg, id);
  const j = reg.get(id);
  assert.ok(j);
  assert.equal(j!.running, false);
  assert.equal(j!.exitCode, 0);
});

test('elpis.bg.tail: returns the last N lines', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { id } = reg.start('printf "line1\nline2\nline3\nline4\n"');
  await awaitExit(reg, id);
 // tail(2) returns the last 2 lines of the file (split by \n), which includes
 // the trailing empty element from the final newline.
  const tail3 = reg.tail(id, 3);
  assert.match(tail3, /line3/);
  assert.match(tail3, /line4/);
});

test('elpis.bg.tail: a live future with no logFile is distinguishable from an unknown id', () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { promise } = Promise.withResolvers<number>();
  const id = reg.registerFuture('await fetch(...)', promise);
  const out = reg.tail(id);
  assert.doesNotMatch(out, /no job/, 'must not read like an unknown id');
  assert.match(out, /running/);
  assert.match(out, /no captured log/);
  reg.dispose();
});

test('elpis.bg.tail: an unknown id still reports "no job"', () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const out = reg.tail('nope');
  assert.match(out, /no job nope/);
  reg.dispose();
});

test('elpis.bg.tail: a settled future with no logFile reports settled, not running', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { promise, resolve } = Promise.withResolvers<number>();
  const id = reg.registerFuture('await fetch(...)', promise);
  resolve(42);
  await promise;
  reg.settleFuture(id, 42, false);
  const out = reg.tail(id);
  assert.match(out, /settled/);
  assert.match(out, /no captured log/);
  reg.dispose();
});

test('elpis.bg.list: shows the job with kind=job', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { id } = reg.start('sleep 1');
  const list = reg.list();
  const job = list.find((j) => j.id === id);
  assert.ok(job, 'job should appear in list');
  assert.equal(job!.kind, 'job');
  assert.equal(job!.running, true);
  await awaitExit(reg, id);
});

test('elpis.bg.cancel: kills a running job', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { id } = reg.start('sleep 30');
  const r = reg.cancel(id);
  assert.equal(r.ok, true);
 // Give the kill a moment via setImmediate yields, then check.
  for (let i = 0; i < 20; i++) {
    const j = reg.get(id);
    if (j && !j.running) break;
    await new Promise<void>((res) => setImmediate(res));
  }
  const j = reg.get(id);
  assert.ok(j);
  assert.equal(j!.running, false);
});

test('bg: registry survives store re-creation (restart durability)', async () => {
  const dir = tmpDir();
  const reg1 = createBgRegistry(dir);
  const { id } = reg1.start('sleep 2 && echo survived');
  await awaitExit(reg1, id);
 // Re-create the registry from the same dir — the settled job should still be
 // visible (loaded from registry.json).
  const reg2 = createBgRegistry(dir);
  const j = reg2.get(id);
  assert.ok(j, 'job should be visible after re-creation');
  assert.equal(j!.running, false);
  assert.equal(j!.exitCode, 0);
});

test('bg: registerFuture + settleFuture round-trip', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { promise, resolve } = Promise.withResolvers<number>();
  const id = reg.registerFuture('await fetch(...)', promise);
  const list = reg.list();
  const f = list.find((j) => j.id === id);
  assert.ok(f, 'future in list');
  assert.equal(f!.kind, 'future');
  assert.equal(f!.running, true);
 // settle it
  resolve(42);
  await promise;
  reg.settleFuture(id, 42, false);
  const settled = reg.get(id);
  assert.ok(settled);
  assert.equal(settled!.running, false);
  assert.equal(settled!.value, 42);
  assert.equal(settled!.rejected, false);
});

test('bg: reapAbandoned drops futures past TTL', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { promise } = Promise.withResolvers<number>();
 // TTL of 0 → ttlAt = startedAt; after the clock advances the future is past TTL.
  const id = reg.registerFuture('stuck', promise, { ttlMs: 0 });
 // Poll until reaped or give up — Date.now granularity may need a few cycles.
 // (This is an integration-style test exercising real TTL clock behavior.)
  let dropped: string[] = [];
  for (let i = 0; i < 50 && dropped.length === 0; i++) {
    await new Promise<void>((r) => setImmediate(r));
    dropped = reg.reapAbandoned();
  }
  assert.ok(dropped.includes(id), `expected ${id} in ${JSON.stringify(dropped)}`);
  const j = reg.get(id);
  assert.ok(j);
  assert.equal(j!.running, false);
});

test('the periodic reaper abandons TTL-expired futures and delivers a notice', async () => {
  const dir = tmpDir();
  const abandoned: Array<{ id: string; value: unknown; origin: string }> = [];
  const reg = createBgRegistry(dir, {
    reapIntervalMs: 20,
    onAbandoned: (id, value, origin) => { abandoned.push({ id, value, origin }); },
  });
  const { promise } = Promise.withResolvers<number>(); // never settles
  const id = reg.registerFuture('stuck', promise, { ttlMs: 0, originChannelId: 'c1' });
 // Wait for the interval reaper to fire (no other settle triggers the inline reap).
  await new Promise<void>((r) => setTimeout(r, 120));
  assert.equal(abandoned.length, 1, `one abandon notice, got ${abandoned.length}`);
  assert.equal(abandoned[0].id, id);
  assert.equal(abandoned[0].origin, 'c1');
  assert.equal(reg.get(id)!.running, false);
  reg.dispose();
});

test('cancel kills a future\'s adopted child processes', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const child = spawn('sleep', ['30']);
  const pid = child.pid!;
  const childPids = new Set<number>([pid]);
  const { promise } = Promise.withResolvers<never>(); // never settles
  const id = reg.registerFuture('await elpis.sh("sleep 30")', promise, { childPids });
  assert.doesNotThrow(() => process.kill(pid, 0), 'child alive before cancel');
  reg.cancel(id);
 // killTree is async (SIGTERM then SIGKILL); give it a moment.
  await new Promise<void>((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), 'child should be dead after cancel');
  reg.dispose();
});

test('a cancelled future ignores a later settle (no overwrite, no notice)', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir);
  const { promise } = Promise.withResolvers<string>();
  const id = reg.registerFuture('stuck', promise, { ttlMs: 60_000 });
  reg.cancel(id);
 // A late settlement of the (uncancellable) promise must be ignored.
  const delivered = reg.settleFuture(id, 'late-value', false);
  assert.equal(delivered, false, 'settleFuture returns false for a cancelled future');
  assert.notEqual(reg.get(id)!.value, 'late-value', 'cancelled record not overwritten');
  reg.dispose();
});

test('bg jobs: durable still-running heartbeats then one completion notice', async () => {
  const dir = tmpDir();
  const nudges: Array<{ job: any; tail: string }> = [];
  const settled: Array<{ job: any; tail: string }> = [];
  const reg = createBgRegistry(dir, {
    jobNudgeMs: 25,
    onJobStillRunning: (job, tail) => nudges.push({ job, tail }),
    onJobSettled: (job, tail) => settled.push({ job, tail }),
  });
  reg.activate();
  const { id } = reg.start('echo began; sleep 0.12; echo finished', { originChannelId: 'home-channel' });
  await new Promise<void>((r) => setTimeout(r, 70));
  assert.ok(nudges.length >= 1);
  assert.equal(nudges[0].job.id, id);
  assert.equal(nudges[0].job.originChannelId, 'home-channel');
  assert.match(nudges[0].tail, /began/);
  await awaitExit(reg, id);
  await new Promise<void>((r) => setTimeout(r, 20));
  assert.equal(settled.length, 1);
  assert.equal(settled[0].job.exitCode, 0);
  assert.match(settled[0].tail, /finished/);
  assert.ok(reg.get(id)!.nudgeNotifiedAt);
  assert.ok(reg.get(id)!.settleNotifiedAt);
  const nudgesAtFinish = nudges.length;
  reg.activate();
  await new Promise<void>((r) => setTimeout(r, 30));
  assert.equal(nudges.length, nudgesAtFinish, 'completion cancels all rearmed heartbeat timers');
  assert.equal(settled.length, 1, 'activate does not duplicate completion');
  reg.dispose();
});

test('bg jobs: a fast completion wakes once without a stale five-minute nudge', async () => {
  const dir = tmpDir();
  const nudges: string[] = [];
  const settled: string[] = [];
  const reg = createBgRegistry(dir, {
    jobNudgeMs: 200,
    onJobStillRunning: (job) => nudges.push(job.id),
    onJobSettled: (job) => settled.push(job.id),
  });
  reg.activate();
  const { id } = reg.start('echo quick');
  await awaitExit(reg, id);
  await new Promise<void>((r) => setTimeout(r, 250));
  assert.deepEqual(settled, [id]);
  assert.deepEqual(nudges, []);
  reg.dispose();
});

test('bg jobs: restart recovery reports newly-dead work and grandfathers old completed records', () => {
  const dir = tmpDir();
  const bgDir = path.join(dir, 'bg');
  fs.mkdirSync(bgDir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(bgDir, 'registry.json'), JSON.stringify([
    { id: 'old', kind: 'job', cmd: 'old', pid: 999998, startedAt: now - 10_000, running: false, exitCode: 0 },
    { id: 'died', kind: 'job', cmd: 'died', pid: 999999, startedAt: now - 5_000, running: true },
  ]));
  const settled: string[] = [];
  const reg = createBgRegistry(dir, { jobNudgeMs: 10, onJobSettled: (job) => settled.push(job.id) });
  assert.deepEqual(settled, [], 'delivery waits until Agent-side activation');
  reg.activate();
  assert.deepEqual(settled, ['died']);
  reg.activate();
  assert.deepEqual(settled, ['died']);
  reg.dispose();
  const afterRestart: string[] = [];
  const reg2 = createBgRegistry(dir, { onJobSettled: (job) => afterRestart.push(job.id) });
  reg2.activate();
  assert.deepEqual(afterRestart, [], 'persisted notice state suppresses reboot duplicates');
  reg2.dispose();
});

test('bg jobs: still-running heartbeats auto-rearm until completion', async () => {
  const dir = tmpDir();
  const nudges: number[] = [];
  const reg = createBgRegistry(dir, { jobNudgeMs: 25, onJobStillRunning: () => nudges.push(Date.now()) });
  reg.activate();
  const { id } = reg.start('sleep 0.14');
  await new Promise<void>((r) => setTimeout(r, 105));
  assert.ok(nudges.length >= 2, `expected repeated auto-rearmed heartbeats, got ${nudges.length}`);
  await awaitExit(reg, id);
  const atFinish = nudges.length;
  await new Promise<void>((r) => setTimeout(r, 60));
  assert.equal(nudges.length, atFinish, 'completion cancels the heartbeat timer');
  reg.dispose();
});

test('bg.rearm moves the next heartbeat without disabling automatic rearm', async () => {
  const dir = tmpDir();
  const nudges: number[] = [];
  const reg = createBgRegistry(dir, { jobNudgeMs: 500, onJobStillRunning: () => nudges.push(Date.now()) });
  reg.activate();
  const { id } = reg.start('sleep 0.14');
  const moved = reg.rearm(id, Date.now() + 20);
  assert.ok(moved.nudgeAt! <= Date.now() + 30);
  await new Promise<void>((r) => setTimeout(r, 70));
  assert.equal(nudges.length, 1);
  assert.ok(reg.get(id)!.nudgeAt! > reg.get(id)!.nudgeNotifiedAt!, 'manual check returns to automatic interval');
  await awaitExit(reg, id);
  reg.dispose();
});

test('elpis.bg wrapper captures inbound origin and coerces manual rearm timestamps', async () => {
  const dir = tmpDir();
  const reg = createBgRegistry(dir, { jobNudgeMs: 10_000 });
  const globals = buildGlobals({
    config: makeConfig(), logbuf: [], bg: reg,
    inbound: { channelId: 'origin-room' },
  } as any) as any;
  reg.activate();
  const started = globals.elpis.bg.start('sleep 1');
  assert.equal(reg.get(started.id)!.originChannelId, 'origin-room');
  const at = Date.now() + 20_000;
  const moved = globals.elpis.bg.rearm(started.id, new Date(at));
  assert.equal(moved.nudgeAt, at);
  globals.elpis.bg.cancel(started.id);
  reg.dispose();
});

test('bg.rearm safely chunks dates beyond Node timer maximum', async () => {
  const dir = tmpDir();
  const nudges: number[] = [];
  const reg = createBgRegistry(dir, { jobNudgeMs: 20, onJobStillRunning: () => nudges.push(Date.now()) });
  reg.activate();
  const { id } = reg.start('sleep 0.15');
  const yearOut = Date.now() + 365 * 24 * 60 * 60 * 1000;
  reg.rearm(id, yearOut);
  await new Promise<void>((r) => setTimeout(r, 80));
  assert.deepEqual(nudges, [], 'a >32-bit delay must not overflow into an immediate heartbeat');
  assert.equal(reg.get(id)!.nudgeAt, yearOut);
  await awaitExit(reg, id);
  reg.dispose();
});

// ─── A5 settle delivery: detached future notifies the originating context ────

import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { buildTestAgent } from './helpers.js';

const EMPTY_END: CompleteResult = {
  message: { role: 'assistant', content: '' }, stripped: false,
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

function scriptedLLM(responses: CompleteResult[]): LLM & { onCall: ((n: number) => void) | null } {
  let i = 0;
  let calls = 0;
  let hook: ((n: number) => void) | null = null;
  return {
    client: {} as unknown as LLM['client'], model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    get onCall() { return hook; },
    set onCall(fn) { hook = fn; },
    complete(): Promise<CompleteResult> {
      calls++;
      const n = calls;
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      queueMicrotask(() => hook?.(n));
      return Promise.resolve(r);
    },
    summarize: () => Promise.resolve('SUMMARY'),
  } as LLM & { onCall: ((n: number) => void) | null };
}

test('A5: notifyFutureSettled enqueues [bg <id> settled] into the one history', () => {
  const { agent } = buildTestAgent({
    llm: scriptedLLM([EMPTY_END]),
    config: { sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 100, previewMaxBytes: 2048, logMaxBytes: 2048 }, heartbeat: { intervalMs: 0, maxIntervalMs: 0, reflectionMinMessages: 99, socialNudgeMs: 12 * 60 * 60 * 1000 } },
    tmpPrefix: 'harness-a5-',
  });

 // V1: settle delivery is unconditional (one history — no origin routing).
  agent.notifyFutureSettled('f1', { result: 'done' }, false);
  assert.ok(agent.inboundQueueLengthForTest > 0, 'a settle notice was queued');
  agent.stop();
});

test('A5: notifyFutureSettled renders post-detach sends into the notice', () => {
  const { agent } = buildTestAgent({
    llm: scriptedLLM([EMPTY_END]),
    config: { sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 100, previewMaxBytes: 2048, logMaxBytes: 2048 }, heartbeat: { intervalMs: 0, maxIntervalMs: 0, reflectionMinMessages: 99, socialNudgeMs: 12 * 60 * 60 * 1000 } },
    tmpPrefix: 'harness-a5-sends-',
  });
  agent.notifyFutureSettled('f1', 'x', false, { sends: [{ channel: 'c', text: 'late msg' }] });
  assert.ok(agent.inboundQueueLengthForTest > 0);
  agent.stop();
});
