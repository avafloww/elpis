import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals } from '../src/sandbox/globals.js';

test('elpis.channel.list() returns { id, name } objects when names are available', () => {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
    listChannelsWithNames: () => [
      { id: '111', name: 'aster' },
      { id: '222', name: 'harness-work' },
    ],
  } as unknown as import('../src/types.js').SandboxDeps);
  const elpis = g.elpis as { channel: { list: () => { id: string; name: string }[] } };
  const result = elpis.channel.list();
  assert.deepEqual(result, [
    { id: '111', name: 'aster' },
    { id: '222', name: 'harness-work' },
  ]);
});

test('elpis.channel.list() falls back to ids with null names when names are unavailable', () => {
  const g = buildGlobals({
    config: { paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' }, sandbox: { syncTimeoutMs: 5000, asyncDeadlineMs: 10000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null } },
    listChannels: () => ['111', '222'],
  } as unknown as import('../src/types.js').SandboxDeps);
  const elpis = g.elpis as { channel: { list: () => { id: string; name: string | null }[] } };
  const result = elpis.channel.list();
  assert.deepEqual(result, [
    { id: '111', name: null },
    { id: '222', name: null },
  ]);
});
