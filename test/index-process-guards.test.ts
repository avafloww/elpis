// index-process-guards.test.ts — unit tests for the pure helpers backing
// index.ts's process-level crash guards + unannounced-restart notice
//. Importing index.ts must remain side-effect free; the production entrypoint
// calls the exported runtime composition only when executed directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElpisRuntime, isUnannouncedRestart, formatProcessErrorNotice, formatSandboxLateProcessErrorNotice } from '../src/index.js';

test('production runtime composition is exported without booting on import', () => {
  assert.equal(typeof createElpisRuntime, 'function');
});

test('isUnannouncedRestart: non-empty resume + no marker → true', () => {
  assert.equal(isUnannouncedRestart(42, false), true);
});

test('isUnannouncedRestart: marker consumed → false (agent-initiated)', () => {
  assert.equal(isUnannouncedRestart(42, true), false);
});

test('isUnannouncedRestart: empty transcript → false (fresh boot)', () => {
  assert.equal(isUnannouncedRestart(0, false), false);
});

test('formatProcessErrorNotice: prefixes kind and includes message', () => {
  const out = formatProcessErrorNotice('unhandledRejection', new Error('boom'));
  assert.match(out, /^\[harness unhandledRejection\]/);
  assert.match(out, /boom/);
});

test('formatSandboxLateProcessErrorNotice: identifies stale sandbox owner without harness blame', () => {
  const out = formatSandboxLateProcessErrorNotice({ kind: 'uncaughtException', error: new Error('missing preview'), alias: 'quiet-otter', generation: 4, runId: 'executor:g4:r9' });
  assert.match(out, /^\[sandbox late uncaughtException alias=quiet-otter generation=4 run=executor:g4:r9\]/);
  assert.match(out, /missing preview/);
  assert.doesNotMatch(out, /^\[harness/);
});
