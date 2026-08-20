import assert from 'node:assert/strict';
import test from 'node:test';
import { adviseWake, buildWakeAdvisorHistory, fallbackWakeAdvice, snapshotWakeAdvisorState, WAKE_ADVISOR_BUCKETS_MS, WAKE_ADVISOR_TIMEOUT_MS, type WakeAdvisorState } from '../src/sandbox/wake-advisor.js';
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
  assert.equal(WAKE_ADVISOR_TIMEOUT_MS, 30_000);
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

test('wake advisor history keeps two same-channel completed turns plus the current bounded run', () => {
  const ended = (id: string, channel: string, code = 'return 1') => [
    { role: 'user', content: `wake ${id}`, channel },
    {
      role: 'assistant', content: `response ${id}`, channel,
      reasoning_content: `summary ${id}`,
      reasoning_items: [{ type: 'reasoning', summary: [], encrypted_content: `opaque-${id}` }],
      tool_calls: [{ id, type: 'function', function: { name: 'run', arguments: JSON.stringify({ code, detail: `detail ${id}`, wake: { auto: true } }) } }],
    },
    {
      role: 'tool', tool_call_id: id, content: `[run ok] ${id}`, channel,
      run: { toolContractVersion: 4, ok: true, wake: { kind: 'auto', state: 'armed', requestedAt: 1, targetAt: 2 } },
    },
  ] as any[];
  const messages = [
    ...ended('other', 'other-room'),
    ...ended('old', 'room'),
    ...ended('middle', 'room'),
    { role: 'user', content: 'current wake', channel: 'room' },
    {
      role: 'assistant', content: 'current response', channel: 'room',
      reasoning_items: [{ type: 'reasoning', summary: [], encrypted_content: 'opaque-current' }],
      tool_calls: [{ id: 'current', type: 'function', function: { name: 'run', arguments: JSON.stringify({ code: 'x'.repeat(10_000), detail: 'current detail', wake: { auto: true } }) } }],
    },
  ] as any[];
  const history = buildWakeAdvisorHistory(messages, 'room', {
    role: 'tool', tool_call_id: 'current', content: 'y'.repeat(10_000), run: { toolContractVersion: 4, ok: true },
  } as any);
  assert.equal(history.some(message => message.content.includes('other')), false);
  assert.deepEqual(history.filter(message => message.role === 'user').map(message => message.content), ['wake old', 'wake middle', 'current wake']);
  assert.deepEqual(history.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['old', 'middle', 'current']);
  assert.equal(history.filter(message => message.role === 'assistant').every(message => message.reasoning_items?.length === 1), true);
  const current = history.find(message => message.role === 'assistant' && message.tool_calls?.[0]?.id === 'current')!;
  assert.ok(current.tool_calls![0].function.arguments.length < 5_000);
  assert.match(current.tool_calls![0].function.arguments, /omitted sha256=/);
  assert.ok(history.at(-1)!.content.length < 5_000);
  assert.match(history.at(-1)!.content, /omitted sha256=/);
});

test('wake advisor sends bounded historical tool context with authoritative current state', async () => {
  let cacheKey = '';
  let prompt = '';
  let captured: any[] = [];
  let options: any;
  const history = [
    { role: 'user', content: 'prior wake' },
    { role: 'assistant', content: 'checked job', tool_calls: [{ id: 'c', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: '[run ok] still running' },
  ] as any[];
  const deps = {
    completeStandalone: async (messages: any[], opts: any) => {
      captured = messages;
      options = opts;
      cacheKey = opts.cacheKey;
      prompt = messages.at(-1).content;
      return completion('{"minutes":5,"reason":"background-wait"}');
    },
  } as Pick<SandboxDeps, 'completeStandalone'>;
  const result = await adviseWake(deps, { ...quiet, runningBg: 1, inProgress: [{ id: 7, title: 'keep going' }] }, logger, 100, history);
  assert.deepEqual(result, { delayMs: 300_000, reason: 'background-wait', source: 'classifier' });
  assert.match(cacheKey, /^wake-advisor-/);
  assert.equal(options.allowHistoricalToolMessages, true);
  assert.deepEqual(captured.slice(1, -1), history);
  assert.match(prompt, /"runningBg":1/);
  assert.match(captured[0].content, /current structured state.*outranks/i);
});

test('wake advisor failure and nonconforming output fall back deterministically without failing yield', async () => {
  const active = { ...quiet, inProgress: [{ id: 7, title: 'work' }] };
  assert.deepEqual(fallbackWakeAdvice(active), { delayMs: 300_000, reason: 'active-work', source: 'fallback' });
  assert.deepEqual(fallbackWakeAdvice({ ...active, ranCode: true, continuedMindId: 7 }), { delayMs: 120_000, reason: 'active-work', source: 'fallback' });
  assert.deepEqual(fallbackWakeAdvice({ ...active, ranCode: true, continuedMindId: 7, runningBg: 1 }), { delayMs: 300_000, reason: 'background-wait', source: 'fallback' });
  const malformed = await adviseWake({ completeStandalone: async () => completion('{"minutes":3,"reason":"active-work"}') }, active, logger, 100);
  assert.deepEqual(malformed, fallbackWakeAdvice(active));
  const timedOut = await adviseWake({ completeStandalone: async () => await new Promise(() => {}) }, quiet, logger, 5);
  assert.deepEqual(timedOut, { delayMs: 3_600_000, reason: 'quiet-exploration', source: 'fallback' });
  const warnings: string[] = [];
  const failed = await adviseWake(
    { completeStandalone: async () => { throw new Error('classifier lane broke'); } },
    quiet,
    { debug() {}, warn(message: string) { warnings.push(message); } },
    100,
  );
  assert.deepEqual(failed, fallbackWakeAdvice(quiet));
  assert.deepEqual(warnings, ['wake advisor unavailable: classifier lane broke']);
});
