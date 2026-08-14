// Loop-level tests for ambient ingest + the room-context tick.
//
// Ambient (wakeClass 'ambient') messages must enter the one history in full
// but never themselves cost a turn: enqueue must not wake a parked loop, and
// the drain must not flip hasNewInput for them. A periodic tick
// (fireAmbientTick, driven directly here for determinism — makeConfig leaves
// ambientTickMs at 0) surfaces accumulated ambient chat as a single
// [room context — N messages ...] harness notice, which DOES wake the loop
// and drains everything (queued ambient + the notice) into ONE turn.
//
// Modeled on test/loop-multichannel.test.ts's stub-LLM/scenario style.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { Agent, type InboundMessage } from '../src/agent.js';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import type { GuildConfig } from '../src/config.js';
import type { MuteStore, MuteRow, MuteType } from '../src/store/mutes.js';
import { loadMostRecentMain } from '../src/store/sessions.js';
import { buildTestAgent, makeConfig, EMPTY_END } from './helpers.js';
import { mindAddAmbientNotice } from '../src/discord/discord.js';

// Two guilds: 'alpha' has a direct, a social, and a quiet channel; 'beta' has
// one social channel — enough to exercise a cross-guild ambient burst and the
// quiet/muted no-fire case.
const FIXTURE_GUILDS: GuildConfig[] = [
  { id: 'g1', slug: 'alpha', slashCommands: false, quietHours: null, timezone: null,
    channels: { '1001': 'direct', '1002': 'social', '1003': 'quiet' } },
  { id: 'g2', slug: 'beta', slashCommands: false, quietHours: null, timezone: null,
    channels: { '2001': 'social' } },
];

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

/** A minimal MuteStore stub — only `.get()` is exercised by fireAmbientTick's
 * countsForTick check. */
function stubMutes(muted: Record<string, MuteType>): MuteStore {
  const row = (id: string, type: MuteType): MuteRow =>
    ({ channelId: id, type, setBy: 'operator', reason: null, createdAt: '2026-01-01T00:00:00Z' });
  return {
    get: (id) => (muted[id] ? row(id, muted[id]) : null),
    set: () => {},
    clear: () => false,
    all: () => Object.entries(muted).map(([id, type]) => row(id, type)),
  };
}

function buildAgent(llm: LLM, opts: { mutes?: MuteStore } = {}) {
  const { agent, sent, tmpDir } = buildTestAgent({
    llm,
    config: {
      heartbeat: { intervalMs: 60_000, maxIntervalMs: 4 * 60 * 60 * 1000, reflectionMinMessages: 99, socialNudgeMs: 12 * 60 * 60 * 1000 },
      discord: { ...makeConfig().discord, guilds: FIXTURE_GUILDS },
    },
    agentDeps: opts.mutes ? { mutes: opts.mutes } : {},
    tmpPrefix: 'harness-loop-ambient-',
  });
  return { agent, sent, tmpDir };
}

function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

function ambientMsg(channelId: string, id: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id, channelId, channelName: channelId, author: 'u', authorId: 'u',
    content: `chat in ${channelId}`, createdAt: '2026-01-01T00:00:00Z',
    replyTo: null, forwarded: null, mentions: [], attachments: [],
    guildId: FIXTURE_GUILDS[0].id,
    wakeClass: 'ambient',
    ...extra,
  };
}

test('ambient: an ambient enqueue does not wake the parked loop', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgent(llm);

  void agent.loop();
  await microtask(); // let the loop reach the park

  agent.enqueue(ambientMsg('1002', 'a-1'));
  await microtask();
  await microtask();

  assert.equal(llm.calls, 0, 'ambient enqueue must not trigger an LLM call');
  assert.equal(agent.inboundQueueLengthForTest, 1, 'the message stays queued — nothing woke the loop to drain it');
  assert.equal(agent.messagesForTest.length, 0, 'nothing entered history while the loop stays parked');
  agent.stop();
});

