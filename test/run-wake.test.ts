// Behaviour tests for explicit run wakes: only a final successful,
// non-detached run that durably arms a wake yields; anything else continues.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_TOOL, THINK_TOOL, externalThinkingJuice } from '../src/llm/llm.js';
import { buildTestAgent, EMPTY_WAKE, makeConfig } from './helpers.js';
import type { LLM, CompleteOptions, CompleteResult, ChatMessage } from '../src/llm/llm.js';
import type { MindListFilter, MindService } from '../src/store/mind.js';
import type { Agent } from '../src/agent.js';
import { YIELD_NUDGE_ALERT_AT, YIELD_NUDGE_REALERT_EVERY } from '../src/agent.js';
import type { ConsoleHub } from '../src/console/hub.js';
import type { Logger } from '../src/lib/log.js';

test('RUN_TOOL requires code/detail and keeps sandbox/wake optional', () => {
  const params = RUN_TOOL.function.parameters;
  assert.equal(Object.hasOwn(params.properties, 'end'), false);
  assert.equal(params.properties.sandbox.type, 'string');
  assert.equal(params.properties.wake.type, 'object');
  assert.deepEqual(params.required, ['code', 'detail']);
  assert.equal(params.properties.code.type, 'string');
  assert.equal(params.properties.detail.maxLength, 120);
});

test('external-thinking JUICE preserves the chosen effort after native reasoning is disabled', () => {
  assert.equal(externalThinkingJuice('low'), 4);
  assert.equal(externalThinkingJuice('high'), 48);
  assert.equal(externalThinkingJuice('max'), 960);
  assert.equal(externalThinkingJuice('unknown'), 8);
});

test('the wake description prefers auto and caps explicit waits at one hour', () => {
  assert.match(RUN_TOOL.function.parameters.properties.wake.description, /prefer auto/i);
  assert.match(RUN_TOOL.function.parameters.properties.wake.description, /at most 1h/i);
  assert.match(RUN_TOOL.function.parameters.properties.wake.description, /Scheduler/i);
});

/** A scripted LLM that yields a macrotask per call. The yield is mandatory: on a
 * no-tool-call response the loop's only await is `complete`, so a
 * `Promise.resolve` stub starves the macrotask queue and setTimeout-based waits
 * never fire. */
function scriptedLLM(responses: CompleteResult[]): LLM & { calls: number; requests: ChatMessage[][]; options: CompleteOptions[] } {
  let i = 0;
  let calls = 0;
  const requests: ChatMessage[][] = [];
  const options: CompleteOptions[] = [];
  return {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    get calls() { return calls; },
    requests,
    options,
    async complete(messages: ChatMessage[], completeOptions: CompleteOptions = {}): Promise<CompleteResult> {
      calls++;
      requests.push(messages);
      options.push(completeOptions);
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      await new Promise((res) => setImmediate(res));
      return r;
    },
    summarize(): Promise<string> { return Promise.resolve('SUMMARY'); },
  } as LLM & { calls: number; requests: ChatMessage[][]; options: CompleteOptions[] };
}

function userMsg(): Parameters<Agent['enqueue']>[0] {
  return {
    id: 'm1', channelId: '100', channelName: '100', author: 'u', authorId: 'u',
    content: 'hi', createdAt: '2026-01-01T00:00:00Z',
    replyTo: null, forwarded: null, mentions: [], attachments: [], kind: 'discord',
  };
}

