// Live integration test: a REAL haiku fleet session over the REAL detached
// runner (dist/fleet/runner.js), using this machine's subscription credentials
// (~/.claude) — sanctioned for this repo, see AGENTS.md personal-agent policy.
// No assertions on cost/billing; only on observable behavior (file written,
// turn-end notice received, clean dismiss).
//
// Gating follows test/llm-integration.test.ts's idiom EXACTLY: TEST_NO_NETWORK=1
// skips (so `npm run test:unit` stays fast and network-free); `npm test` runs it.
//
// NOTE on timers: unlike llm-integration.test.ts (which awaits a promise the
// agent's own send callback resolves), the fleet runner is a detached child
// process talking over a control socket — there is no in-process promise to
// await here, so we poll the `notify` callback's recorded notices for the
// `[fleet <name> finished turn]` marker (bounded at 120s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDatabase, type Database } from '../src/store/db.js';
import { noopLogger } from '../src/lib/log.js';
import { SDK_EFFORT_LEVELS } from '../src/config.js';
import { createFleet, type FleetHandle } from '../src/fleet/index.js';

const execFileP = promisify(execFile);

const NO_NETWORK = !!process.env.TEST_NO_NETWORK;

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER_PATH = path.join(HARNESS_ROOT, 'dist', 'fleet', 'runner.js');

/** dist/fleet/runner.js is a build artifact, not checked in. Build it if
 * missing (300s timeout — tsc + copy-assets); if the build itself fails,
 * the test skips rather than fails (no way to run a real runner without it). */
let buildFailure: string | null = null;

async function ensureBuilt(): Promise<void> {
  if (fs.existsSync(RUNNER_PATH)) return;
  try {
    await execFileP('npm', ['run', 'build'], { cwd: HARNESS_ROOT, timeout: 300_000 });
  } catch (e) {
    buildFailure = `npm run build failed: ${String((e as Error).message ?? e)}`;
    return;
  }
  if (!fs.existsSync(RUNNER_PATH)) {
    buildFailure = `dist/fleet/runner.js still missing after a successful build`;
  }
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out after ' + ms + 'ms');
    await delay(250);
  }
}

interface Harness {
  fleet: FleetHandle;
  db: Database;
  dataDir: string;
  cwdDir: string;
  notices: string[];
}

function buildHarness(t: { after: (fn: () => void) => void }): Harness {
 // Plain tmp dirs — NOT git repos. `dataDir` backs agent.db + fleet session
 // state; `cwdDir` is the target working directory for the fleet session
 // (worktree: false, so no git required there).
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-int-data-'));
  const cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-int-cwd-'));
  const db = openDatabase(dataDir);
  const notices: string[] = [];
  const fleet = createFleet({
    db,
    dataDirectory: dataDir,
    harnessRoot: HARNESS_ROOT, // runnerPath default resolves to <harnessRoot>/dist/fleet/runner.js
    fleet: {
      enabled: true,
      maxConcurrent: 1,
      defaultModel: 'haiku',
      defaultEffort: 'low',
      efforts: [...SDK_EFFORT_LEVELS],
      endpoint: { baseUrl: null, apiKey: null, authToken: null },
      models: {
        opus: { name: null, context: null }, sonnet: { name: null, context: null },
        haiku: { name: null, context: null }, fable: { name: null, context: null },
      },
      idleTimeoutMs: 60_000,
      reapAfterMs: 86_400_000,
      env: {},
    },
    logger: noopLogger,
    notify: (text) => notices.push(text),
  });
  t.after(() => {
    try { fleet.dispose(); } catch { /* ignore */ }
 // Safety net: if the test failed before a clean dismiss, don't leave a
 // runner process behind — read its pid from the DB row and kill it.
    try {
      const rows = db.prepare('SELECT runner_pid FROM fleet_sessions').all() as Array<{ runner_pid: number | null }>;
      for (const row of rows) {
        if (pidAlive(row.runner_pid)) { try { process.kill(row.runner_pid as number, 'SIGKILL'); } catch { /* gone */ } }
      }
    } catch { /* best effort */ }
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(cwdDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return { fleet, db, dataDir, cwdDir, notices };
}

test(
  'live: a real haiku fleet session writes a file and reports turn-end',
  { skip: NO_NETWORK, timeout: 180_000 },
  async (t) => {
    await ensureBuilt();
    if (buildFailure) {
      t.skip(buildFailure);
      return;
    }

    const h = buildHarness(t);

    const res = await h.fleet.run(
      'Create a file named hello.txt containing exactly "hello fleet" and nothing else. Do not use a worktree.',
      { model: 'haiku', worktree: false, cwd: h.cwdDir },
    );
    assert.equal(res.model, 'haiku');
    assert.equal(res.cwd, h.cwdDir);

 // Poll for the runner's turn-end notice (real SDK round-trip: no in-process
 // promise to await, so bounded polling is the only signal available).
 // Early bail on failure notices instead of waiting out the full 120s.
    const start = Date.now();
    while (!h.notices.some((n) => /\[fleet .+ finished turn\]/.test(n))) {
      const failureNotice = h.notices.find((n) => /\[fleet .+ (failed|runner died)/.test(n));
      if (failureNotice) throw new Error(`fleet session failed: ${failureNotice}`);
      if (Date.now() - start > 120_000) throw new Error('notice polling timed out after 120000ms');
      await delay(250);
    }

    const hello = path.join(h.cwdDir, 'hello.txt');
    assert.ok(fs.existsSync(hello), `expected ${hello} to exist; notices so far: ${JSON.stringify(h.notices)}`);
    assert.equal(fs.readFileSync(hello, 'utf8').trim(), 'hello fleet');

 // Capture the runner's pid before dismissal so we can verify it actually dies.
    const rowBeforeDismiss = h.db.prepare('SELECT runner_pid FROM fleet_sessions WHERE id = ?').get(res.id) as { runner_pid: number | null };
    const pidBeforeDismiss = rowBeforeDismiss.runner_pid;

    const dismissResult = await h.fleet.dismiss(res.name);
    assert.equal(dismissResult.ok, true, `dismiss should succeed cleanly (no worktrees, no dirty state): ${JSON.stringify(dismissResult)}`);

 // No stray runner process left behind.
    const row = h.db.prepare('SELECT runner_pid FROM fleet_sessions WHERE id = ?').get(res.id) as { runner_pid: number | null };
    assert.equal(pidAlive(row.runner_pid), false, 'runner process must not outlive a clean dismiss');

 // Verify that the runner process that was alive before dismiss actually died
 // (poll up to ~3s with 250ms delays since SIGTERM→exit is async).
    await waitUntil(() => pidAlive(pidBeforeDismiss) === false, 3_000);
    assert.equal(pidAlive(pidBeforeDismiss), false, 'runner must actually terminate after dismiss, not just be marked dead in DB');
  },
);
