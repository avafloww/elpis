// sandbox-channel-moderate.test.ts — the killswitch's sandbox-side asymmetry
// elpis.channel(ref) exposes .mute only, never
// .unmute/.deafen, and .mute delegates to deps.moderate untouched. This
// is the other half of the asymmetry from moderation.test.ts (which covers
// Agent.moderateChannel) — a later widening of SandboxDeps.moderate to take an
// action/actor would silently dissolve the asymmetry without a test like this
// one to catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals } from '../src/sandbox/globals.js';

const baseConfig = {
  paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
  sandbox: {
    syncTimeoutMs: 5000,
    asyncDeadlineMs: 10000,
    previewMaxBytes: 2048,
    logMaxBytes: 2048,
  },
  kagi: { apiKey: null },
};

function buildHandle(
  moderate?: (
    channelId: string,
    reason?: string,
  ) => { ok: boolean; note: string },
) {
  const g = buildGlobals({
    config: baseConfig,
    send: async () => {},
    moderate,
  } as unknown as import('../src/types.js').SandboxDeps);
  const elpis = g.elpis as {
    channel: (id?: string) => Record<string, unknown>;
  };
  return elpis.channel('2001');
}

test('elpis.channel(ref) handle exposes mute() but no unmute()/deafen()', () => {
  const handle = buildHandle(() => ({ ok: true, note: 'muted' }));
  assert.equal(typeof handle.mute, 'function');
  assert.equal(handle.unmute, undefined);
  assert.equal(handle.deafen, undefined);
});

test('elpis.channel(ref).mute(reason) delegates to deps.moderate with the channel id and reason', () => {
  const calls: { channelId: string; reason?: string }[] = [];
  const handle = buildHandle((channelId: string, reason?: string) => {
    calls.push({ channelId, reason });
    return {
      ok: true,
      note: `channel ${channelId} muted by Echo (self): ${reason}`,
    };
  });
  const mute = handle.mute as (reason?: string) => {
    ok: boolean;
    channelId: string;
    note: string;
  };
  const result = mute('taking a break');
  assert.deepEqual(calls, [{ channelId: '2001', reason: 'taking a break' }]);
  assert.equal(result.ok, true);
  assert.equal(result.channelId, '2001');
  assert.match(result.note, /muted by Echo \(self\): taking a break/);
});

test('elpis.channel(ref).mute() throws when deps.moderate is not wired', () => {
  const handle = buildHandle(undefined);
  const mute = handle.mute as (reason?: string) => unknown;
  assert.throws(
    () => mute('reason'),
    /elpis\.channel\(\)\.mute\(\) is not wired/,
  );
});
