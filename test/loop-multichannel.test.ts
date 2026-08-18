// Loop-level tests for the V1 monocontext loop.
//
// - FIFO drain: interleaved inbound from two channels both land in the ONE
// history, in FIFO order.
// - Explicit-target send: a run that calls elpis.channel('1001').send(...) reaches '1001'.
// - Mid-turn inbound from another room doesn't disturb the running turn.
// - Beat reschedule on error: an LLM-error turn still reschedules the chain.
//
// Channel ids here are numeric ('1001'/'1002', members of the fixture guild
// below) rather than the old bare 'a'/'b' — a bare non-numeric name now
// throws (qualified refs) unless the caller writes it as
// 'slug/name'. Raw digit ids skip resolution entirely and stay unqualified,
// which keeps this suite's actual concern (multichannel interleave in one
// history) unentangled from the ref-qualification behavior — that's covered
// by test/resolve-ref.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import type { GuildConfig } from '../src/config.js';
import type { MuteStore, MuteRow, MuteType } from '../src/store/mutes.js';
import { buildTestAgent, makeConfig } from './helpers.js';

const FIXTURE_GUILD: GuildConfig = { id: 'g1', slug: 'stub', slashCommands: false, quietHours: null, timezone: null,
  channels: { '1001': 'direct', '1002': 'direct' } };

function scriptedLLM(responses: CompleteResult[], throwOn: Set<number> = new Set()):
  LLM & { calls: number; onCall: ((n: number) => void) | null } {
  let i = 0;
  let calls = 0;
  let hook: ((n: number) => void) | null = null;
  return {
    client: {} as unknown as LLM['client'], model: 'test', runTool: {} as unknown as LLM['runTool'],
    get calls() { return calls; },
    set onCall(fn) { hook = fn; },
    get onCall() { return hook; },
    complete(): Promise<CompleteResult> {
      calls++;
      const n = calls;
      queueMicrotask(() => hook?.(n));
      if (throwOn.has(n)) return Promise.reject(new Error('boom'));
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve(r);
    },
    summarize(): Promise<string> { return Promise.resolve('SUMMARY'); },
  } as LLM & { calls: number; onCall: ((n: number) => void) | null };
}

function buildAgent(llm: LLM) {
  const { agent, sent, tmpDir } = buildTestAgent({
    llm,
    config: {
      heartbeat: { intervalMs: 60_000, maxIntervalMs: 4 * 60 * 60 * 1000, reflectionMinMessages: 99, socialNudgeMs: 12 * 60 * 60 * 1000 },
      discord: { ...makeConfig().discord, guilds: [FIXTURE_GUILD] },
    },
    tmpPrefix: 'harness-loop-mc-',
  });
  return { agent, sent, tmpDir };
}

function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

function msg(channelId: string, id: string): Parameters<Agent['enqueue']>[0] {
  return {
    id, channelId, channelName: channelId, author: 'u', authorId: 'u',
    content: `hi from ${channelId}`, createdAt: '2026-01-01T00:00:00Z',
    replyTo: null, forwarded: null, mentions: [], attachments: [],
 // Stamps the channel directory with the fixture guild at drain time (
 // channels.set), so a raw-digit resolveChannelRef lookup finds the entry.
    guildId: FIXTURE_GUILD.id,
  };
}

/** An in-memory, mutable MuteStore stub — unlike loop-ambient.test.ts's
 * read-only fixture, `moderateChannel` needs a working `.set`/`.clear`
 * to exercise a real mid-conversation mute transition. */
function mutableMutes(): MuteStore {
  const rows = new Map<string, MuteRow>();
  return {
    get: (id) => rows.get(id) ?? null,
    set: (id, type: MuteType, setBy, reason = null) => {
      rows.set(id, { channelId: id, type, setBy, reason: reason ?? null, createdAt: new Date().toISOString() });
    },
    clear: (id) => rows.delete(id),
    all: () => [...rows.values()],
  };
}

// A turn that sends to an EXPLICIT channel via a run tool call, then ends.
const SEND_THEN_END = (target: string, text: string): CompleteResult[] => [
  { message: { role: 'assistant', content: '', tool_calls: [{
      id: 'tc', type: 'function', function: { name: 'run', arguments: `{"code":"elpis.channel('${target}').send(\\"${text}\\")"}` } }] },
    stripped: false, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } },
  { message: { role: 'assistant', content: '' }, stripped: false,
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } },
];