test('ambient: a /mind add notice waits without waking, then rides the next room-context tick', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };
  const item = {
    id: 42, title: 'A thought arrived', body: '', kind: 'idea' as const, status: 'open' as const, effectiveStatus: 'open' as const,
    priority: 2, parentId: null, dueAt: null, createdBy: 'discord:bramble', createdAt: 1, updatedAt: 1,
    lastCommentAt: null, closedAt: null, archivedAt: null, tags: [], blockedBy: [], blocks: [], childCount: 0, commentCount: 0, reminderCount: 0,
  };

  void agent.loop();
  await microtask();
  agent.enqueue(mindAddAmbientNotice(item, { channelId: '1002', channelName: 'ideas', guildId: 'g1', guildSlug: 'alpha', createdAt: '2026-08-11T00:00:00Z' }));
  await microtask();
  assert.equal(llm.calls, 0, 'the slash-created notice must not wake the inhabitant immediately');

  agent.fireAmbientTick();
  await done;
  await microtask();
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.equal(llm.calls, 1);
  assert.equal(users.filter((m) => m.content.includes('[mind item added via /mind]')).length, 1);
  assert.ok(users[0].content.includes('#42') && users[0].content.includes('A thought arrived'));
  agent.stop();
});

test('ambient: tick enqueues one room-context notice and one turn drains all ambient', async () => {

  const llm = scriptedLLM([EMPTY_END]);
  const { agent, tmpDir } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };

  void agent.loop();
  agent.enqueue(ambientMsg('1002', 'a-1'));
  agent.enqueue(ambientMsg('2001', 'a-2', { guildId: FIXTURE_GUILDS[1].id }));
  agent.enqueue(ambientMsg('1002', 'a-3'));
  await microtask();
  assert.equal(llm.calls, 0, 'still parked before the tick');

  agent.fireAmbientTick();
  await done;
  await microtask();

  assert.equal(llm.calls, 1, 'exactly one turn ran for the whole burst');
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.equal(users.length, 4, '3 ambient envelopes + 1 room-context notice');
  assert.ok(users[0].content.includes('chat in 1002'));
  assert.ok(users[1].content.includes('chat in 2001'));
  assert.ok(users[2].content.includes('chat in 1002'));
  assert.ok(users[3].content.includes('room context — 3 messages'), 'the notice trails the drained ambient chat');

 // Provenance half of the contract: ambient messages carry the
 // real room id, not the internal-channel label, and land in the transcript
 // exactly as they land in history — verified by reading the persisted
 // transcript back off disk, not just the in-memory `messages` array.
  assert.equal(users[0].channel, '1002', 'in-history stamp: ambient message keeps its real room id');
  assert.equal(users[1].channel, '2001', 'in-history stamp: a second guild\'s room id is kept too');
  assert.equal(users[3].channel, 'internal', 'in-history stamp: the tick-generated notice is internal/harness provenance');
  const loaded = loadMostRecentMain(path.join(tmpDir, 'sessions'));
  assert.ok(loaded, 'the turn persisted to the one transcript stream');
  const persistedUsers = loaded!.messages.filter((m) => m.role === 'user');
  assert.equal(persistedUsers.length, 4, 'transcript holds the 3 ambient envelopes + the room-context notice');
  assert.equal(persistedUsers[0].channel, '1002', 'transcript stamp: ambient message a-1 keeps its real room id');
  assert.equal(persistedUsers[1].channel, '2001', 'transcript stamp: ambient message a-2 keeps its real room id');
  assert.equal(persistedUsers[2].channel, '1002', 'transcript stamp: ambient message a-3 keeps its real room id');
  assert.equal(persistedUsers[3].channel, 'internal', 'transcript stamp: the room-context notice is internal provenance');
  agent.stop();
});

test('ambient: ghost-nudge does not fire on an ambient-only turn', async () => {
 // Two scripted responses because a bare no-tool-call reply is no longer a
 // turn-end : it earns the END_TURN_NUDGE, so a second completion
 // always follows. What must NOT appear is the ghost bounce.
  const llm = scriptedLLM([{
    message: { role: 'assistant', content: 'a private thought, never sent anywhere' },
    stripped: false, usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  }, EMPTY_END]);
  const { agent, sent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signal(); };

  void agent.loop();
  agent.enqueue(ambientMsg('1002', 'a-1'));
  agent.fireAmbientTick();
  await done;
  await microtask();
  await microtask();

  assert.equal(llm.calls, 2, 'exactly the end-nudge round trip — no third (repair) turn from a ghost-nudge');
  assert.equal(sent.length, 0);
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(!users.some((m) => m.content.includes('you wrote a reply but sent nothing')),
    'no ghost-nudge message appended — an ambient-only turn never sets realUserTurn');
  agent.stop();
});

