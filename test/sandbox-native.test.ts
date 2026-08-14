// test/sandbox-native.test.ts — tests for the elpis.native sandbox global.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals } from '../src/sandbox/globals.js';

test('elpis.native() forwards to deps.native and returns its result', () => {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
    native: (text) => ({ ok: true, path: `/tmp/${text}` }),
  });
  const elpis = g.elpis as { native: (text: string) => { ok: boolean; path: string } };
  const res = elpis.native('hello');
  assert.equal(res.ok, true);
  assert.equal(res.path, '/tmp/hello');
});

test('elpis.native() returns a graceful failure when not configured', () => {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
  });
  const elpis = g.elpis as { native: (text: string) => { ok: boolean; note: string } };
  const res = elpis.native('hello');
  assert.equal(res.ok, false);
  assert.equal(res.note, 'elpis.native() is not configured in this sandbox');
});
