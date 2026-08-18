// Loop-level test: ghost-reply detection. On a real-user turn, if the
// model writes any non-empty assistant content but calls elpis.channel(\\"100\\").send zero
// times, the harness injects a one-shot synthetic bounce so the model gets
// exactly one repair turn instead of the user seeing silence. No length gate —
// a short reply written as content is just as much a silent failure as a long
// one.
//
// Mirrors the leak-retry test's stub pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasReplySubstance, type Agent } from '../src/agent.js';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { buildTestAgent, makeConfig, EMPTY_END } from './helpers.js';

function scriptedLLM(responses: CompleteResult[]): LLM & { calls: number; onCall: ((n: number) => void) | null } {
  let i = 0;
  let calls = 0;
  let hook: ((n: number) => void) | null = null;
  return {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    get calls() { return calls; },
    set onCall(fn) { hook = fn; },
    get onCall() { return hook; },
    complete(): Promise<CompleteResult> {
      calls++;
      const n = calls;
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      queueMicrotask(() => hook?.(n));
      return Promise.resolve(r);
    },
    summarize(): Promise<string> {
      return Promise.resolve('SUMMARY');
    },
  } as LLM & { calls: number; onCall: ((n: number) => void) | null };
}

function buildAgentWith(llm: LLM) {
 // The sandbox's elpis.channel(\\"100\\").send routes through agent.send (which counts
 // sends for the ghost nudge), whose terminal send pushes into `sent` — same
 // wiring as index.ts. buildTestAgent supplies both.
  const { agent, sent, tmpDir } = buildTestAgent({ llm, tmpPrefix: 'harness-ghost-' });
  return { agent, sent, tmpDir };
}

function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

function userMsg(): Parameters<Agent['enqueue']>[0] {
  return {
 // channelId is a raw numeric id (bare non-numeric names now throw
 // even when unique — resolveChannelRef requires guild qualification).
    id: 'm1', channelId: '100', channelName: '100', author: 'u', authorId: 'u',
    content: 'hi, can you help me?', createdAt: '2026-01-01T00:00:00Z',
    replyTo: null, forwarded: null, mentions: [], attachments: [],
  };
}

function heartbeatMsg(): Parameters<Agent['enqueue']>[0] {
 // kind drives the drain's internal-vs-real-user branch now (channelName is
 // display only). A heartbeat is kind 'heartbeat' → the internal branch → no
 // realUserTurn → never a ghost bounce.
  return { ...userMsg(), channelName: 'heartbeat', kind: 'heartbeat' };
}

