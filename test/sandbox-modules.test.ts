import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGlobals } from '../src/sandbox/globals.js';
import { resolveBuiltinModules } from '../src/builtin-modules.js';
import { makeConfig } from './helpers.js';
import type { SandboxDeps } from '../src/types.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

function globals(config = makeConfig(), restricted = false) {
  const deps = {
    config,
    modules: resolveBuiltinModules(config),
    profile: { restricted, source: restricted ? 'sentinel' : 'normal' },
    memory: {
      read: () => '',
      append: () => undefined,
      overwrite: () => undefined,
    },
    logbuf: [],
  } as unknown as SandboxDeps;
  return buildGlobals(deps).elpis as Record<string, unknown>;
}

for (const [id, keys] of [
  ['kagi', ['search', 'extract']],
  ['bsky', ['bsky']],
  ['browser', ['browser']],
  ['computer', ['computer']],
  ['motor', ['motor']],
] as const) {
  test(`disabled ${id} module is entirely absent`, () => {
    const e = globals(makeConfig({ modules: { enabled: [], disabled: [] } }));
    for (const key of keys) {
      assert.equal(Object.keys(e).includes(key), false);
      assert.equal(e[key], undefined);
    }
  });
}

test('selected but unconfigured Kagi is enumerable, omitted functionality rejects precisely', async () => {
  const e = globals(
    makeConfig({ modules: { enabled: ['kagi'], disabled: [] } }),
  );
  assert.equal(Object.keys(e).includes('search'), true);
  assert.equal(Object.keys(e).includes('extract'), true);
  await assert.rejects(
    (e.search as (...args: unknown[]) => Promise<unknown>)('x'),
    /Kagi is selected but not configured/,
  );
  await assert.rejects(
    (e.extract as (...args: unknown[]) => Promise<unknown>)(
      'https://example.com',
    ),
    /Kagi is selected but not configured/,
  );
});

test('selected but unconfigured Bluesky exposes a diagnostic method stub', async () => {
  const e = globals(
    makeConfig({ modules: { enabled: ['bsky'], disabled: [] } }),
  );
  assert.equal(Object.keys(e).includes('bsky'), true);
  await assert.rejects(
    (
      (e.bsky as Record<string, unknown>).post as (
        ...args: unknown[]
      ) => Promise<unknown>
    )('x'),
    /Bluesky is selected but not configured/,
  );
});

test('selected motor with excluded computer is unavailable rather than disabled', async () => {
  const e = globals(
    makeConfig({ modules: { enabled: ['motor'], disabled: [] } }),
  );
  assert.equal(Object.keys(e).includes('motor'), true);
  await assert.rejects(
    (
      (e.motor as Record<string, unknown>).step as (
        ...args: unknown[]
      ) => Promise<unknown>
    )('x'),
    /requires an active computer module/,
  );
});

test('restricted profile keeps brokered restart but removes sudo and deploy', () => {
  const e = globals(
    makeConfig({ modules: { enabled: [], disabled: [] } }),
    true,
  );
  for (const key of ['sudo', 'deploy']) {
    assert.equal(Object.keys(e).includes(key), false);
    assert.equal(e[key], undefined);
  }
  assert.equal(typeof e.restart, 'function');
  assert.equal(typeof e.sh, 'function');
  assert.equal(typeof e.git, 'object');
});

test('restricted restart flushes and preserves resume state only when broker accepts', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restricted-restart-'));
  let flushed = 0;
  let requested: string | undefined;
  const config = makeConfig({
    paths: { ...makeConfig().paths, dataDirectory: dir },
  });
  const acceptedDeps = {
    config,
    modules: resolveBuiltinModules(config),
    profile: { restricted: true, source: 'sentinel' },
    memory: {
      read: () => '',
      append: () => undefined,
      overwrite: () => undefined,
    },
    logbuf: [],
    flushTranscripts: () => {
      flushed += 1;
    },
    requestRestrictedRestart: async (reason?: string) => {
      requested = reason;
    },
  } as unknown as SandboxDeps;
  const accepted = buildGlobals(acceptedDeps).elpis as Record<string, unknown>;
  const result = await (
    accepted.restart as (
      reason?: string,
    ) => Promise<{ ok: boolean; note: string }>
  )('load extension');
  assert.equal(result.ok, true);
  assert.equal(flushed, 1);
  assert.equal(requested, 'load extension');
  assert.equal(
    JSON.parse(fs.readFileSync(resolveDataLayout(dir).resumeMarker, 'utf8'))
      .reason,
    'load extension',
  );

  acceptedDeps.requestRestrictedRestart = async () => {
    throw new Error('broker unavailable');
  };
  const rejected = buildGlobals(acceptedDeps).elpis as Record<string, unknown>;
  const failure = await (
    rejected.restart as () => Promise<{ ok: boolean; note: string }>
  )();
  assert.equal(failure.ok, false);
  assert.match(failure.note, /broker unavailable/);
  assert.equal(fs.existsSync(resolveDataLayout(dir).resumeMarker), false);
});
