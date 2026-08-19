import assert from 'node:assert/strict';
import test from 'node:test';
import { adviseWake, fallbackWakeAdvice, snapshotWakeAdvisorState, WAKE_ADVISOR_BUCKETS_MS, type WakeAdvisorState } from '../src/sandbox/wake-advisor.js';
import type { SandboxDeps } from '../src/types.js';

const quiet: WakeAdvisorState = {
  turnKind: 'autonomous', sendsThisTurn: 0, ranCode: false, continuedMindId: null,
  inProgress: [], ready: [], waiting: [], runningBg: 0, nextScheduledInMs: null,
};
const logger = { debug() {}, warn() {} };

function completion(content: string) {
  return { content, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
}

test('wake advisor exposes exactly the approved autonomy cadence buckets', () => {
  assert.deepEqual(WAKE_ADVISOR_BUCKETS_MS, [1, 2, 5, 10, 15, 30, 45, 60].map(minutes => minutes * 60_000));
});

test('wake advisor snapshot is bounded to work facts and ignores reserved run wakes', () => {
  const mind = {
    list(filter: any) {
      if (filter.ready) return [{ id: 2, title: ' ready   thing ' }];
      if (filter.statuses?.includes('in_progress')) return [{ id: 1, title: 'ship\nthing' }, { id: 9, title: 'x'.repeat(200) }];
      if (filter.statuses?.includes('waiting')) return [{ id: 3, title: 'wait' }];
      return [];
    },
  };
  const deps = {
    mind,
    bg: { list: () => [{ running: true }, { running: false }] },
    scheduler: { list: () => [
      { name: '__elpis_run_wake_v3__-old', nextRunAt: 10_100, doneAt: null },
      { name: 'real', nextRunAt: 40_000, doneAt: null },
    ] },
  } as unknown as Pick<SandboxDeps, 'mind' | 'bg' | 'scheduler'>;
  const state = snapshotWakeAdvisorState(deps, { turnKind: 'person', sendsThisTurn: 1, ranCode: false, continuedMindId: null }, 10_000);
  assert.deepEqual(state.inProgress[0], { id: 1, title: 'ship thing' });
  assert.equal(state.inProgress[1]?.title.length, 120);
  assert.deepEqual(state.ready, [{ id: 2, title: ' ready thing ' }]);
  assert.equal(state.runningBg, 1);
  assert.equal(state.nextScheduledInMs, 30_000);
});

test('wake advisor accepts only fixed-bucket strict JSON and uses a fresh isolated lane', async () => {
  let cacheKey = '';
  let prompt = '';
  const deps = {
    completeStandalone: async (messages: any[], opts: any) => {
      cacheKey = opts.cacheKey;
      prompt = messages[1].content;
      return completion('{"minutes":2,"reason":"active-work"}');
    },
  } as Pick<SandboxDeps, 'completeStandalone'>;
  const result = await adviseWake(deps, { ...quiet, inProgress: [{ id: 7, title: 'keep going' }] }, logger, 100);
  assert.deepEqual(result, { delayMs: 120_000, reason: 'active-work', source: 'classifier' });
  assert.match(cacheKey, /^wake-advisor-/);
  assert.match(prompt, /"inProgress"/);
  assert.doesNotMatch(prompt, /transcript|message history/i);
});

test('wake advisor failure and nonconforming output fall back deterministically without failing yield', async () => {
  const active = { ...quiet, inProgress: [{ id: 7, title: 'work' }] };
  assert.deepEqual(fallbackWakeAdvice(active), { delayMs: 300_000, reason: 'active-work', source: 'fallback' });
  assert.deepEqual(fallbackWakeAdvice({ ...active, ranCode: true, continuedMindId: 7 }), { delayMs: 120_000, reason: 'active-work', source: 'fallback' });
  const malformed = await adviseWake({ completeStandalone: async () => completion('{"minutes":3,"reason":"active-work"}') }, active, logger, 100);
  assert.deepEqual(malformed, fallbackWakeAdvice(active));
  const timedOut = await adviseWake({ completeStandalone: async () => await new Promise(() => {}) }, quiet, logger, 5);
  assert.deepEqual(timedOut, { delayMs: 3_600_000, reason: 'quiet-exploration', source: 'fallback' });
});
