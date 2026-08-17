import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals } from '../src/sandbox/globals.js';
import { resolveBuiltinModules } from '../src/builtin-modules.js';
import { makeConfig } from './helpers.js';
import type { SandboxDeps } from '../src/types.js';

function globals(config = makeConfig(), restricted = false) {
  const deps = {
    config,
    modules: resolveBuiltinModules(config),
    profile: { restricted, source: restricted ? 'sentinel' : 'normal' },
    memory: { read: () => '', append: () => undefined, overwrite: () => undefined },
    logbuf: [],
  } as unknown as SandboxDeps;
  return buildGlobals(deps).elpis as Record<string, unknown>;
}

for (const [id, keys] of [['kagi', ['search', 'extract']], ['bsky', ['bsky']], ['browser', ['browser']], ['computer', ['computer']], ['motor', ['motor']], ['fleet', ['fleet']]] as const) {
  test(`disabled ${id} module is entirely absent`, () => {
    const e = globals(makeConfig({ modules: { enabled: [], disabled: [] } }));
    for (const key of keys) {
      assert.equal(Object.keys(e).includes(key), false);
      assert.equal(e[key], undefined);
    }
  });
}

test('selected but unconfigured Kagi is enumerable, omitted functionality rejects precisely', async () => {
  const e = globals(makeConfig({ modules: { enabled: ['kagi'], disabled: [] } }));
  assert.equal(Object.keys(e).includes('search'), true);
  assert.equal(Object.keys(e).includes('extract'), true);
  await assert.rejects((e.search as (...args: unknown[]) => Promise<unknown>)('x'), /Kagi is selected but not configured/);
});

test('selected but unconfigured Bluesky exposes a diagnostic method stub', async () => {
  const e = globals(makeConfig({ modules: { enabled: ['bsky'], disabled: [] } }));
  assert.equal(Object.keys(e).includes('bsky'), true);
  await assert.rejects(((e.bsky as Record<string, unknown>).post as (...args: unknown[]) => Promise<unknown>)('x'), /Bluesky is selected but not configured/);
});

test('selected but config-disabled fleet is unavailable and diagnostic', async () => {
  const baseline = makeConfig();
  const e = globals(makeConfig({ modules: { enabled: ['fleet'], disabled: [] }, fleet: { ...baseline.fleet, enabled: false } }));
  assert.equal(Object.keys(e).includes('fleet'), true);
  await assert.rejects(((e.fleet as Record<string, unknown>).run as (...args: unknown[]) => Promise<unknown>)('x'), /fleet is selected but disabled/);
});

test('selected motor with excluded computer is unavailable rather than disabled', async () => {
  const e = globals(makeConfig({ modules: { enabled: ['motor'], disabled: [] } }));
  assert.equal(Object.keys(e).includes('motor'), true);
  await assert.rejects(((e.motor as Record<string, unknown>).step as (...args: unknown[]) => Promise<unknown>)('x'), /requires an active computer module/);
});

test('restricted profile removes sudo, restart, and deploy entirely', () => {
  const e = globals(makeConfig({ modules: { enabled: [], disabled: [] } }), true);
  for (const key of ['sudo', 'restart', 'deploy']) {
    assert.equal(Object.keys(e).includes(key), false);
    assert.equal(e[key], undefined);
  }
  assert.equal(typeof e.sh, 'function');
  assert.equal(typeof e.git, 'object');
});