async function settle(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function runCall(code: string, wake: boolean): CompleteResult {
  return {
    message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ code, detail: 'Exercise run wake handling', ...(wake ? { wake: { after: '1h' } } : {}) }) } }],
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function thinkCall(thoughts: string): CompleteResult {
  return {
    message: {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'think1', type: 'function', function: { name: 'think', arguments: JSON.stringify({ thoughts }) } }],
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** A single response carrying MULTIPLE tool_calls, each independently
 * {code, wake} — for exercising final-call yield behavior within
 * one dispatch. */
function multiRunCall(calls: { code: string; wake: boolean }[]): CompleteResult {
  return {
    message: {
      role: 'assistant', content: '',
      tool_calls: calls.map((c, i) => ({
        id: `tc${i + 1}`, type: 'function' as const,
        function: { name: 'run', arguments: JSON.stringify({ code: c.code, detail: 'Exercise final wake selection', ...(c.wake ? { wake: { after: '1h' } } : {}) }) },
      })),
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

test('wake on a successful final run yields with no further completion', async () => {
  const llm = scriptedLLM([runCall('1 + 1', true)]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-ok-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  assert.equal(llm.calls, 1, 'exactly one completion — no turn-end round trip');
  cleanup();
});

test('shared test agents expose the current inbound during a real turn and clear it when idle', async () => {
  const llm = scriptedLLM([runCall("if (elpis.inbound?.channelId !== '100') throw new Error('missing current inbound')", true)]);
  const { agent, inboundRef, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-inbound-ref-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  assert.equal(llm.calls, 1, 'documented elpis.inbound access must succeed on the first dispatch');
  assert.equal(inboundRef.current, null, 'the current inbound must clear after the turn parks');
  agent.stop();
  cleanup();
});

test('shared test agents intercept elpis.restart without spawning a real service command', async () => {
  const llm = scriptedLLM([runCall("const result = elpis.restart('contained'); if (!result.note.includes('simulated in test harness')) throw new Error(result.note)", true)]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-restart-seam-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  assert.equal(llm.calls, 1, 'the simulated restart should succeed and end the turn');
  agent.stop();
  cleanup();
});

test('external thinking is forced once on each outer turn, then the separator continuation is ordinary', async () => {
  assert.deepEqual(THINK_TOOL.function.parameters.required, ['thoughts']);
  const thought = 'need inspect the actual edge before choosing';
  const llm = scriptedLLM([thinkCall(thought), runCall('', true)]);
  const base = makeConfig();
  const { agent, sent, cleanup } = buildTestAgent({
    llm,
    config: { llm: { ...base.llm, externalThinking: true } },
    tmpPrefix: 'harness-external-think-',
  });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();

  assert.equal(llm.calls, 2);
  assert.equal(llm.options[0].forceThink, true, 'first model request must force think');
  assert.equal(llm.options[1].forceThink, false, 'post-think continuation must return to normal choice');
  assert.equal(sent.length, 0, 'think arguments never become chat output');
  const thinkMessage = agent.messagesForTest.find((message) =>
    message.role === 'assistant' && message.tool_calls?.some((call) => call.function.name === 'think'));
  assert.ok(thinkMessage);
  assert.match(thinkMessage.tool_calls![0].function.arguments, /actual edge/);
  const separator = agent.messagesForTest.find((message) => message.role === 'tool' && message.tool_call_id === 'think1');
  assert.equal(separator?.content, '------');
  cleanup();
});

test('external thinking stays optional on synthetic stimulus turns', async () => {
  const llm = scriptedLLM([runCall('', true)]);
  const base = makeConfig();
  const { agent, cleanup } = buildTestAgent({
    llm,
    config: { llm: { ...base.llm, externalThinking: true } },
    tmpPrefix: 'harness-external-think-synthetic-',
  });
  void agent.loop();
  agent.enqueue({
    id: 'heartbeat-test', channelId: 'internal', channelName: 'heartbeat',
    author: 'agent', authorId: 'agent', content: '[heartbeat]',
    createdAt: '2026-01-01T00:00:00Z', replyTo: null, forwarded: null,
    mentions: [], attachments: [], kind: 'heartbeat',
  });
  await settle();
  agent.stop();

  assert.equal(llm.calls, 1);
  assert.equal(llm.options[0].forceThink, false, 'synthetic turn keeps think available without requiring it');
  cleanup();
});

test('Mind frontier serves once per outer turn, not on tool continuations', async () => {
  const llm = scriptedLLM([runCall('1 + 1', false), EMPTY_WAKE, EMPTY_WAKE]);
  const mindItem = {
    id: 12, title: 'Current commitment', body: '', kind: 'task', status: 'in_progress', effectiveStatus: 'in_progress',
    priority: 3, parentId: null, dueAt: null, createdBy: 'agent', createdAt: 1, updatedAt: 1,
    closedAt: null, archivedAt: null, tags: [], blockedBy: [], blocks: [], childCount: 0,
    commentCount: 0, reminderCount: 0,
  } as const;
  const mind = {
    stats: () => ({ active: 1, ready: 0, blocked: 0, waiting: 0, overdue: 0, done: 0, inbox: 0 }),
    list: (filter: MindListFilter = {}) => {
      if (filter.statuses && !filter.statuses.includes(mindItem.status)) return [];
      if (filter.kinds && !filter.kinds.includes(mindItem.kind)) return [];
      if (filter.ready || filter.blocked) return [];
      return [mindItem].slice(0, filter.limit);
    },
  } as unknown as MindService;
  const base = makeConfig();
  const { agent, cleanup } = buildTestAgent({
    llm,
    config: { discord: { ...base.discord, guilds: [{ id: 'g-home', slug: 'home', slashCommands: false, quietHours: null, timezone: null, channels: { '100': 'direct' } }] } },
    agentDeps: { mind },
    tmpPrefix: 'harness-mind-frontier-cadence-',
  });
  agent.enqueue({ ...userMsg(), guildId: 'g-home' });
  agent.enqueue({ ...userMsg(), id: 'm-batch-2', content: 'second message in the same inbound batch', guildId: 'g-home' });
  void agent.loop();
  await settle();
  assert.equal(llm.calls, 2);
  assert.match(String(llm.requests[0].at(-4)?.content), /^<mind-frontier>/, 'frontier sits before the whole current inbound batch');
  assert.match(String(llm.requests[0].at(-3)?.content), /^\[person-memory/, 'first-seen profile stays inside the current inbound batch');
  assert.match(String(llm.requests[0].at(-2)?.content), /hi/, 'first inbound stays after its profile');
  assert.match(String(llm.requests[0].at(-1)?.content), /second message in the same inbound batch/, 'current conversation has maximum recency');
  assert.ok(llm.requests[1].every((m) => !String(m.content).startsWith('<mind-frontier>')), 'post-tool continuation omits the request-only card');

  agent.enqueue({ ...userMsg(), id: 'm2', content: 'new outer turn', guildId: 'g-home' });
  await settle();
  agent.stop();
  assert.equal(llm.calls, 3);
  assert.match(String(llm.requests[2].at(-2)?.content), /^<mind-frontier>/, 'turn end re-arms the next turn');
  assert.match(String(llm.requests[2].at(-1)?.content), /new outer turn/, 'new conversation remains after the frontier');
  cleanup();
});

test('wake on a FAILED run continues the chain', async () => {
 // A throwing program yields ok:false, so `end` must be ignored and the model
 // asked again — otherwise the error is never seen.
  const llm = scriptedLLM([runCall('throw new Error("boom")', true), EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-fail-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  assert.equal(llm.calls, 2, `a failed run must not end the turn (calls=${llm.calls})`);
  cleanup();
});

test('a mixed multi-tool-call response — an ending call followed by a failing call — does not end the turn', async () => {
 // A non-final wake must not survive a later sibling failure and hide its error.
  const llm = scriptedLLM([
    multiRunCall([{ code: '1 + 1', wake: true }, { code: 'throw new Error("boom")', wake: false }]),
    EMPTY_WAKE,
  ]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-mixed-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  assert.equal(llm.calls, 2, `a sibling call's failure must not be swallowed by an earlier end:true (calls=${llm.calls})`);
  cleanup();
});

test('wake still yields when the successful run only sends', async () => {
  const llm = scriptedLLM([runCall('await elpis.channel("100").send("hi there")', true)]);
  const { agent, sent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-send-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'hi there');
  assert.equal(llm.calls, 1, 'the send turn cost one completion, not two');
  cleanup();
});

test('omitting wake keeps the chain running', async () => {
  const llm = scriptedLLM([runCall('1 + 1', false), EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-omit-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  assert.equal(llm.calls, 2, 'a run without wake must not yield the turn');
  cleanup();
});

test('empty successful run with wake — the chosen-silence idiom — yields and sends nothing', async () => {
  const llm = scriptedLLM([EMPTY_WAKE]);
  const { agent, sent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-silence-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  assert.equal(llm.calls, 1, 'silence costs exactly one completion');
  assert.equal(sent.length, 0);
  cleanup();
});

/** Text unique to YIELD_TURN_NUDGE. Both nudges name the empty-run wake
 * idiom — the ghost bounce's corrected final sentence does too — so probing on
 * the idiom cannot tell them apart, and a test that did would pass on a ghost
 * bounce with the end-nudge deleted entirely. Probe the distinguishing clause. */
const YIELD_NUDGE_MARK = 'that did not yield your turn';

test('a response with NO tool calls does not end the turn — it nudges and continues', async () => {
 // Artifact-only content on purpose: `hasReplySubstance('</invoke>')` is false,
 // so the ghost bounce cannot fire and the END nudge is the only thing that can
 // put a second user message in history. With a substantive fixture this test
 // passed on the ghost bounce alone and stayed green with the end-nudge removed.
  const bare: CompleteResult = {
    message: { role: 'assistant', content: '</invoke>' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
  const llm = scriptedLLM([bare, EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-nudge-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes(YIELD_NUDGE_MARK)),
    'the yield nudge should be in history');
  assert.ok(users.some((m) => m.content.includes('wake: { auto: true }')),
    'and it should name the explicit silence-yield idiom');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'artifact-only content must not bounce — the END nudge is what fired');
  assert.ok(llm.calls >= 2, 'the loop asked again rather than ending');
  cleanup();
});

test('the nudge repeats without bound — there is deliberately no force-end', async () => {
 // Operator decision no bounded retry, no fallback. A cap here would
 // be a regression, so assert its absence rather than trusting comments.
 //
 // The assertion is STRICT GROWTH across two samples, not a floor. A floor of N
 // is only violated by a cap below N — a "for safety" cap of 5 or 50 would sail
 // past `nudges.length >= 4` while being exactly the regression this test
 // exists to catch. Any finite cap eventually stops the count moving, so
 // sample → wait → sample → assert growth catches all of them.
  const bare: CompleteResult = {
    message: { role: 'assistant', content: '</invoke>' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
  };
  const llm = scriptedLLM([bare]);  // repeats forever
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-unbounded-' });
  const countNudges = () => agent.messagesForTest.filter(
    (m) => m.role === 'user' && m.content.includes(YIELD_NUDGE_MARK)).length;
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(150);
  const first = countNudges();
  await settle(150);
  const second = countNudges();
  agent.stop();
  await settle(50);
  assert.ok(first > 0, `nudging started at all, got ${first}`);
  assert.ok(second > first,
    `the nudge count must still be growing — a cap would have frozen it (${first} → ${second})`);
  cleanup();
});

test('agent.stop() breaks a nudge spin — graceful shutdown is not a fallback', async () => {
  const bare: CompleteResult = {
    message: { role: 'assistant', content: 'nope' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
  const llm = scriptedLLM([bare]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-stop-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(150);
  agent.stop();
  await settle(100);
  const before = llm.calls;
  await settle(150);
  assert.equal(llm.calls, before, 'no further completions after stop()');
  cleanup();
});

test('the consecutive-nudge counter resets when a turn finally ends', async () => {
  const bare: CompleteResult = {
    message: { role: 'assistant', content: 'not yet' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
 // Two bare responses, then a proper end; then a second turn that also nudges.
  const llm = scriptedLLM([bare, bare, EMPTY_WAKE, bare, EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-reset-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(200);
  agent.enqueue({ ...userMsg(), id: 'm2' });
  await settle(200);
  agent.stop();
  assert.equal(agent.yieldNudgeCountForTest, 0, 'counter reset at the last finishTurn');
  cleanup();
});

test('ghost-reply nudge still fires on a wake-yielded turn with zero sends', async () => {
 // Retro finding #18: a written-but-unsent reply is silent failure. The reply
 // now rides the run-call message's content, so the nudge must read it there.
  const ghost: CompleteResult = {
    message: {
      role: 'assistant',
      content: 'Yes, I can help with that — here is what I would do first.',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"code":"1+1","detail":"Compute the ghost fixture","wake":{"after":"1h"}}' } }],
    },
    stripped: false, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const llm = scriptedLLM([ghost, EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-ghost-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(200);
  agent.stop();
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'the ghost bounce must still fire after the wake requested a yield');
  cleanup();
});

test('ghost-reply nudge takes precedence over the end-nudge', async () => {
 // A bare response carrying reply substance is BOTH a ghost reply and a missing
 // end. The ghost bounce is the one that fires — it concerns a person.
  const ghostBare: CompleteResult = {
    message: { role: 'assistant', content: 'Sure, happy to help you with that today.' },
    stripped: false, usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
  };
  const llm = scriptedLLM([ghostBare, EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-precedence-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(200);
  agent.stop();
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  const ghostIdx = users.findIndex((m) => m.content.includes('you wrote a reply but sent nothing'));
 // Probe YIELD_TURN_NUDGE by a phrase unique to it: both nudges now name the
 // empty-run wake idiom (the ghost bounce's corrected final sentence
 // does too), so matching on the idiom alone cannot tell them apart.
  const endIdx = users.findIndex((m) => m.content.includes('that did not end your turn'));
  assert.ok(ghostIdx >= 0, 'ghost bounce fired');
  assert.ok(endIdx === -1 || ghostIdx < endIdx, 'ghost bounce came first');
  cleanup();
});

test('mid-turn inbound arriving during a wake-bearing run drains instead of parking', async () => {
  const llm = scriptedLLM([runCall('await elpis.sleep(40)', true), EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-midturn-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(30);
  agent.enqueue({ ...userMsg(), id: 'm2', content: 'one more thing' });
  await settle(250);
  agent.stop();
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('one more thing')),
    'the mid-turn message must reach history, not be stranded in the queue');
  assert.ok(llm.calls >= 2, 'a new turn ran for the queued message');
  cleanup();
});

test('a fully-leaked response ends the turn without nudging', async () => {
 // The leak path exits via finishTurn before the turn-end region, so the
 // end-nudge must never fire there — otherwise a broken endpoint spins.
  const leaked: CompleteResult = {
    message: { role: 'assistant', content: '' }, stripped: true,
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  };
  const llm = scriptedLLM([leaked]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-leak-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(300);
  agent.stop();
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(!users.some((m) => m.content.includes('wake: { auto: true }')),
    'the leak path must exit, not nudge');
  cleanup();
});

test('a sustained nudge loop alerts the operator exactly once, at the threshold', async () => {
 // Artifact-only content (`</invoke>`), same reason as the YIELD_NUDGE_MARK test
 // above: substantive content ('nope' etc.) would fire the one-shot ghost-reply
 // bounce on the FIRST response instead of the end-nudge, throwing off the exact
 // count this test relies on (deterministic array length == YIELD_NUDGE_ALERT_AT).
  const bare: CompleteResult = {
    message: { role: 'assistant', content: '</invoke>' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
 // Exactly YIELD_NUDGE_ALERT_AT nudges, then a real end — short enough that the
 // periodic re-alert (every YIELD_NUDGE_REALERT_EVERY past the threshold, see the
 // dedicated re-alert test below) never gets a second chance to fire.
  const responses = Array.from({ length: YIELD_NUDGE_ALERT_AT }, () => bare).concat([EMPTY_WAKE]);
  const llm = scriptedLLM(responses);
  const base = makeConfig();
  const { agent, sent, cleanup } = buildTestAgent({
    llm,
    tmpPrefix: 'harness-end-alert-',
 // makeConfig takes Partial<Config>, so `discord` must be a complete object —
 // spread the base and override one key (same idiom as test/leak-retry.test.ts).
    config: { discord: { ...base.discord, errorChannelId: '999' } },
  });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(500);
  agent.stop();
  await settle(50);
  const alerts = sent.filter((s) => s.channelId === '999' && /no-run-call responses/.test(s.text));
  assert.equal(alerts.length, 1, `expected exactly one operator alert, got ${alerts.length}`);
  cleanup();
});

// ---------- agent -> console.yieldNudge wiring (review fix: Important 1) ----------
//
// Mirrors test/cache-stats.test.ts's agent -> console.cacheBusted pair
// (:312, :331): the hub-level test alone (test/console.test.ts) does not
// prove agent.ts actually calls it, or that the call is guarded. Without
// these, deleting `this.deps.console?.yieldNudge(...)` — or its try/catch —
// passes the whole suite.

test('agent: a spinning nudge loop reaches console.yieldNudge with the consecutive count', async () => {
  const bare: CompleteResult = {
    message: { role: 'assistant', content: 'nope' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
  const llm = scriptedLLM([bare]); // never ends
  const counts: number[] = [];
  const stubConsole = { yieldNudge: (count: number) => { counts.push(count); } } as unknown as ConsoleHub;
  const { agent, cleanup } = buildTestAgent({
    llm, tmpPrefix: 'harness-end-hub-wire-', agentDeps: { console: stubConsole },
  });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(300);
  agent.stop();
  assert.ok(counts.length > 0, 'console.yieldNudge must be called during a spin');
  assert.deepEqual(counts, counts.map((_, i) => i + 1),
    'reported counts are consecutive, starting at 1 (one call per nudge)');
  assert.equal(counts[counts.length - 1], agent.yieldNudgeCountForTest,
    "the last reported count matches the agent's own counter");
  cleanup();
});

test('agent: a throwing console.yieldNudge is swallowed — the loop keeps nudging', async () => {
  const bare: CompleteResult = {
    message: { role: 'assistant', content: 'nope' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
  const llm = scriptedLLM([bare]); // never ends
  const stubConsole = {
    yieldNudge: () => { throw new Error('boom — observer-only, must not propagate'); },
  } as unknown as ConsoleHub;
  const { agent, cleanup } = buildTestAgent({
    llm, tmpPrefix: 'harness-end-hub-throw-', agentDeps: { console: stubConsole },
  });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(150);
  const first = agent.yieldNudgeCountForTest;
  await settle(150);
  const second = agent.yieldNudgeCountForTest;
  agent.stop();
  assert.ok(first > 0, 'the loop must have started nudging before the throwing observer could matter');
  assert.ok(second > first,
    'the nudge count keeps growing — a throwing console.yieldNudge must not break the loop');
  cleanup();
});

// ---------- clearContext resets the nudge counter (review fix: Minor 2) ----------

test("clearContext() resets the nudge counter mid-spin — the fresh spin can re-alert", async () => {
  const bare: CompleteResult = {
    message: { role: 'assistant', content: 'nope' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
  const llm = scriptedLLM([bare]); // never ends
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-clear-reset-' });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(300);
  const before = agent.yieldNudgeCountForTest;
  assert.ok(before > 0, 'the loop must have nudged before clearing');
  agent.clearContext();
  assert.equal(agent.yieldNudgeCountForTest, 0,
    'clearContext() resets the nudge counter synchronously, alongside the other one-shot flags — ' +
    'otherwise a fresh post-clear spin would start above the alert threshold and never re-cross it');
  agent.stop();
  cleanup();
});

test('a sustained no-run-call spin ALSO re-alerts every YIELD_NUDGE_REALERT_EVERY cycles past the threshold', async () => {
 // Same re-alert cadence, other shape (Minor finding 2 applies to both).
 // Artifact-only content (see the earlier YIELD_NUDGE_MARK test's comment):
 // substantive content would divert the FIRST response into the one-shot
 // ghost-reply bounce instead of the end-nudge, eating one of the counted
 // responses and throwing off the exact crossing this test relies on.
  const bare: CompleteResult = {
    message: { role: 'assistant', content: '</invoke>' }, stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };
  const secondCrossing = YIELD_NUDGE_ALERT_AT + YIELD_NUDGE_REALERT_EVERY;
  const responses = Array.from({ length: secondCrossing }, () => bare).concat([EMPTY_WAKE]);
  const llm = scriptedLLM(responses);
  const base = makeConfig();
  const { agent, sent, cleanup } = buildTestAgent({
    llm,
    tmpPrefix: 'harness-end-realert-',
    config: { discord: { ...base.discord, errorChannelId: '999' } },
  });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(1500);
  agent.stop();
  await settle(50);
  const alerts = sent.filter((s) => s.channelId === '999' && /no-run-call responses/.test(s.text));
  assert.equal(alerts.length, 2,
    `expected exactly two operator alerts (at ${YIELD_NUDGE_ALERT_AT} and ${secondCrossing}), got ${alerts.length}`);
  cleanup();
});

// ---------- Minor finding 3: misleading/duplicate "turn end" log lines ----------

/** A logger stub that records every emitted line as one joined string per call,
 * regardless of level — enough to grep for the outcome markers below. */
function makeLogSpy(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stringify = (a: unknown[]) => a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  const record = (...a: unknown[]) => { lines.push(stringify(a)); };
  return { lines, logger: { debug: record, info: record, warn: record, error: record } };
}

test('a genuinely wake-yielded turn logs its outcome exactly once (no premature/duplicate "turn end" line)', async () => {
  const { logger, lines } = makeLogSpy();
  const llm = scriptedLLM([EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-logonce-', config: { logger } });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle();
  agent.stop();
  const yielded = lines.filter((l) => l.includes('turn end | yielded by wake'));
  assert.equal(yielded.length, 1, `expected exactly one real turn-yield log line, got ${yielded.length}`);
  cleanup();
});

test('a ghost-bounced turn does not log a turn-end that never happened', async () => {
  const { logger, lines } = makeLogSpy();
  const ghost: CompleteResult = {
    message: {
      role: 'assistant',
      content: 'Yes, I can help with that — here is what I would do first.',
      tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"code":"1+1","detail":"Compute the ghost fixture","wake":{"after":"1h"}}' } }],
    },
    stripped: false, usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
  const llm = scriptedLLM([ghost, EMPTY_WAKE]);
  const { agent, cleanup } = buildTestAgent({ llm, tmpPrefix: 'harness-end-logbounce-', config: { logger } });
  void agent.loop();
  agent.enqueue(userMsg());
  await settle(200);
  agent.stop();
 // The first response arms a wake but the ghost bounce preempts the
 // yield — only the SECOND (EMPTY_WAKE) call actually finishes the turn. A
 // premature marker on the first would produce two yield lines for one real yield.
  const yielded = lines.filter((l) => l.includes('turn end | yielded by wake'));
  assert.equal(yielded.length, 1,
    `expected exactly one real turn-yield line despite the bounce, got ${yielded.length}`);
  cleanup();
});
