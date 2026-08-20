import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import { createSandboxRegistry } from '../src/sandbox/registry.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-registry-'));
  const db = openDatabase(dir);
  let clock = 1_000;
  let uuid = 0;
  const registry = createSandboxRegistry({ db, now: () => ++clock, uuid: () => `uuid-${++uuid}` });
  const mind = (status = 'open') => Number(db.prepare(`
    INSERT INTO mind_items (title, body, kind, status, priority, parent_id, due_at, created_by, created_at, updated_at, closed_at, archived_at)
    VALUES ('work', '', 'task', ?, 2, NULL, NULL, 'test', ?, ?, NULL, NULL)
  `).run(status, ++clock, ++clock).lastInsertRowid);
  return { dir, db, registry, mind, now: () => ++clock };
}

test('executor identity is created once and made immutable by SQLite', () => {
  const { db, registry } = fixture();
  assert.equal(registry.executorId, 'uuid-1');
  const reopened = createSandboxRegistry({ db, uuid: () => { throw new Error('must not regenerate'); } });
  assert.equal(reopened.executorId, registry.executorId);
  assert.throws(() => db.prepare('UPDATE sandbox_executor_identity SET executor_id = ? WHERE singleton = 1').run('changed'), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM sandbox_executor_identity WHERE singleton = 1').run(), /immutable/);
  db.close();
});

test('one Mind binds once and aliases remain permanently reserved', () => {
  const { db, registry, mind } = fixture();
  const firstMind = mind();
  const first = registry.register(firstMind, ['swiftly-saucy-blahaj']);
  assert.equal(first.alias, 'swiftly-saucy-blahaj');
  assert.equal(first.id, 'uuid-2');
  assert.equal(registry.defaultMindId(first.alias), firstMind);
  assert.equal(registry.defaultMindId(first.id), firstMind);
  assert.equal(registry.register(firstMind, ['quietly-lilac-moth']).id, first.id, 'registration is idempotent for its bound Mind');

  const secondMind = mind();
  const second = registry.register(secondMind, ['swiftly-saucy-blahaj', 'quietly-lilac-moth']);
  assert.equal(second.alias, 'quietly-lilac-moth');
  assert.throws(() => db.prepare('UPDATE persistent_sandboxes SET mind_id = ? WHERE id = ?').run(secondMind, first.id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM sandbox_aliases WHERE alias = ?').run(first.alias), /never reused/);
  assert.throws(() => db.prepare('DELETE FROM persistent_sandboxes WHERE id = ?').run(first.id), /permanent/);

  const closedMind = mind('done');
  assert.throws(() => registry.register(closedMind, ['boldly-cobalt-orbit']), /closed/);
  db.close();
});

test('alias exhaustion rolls back the registration atomically', () => {
  const { db, registry, mind } = fixture();
  registry.register(mind(), ['swiftly-saucy-blahaj']);
  const secondMind = mind();
  assert.throws(() => registry.register(secondMind, ['swiftly-saucy-blahaj', 'swiftly-saucy-blahaj']), /exhausted/);
  assert.equal(registry.getByMind(secondMind), null);
  assert.equal(registry.list().length, 1);
  db.close();
});

test('runs carry generation-scoped IDs through busy, detached, finish, and reset', () => {
  const { db, registry, mind } = fixture();
  const sandbox = registry.register(mind(), ['briskly-amber-otter']);
  const first = registry.beginRun(sandbox.alias);
  assert.equal(first.runId, `${sandbox.id}:g1:r1`);
  assert.equal(first.sandbox.lifecycle, 'busy');
  assert.throws(() => registry.beginRun(sandbox.id), /is busy/);
  assert.throws(() => registry.finishRun(sandbox.id, 'wrong'), /does not own/);
  assert.equal(registry.detachRun(sandbox.id, first.runId).lifecycle, 'detached');
  assert.equal(registry.finishRun(sandbox.id, first.runId).lifecycle, 'ready');

  const second = registry.beginRun(sandbox.id);
  assert.equal(second.runId, `${sandbox.id}:g1:r2`);
  registry.finishRun(sandbox.id, second.runId);
  const reset = registry.reset(sandbox.id);
  assert.equal(reset.generation, 2);
  assert.equal(reset.nextRunSeq, 1);
  const third = registry.beginRun(sandbox.id);
  assert.equal(third.runId, `${sandbox.id}:g2:r1`);
  assert.notEqual(third.runId, first.runId);

  const restarted = createSandboxRegistry({ db });
  assert.equal(restarted.markInterruptedRunsDetached(), 1);
  assert.equal(restarted.get(sandbox.id).lifecycle, 'detached');
  assert.equal(restarted.finishRun(sandbox.id, third.runId).lifecycle, 'ready');
  db.close();
});

test('reminders latch once and retirement waits for explicit idle GC', () => {
  const { db, registry, mind, now } = fixture();
  const mindId = mind();
  const sandbox = registry.register(mindId, ['softly-mossy-rabbit']);
  assert.equal(registry.latchReminder(sandbox.id), true);
  assert.equal(registry.latchReminder(sandbox.id), false);
  assert.equal(registry.clearReminder(sandbox.id).reminderLatched, false);

  const run = registry.beginRun(sandbox.id);
  db.prepare("UPDATE mind_items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), mindId);
  const retiring = registry.retireByMind(mindId)!;
  assert.equal(retiring.lifecycle, 'busy');
  assert.equal(retiring.retireRequested, true);
  assert.ok(retiring.retireRequestedAt);
  const requestedAt = retiring.retireRequestedAt;
  const idle = registry.finishRun(sandbox.id, run.runId);
  assert.equal(idle.lifecycle, 'ready');
  assert.equal(idle.retireRequested, true);
  assert.equal(idle.retireRequestedAt, requestedAt);
  const finalRun = registry.beginRun(sandbox.id);
  assert.match(finalRun.runId, /:g1:r2$/);
  assert.equal(finalRun.sandbox.retireRequestedAt, requestedAt);
  assert.equal(registry.finishRun(sandbox.id, finalRun.runId).retireRequestedAt, requestedAt);
  const retired = registry.finalizeRetirement(sandbox.id);
  assert.equal(retired.lifecycle, 'retired');
  assert.ok(retired.retiredAt);
  assert.throws(() => registry.beginRun(sandbox.id), /is retired/);

  const replacementMind = mind();
  const replacement = registry.register(replacementMind, [sandbox.alias, 'warmly-violet-gecko']);
  assert.equal(replacement.alias, 'warmly-violet-gecko', 'retired aliases remain tombstoned');
  const aliasRow = db.prepare('SELECT retired_at FROM sandbox_aliases WHERE alias = ?').get(sandbox.alias) as { retired_at: number | null };
  assert.ok(aliasRow.retired_at);
  db.close();
});

test('registerNamed hot-reads authored wordlists for each new binding', () => {
  const { dir, db, mind } = fixture();
  const warnings: string[] = [];
  const registry = createSandboxRegistry({
    db,
    aliases: { dataDirectory: dir, logger: { warn: (message: string) => warnings.push(message) }, chooseStart: () => 0 },
  });
  const seeded = registry.registerNamed(mind());
  assert.equal(seeded.alias, 'brightly-amber-alpaca');

  const wordlistDirectory = resolveDataLayout(dir).wordlists;
  fs.writeFileSync(path.join(wordlistDirectory, 'adverbs.txt'), 'suspiciously\n');
  fs.writeFileSync(path.join(wordlistDirectory, 'adjectives.txt'), 'saucy\n');
  fs.writeFileSync(path.join(wordlistDirectory, 'nouns.txt'), 'blahaj\n');
  const authored = registry.registerNamed(mind());
  assert.equal(authored.alias, 'suspiciously-saucy-blahaj');
  assert.deepEqual(warnings, []);
  db.close();
});

test('beginRun auto-marks a closed Mind retiring but preserves use until GC', () => {
  const { db, registry, mind, now } = fixture();
  const mindId = mind();
  const sandbox = registry.register(mindId, ['plainly-silver-newt']);
  db.prepare("UPDATE mind_items SET status = 'cancelled', closed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), mindId);
  const run = registry.beginRun(sandbox.id);
  assert.equal(run.sandbox.lifecycle, 'busy');
  assert.equal(run.sandbox.retireRequested, true);
  assert.ok(run.sandbox.retireRequestedAt);
  const requestedAt = run.sandbox.retireRequestedAt;
  const idle = registry.finishRun(sandbox.id, run.runId);
  assert.equal(idle.lifecycle, 'ready');
  assert.equal(idle.retireRequestedAt, requestedAt);
  assert.equal(registry.finalizeRetirement(sandbox.id).lifecycle, 'retired');
  db.close();
});

test('reopen cancels pending retirement and cold reset advances every live generation once', () => {
  const { db, registry, mind, now } = fixture();
  const mindId = mind();
  const sandbox = registry.register(mindId, ['plainly-copper-otter']);
  db.prepare("UPDATE mind_items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), mindId);
  registry.retireByMind(mindId);
  db.prepare("UPDATE mind_items SET status = 'open', closed_at = NULL, updated_at = ? WHERE id = ?").run(now(), mindId);
  const reopened = registry.cancelRetirement(mindId)!;
  assert.equal(reopened.retireRequested, false);
  assert.equal(reopened.retireRequestedAt, null);
  assert.equal(registry.coldResetAll(), 1);
  const cold = registry.get(sandbox.id);
  assert.equal(cold.generation, 2);
  assert.equal(cold.coldNoticePending, true);
  assert.equal(registry.consumeColdNotice(sandbox.id), true);
  assert.equal(registry.consumeColdNotice(sandbox.id), false);
  db.close();
});

test('finishRun requests retirement when the Mind closes during execution without a callback', () => {
  const { db, registry, mind, now } = fixture();
  const mindId = mind();
  const sandbox = registry.register(mindId, ['quietly-crimson-ibis']);
  const run = registry.beginRun(sandbox.alias);
  db.prepare("UPDATE mind_items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), mindId);
  const finished = registry.finishRun(sandbox.alias, run.runId);
  assert.equal(finished.lifecycle, 'ready');
  assert.equal(finished.retireRequested, true);
  assert.ok(finished.retireRequestedAt);
  db.close();
});
