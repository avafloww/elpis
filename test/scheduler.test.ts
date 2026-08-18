// scheduler.ts unit tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import { Scheduler } from '../src/store/scheduler.js';
import { createLogger } from '../src/lib/log.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scheduler-'));
}

function noopLogger() {
  return createLogger('silent', '[scheduler-test]');
}

test('create and list tasks', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: () => {} });

  const task = scheduler.create({
    name: 'estrogen',
    kind: 'reminder',
    channelId: 'c1',
    payload: 'time for your injection',
    nextRunAt: Date.now() + 60_000,
    intervalMs: 6 * 24 * 60 * 60 * 1000,
    nagIntervalMs: 2 * 60 * 60 * 1000,
  });

  assert.equal(task.name, 'estrogen');
  assert.equal(task.kind, 'reminder');
  assert.equal(task.channelId, 'c1');
  assert.equal(task.nagIntervalMs, 2 * 60 * 60 * 1000);

  const list = scheduler.list();
  assert.equal(list.length, 1);

  scheduler.stop();
  db.close();
});

test('fires due one-shot task and marks it done', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const fired: unknown[] = [];
  const scheduler = new Scheduler({
    db,
    logger: noopLogger(),
    onTaskWake: (task) => fired.push(task),
  });

  scheduler.create({
    name: 'now',
    payload: 'wake up',
    nextRunAt: Date.now() - 1,
  });

  scheduler.poll();
  assert.equal(fired.length, 1);
  assert.equal((fired[0] as { name: string }).name, 'now');

  const list = scheduler.list();
  assert.equal(typeof list[0].doneAt, 'number');

  scheduler.stop();
  db.close();
});

test('recurring task reschedules after firing', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const fired: unknown[] = [];
  const scheduler = new Scheduler({
    db,
    logger: noopLogger(),
    onTaskWake: (task) => fired.push(task),
  });

  const base = Date.now();
  scheduler.create({
    name: 'daily',
    payload: 'ping',
    nextRunAt: base - 1,
    intervalMs: 86_400_000,
  });

  scheduler.poll();
  assert.equal(fired.length, 1);

  const task = scheduler.getByName('daily');
  assert.ok(task);
  assert.ok(task.nextRunAt >= base + 86_400_000 - 1000, 'next run moved forward by interval');
  assert.equal(task.doneAt, null);

  scheduler.stop();
  db.close();
});

test('reminder spawns nag tasks', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const fired: unknown[] = [];
  const scheduler = new Scheduler({
    db,
    logger: noopLogger(),
    onTaskWake: (task) => fired.push(task),
  });

  const base = Date.now();
  scheduler.create({
    name: 'estrogen',
    kind: 'reminder',
    payload: 'injection time',
    nextRunAt: base - 1,
    intervalMs: 6 * 24 * 60 * 60 * 1000,
    nagIntervalMs: 2 * 60 * 60 * 1000,
  });

  scheduler.poll();
  assert.equal(fired.length, 1);

  const list = scheduler.list();
  assert.equal(list.length, 2, 'parent + nag');
  const nag = list.find((t) => t.kind === 'reminder-nag');
  assert.ok(nag);
  assert.ok(nag.nextRunAt >= base + 2 * 60 * 60 * 1000 - 1000, 'nag scheduled at interval');

  scheduler.stop();
  db.close();
});

test('markDoneByName re-arms recurring reminder, kills nags', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: () => {} });

  const base = Date.now();
  scheduler.create({
    name: 'estrogen',
    kind: 'reminder',
    payload: 'injection time',
    nextRunAt: base - 1,
    intervalMs: 6 * 24 * 60 * 60 * 1000,
    nagIntervalMs: 2 * 60 * 60 * 1000,
  });

  scheduler.poll();
  scheduler.markDoneByName('estrogen');

  const all = scheduler.list();
  const parent = all.find((t) => t.kind === 'reminder');
  const nags = all.filter((t) => t.kind === 'reminder-nag');
  assert.ok(parent.doneAt == null, 'recurring parent re-armed, not killed');
  assert.ok(parent.nextRunAt > Date.now(), 'next run advanced past now');
  assert.ok(nags.length > 0 && nags.every((t) => t.doneAt != null), 'nags done');

  scheduler.stop();
  db.close();
});

test('markDoneByName on one-shot still marks done', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: () => {} });

  scheduler.create({ name: 'once', payload: 'one shot', nextRunAt: Date.now() - 1 });
  scheduler.poll();
  scheduler.markDoneByName('once');
  assert.ok(scheduler.list().every((t) => t.doneAt != null), 'one-shot stays done');

  scheduler.stop();
  db.close();
});

test('snooze prevents firing until after snooze', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const fired: unknown[] = [];
  const scheduler = new Scheduler({
    db,
    logger: noopLogger(),
    onTaskWake: (task) => fired.push(task),
  });

  const task = scheduler.create({
    name: 'snoozed',
    payload: 'later',
    nextRunAt: Date.now() - 1,
  });

  scheduler.snooze(task.id, Date.now() + 60_000);
  scheduler.poll();
  assert.equal(fired.length, 0);

  scheduler.stop();
  db.close();
});

test('update patches payload and nextRunAt on an existing task', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: () => {} });

  const task = scheduler.create({ name: 'updateme', payload: 'before', nextRunAt: Date.now() + 60_000 });
  const newNextRunAt = Date.now() + 120_000;
  const updated = scheduler.update(task.id, { payload: 'after', nextRunAt: newNextRunAt });

  assert.ok(updated);
  assert.equal(updated!.payload, 'after');
  assert.equal(updated!.nextRunAt, newNextRunAt);

  scheduler.stop();
  db.close();
});

test('update with no patch fields returns the task unchanged', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: () => {} });

  const task = scheduler.create({ name: 'unchanged', payload: 'x', nextRunAt: Date.now() + 60_000 });
  const updated = scheduler.update(task.id, {});

  assert.ok(updated);
  assert.equal(updated!.payload, 'x');

  scheduler.stop();
  db.close();
});

test('update on a missing id returns null', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: () => {} });

  assert.equal(scheduler.update(999999, { payload: 'x' }), null);

  scheduler.stop();
  db.close();
});

test('delete removes a task', () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: () => {} });

  const task = scheduler.create({ name: 'delete-me', payload: 'x', nextRunAt: Date.now() });
  assert.equal(scheduler.delete(task.id), true);
  assert.equal(scheduler.getById(task.id), null);

  scheduler.stop();
  db.close();
});

test('started scheduler re-arms its single timer when an earlier task is created', async () => {
  const dir = tmpDir();
  const db = openDatabase(dir);
  const fired: string[] = [];
  const scheduler = new Scheduler({ db, logger: noopLogger(), onTaskWake: (task) => fired.push(task.name) });
  try {
    scheduler.create({ name: 'later', payload: 'later', nextRunAt: Date.now() + 500 });
    scheduler.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    scheduler.create({ name: 'earlier', payload: 'earlier', nextRunAt: Date.now() + 40 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(fired, ['earlier']);
    assert.ok(scheduler.getByName('earlier')?.doneAt);
    assert.equal(scheduler.getByName('later')?.doneAt, null);
  } finally {
    scheduler.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
