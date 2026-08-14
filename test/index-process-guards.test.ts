// index-process-guards.test.ts — unit tests for the pure helpers backing
// index.ts's process-level crash guards + unannounced-restart notice
//. index.ts itself is side-effectful on import (it
// runs main at module load), so only the two exported pure decisions are
// tested directly here, not the module's boot sequence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnannouncedRestart, formatProcessErrorNotice } from '../src/index.js';

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
