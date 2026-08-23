import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGlobals,
  createRunLogger,
  runScope,
} from '../src/sandbox/globals.js';
import type { ExtensionRegistry } from '../src/extensions.js';

const config = {
  paths: { dataDirectory: '/tmp', harnessRoot: '/tmp' },
  sandbox: {
    syncTimeoutMs: 5000,
    asyncDeadlineMs: 10000,
    previewMaxBytes: 2048,
    logMaxBytes: 2048,
  },
  kagi: { apiKey: null },
};

function registry(): ExtensionRegistry {
  const api = Object.freeze(
    Object.assign(Object.create(null), {
      add: (a: number, b: number) => a + b,
    }),
  );
  const apis = Object.freeze(
    Object.assign(Object.create(null), { sample: api }),
  );
  return Object.freeze({
    apis,
    summaries: Object.freeze([
      Object.freeze({
        namespace: 'sample',
        file: 'sample.ext.ts',
        description: 'fixture',
        members: Object.freeze(['add']),
      }),
    ]),
    failures: Object.freeze([]),
    prompt: '',
  });
}

test('elpis.ext exposes frozen namespaced APIs and deterministic help', () => {
  const globals = buildGlobals({ config, extensions: registry() } as never);
  const elpis = globals.elpis as {
    ext: {
      sample: { add(a: number, b: number): number };
      $help(namespace?: string): unknown;
      $failures(): unknown[];
    };
  };
  assert.equal(elpis.ext.sample.add(20, 22), 42);
  assert.deepEqual(elpis.ext.$help('sample'), {
    namespace: 'sample',
    file: 'sample.ext.ts',
    description: 'fixture',
    members: ['add'],
  });
  assert.ok(Object.isFrozen(elpis.ext));
  assert.ok(Object.isFrozen(elpis.ext.sample));
  assert.deepEqual(elpis.ext.$failures(), []);
  assert.throws(
    () => elpis.ext.$help('missing'),
    /unknown extension namespace/,
  );
});

test('elpis.ext exists with empty help when no extensions are loaded', () => {
  const globals = buildGlobals({ config } as never);
  const elpis = globals.elpis as {
    ext: { $help(): unknown[]; $failures(): unknown[] };
  };
  assert.deepEqual(elpis.ext.$help(), []);
  assert.deepEqual(elpis.ext.$failures(), []);
  assert.deepEqual(Object.keys(elpis.ext).sort(), ['$failures', '$help']);
});

test('extension runLog follows the active run scope and otherwise uses its shared fallback', () => {
  const fallback: string[] = [];
  const log = createRunLogger(fallback);
  const scoped: string[] = [];
  runScope.run({ logbuf: scoped, childPids: new Set(), sends: [] }, () =>
    log('inside', 42),
  );
  assert.deepEqual(scoped, ['inside 42']);
  assert.deepEqual(fallback, []);
  log('outside', 7);
  assert.deepEqual(fallback, ['outside 7']);
});
