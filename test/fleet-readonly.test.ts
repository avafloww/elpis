// Unit tests for the send-time readOnly override (lifting a read-only session
// to writable at revive time). Mirrors test/fleet-registry.test.ts's style: a
// REAL detached fake-fleet-runner.mjs over a real control socket + real
// events.jsonl + real agent.db, all under os.tmpdir. No SDK, no network.
//
// `readOnly` is enforced once per runner process at spawn (the SDK options
// object in runner-core.ts), so lifting is a revive-time override, not a
// mid-turn flip — these tests pin that contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type Database } from '../src/store/db.js';
import { noopLogger } from '../src/lib/log.js';
import { SDK_EFFORT_LEVELS } from '../src/config.js';
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

interface Harness {
  fleet: FleetHandle;
  db: Database;
  dataDir: string;
  notices: string[];
  fleetConfig: FleetOpts['fleet'];
}

function harness(t: { after: (fn: () => void) => void }, over: Partial<FleetOpts['fleet']> = {}, env: Record<string, string> = {}): Harness {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ro-'));
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

function configOf(h: Harness, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(h.dataDir, 'fleet', id, 'runner-config.json'), 'utf8'));
}

function eventsOf(h: Harness, id: string): string {
  return fs.readFileSync(path.join(h.dataDir, 'fleet', id, 'events.jsonl'), 'utf8');
}

// ===========================================================================

test('lift on a dead runner: persists read_only, logs the lift, config reflects it', async (t) => {
  const h = harness(t);
 // A read-only session that has gone idle then died (so a send revives it).
  const res = await h.fleet.run('initial', { name: 'ro-dead', readOnly: true });
  await h.fleet.send('ro-dead', 'first');
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')));
  await waitUntil(() => sessionRow(h.db, res.id).sdk_session_id != null);
  assert.equal(sessionRow(h.db, res.id).read_only, 1, 'started read-only');
  const pid = sessionRow(h.db, res.id).runner_pid as number;
  process.kill(pid, 'SIGKILL');
  await waitUntil(() => !pidAlive(pid));
  await delay(50);

  const lifted = await h.fleet.send('ro-dead', 'now go edit', { readOnly: false });
  assert.equal(lifted.ok, true);
  assert.match(lifted.note, /readOnly lifted/);
  assert.equal(sessionRow(h.db, res.id).read_only, 0, 'read_only persisted as writable');
  assert.equal(configOf(h, res.id).readOnly, false, 'runner-config.json rebuilt writable');
  assert.match(eventsOf(h, res.id), /readOnly lifted by dispatcher/, 'event log records the lift');
  assert.ok(pidAlive(sessionRow(h.db, res.id).runner_pid as number), 'a fresh runner spawned');
});

test('lift is refused mid-turn — interrupt first', async (t) => {
  const h = harness(t, {}, { FAKE_SCRIPT: JSON.stringify([{ ev: 'mailbox', text: 'thinking' }]) });
 // Start read-only; the mailbox frame keeps the runner alive but we need a
 // genuinely mid-turn (running) state. Drive it there via a manual row: a
 // live pid with status 'running'.
  const res = await h.fleet.run('go', { name: 'ro-mid', readOnly: true });
 // The fake runner turns a send into a turn-end synchronously, so to model a
 // mid-turn we mark the row running while the pid is alive.
  h.db.prepare('UPDATE fleet_sessions SET status = ? WHERE id = ?').run('running', res.id);
  const pid = sessionRow(h.db, res.id).runner_pid as number;
  assert.ok(pidAlive(pid));

  const lifted = await h.fleet.send('ro-mid', 'edit now', { readOnly: false });
  assert.equal(lifted.ok, false);
  assert.match(lifted.note, /mid-turn/);
  assert.match(lifted.note, /interrupt/);
  assert.equal(sessionRow(h.db, res.id).read_only, 1, 'permission unchanged on refusal');
  assert.equal(sessionRow(h.db, res.id).runner_pid, pid, 'runner NOT torn down on refusal');
});

test('lift on an idle LIVE runner tears it down and revives writable', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('initial', { name: 'ro-idle', readOnly: true });
  await h.fleet.send('ro-idle', 'first');
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')));
  const oldPid = sessionRow(h.db, res.id).runner_pid as number;
  assert.ok(pidAlive(oldPid));
  assert.equal(sessionRow(h.db, res.id).status, 'idle');

  const lifted = await h.fleet.send('ro-idle', 'go edit', { readOnly: false });
  assert.equal(lifted.ok, true);
  assert.match(lifted.note, /readOnly lifted/);
  const newPid = sessionRow(h.db, res.id).runner_pid as number;
  assert.notEqual(newPid, oldPid, 'a fresh runner spawned (the idle one was torn down)');
  assert.ok(pidAlive(newPid));
  assert.equal(sessionRow(h.db, res.id).read_only, 0, 'persisted writable');
  assert.equal(configOf(h, res.id).readOnly, false);
  assert.match(eventsOf(h, res.id), /readOnly lifted by dispatcher/);

 // The torn-down runner appends a trailing `state:exited` to events.jsonl.
 // The revive's openConn must subscribe from the CURRENT delivered_seq (past
 // the lift line + that exited), NOT the stale snapshot — else replaying the
 // exited nulls the just-spawned pid via applyState. Wait for any delayed
 // replay to land, then confirm the new pid is still recorded + alive.
  await delay(200);
  const after = sessionRow(h.db, res.id);
  assert.equal(after.runner_pid, newPid, 'new pid not clobbered by a stale state:exited replay');
  assert.ok(pidAlive(after.runner_pid as number));
  assert.notEqual(after.status, 'failed');
});

test('a no-op readOnly override on a live idle runner delivers in-place (no teardown)', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('go', { name: 'plain', readOnly: false });
  await h.fleet.send('plain', 'first');
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')));
  const pid = sessionRow(h.db, res.id).runner_pid as number;

 // readOnly:false matches the stored value → no change, no teardown.
  const r = await h.fleet.send('plain', 'second', { readOnly: false });
  assert.equal(r.ok, true);
  assert.match(r.note, /delivered to plain/); // in-place delivery, not a revive
  assert.equal(sessionRow(h.db, res.id).runner_pid, pid, 'same runner — not torn down');
  await waitUntil(() => h.notices.some((n) => n.includes('echo: second')));
});

test('a plain send (no override) still revives a dead runner read-only', async (t) => {
  const h = harness(t);
  const res = await h.fleet.run('initial', { name: 'ro-plain', readOnly: true });
  await h.fleet.send('ro-plain', 'first');
  await waitUntil(() => h.notices.some((n) => n.includes('finished turn')));
  await waitUntil(() => sessionRow(h.db, res.id).sdk_session_id != null);
  const pid = sessionRow(h.db, res.id).runner_pid as number;
  process.kill(pid, 'SIGKILL');
  await waitUntil(() => !pidAlive(pid));
  await delay(50);

  const revived = await h.fleet.send('ro-plain', 'again');
  assert.equal(revived.ok, true);
  assert.doesNotMatch(revived.note, /readOnly lifted/, 'a plain revive is not a lift');
  assert.equal(sessionRow(h.db, res.id).read_only, 1, 'stays read-only');
  assert.equal(configOf(h, res.id).readOnly, true);
  assert.doesNotMatch(eventsOf(h, res.id), /readOnly lifted/);
});
