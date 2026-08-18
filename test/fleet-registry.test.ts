// Unit tests for src/fleet/index.ts — the harness-side fleet registry. Drives a
// REAL detached child (test/fixtures/fake-fleet-runner.mjs) over a real control
// socket + real events.jsonl and a real agent.db, all under os.tmpdir. No SDK,
// no network. Real throwaway git repos back the dismiss-gate tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { openDatabase, type Database } from '../src/store/db.js';
import { noopLogger } from '../src/lib/log.js';
import { SDK_EFFORT_LEVELS } from '../src/config.js';
import { createFleet, type FleetHandle, type FleetOpts } from '../src/fleet/index.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

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

/** A fully-unconfigured `fleet.models` block (every alias left to the SDK).
 * Fresh object per call — `over` in harness may replace individual slots. */
const NO_ALIASES = (): FleetOpts['fleet']['models'] => ({
  opus: { name: null, context: null },
  sonnet: { name: null, context: null },
  haiku: { name: null, context: null },
  fable: { name: null, context: null },
});

interface Harness {
  fleet: FleetHandle;
  db: Database;
  dataDir: string;
  notices: string[];
  fleetConfig: FleetOpts['fleet'];
}

function harness(t: { after: (fn: () => void) => void }, over: Partial<FleetOpts['fleet']> = {}, env: Record<string, string> = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reg-'));
  const db = openDatabase(dataDir);
  const notices: string[] = [];
  const fleetConfig: FleetOpts['fleet'] = {
    enabled: true, maxConcurrent: 4, defaultModel: 'opus', defaultEffort: 'high',
    efforts: [...SDK_EFFORT_LEVELS],
    endpoint: { baseUrl: null, apiKey: null, authToken: null },
    models: NO_ALIASES(),
    idleTimeoutMs: 0, reapAfterMs: 14 * 86_400_000, env, ...over,
  };
  const fleet = createFleet({
    db, dataDirectory: dataDir, harnessRoot: dataDir, fleet: fleetConfig,
    logger: noopLogger, notify: (t2) => notices.push(t2),
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
  return { fleet, db, dataDir, notices, fleetConfig };
}

function sessionRow(db: Database, id: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM fleet_sessions WHERE id = ?').get(id) as Record<string, unknown>;
}

// ---- git repo fixture (dismiss gate) --------------------------------------
function gitRepoWithDirtyWorktree(t: { after: (fn: () => void) => void }): { repoDir: string; wtDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-reg-git-'));
  const repoDir = path.join(root, 'repo');
  const wtDir = path.join(root, 'wt');
  fs.mkdirSync(repoDir);
  const g = (args: string[], cwd = repoDir) => execFileSync('git', args, { cwd });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'a@test.com']);
  g(['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'hello\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'init']);
  const head = g(['rev-parse', 'HEAD']).toString().trim();
  g(['worktree', 'add', '-q', '-b', 'feature', wtDir, head]);
  fs.writeFileSync(path.join(wtDir, 'dirty.txt'), 'uncommitted\n'); // makes wt dirty
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });
  return { repoDir, wtDir };
}

// ===========================================================================

test('run: creates row+dir+config, handshakes hello, returns name/id', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('do a thing', { name: 'my-agent' });
  assert.equal(res.name, 'my-agent');
  assert.match(res.id, /^f-[0-9a-z]{6}$/);
  assert.equal(res.model, 'opus');

  const sessionDir = path.join(resolveDataLayout(h.dataDir).fleet, res.id);
  assert.ok(fs.existsSync(path.join(sessionDir, 'runner-config.json')));
  const cfg = JSON.parse(fs.readFileSync(path.join(sessionDir, 'runner-config.json'), 'utf8'));
  assert.equal(cfg.prompt, 'do a thing');
  assert.equal(cfg.model, 'opus');
  assert.equal(cfg.resume, null);

  const row = sessionRow(h.db, res.id);
  assert.equal(row.status, 'running');
  assert.ok(pidAlive(row.runner_pid as number));
});

