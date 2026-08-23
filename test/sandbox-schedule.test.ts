// test/sandbox-schedule.test.ts — validation for elpis.schedule/unschedule at
// the sandbox-global level: coerceNextRunAt's epoch-ms/ISO/
// Date coercion, elpis.schedule's required-field checks, elpis.schedule.update,
// and elpis.schedule.remove's unified id-or-name keying.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals, coerceNextRunAt } from '../src/sandbox/globals.js';
import type { SandboxDeps } from '../src/types.js';

test('coerceNextRunAt: number passes through', () => {
  assert.equal(coerceNextRunAt(1000), 1000);
});

test('coerceNextRunAt: ISO string parses', () => {
  assert.equal(
    coerceNextRunAt('2026-07-23T00:00:00Z'),
    Date.parse('2026-07-23T00:00:00Z'),
  );
});

test('coerceNextRunAt: Date parses', () => {
  assert.equal(coerceNextRunAt(new Date(1000)), 1000);
});

test('coerceNextRunAt: garbage string throws', () => {
  assert.throws(() => coerceNextRunAt('not-a-date'), /nextRunAt must be/);
});

test('coerceNextRunAt: NaN/Infinity throws', () => {
  assert.throws(() => coerceNextRunAt(Infinity), /nextRunAt must be/);
  assert.throws(() => coerceNextRunAt(NaN), /nextRunAt must be/);
});

function baseConfig() {
  return {
    paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
    sandbox: {
      syncTimeoutMs: 5000,
      asyncDeadlineMs: 10000,
      previewMaxBytes: 2048,
      logMaxBytes: 2048,
    },
    kagi: { apiKey: null },
  };
}

function fakeScheduler() {
  const tasks = new Map<
    number,
    { id: number; name: string; payload: string; nextRunAt: number }
  >();
  let nextId = 1;
  const scheduler: NonNullable<SandboxDeps['scheduler']> = {
    create: (opts) => {
      const task = {
        id: nextId++,
        name: opts.name,
        payload: opts.payload,
        nextRunAt: opts.nextRunAt,
      };
      tasks.set(task.id, task);
      return task;
    },
    delete: (id) => tasks.delete(id),
    list: () => Array.from(tasks.values()),
    getByName: (name) =>
      Array.from(tasks.values()).find((t) => t.name === name) ?? null,
    markDone: () => null,
    markDoneByName: () => true,
    snooze: () => null,
    snoozeByName: () => true,
    update: (id, patch) => {
      const t = tasks.get(id);
      if (!t) return null;
      Object.assign(t, patch);
      return t;
    },
  };
  return scheduler;
}

test('elpis.schedule: requires a non-empty name', () => {
  const g = buildGlobals({
    config: baseConfig(),
    scheduler: fakeScheduler(),
  } as unknown as SandboxDeps);
  const elpis = g.elpis as { schedule: (opts: unknown) => unknown };
  assert.throws(
    () => elpis.schedule({ name: '', payload: 'x', nextRunAt: Date.now() }),
    /name.*non-empty string/,
  );
});

test('elpis.schedule: requires a string payload', () => {
  const g = buildGlobals({
    config: baseConfig(),
    scheduler: fakeScheduler(),
  } as unknown as SandboxDeps);
  const elpis = g.elpis as { schedule: (opts: unknown) => unknown };
  assert.throws(
    () => elpis.schedule({ name: 'x', payload: 123, nextRunAt: Date.now() }),
    /payload.*must be a string/,
  );
});

test('elpis.schedule: coerces an ISO nextRunAt', () => {
  const scheduler = fakeScheduler();
  const g = buildGlobals({
    config: baseConfig(),
    scheduler,
  } as unknown as SandboxDeps);
  const elpis = g.elpis as {
    schedule: (opts: unknown) => { nextRunAt: number };
  };
  const task = elpis.schedule({
    name: 'x',
    payload: 'y',
    nextRunAt: '2026-07-23T00:00:00Z',
  });
  assert.equal(task.nextRunAt, Date.parse('2026-07-23T00:00:00Z'));
});

test('elpis.schedule.update: patches an existing task by id', () => {
  const scheduler = fakeScheduler();
  const g = buildGlobals({
    config: baseConfig(),
    scheduler,
  } as unknown as SandboxDeps);
  const elpis = g.elpis as {
    schedule: ((opts: unknown) => { id: number }) & {
      update: (id: number, patch: unknown) => { payload: string };
    };
  };
  const task = elpis.schedule({
    name: 'x',
    payload: 'y',
    nextRunAt: Date.now(),
  });
  const updated = elpis.schedule.update(task.id, { payload: 'new payload' });
  assert.equal(updated.payload, 'new payload');
});

test('elpis.schedule.update: null clears snoozeUntil', () => {
  const scheduler = fakeScheduler();
  const g = buildGlobals({
    config: baseConfig(),
    scheduler,
  } as unknown as SandboxDeps);
  const elpis = g.elpis as {
    schedule: ((opts: unknown) => { id: number }) & {
      update: (id: number, patch: unknown) => { snoozeUntil: number | null };
    };
  };
  const task = elpis.schedule({
    name: 'clear-snooze',
    payload: 'y',
    nextRunAt: Date.now(),
  });
  const set = elpis.schedule.update(task.id, {
    snoozeUntil: '2026-08-10T02:00:00Z',
  });
  assert.equal(set.snoozeUntil, Date.parse('2026-08-10T02:00:00Z'));
  const cleared = elpis.schedule.update(task.id, { snoozeUntil: null });
  assert.equal(cleared.snoozeUntil, null);
});

test('elpis.schedule.remove: deletes by numeric id', async () => {
  const scheduler = fakeScheduler();
  const g = buildGlobals({
    config: baseConfig(),
    scheduler,
  } as unknown as SandboxDeps);
  const elpis = g.elpis as {
    schedule: ((opts: unknown) => { id: number }) & {
      remove: (ref: number | string) => Promise<boolean>;
    };
  };
  const task = elpis.schedule({
    name: 'by-id',
    payload: 'y',
    nextRunAt: Date.now(),
  });
  assert.equal(await elpis.schedule.remove(task.id), true);
});

test('elpis.schedule.remove: deletes by name', async () => {
  const scheduler = fakeScheduler();
  const g = buildGlobals({
    config: baseConfig(),
    scheduler,
  } as unknown as SandboxDeps);
  const elpis = g.elpis as {
    schedule: ((opts: unknown) => { id: number }) & {
      remove: (ref: number | string) => Promise<boolean>;
    };
  };
  elpis.schedule({ name: 'by-name', payload: 'y', nextRunAt: Date.now() });
  assert.equal(await elpis.schedule.remove('by-name'), true);
});

test('elpis.schedule.remove: throws a teachable error for an unknown name', async () => {
  const scheduler = fakeScheduler();
  const g = buildGlobals({
    config: baseConfig(),
    scheduler,
  } as unknown as SandboxDeps);
  const elpis = g.elpis as {
    schedule: { remove: (ref: number | string) => Promise<boolean> };
  };
  await assert.rejects(
    () => elpis.schedule.remove('nope'),
    /no task named 'nope'/,
  );
});
