import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGlobals } from '../src/sandbox/globals.js';
import type { SandboxDeps } from '../src/types.js';
import { makeConfig } from './helpers.js';

function deps(surface: 'full' | 'core' | 'worker') {
  const calls: unknown[] = [];
  const worker = {
    async start(mindId: unknown, options?: unknown) {
      calls.push(['start', mindId, options]);
      return { id: 'wrk-a1b2c3d4' } as never;
    },
    async send(ref: string, text: string) {
      calls.push(['send', ref, text]);
      return { id: 1 } as never;
    },
    async followup(ref: string, text?: string) {
      calls.push(['followup', ref, text]);
      return { continuity: 'fresh_same_mind' } as never;
    },
    async list() {
      calls.push(['list']);
      return [];
    },
    async status(ref: string) {
      calls.push(['status', ref]);
      return {
        session: { id: 'wrk-a1b2c3d4' },
        messages: [],
        artifacts: [],
      } as never;
    },
    async artifact(ref: string, key?: string) {
      calls.push(['artifact', ref, key]);
      return { localPath: '/tmp/artifact' } as never;
    },
    async dismiss(ref: string) {
      calls.push(['dismiss', ref]);
      return { id: 'wrk-a1b2c3d4' } as never;
    },
  };
  return {
    calls,
    value: {
      config: makeConfig(),
      surface,
      worker,
      memory: {
        read: () => '',
        append: () => undefined,
        overwrite: () => undefined,
      },
      logbuf: [],
    } as unknown as SandboxDeps,
  };
}

test('full sandbox exposes a frozen forwarding worker supervisor', async () => {
  const f = deps('full');
  const elpis = buildGlobals(f.value).elpis as any;
  assert.deepEqual(Object.keys(elpis.worker).sort(), [
    'artifact',
    'dismiss',
    'followup',
    'list',
    'send',
    'start',
    'status',
  ]);
  await elpis.worker.start('elm-a1b2c3d4', { modelRef: 'p/model' });
  await elpis.worker.send('quiet-otter', 'steer');
  await elpis.worker.followup('quiet-otter', 'continue durably');
  await elpis.worker.status('quiet-otter');
  await elpis.worker.artifact('quiet-otter', 'workspace.patch.gz');
  await elpis.worker.list();
  await elpis.worker.dismiss('quiet-otter');
  assert.deepEqual(f.calls, [
    ['start', 'elm-a1b2c3d4', { modelRef: 'p/model' }],
    ['send', 'quiet-otter', 'steer'],
    ['followup', 'quiet-otter', 'continue durably'],
    ['status', 'quiet-otter'],
    ['artifact', 'quiet-otter', 'workspace.patch.gz'],
    ['list'],
    ['dismiss', 'quiet-otter'],
  ]);
  assert.equal(Object.isFrozen(elpis.worker), true);
});

test('worker supervision is absent from core and worker sandboxes', () => {
  for (const surface of ['core', 'worker'] as const) {
    const f = deps(surface);
    const elpis = buildGlobals(f.value).elpis as Record<string, unknown>;
    assert.equal(elpis.worker, undefined);
    assert.equal(Object.keys(elpis).includes('worker'), false);
  }
});
