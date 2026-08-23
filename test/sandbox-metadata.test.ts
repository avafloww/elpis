import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRunMessageMetadata } from '../src/sandbox/metadata.js';

test('run metadata parser restores bounded execution and wake attribution', () => {
  const parsed = parseRunMessageMetadata({
    toolContractVersion: 'elpis-run-v4',
    ok: true,
    detail: 'Ship the verified fixture',
    detached: true,
    bgId: 'f1',
    execution: {
      kind: 'persistent',
      lifecycle: 'detached',
      alias: 'quietly-crimson-ibis',
      mindId: 'elm-a2b3k7q9',
      mindTitle: 'ship the thing',
      mindStatus: 'in_progress',
      latestComment: 'still working',
      executorId: 'executor-1',
      generation: 3,
      resetGeneration: 4,
      runId: 'executor-1:g3:r8',
      coldStart: true,
      retiring: true,
      retirementDeadlineAt: 2000,
      retirementWarning: 'use active work',
      statusReminder: true,
      classifierReminder: false,
      ignored: 'drop me',
    },
    wake: {
      kind: 'auto',
      state: 'armed',
      requestedAt: 1000,
      targetAt: 2000,
      taskId: 7,
      note: 'armed',
      advice: { source: 'classifier', delayMs: 120_000, reason: 'active-work' },
    },
    ignored: 'drop me',
  });
  assert.deepEqual(parsed, {
    toolContractVersion: 'elpis-run-v4',
    ok: true,
    detail: 'Ship the verified fixture',
    detached: true,
    bgId: 'f1',
    execution: {
      kind: 'persistent',
      lifecycle: 'detached',
      alias: 'quietly-crimson-ibis',
      mindId: 'elm-a2b3k7q9',
      mindTitle: 'ship the thing',
      mindStatus: 'in_progress',
      latestComment: 'still working',
      executorId: 'executor-1',
      generation: 3,
      resetGeneration: 4,
      runId: 'executor-1:g3:r8',
      coldStart: true,
      retiring: true,
      retirementDeadlineAt: 2000,
      retirementWarning: 'use active work',
      statusReminder: true,
      classifierReminder: false,
    },
    wake: {
      kind: 'auto',
      state: 'armed',
      requestedAt: 1000,
      targetAt: 2000,
      taskId: 7,
      note: 'armed',
      advice: { source: 'classifier', delayMs: 120_000, reason: 'active-work' },
    },
  });
});

test('run metadata parser rejects envelopes and drops malformed nested fields', () => {
  assert.equal(parseRunMessageMetadata(null), undefined);
  assert.equal(parseRunMessageMetadata({ ok: true }), undefined);
  assert.equal(
    parseRunMessageMetadata({ toolContractVersion: 'v3', ok: 'yes' }),
    undefined,
  );
  assert.deepEqual(
    parseRunMessageMetadata({
      toolContractVersion: 'v3',
      ok: false,
      detail: 'one two three four five six seven eight nine ten eleven',
      execution: {
        kind: 'persistent',
        alias: 'x'.repeat(300),
        generation: 1.5,
      },
      wake: { kind: 'after', state: 'armed', requestedAt: 1.5 },
    }),
    { toolContractVersion: 'v3', ok: false, execution: { kind: 'persistent' } },
  );
});
