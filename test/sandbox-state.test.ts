// test/sandbox-state.test.ts — tests for the elpis.state sandbox global.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals } from '../src/sandbox/globals.js';

test('elpis.state() returns current state when no update provided', () => {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
    readState: () => ({ mood: 'calm' }),
    writeState: () => {},
  });
  const elpis = g.elpis as { state: (updates?: Record<string, unknown>) => unknown };
  assert.deepEqual(elpis.state(), { mood: 'calm' });
});

test('elpis.state(updates) shallow-merges and writes', () => {
  const writes: unknown[] = [];
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
    readState: () => ({ mood: 'calm', energy: 'medium' }),
    writeState: (s) => writes.push(s),
  });
  const elpis = g.elpis as { state: (updates?: Record<string, unknown>) => unknown };
  const result = elpis.state({ energy: 'high' });
  assert.deepEqual(result, { mood: 'calm', energy: 'high' });
  assert.deepEqual(writes, [{ mood: 'calm', energy: 'high' }]);
});

test('elpis.state() returns empty object when readState is missing', () => {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
  });
  const elpis = g.elpis as { state: (updates?: Record<string, unknown>) => unknown };
  assert.deepEqual(elpis.state(), {});
});

test('elpis.state(updates) does not throw when writeState is missing', () => {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
    readState: () => ({ a: 1 }),
  });
  const elpis = g.elpis as { state: (updates?: Record<string, unknown>) => unknown };
  assert.deepEqual(elpis.state({ a: 2 }), { a: 2 });
});