test('run: the configured endpoint + aliases land in runner-config.json, 0600', async (t) => {
  const h = harness(t, {
    endpoint: { baseUrl: 'https://api.example.com', apiKey: 'sk-fleet', authToken: null },
    models: { ...NO_ALIASES(), opus: { name: 'big-1', context: 262144 } },
  });
  const res = await h.fleet.run('go', { name: 'wired' });
  const cfgPath = path.join(resolveDataLayout(h.dataDir).fleet, res.id, 'runner-config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
 // Only alias NAMES travel on the wire; `context` is resolved per-session.
  assert.deepEqual(cfg.endpoint, {
    baseUrl: 'https://api.example.com', apiKey: 'sk-fleet', authToken: null,
    models: { opus: 'big-1', sonnet: null, haiku: null, fable: null },
  });
 // It can carry a credential, so it must not be world-readable.
  assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600);
});

// ---- context window resolution --------------------------------------------

test('an explicit alias context is used verbatim and SKIPS the models/info probe', async (t) => {
 // No fetch stub: a probe would reject against this unreachable host, so the
 // pinned value proving through is itself the evidence the probe was skipped.
  const h = harness(t, {
    endpoint: { baseUrl: 'http://127.0.0.1:1/never', apiKey: 'sk', authToken: null },
    models: { ...NO_ALIASES(), opus: { name: 'big-1', context: 262144 } },
  });
  const res = await h.fleet.run('go', { name: 'pinned' });
  const cfg = JSON.parse(fs.readFileSync(path.join(resolveDataLayout(h.dataDir).fleet, res.id, 'runner-config.json'), 'utf8'));
  assert.equal(cfg.contextTokens, 262144);
});

test('a context pinned by alias KEY applies when the session names the raw model id', async (t) => {
  const h = harness(t, {
    endpoint: { baseUrl: 'http://127.0.0.1:1/never', apiKey: 'sk', authToken: null },
    models: { ...NO_ALIASES(), opus: { name: 'big-1', context: 999 } },
  });
  const res = await h.fleet.run('go', { name: 'byname', model: 'big-1' });
  const cfg = JSON.parse(fs.readFileSync(path.join(resolveDataLayout(h.dataDir).fleet, res.id, 'runner-config.json'), 'utf8'));
  assert.equal(cfg.contextTokens, 999, 'matched the alias by its configured target name');
});

test('no custom endpoint → no probe, no CLAUDE_CODE_MAX_CONTEXT_TOKENS', async (t) => {
  const h = harness(t); // endpoint entirely unset
  const res = await h.fleet.run('go', { name: 'stock' });
  const cfg = JSON.parse(fs.readFileSync(path.join(resolveDataLayout(h.dataDir).fleet, res.id, 'runner-config.json'), 'utf8'));
  assert.equal(cfg.contextTokens, null);
});

test('a failing models/info probe degrades to null — it never fails the spawn', async (t) => {
  const h = harness(t, {
 // Unroutable port: the probe rejects fast, and run must still succeed.
    endpoint: { baseUrl: 'http://127.0.0.1:1/never', apiKey: 'sk', authToken: null },
    models: { ...NO_ALIASES(), opus: { name: 'big-1', context: null } },
  });
  const res = await h.fleet.run('go', { name: 'degraded' });
  const cfg = JSON.parse(fs.readFileSync(path.join(resolveDataLayout(h.dataDir).fleet, res.id, 'runner-config.json'), 'utf8'));
  assert.equal(cfg.contextTokens, null);
  assert.equal(sessionRow(h.db, res.id).status, 'running', 'the session still started');
});

test('models/info is probed once per model and the answer is reused', async (t) => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ 'big-1': { capabilities: { context_window: 131072 } } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });

  const h = harness(t, {
    endpoint: { baseUrl: 'https://api.example.com', apiKey: 'sk-fleet', authToken: null },
    models: { ...NO_ALIASES(), opus: { name: 'big-1', context: null } },
  });
  const a = await h.fleet.run('go', { name: 'probe-a' });
  const b = await h.fleet.run('go', { name: 'probe-b' });
  const read = (id: string) =>
    JSON.parse(fs.readFileSync(path.join(resolveDataLayout(h.dataDir).fleet, id, 'runner-config.json'), 'utf8'));
  assert.equal(read(a.id).contextTokens, 131072);
  assert.equal(read(b.id).contextTokens, 131072, 'second spawn reuses the memoized answer');
 // base_url is the API ROOT (what ANTHROPIC_BASE_URL wants); the probe adds
 // the version segment back, because models/info sits beside messages.
  assert.deepEqual(calls, ['https://api.example.com/v1/models/info'], 'probed exactly once');
});