test('ghost reply triggers exactly one bounce, then a send clears the flag', async () => {
 // Response 1: a long ghost reply written into content, no sends, no tool calls.
 // Response 2 (after the bounce): the model sends via a run tool call, then ends with empty content.
  const ghost = 'I would love to help you with that. Let me think through the best approach here. ' +
    'There are several considerations to weigh: the reversibility of the action, the blast radius, ' +
    'and whether the user has already given explicit consent. I think the safest path is to start ' +
    'with the reversible step and confirm before anything destructive. Here is my plan in detail.';
  const llm = scriptedLLM([
    { message: { role: 'assistant', content: ghost }, stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } },
 // Repair turn: the model runs code that sends, then ends with empty content.
    { message: { role: 'assistant', content: '', tool_calls: [{
        id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"code":"elpis.channel(\\"100\\").send(\\"all set\\")"}' } }] },
      stripped: false, usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
 // After the tool result, the model ends with the run('', end: true) idiom.
    EMPTY_END,
  ]);
  const { agent, sent } = buildAgentWith(llm);

  const { promise: thirdCall, resolve: signalThird } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 3) signalThird(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await thirdCall;
  await microtask();

 // The ghost turn triggered one bounce (a synthetic user message) — visible
 // in history as a second user message after the real one.
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'the bounce nudge should be in history');
 // The model sent during the repair turn.
  assert.equal(sent.length, 1, 'one send during the repair turn');
  assert.equal(sent[0].text, 'all set');
  agent.stop();
});

test('short content with zero sends DOES trigger a bounce (no length gate)', async () => {
 // The model wrote a 79-char reply as content with no elpis.channel(\\"100\\").send —
 // under the old >150 length gate this slipped through and the user saw
 // silence. Now any non-empty content on a real-user turn with zero sends
 // triggers the bounce.
  const llm = scriptedLLM([
    { message: { role: 'assistant', content: 'hoiii~ I\'m well. How are you?' }, stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } },
 // Repair turn: send via a run tool call, then end with empty content.
    { message: { role: 'assistant', content: '', tool_calls: [{
        id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"code":"elpis.channel(\\"100\\").send(\\"all set\\")"}' } }] },
      stripped: false, usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
    EMPTY_END,
  ]);
  const { agent, sent } = buildAgentWith(llm);
  const { promise: thirdCall, resolve: signalThird } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 3) signalThird(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await thirdCall;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'short content with zero sends should trigger the bounce');
  assert.equal(sent.length, 1, 'one send during the repair turn');
  agent.stop();
});

test('a tool-chain ghost bounces (user → tool_call → result → content-only reply)', async () => {
 // The most common ghost shape and the one the OLD iteration-scoped realUserTurn
 // missed: the user message is followed by a tool call, then the final reply is
 // written as content with zero sends. Because realUserTurn used to be reset at
 // the top of every loop iteration, the tool-chain `continue` cleared it before
 // the content-only reply, so no bounce fired. Turn-scoped realUserTurn
 // keeps the flag set across the whole turn, so the bounce fires.
  const llm = scriptedLLM([
 // Turn 1a: a tool call that does NOT send (just runs some code).
    { message: { role: 'assistant', content: '', tool_calls: [{
        id: 'tc0', type: 'function', function: { name: 'run', arguments: '{"code":"1 + 1"}' } }] },
      stripped: false, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
 // Turn 1b (after the tool result): the ghost — a content-only reply, no sends.
    { message: { role: 'assistant', content: 'The answer is 2. Let me know if you need anything else!' },
      stripped: false, usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 } },
 // Repair turn (after the bounce): send via a run tool call.
    { message: { role: 'assistant', content: '', tool_calls: [{
        id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"code":"elpis.channel(\\"100\\").send(\\"it is 2\\")"}' } }] },
      stripped: false, usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } },
 // Natural end after the send.
    EMPTY_END,
  ]);
  const { agent, sent } = buildAgentWith(llm);

  const { promise: fourthCall, resolve: signalFourth } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 4) signalFourth(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await fourthCall;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'the tool-chain ghost should still trigger the bounce');
  assert.equal(sent.length, 1, 'one send during the repair turn');
  assert.equal(sent[0].text, 'it is 2');
  agent.stop();
});

test('hasReplySubstance classifies artifacts vs real replies', () => {
  for (const artifact of ['..', '.', '…', '</invoke>', '<|im_end|>', '</tool_call>', ' ', '<br/>']) {
    assert.equal(hasReplySubstance(artifact), false, `"${artifact}" is an artifact`);
  }
  for (const real of ['ok', 'hi!', 'the answer is 2', 'sent; watching for her reply.']) {
    assert.equal(hasReplySubstance(real), true, `"${real}" is a real reply`);
  }
});

test('artifact-only content (stray tokens, punctuation) does not bounce', async () => {
 // Observed live: the model emitted literally "</invoke>" (a stray tool-call
 // artifact) as content with zero sends — not a reply the user lost, so
 // bouncing it is noise. Same for ".." / "." tics.
 // The artifact response no longer ends the turn , so it earns the
 // END_TURN_NUDGE and a second completion follows; EMPTY_END closes the turn.
 // That nudge is the ONLY extra user message — the ghost bounce must not fire.
  const llm = scriptedLLM([
    { message: { role: 'assistant', content: '</invoke>' }, stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    EMPTY_END,
  ]);
  const { agent } = buildAgentWith(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await done;
  await microtask();
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.equal(users.length, 2, 'the real message + the end-turn nudge only');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'artifact-only content must not trigger a bounce');
  agent.stop();
});

test('heartbeat turns never trigger a bounce', async () => {
  const ghost = 'x'.repeat(300);
 // The content-only reply is no longer an ending, so the end-turn nudge lands
 // and EMPTY_END closes the turn. That nudge is the only extra user message.
  const llm = scriptedLLM([
    { message: { role: 'assistant', content: ghost }, stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } },
    EMPTY_END,
  ]);
  const { agent } = buildAgentWith(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue(heartbeatMsg());
  await done;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.equal(users.length, 2, 'the heartbeat message + the end-turn nudge only');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'no bounce on a heartbeat turn even with long content');
  agent.stop();
});

test('send in a tool-chain iteration + brief closing content → NO bounce (turn-scoped sends)', async () => {
 // The false-positive that taught the agent to end every send with strictly
 // empty content: sendsThisTurn used to be reset at the top of EVERY loop
 // iteration, so a send inside a run tool call was zeroed by the time the
 // next iteration's content-only closing note hit the ghost check. With the
 // drain-time reset (only on the first real user message of a turn), the send
 // survives the tool-chain continue and the closing note is treated as the
 // internal monologue it is.
  const llm = scriptedLLM([
 // Turn 1a: the model sends via a run tool call.
    { message: { role: 'assistant', content: '', tool_calls: [{
        id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"code":"elpis.channel(\\"100\\").send(\\"here you go\\")"}' } }] },
      stripped: false, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
 // Turn 1b: a brief note-to-self as content — previously false-bounced. It
 // is no longer an ending either, so the end-turn nudge follows it and
 // EMPTY_END closes the turn.
    { message: { role: 'assistant', content: 'sent; watching for her reply.' }, stripped: false,
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
    EMPTY_END,
  ]);
  const { agent, sent } = buildAgentWith(llm);
  const { promise: thirdCall, resolve: signalThird } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 3) signalThird(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await thirdCall;
  await microtask();
 // one more microtask round so the post-response ghost check has run
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.equal(users.length, 2, 'the real message + the end-turn nudge — a send earlier in the turn must suppress the bounce for closing content');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'here you go');
  agent.stop();
});

test('D1: a real wake into a self-muted channel is annotated so the model knows a reply will not send', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildTestAgent({
    llm,
    agentDeps: {
      mutes: { get: (id: string) => (id === '100' ? { type: 'mute' as const, actor: 'self', reason: null } : null) } as any,
    },
  });
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await done;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('is muted — a reply here will not send')),
    'a real wake in a muted channel should be annotated');
  agent.stop();
});

test('D1: an unmuted channel wake is NOT annotated', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgentWith(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await done;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(!users.some((m) => m.content.includes('is muted — a reply here will not send')),
    'an unmuted channel wake must not be annotated');
  agent.stop();
});

test('D1: a ghost reply in a muted channel does NOT bounce (a reply legitimately cannot send)', async () => {
  const ghost = 'I would love to help you with that. Let me think through the best approach here. ' +
    'There are several considerations to weigh: the reversibility of the action, the blast radius, ' +
    'and whether the user has already given explicit consent. I think the safest path is to start ' +
    'with the reversible step and confirm before anything destructive. Here is my plan in detail.';
  const llm = scriptedLLM([
    { message: { role: 'assistant', content: ghost }, stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } },
    EMPTY_END,
  ]);
  const { agent } = buildTestAgent({
    llm,
    agentDeps: {
      mutes: { get: (id: string) => (id === '100' ? { type: 'mute' as const, actor: 'self', reason: null } : null) } as any,
    },
  });
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await done;
  await microtask();
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'a muted turn channel must not bounce a ghost reply');
  agent.stop();
});