test('mono: interleaved inbound from two channels drains into one history in FIFO order', async () => {
  const llm = scriptedLLM([...SEND_THEN_END('1001', 'reply')]);
  const { agent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue(msg('1001', 'm-a'));
  agent.enqueue(msg('1002', 'm-b'));
  await done;
  await microtask();

 // Both user messages are in the one history, in FIFO order.
  const users = agent.messagesForTest.filter((m) => m.role === 'user' && m.personContext?.kind === 'inbound');
  assert.ok(users[0].content.includes('hi from 1001'), 'A drained first');
  assert.ok(users[1].content.includes('hi from 1002'), 'B drained second into the same history');
 // Provenance stamps carry the originating channel.
  assert.equal(users[0].channel, '1001');
  assert.equal(users[1].channel, '1002');
  agent.stop();
});

test('mono: elpis.channel(target).send() reaches the explicitly-named room', async () => {
  const llm = scriptedLLM([...SEND_THEN_END('1001', 'to-A')]);
  const { agent, sent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue(msg('1001', 'm-a'));
  await done;
  await microtask();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, '1001');
  assert.equal(sent[0].text, 'to-A');
  agent.stop();
});

test('the heartbeat chain is rescheduled after an LLM-error turn', async () => {
  const llm = scriptedLLM([], new Set([1]));
  const { agent } = buildAgent(llm);

  const { promise: rescheduled, resolve: onReschedule } = Promise.withResolvers<void>();
  const spy = { called: false, delay: -1 };

  agent.primeForHeartbeatTest();

  void agent.loop();
  agent.fireHeartbeatForTest((d) => { spy.called = true; spy.delay = d; onReschedule(); });
  await rescheduled;

  assert.ok(spy.called, 'the beat was rescheduled even though the turn errored');
  assert.ok(spy.delay > 0, 'a positive delay was scheduled');
  agent.stop();
});

// Composition test for the killswitch: a real conversation is
// already underway (turn 1 sends successfully), THEN the operator mutes the
// channel, and both halves of the contract must hold together — the
// transition notice actually lands in the one history (not just returned as
// an ok:true result) AND the very next send attempt on that channel throws,
// via the same Agent.send guard a sandbox elpis.channel(id).send tool
// call would hit. moderation.test.ts covers each half in isolation (no
// running loop, no prior turn); this pins them composing in a live loop.
test('killswitch: an operator mute mid-conversation blocks the next send, and the transition notice lands in history', async () => {
  const llm = scriptedLLM([...SEND_THEN_END('1001', 'first reply')]);
  const mutes = mutableMutes();
  const { agent, sent } = buildTestAgent({
    llm,
    config: {
      heartbeat: { intervalMs: 60_000, maxIntervalMs: 4 * 60 * 60 * 1000, reflectionMinMessages: 99, socialNudgeMs: 12 * 60 * 60 * 1000 },
      discord: { ...makeConfig().discord, guilds: [FIXTURE_GUILD] },
    },
    agentDeps: { mutes },
    tmpPrefix: 'harness-loop-mc-mute-',
  });

  const { promise: doneTurn1, resolve: signalTurn1 } = Promise.withResolvers<void>();
  const { promise: doneTurn2, resolve: signalTurn2 } = Promise.withResolvers<void>();
  llm.onCall = (n) => {
    if (n === 2) signalTurn1(); // turn 1: tool-call send (call 1) then natural end (call 2)
    if (n === 3) signalTurn2(); // turn 2: the mute notice's own drain-and-end
  };

  void agent.loop();
  agent.enqueue(msg('1001', 'm-a'));
  await doneTurn1;
  await microtask();
  await microtask();
  await microtask();

  assert.equal(sent.length, 1, 'the first turn sent before any mute existed');
  assert.equal(sent[0].channelId, '1001');

 // Mid-conversation: the operator mutes the channel the agent was just
 // talking in.
  const r = agent.moderateChannel('1001', 'mute', 'operator', 'noisy');
  assert.equal(r.ok, true);

  await doneTurn2;
  await microtask();
  await microtask();
  await microtask();

  const notices = agent.messagesForTest.filter(
    (m) => m.role === 'user' && m.content.includes('1001') && m.content.includes('muted by operator'),
  );
  assert.ok(notices.length > 0, 'the mute transition notice was drained into the one history');

  await assert.rejects(
    () => agent.send('1001', 'second reply'),
    /muted.*release is operator-only/s,
    'the next send on the now-muted channel throws',
  );
  assert.equal(sent.length, 1, 'the blocked send never reached the send handler');

  agent.stop();
});
