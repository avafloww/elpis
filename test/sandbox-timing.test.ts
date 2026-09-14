import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGlobals } from '../src/sandbox/globals.js';
import type { SandboxDeps } from '../src/types.js';
import { makeConfig } from './helpers.js';

// Test the exported capability with a virtual clock. Real-run pause/resume
// wiring is covered by sleep-typing.test.ts.
function timing() {
  const { elpis } = buildGlobals({
    config: makeConfig(),
    logbuf: [],
  } as unknown as SandboxDeps);
  return elpis as {
    sleep(ms?: number): Promise<void>;
    timeout<T>(value: Promise<T>, ms?: number): Promise<T>;
  };
}

test('sleep yields and concurrent waits settle at their own deadlines', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sleep } = timing();
  const completed: string[] = [];
  const long = sleep(80).then(() => completed.push('long'));
  const short = sleep(20).then(() => completed.push('short'));
  assert.deepEqual(completed, []);
  t.mock.timers.tick(19);
  await Promise.resolve();
  assert.deepEqual(completed, []);
  t.mock.timers.tick(1);
  await short;
  assert.deepEqual(completed, ['short']);
  t.mock.timers.tick(60);
  await long;
  assert.deepEqual(completed, ['short', 'long']);
});

test('sleep normalizes missing, negative, and non-finite delays to zero', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { sleep } = timing();
  const pending = [undefined, -50, NaN, Infinity].map((delay) => sleep(delay));
  t.mock.timers.tick(0);
  await Promise.all(pending);
});

test('timeout preserves fulfillment and rejection before the deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { timeout } = timing();
  assert.equal(await timeout(Promise.resolve('kept'), 100), 'kept');
  const error = new Error('original failure');
  await assert.rejects(
    timeout(Promise.reject(error), 100),
    (actual) => actual === error,
  );
  t.mock.timers.tick(100);
});

test('timeout rejects pending work only when its deadline is reached', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { timeout } = timing();
  let rejected = false;
  const pending = timeout(new Promise(() => {}), 30);
  const checked = assert.rejects(pending, (error: Error) => {
    rejected = true;
    assert.match(error.message, /timeout after 30ms/);
    return true;
  });
  t.mock.timers.tick(29);
  await Promise.resolve();
  assert.equal(rejected, false);
  t.mock.timers.tick(1);
  await checked;
});

test('zero and invalid timeout delays leave pending work uncapped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { timeout } = timing();
  let resolve!: (value: string) => void;
  const work = new Promise<string>((done) => {
    resolve = done;
  });
  const pending = [0, undefined, -1, NaN, Infinity].map((delay) =>
    timeout(work, delay),
  );
  t.mock.timers.tick(1000);
  resolve('finished');
  assert.deepEqual(await Promise.all(pending), Array(5).fill('finished'));
});
