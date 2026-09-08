import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RUN_WAKE_TASK_PREFIX,
  RUN_WAKE_PAYLOAD_TYPE,
  encodeRunWakePayload,
} from '../src/sandbox/wake.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Scheduler } from '../src/store/scheduler.js';
import { createLogger } from '../src/lib/log.js';
import {
  deliverInternalErrorNotice,
  formatProcessErrorNotice,
  formatSandboxLateProcessErrorNotice,
} from '../src/index.js';
import { Agent } from '../src/agent.js';

function fixture(onTaskWake: (task: any) => void) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE scheduled_tasks (
    id INTEGER PRIMARY KEY, name TEXT, kind TEXT, channel_id TEXT, payload TEXT,
    next_run_at INTEGER, interval_ms INTEGER, nag_interval_ms INTEGER,
    parent_id INTEGER, nag_count INTEGER DEFAULT 0, snooze_until INTEGER,
    done_at INTEGER, created_at INTEGER DEFAULT 0)`);
  return {
    db,
    scheduler: new Scheduler({
      db,
      logger: createLogger('silent'),
      onTaskWake,
    }),
  };
}

for (const action of ['done', 'delete', 'reschedule', 'snooze']) {
  test('same poll respects earlier ' + action, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const seen: number[] = [];
    const { db, scheduler } = fixture((task) => {
      seen.push(task.id);
      if (task.id !== first.id) return;
      if (action === 'done') scheduler.markDone(second.id);
      if (action === 'delete') scheduler.delete(second.id);
      if (action === 'reschedule')
        scheduler.update(second.id, { nextRunAt: 2000 });
      if (action === 'snooze') scheduler.snooze(second.id, 2000);
    });
    t.after(() => {
      scheduler.stop();
      db.close();
    });
    const first = scheduler.create({
      name: 'first',
      payload: '',
      nextRunAt: 900,
    });
    const second = scheduler.create({
      name: 'second',
      payload: '',
      nextRunAt: 950,
    });
    scheduler.poll();
    assert.deepEqual(seen, [first.id]);
    scheduler.poll();
    assert.deepEqual(seen, [first.id]);
    if (action === 'done')
      assert.throws(
        () => scheduler.update(second.id, { payload: 'new' }),
        /is done/,
      );
  });
}

test('failed dispatch persists sixty-second retry and progresses unrelated tasks', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const seen: string[] = [];
  const failure = new Error('synthetic dispatch failure');
  let fail = true;
  const { db, scheduler } = fixture((task) => {
    seen.push(task.name);
    if (task.name === 'retry' && fail) throw failure;
  });
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  const retry = scheduler.create({
    name: 'retry',
    payload: '',
    nextRunAt: 900,
  });
  scheduler.create({ name: 'other', payload: '', nextRunAt: 950 });
  scheduler.start();
  assert.throws(
    () => t.mock.timers.tick(0),
    (error) => error === failure,
  );
  assert.deepEqual(seen, ['retry', 'other']);
  assert.equal(scheduler.getById(retry.id)?.doneAt, null);
  assert.equal(scheduler.getById(retry.id)?.nextRunAt, 61000);
  assert.deepEqual(scheduler.listDue(60999), []);
  assert.equal(scheduler.listDue(61000)[0].id, retry.id);
  t.mock.timers.tick(59999);
  assert.deepEqual(seen, ['retry', 'other']);
  assert.throws(
    () => t.mock.timers.tick(1),
    (error) => error === failure,
  );
  assert.equal(scheduler.getById(retry.id)?.nextRunAt, 121000);
  fail = false;
  t.mock.timers.tick(60000);
  assert.deepEqual(seen, ['retry', 'other', 'retry', 'retry']);
  assert.notEqual(scheduler.getById(retry.id)?.doneAt, null);
  t.mock.timers.tick(60000);
  assert.equal(seen.length, 4);
});

test('internal error observer logs and queues without speech, contains failures', () => {
  const logged: string[] = [];
  const queued: any[] = [];
  const resident = {
    syntheticId: () => 'synthetic-error',
    enqueueInternal: (...args: any[]) => queued.push(args),
    send: () => assert.fail('public send'),
  };
  deliverInternalErrorNotice(
    'synthetic notice',
    (text) => logged.push(text),
    (text) => Agent.prototype.notifyInternalError.call(resident as any, text),
  );
  assert.deepEqual(logged, ['synthetic notice']);
  assert.deepEqual(queued[0].slice(0, 3), [
    'harness',
    'harness',
    'synthetic notice',
  ]);
  assert.doesNotThrow(() =>
    deliverInternalErrorNotice(
      'notice',
      () => {
        throw Error('log');
      },
      () => {
        throw Error('queue');
      },
    ),
  );
});

test('run wake rereads durable payload and completion for exactly-once delivery', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const queued: unknown[] = [];
  const { db, scheduler } = fixture((task) => {
    assert.equal(
      Agent.prototype.notifyRunWake.call(resident as any, task),
      true,
    );
  });
  t.after(() => {
    scheduler.stop();
    db.close();
  });
  const resident = {
    deps: { scheduler },
    pendingRunWake: null,
    enqueueInternal: (...args: unknown[]) => queued.push(args),
  };
  const task = scheduler.create({
    name: RUN_WAKE_TASK_PREFIX + 'synthetic',
    payload: encodeRunWakePayload({
      type: RUN_WAKE_PAYLOAD_TYPE,
      kind: 'after',
      state: 'armed',
      requestedAt: 900,
      targetAt: 1000,
    }),
    nextRunAt: 1000,
  });
  Agent.prototype.notifyRunWake.call(resident as any, task);
  Agent.prototype.notifyRunWake.call(resident as any, task);
  assert.equal(queued.length, 1);
  scheduler.poll();
  assert.notEqual(scheduler.getById(task.id)?.doneAt, null);
  assert.doesNotThrow(() =>
    Agent.prototype.notifyRunWake.call(resident as any, task),
  );
  assert.equal(queued.length, 1);
  const cancelled = scheduler.create({
    name: RUN_WAKE_TASK_PREFIX + 'cancelled',
    payload: task.payload,
    nextRunAt: 1000,
  });
  scheduler.markDone(cancelled.id);
  Agent.prototype.notifyRunWake.call(resident as any, cancelled);
  assert.equal(queued.length, 1);
});

for (const action of ['done', 'delete', 'later']) {
  test('failed callback does not undo its own ' + action, (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const { db, scheduler } = fixture((task) => {
      if (action === 'done') scheduler.markDone(task.id);
      if (action === 'delete') scheduler.delete(task.id);
      if (action === 'later') scheduler.update(task.id, { nextRunAt: 200000 });
      throw new Error('synthetic failure');
    });
    t.after(() => {
      scheduler.stop();
      db.close();
    });
    const task = scheduler.create({
      name: 'task',
      payload: '',
      nextRunAt: 1000,
    });
    assert.throws(() => scheduler.poll(), /synthetic failure/);
    assert.deepEqual(scheduler.listDue(61000), []);
    if (action === 'later')
      assert.equal(scheduler.getById(task.id)?.nextRunAt, 200000);
    if (action === 'done')
      assert.equal(scheduler.getById(task.id)?.doneAt, 1000);
    if (action === 'delete') assert.equal(scheduler.getById(task.id), null);
  });
}

test('ordinary exception notices retain a file log and internal-only provenance', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'notices.log');
  const queue: unknown[][] = [];
  const resident = {
    syntheticId: () => 'synthetic-error',
    enqueueInternal: (...args: unknown[]) => queue.push(args),
    send: () => assert.fail('automatic speech'),
  };
  for (const notice of [
    formatProcessErrorNotice(
      'unhandledRejection',
      new Error('synthetic process failure'),
    ),
    formatSandboxLateProcessErrorNotice({
      kind: 'uncaughtException',
      error: new Error('synthetic late failure'),
    } as any),
  ]) {
    deliverInternalErrorNotice(
      notice,
      (text) => fs.appendFileSync(file, text + '\n'),
      (text) => Agent.prototype.notifyInternalError.call(resident as any, text),
    );
    assert.ok(fs.readFileSync(file, 'utf8').includes(notice));
  }
  assert.equal(queue.length, 2);
  assert.ok(
    queue.every((args) => args[0] === 'harness' && args[1] === 'harness'),
  );
});