test('ambient: tick with only quiet-tier/muted ambient does not fire', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const mutes = stubMutes({ '2001': 'mute' });
  const { agent } = buildAgent(llm, { mutes });

  void agent.loop();
  agent.enqueue(ambientMsg('1003', 'a-1')); // quiet tier
  agent.enqueue(ambientMsg('2001', 'a-2', { guildId: FIXTURE_GUILDS[1].id })); // muted
  await microtask();

  agent.fireAmbientTick();
  await microtask();
  await microtask();

  assert.equal(llm.calls, 0, 'neither pending message counts toward the tick, so it never fires');
  assert.equal(agent.inboundQueueLengthForTest, 2, 'both ambient messages remain queued, undrained');
  agent.stop();
});

test('ambient: one qualifying room lets a muted room\'s message ride along in the same notice', async () => {
 // countsForTick is a gate over the WHOLE pending batch, not a per-message
 // filter (spec intent, pinned in docs/context.md): a single social-tier
 // message is enough for the tick to fire, and the notice then counts and
 // labels every pending message — including a muted room's, which would not
 // have counted on its own. A muted channel is read-but-not-spoken-in; the
 // killswitch blocks the SEND, not the read.
  const llm = scriptedLLM([EMPTY_END]);
  const mutes = stubMutes({ '2001': 'mute' });
  const { agent } = buildAgent(llm, { mutes });
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };

  void agent.loop();
  agent.enqueue(ambientMsg('1002', 's-1')); // social tier — counts on its own
  agent.enqueue(ambientMsg('2001', 'm-1', { guildId: FIXTURE_GUILDS[1].id })); // muted — would not count alone
  await microtask();

  agent.fireAmbientTick();
  await done;
  await microtask();

  assert.equal(llm.calls, 1, 'the qualifying social-tier message let the tick fire');
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.equal(users.length, 3, '2 ambient envelopes + 1 room-context notice');
  const notice = users[2].content;
  assert.ok(notice.includes('room context — 2 messages'), 'both pending messages are counted, not just the qualifying one');
  assert.ok(notice.includes('1002'), 'the qualifying room is labeled');
  assert.ok(notice.includes('2001'), 'the muted room rides along in the same notice label');
  agent.stop();
});

test('ambient: mention (wakeClass wake) still wakes immediately', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };

  void agent.loop();
  agent.enqueue(ambientMsg('1002', 'w-1', { wakeClass: 'wake' }));
  await done;
  await microtask();

  assert.equal(llm.calls, 1, 'a wake-class message starts a turn immediately, batching or not');
  agent.stop();
});

test('ambient: a thread\'s ambient chat resolves to its parent for the tick', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };

  void agent.loop();
 // The thread's own id ('thread-under-1002') is NOT itself in the guild
 // index — only its parent ('1002', social tier) is. Without resolving
 // through policyChannelId, countsForTick would never find it and the tick
 // would never fire for thread chat.
  agent.enqueue(ambientMsg('thread-under-1002', 't-1', { channelName: 'my-thread', policyChannelId: '1002' }));
  await microtask();

  agent.fireAmbientTick();
  await done;
  await microtask();

  assert.equal(llm.calls, 1, 'the tick fired because the thread resolves to its parent\'s social tier');
  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(users.some((m) => m.content.includes('room context — 1 message')), 'a room-context notice was enqueued');
  agent.stop();
});

test('ambient: notice wording for three or more rooms is a comma list with a final "and"', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };

  void agent.loop();
  agent.enqueue(ambientMsg('1002', 'a-1'));
  agent.enqueue(ambientMsg('2001', 'a-2', { guildId: FIXTURE_GUILDS[1].id }));
  agent.enqueue(ambientMsg('1003', 'a-3')); // quiet tier — rides along once 1002/2001 qualify
  await microtask();

  agent.fireAmbientTick();
  await done;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  const notice = users[users.length - 1].content;
  assert.ok(
    notice.includes('across alpha/1002, beta/2001, and alpha/1003.'),
    `expected a comma list with a final "and" past two rooms, got: ${notice}`,
  );
  assert.doesNotMatch(notice, /\S+ and \S+ and \S+/, 'must not degrade to "a and b and c"');
  agent.stop();
});