test('a ghost reply in a config-denied channel does NOT bounce', async () => {
  const ghost = 'I would love to help you with that. Let me think through the best approach here. ' +
    'There are several considerations to weigh: the reversibility of the action, the blast radius, ' +
    'and whether the user has already given explicit consent. I think the safest path is to start ' +
    'with the reversible step and confirm before anything destructive. Here is my plan in detail.';
  const llm = scriptedLLM([
    { message: { role: 'assistant', content: ghost }, stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } },
    EMPTY_END,
  ]);
  const guilds = [{
    id: 'g1', slug: 'home', slashCommands: false, quietHours: null, timezone: null,
    defaultTier: 'drop' as const, allowSend: true, defaultAllowSend: false,
    channels: { '100': 'direct' as const }, channelAllowSend: { '100': false },
  }];
  const { agent } = buildTestAgent({
    llm,
    config: { discord: { ...makeConfig().discord, guilds } },
  });
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue({ ...userMsg(), guildId: 'g1' });
  await done;
  await microtask();
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('sending to this room is disabled by configuration')),
    'a direct config-denied wake is annotated');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'a config-denied turn channel must not bounce a ghost reply');
  agent.stop();
});

test('D1: a ghost reply on a THREAD whose PARENT is muted does NOT bounce (thread has no own mute row)', async () => {
 // The thread ('200') is never muted directly — only its parent ('100') has a
 // mute row, exactly the shape a real thread takes (threads never get their
 // own killswitch row; Agent.send checks the parent too, ~:432). The
 // ghost-nudge's mute lookup must walk the same parent chain or it fires
 // anyway, contradicting the drain-time mute annotation the model already saw.
  const ghost = 'I would love to help you with that. Let me think through the best approach here. ' +
    'There are several considerations to weigh: the reversibility of the action, the blast radius, ' +
    'and whether the user has already given explicit consent. I think the safest path is to start ' +
    'with the reversible step and confirm before anything destructive. Here is my plan in detail.';
  const llm = scriptedLLM([
    { message: { role: 'assistant', content: ghost }, stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } },
    EMPTY_END,
  ]);
  const { agent } = buildTestAgent({
    llm,
    agentDeps: {
      mutes: { get: (id: string) => (id === '100' ? { type: 'mute' as const, actor: 'operator', reason: null } : null) } as any,
      channels: {
        guildOf: () => null,
        parentOf: (id: string) => (id === '200' ? '100' : null),
        entry: () => undefined,
        set: () => {},
        all: () => [],
      } as any,
    },
  });
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue({ ...userMsg(), channelId: '200', channelName: '200' });
  await done;
  await microtask();
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'a thread whose parent is muted must not bounce a ghost reply either');
  agent.stop();
});

test('a send during the turn prevents the bounce', async () => {
  const ghost = 'x'.repeat(300);
  const llm = scriptedLLM([
 // Turn 1: model sends via a tool call AND writes long content. The send
 // counts, so no bounce.
    { message: { role: 'assistant', content: ghost, tool_calls: [{
        id: 'tc1', type: 'function', function: { name: 'run', arguments: '{"code":"elpis.channel(\\"100\\").send(\\"sent\\")"}' } }] },
      stripped: false, usage: { prompt_tokens: 10, completion_tokens: 50, total_tokens: 60 } },
    EMPTY_END,
  ]);
  const { agent, sent } = buildAgentWith(llm);
  const { promise: secondCall, resolve: signalSecond } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signalSecond(); };

  void agent.loop();
  agent.enqueue(userMsg());
  await secondCall;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.equal(users.length, 1, 'a send during the turn prevents the bounce');
  assert.equal(sent.length, 1);
  agent.stop();
});