test('run: an off-list effort is rejected against the configured level set', async (t) => {
  const h = harness(t, { efforts: ['fast', 'deep'], defaultEffort: 'fast' });
  await assert.rejects(() => h.fleet.run('x', { effort: 'high' }), /effort must be fast\|deep/);
  const res = await h.fleet.run('x', { effort: 'deep', name: 'deep-one' });
  assert.equal(sessionRow(h.db, res.id).effort, 'deep');
});

test('run: null model/effort persist as "" and read back as null on revive', async (t) => {
  const h = harness(t, { defaultModel: null, defaultEffort: null });
  const res = await h.fleet.run('go', { name: 'bare' });
  assert.equal(res.model, null);
  const row = sessionRow(h.db, res.id);
  assert.equal(row.model, '');
  assert.equal(row.effort, '');
  const cfg = JSON.parse(fs.readFileSync(path.join(resolveDataLayout(h.dataDir).fleet, res.id, 'runner-config.json'), 'utf8'));
  assert.equal(cfg.model, null);
  assert.equal(cfg.effort, null);
});

test('run: rejects a bad explicit name', async (t) => {
  const h = harness(t);
  await assert.rejects(() => h.fleet.run('x', { name: 'f-nope' }));
});

test('run: refuses when live sessions >= maxConcurrent', async (t) => {
  const h = harness(t, { maxConcurrent: 1 });
  await h.fleet.run('first', { name: 'one' });
  await assert.rejects(() => h.fleet.run('second', { name: 'two' }), /concurren|one/i);
 // the refused session left no row.
  const rows = h.fleet.list();
  assert.equal(rows.length, 1);
});

test('turn-end frame notifies and advances delivered_seq', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('go', { name: 'runner-a' });
  const send = await h.fleet.send('runner-a', 'ping');
  assert.equal(send.ok, true);
  await waitUntil(() => h.notices.some((n) => n.includes('[fleet runner-a finished turn]')));
  await waitUntil(() => (sessionRow(h.db, res.id).delivered_seq as number) > 0);
  const notice = h.notices.find((n) => n.includes('finished turn'))!;
  assert.match(notice, /echo: ping/);
  assert.match(notice, /tokens/);
  assert.match(notice, /\$0\.0123/);
});

test('mailbox frame notifies with the says-notice', async (t) => {
  const h = harness(t, {}, {});
  process.env.FAKE_SCRIPT = JSON.stringify([{ ev: 'mailbox', text: 'need a decision' }]);
  try {
    await h.fleet.run('go', { name: 'chatty' });
    await waitUntil(() => h.notices.some((n) => n.includes('[fleet chatty says] need a decision')));
  } finally {
    delete process.env.FAKE_SCRIPT;
  }
});

test('send: revives a dead session, rewriting config with resume+prompt', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('initial', { name: 'reviveme' });
  await h.fleet.send('reviveme', 'first');
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')));
 // capture the sdk session id the runner reported, then kill it.
  await waitUntil(() => sessionRow(h.db, res.id).sdk_session_id != null);
  const sdkId = sessionRow(h.db, res.id).sdk_session_id as string;
  const pid = sessionRow(h.db, res.id).runner_pid as number;
  process.kill(pid, 'SIGKILL');
  await waitUntil(() => !pidAlive(pid));
  await delay(50); // let the socket-close handler run

  const revived = await h.fleet.send('reviveme', 'second message');
  assert.equal(revived.ok, true);
  const cfg = JSON.parse(fs.readFileSync(path.join(resolveDataLayout(h.dataDir).fleet, res.id, 'runner-config.json'), 'utf8'));
  assert.equal(cfg.resume, sdkId);
  assert.equal(cfg.prompt, 'second message');
});