test('ambient: clearContext resets ambientUnseen — a post-clear tick must not fire on stale bookkeeping', async () => {
 // Regression for a concrete repro (traced in review, not hypothetical):
 // 1. A wake message starts a real-user turn.
 // 2. Ambient chat is enqueued while that turn's LLM call is in flight.
 // 3. The model ends the turn naturally (no tool calls) -> hasNewInput=false.
 // 4. The loop reaches the top, drains the queued ambient into history AND
 // ambientUnseen, then parks on the (unbounded) wake promise.
 // 5. clearContext fires — wiping history.
 // 6. Without resetting ambientUnseen, the next fireAmbientTick would
 // find the stale entry still pending and enqueue a room-context notice
 // describing history that no longer exists, waking a turn out of thin
 // air on an empty mind.
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgent(llm);
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => {
    if (n === 1) {
 // Ambient traffic lands mid-turn (busy=true) — it queues but cannot
 // itself wake anything; it's still sitting in `inbound` right now.
      agent.enqueue(ambientMsg('1002', 'a-1'));
      signal();
    }
  };

  void agent.loop();
  agent.enqueue(ambientMsg('1001', 'w-1', { wakeClass: 'wake', content: 'a real user message' }));
  await done;
 // Let the natural turn-end run to completion: drains the queued ambient
 // into history + ambientUnseen, then parks without a second LLM call.
  await microtask();
  await microtask();
  await microtask();

  assert.equal(llm.calls, 1, 'the real-user turn ended naturally — no second call yet');
  assert.ok(agent.messagesForTest.some((m) => m.content.includes('chat in 1002')),
    'the ambient message drained into history before the clear');

  agent.clearContext();
  agent.fireAmbientTick();
  await microtask();
  await microtask();
  await microtask();

  assert.equal(llm.calls, 1, 'no turn ran after the clear — the tick found nothing pending');
  assert.equal(agent.messagesForTest.length, 0, 'history stays empty after the clear');
  agent.stop();
});

// Ambient traffic must never starve the heartbeat. The skip guard once counted
// `inbound.length`, written when every queued message was guaranteed to drain
// at the next wake — ambient messages break that guarantee: they sit in the
// queue indefinitely without waking the loop, and for a muted or quiet-tier
// channel the ambient tick never fires from them either. Steady chat in such a
// room therefore parked the beat forever (reflection, ponder, the per-guild
// social nudge, memory writes — all silently stopped) behind a log line that
// read like nothing was wrong. The guard now counts only wake-class pending.
test('heartbeat: ambient-only backlog does not skip the beat; a wake-class message still does', async () => {
  const llm = scriptedLLM([EMPTY_END]);
  const { agent } = buildAgent(llm);
  agent.primeForHeartbeatTest();

 // A muted channel is the sharp case: classifyInbound downgrades it to
 // ambient and countsForTick refuses it, so nothing else will ever drain it.
  agent.enqueue(ambientMsg('1002', 'a-1'));
  agent.enqueue(ambientMsg('1002', 'a-2'));

  await agent.fireHeartbeatForTest();
  assert.equal(agent.inboundQueueLengthForTest, 3, 'the beat fired and enqueued alongside the ambient backlog');
  assert.ok(
    (agent['inbound'] as InboundMessage[]).some((m) => m.channelName === 'heartbeat'),
    'the enqueued message is the heartbeat',
  );

 // Drain, then re-run with a real (wake-class) message pending: still skips.
  (agent['inbound'] as InboundMessage[]).length = 0;
  agent.enqueue(ambientMsg('1001', 'w-1', { wakeClass: 'wake', content: 'a real user message' }));
  await agent.fireHeartbeatForTest();
  assert.equal(agent.inboundQueueLengthForTest, 1, 'a queued wake-class message still skips the beat');

  agent.stop();
});