test('send: refuses a dismissed session', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('go', { name: 'gone' });
  await h.fleet.dismiss('gone');
  assert.equal((sessionRow(h.db, res.id).status as string), 'dismissed');
  const r = await h.fleet.send('gone', 'hi');
  assert.equal(r.ok, false);
});

test('dismiss gate: dirty worktree refuses without force, then force removes it', async (t) => {
  const h = harness(t);
  const { repoDir, wtDir } = gitRepoWithDirtyWorktree(t);
  const id = 'f-manual';
  const now = Date.now();
  h.db.prepare(
    `INSERT INTO fleet_sessions (id, name, cwd, status, model, effort, created_at, updated_at)
     VALUES (?, ?, ?, 'idle', 'opus', 'high', ?, ?)`,
  ).run(id, 'dirty-sess', repoDir, now, now);
  h.db.prepare(
    `INSERT INTO fleet_worktrees (session_id, name, path, created_at) VALUES (?, ?, ?, ?)`,
  ).run(id, 'feature', wtDir, now);

  const refused = await h.fleet.dismiss('dirty-sess');
  assert.equal(refused.ok, false);
  assert.ok(Array.isArray(refused.stranded));
  assert.equal((sessionRow(h.db, id).status as string), 'idle'); // stays
  assert.ok(fs.existsSync(wtDir));

  const forced = await h.fleet.dismiss('dirty-sess', { force: true });
  assert.equal(forced.ok, true);
  assert.equal((sessionRow(h.db, id).status as string), 'dismissed');
  assert.ok(!fs.existsSync(wtDir));
});

test('recover: dead runner with an undelivered turn-end → notice + died-notice, status failed', async (t) => {
  const h = harness(t);
  const id = 'f-dead01';
  const sessionDir = path.join(resolveDataLayout(h.dataDir).fleet, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const events = [
    { ev: 'state', seq: 1, state: 'running' },
    { ev: 'turn-end', seq: 2, result: 'did work', isError: false, usage: { input: 5, output: 7 }, costUsd: 0.5, turns: 2, sdkSessionId: 'sdk-9' },
  ];
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const now = Date.now();
  h.db.prepare(
    `INSERT INTO fleet_sessions (id, name, cwd, status, model, effort, runner_pid, delivered_seq, created_at, updated_at)
     VALUES (?, ?, ?, 'running', 'opus', 'high', ?, 0, ?, ?)`,
  ).run(id, 'ghost', h.dataDir, 999999, now, now); // 999999 = a dead pid

  h.fleet.recover();
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')) && h.notices.some((n) => n.includes('runner died')));
  assert.equal((sessionRow(h.db, id).status as string), 'failed');
  assert.equal((sessionRow(h.db, id).delivered_seq as number), 2);
});

test('recover: dead runner with a clean exited tail → status idle, no died-notice', async (t) => {
  const h = harness(t);
  const id = 'f-clean1';
  const sessionDir = path.join(resolveDataLayout(h.dataDir).fleet, id);
  fs.mkdirSync(sessionDir, { recursive: true });
  const events = [
    { ev: 'turn-end', seq: 1, result: 'done', isError: false, usage: { input: 1, output: 1 }, costUsd: 0.1, turns: 1, sdkSessionId: 'sdk-1' },
    { ev: 'state', seq: 2, state: 'idle' },
    { ev: 'state', seq: 3, state: 'exited' },
  ];
  fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const now = Date.now();
  h.db.prepare(
    `INSERT INTO fleet_sessions (id, name, cwd, status, model, effort, runner_pid, delivered_seq, created_at, updated_at)
     VALUES (?, ?, ?, 'idle', 'opus', 'high', ?, 3, ?, ?)`,
  ).run(id, 'tidy', h.dataDir, 999999, now, now);

  h.fleet.recover();
  await delay(100);
  assert.equal((sessionRow(h.db, id).status as string), 'idle');
  assert.equal(sessionRow(h.db, id).runner_pid, null);
  assert.ok(!h.notices.some((n) => n.includes('runner died')));
});

test('list/status/tail: thin readers over the DB + events.jsonl', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('go', { name: 'readable' });
  await h.fleet.send('readable', 'ping');
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')));

  const list = h.fleet.list();
  assert.ok(list.some((r) => r.name === 'readable'));
  const st = h.fleet.status('readable');
  assert.equal(st.id, res.id);
  const tail = h.fleet.tail('readable', 20);
  assert.match(tail, /turn-end/);
});

test('send: a dropped conn to a LIVE runner reconnects — no duplicate spawn', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('go', { name: 'blippy' });
  const pid = sessionRow(h.db, res.id).runner_pid as number;
  assert.ok(pidAlive(pid));

 // Blip the control socket: the fixture drops the client but stays alive.
  await h.fleet.send('blippy', '__BLIP__');
 // Let the registry observe the close (onUnexpectedClose drops the conn but,
 // because the pid is still alive, must NOT mark the session dead/failed).
  await delay(150);
  assert.ok(pidAlive(pid), 'runner process still alive after a socket blip');
  assert.equal(sessionRow(h.db, res.id).status, 'running');
  assert.ok(!h.notices.some((n) => n.includes('runner died')), 'a blip must not surface a died-notice');

 // The next send has no held conn but a live pid → reconnect, NOT revive.
  const again = await h.fleet.send('blippy', 'after blip');
  assert.equal(again.ok, true);
  await waitUntil(() => h.notices.some((n) => n.includes('echo: after blip')));
 // The proof of "reconnect, not duplicate spawn": the pid is unchanged. A
 // revive would have spawned a new runner and rewritten runner_pid.
  assert.equal(sessionRow(h.db, res.id).runner_pid, pid, 'no second spawn — same runner_pid');
});

test('recover: an alive runner with a stale delivered_seq replays the missed turn-end', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('go', { name: 'replayme' });
  await h.fleet.send('replayme', 'work');
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')));
  const pid = sessionRow(h.db, res.id).runner_pid as number;
  const turnSeq = sessionRow(h.db, res.id).delivered_seq as number;
  assert.ok(turnSeq > 0);

 // Simulate a harness restart that never delivered the turn-end: drop the live
 // conns (the detached runner survives) and rewind delivered_seq.
  h.fleet.dispose();
  h.db.prepare('UPDATE fleet_sessions SET delivered_seq = 0 WHERE id = ?').run(res.id);

 // A fresh registry over the same db/dir recovers the still-alive runner and
 // replays from the stale offset via subscribe.
  const notices2: string[] = [];
  const fleet2 = createFleet({
    db: h.db, dataDirectory: h.dataDir, harnessRoot: h.dataDir, fleet: h.fleetConfig,
    logger: noopLogger, notify: (n) => notices2.push(n),
    runnerPath: RUNNER, nodePath: process.execPath,
  });
  t.after(() => { try { fleet2.dispose(); } catch { /* ignore */ } });

  fleet2.recover();
  await waitUntil(() => notices2.some((n) => n.includes('finished turn')));
  assert.equal(sessionRow(h.db, res.id).delivered_seq, turnSeq, 'delivered_seq re-advanced to the replayed turn-end');
  assert.equal(sessionRow(h.db, res.id).runner_pid, pid, 'recovery reconnected — did not respawn');
});

test('diff: no worktrees falls back to a cwd diff', async (t) => {
  const h = harness(t);
  const { repoDir } = gitRepoWithDirtyWorktree(t);
  const id = 'f-diff01';
  const now = Date.now();
  h.db.prepare(
    `INSERT INTO fleet_sessions (id, name, cwd, status, model, effort, created_at, updated_at)
     VALUES (?, ?, ?, 'idle', 'opus', 'high', ?, ?)`,
  ).run(id, 'differ', repoDir, now, now);
  const d = await h.fleet.diff('differ');
  assert.equal(d.ok, true);
  assert.equal(d.session, 'differ');
  assert.equal(d.worktrees.length, 1);
  assert.equal(d.worktrees[0].path, repoDir);
});
