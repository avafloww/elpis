// Integration coverage for the REAL Discord ingest path — createDiscord's
// MessageCreate listener — which nothing else in the suite drives (every
// other loop test hand-builds an already-classified InboundMessage and calls
// agent.enqueue directly, skipping src/discord.ts entirely). wake.test.ts
// pins classifyInbound as a pure function; this file pins the composition
// around it: the actual gateway handler, the ambient_tick_ms=0 escape hatch
// (discord.ts's cls==='ambient' -> 'wake' promotion), and its muted-channel
// exception, wired to a real running Agent loop.
//
// A hand-built object satisfying the narrow discord.js surface the handler
// actually touches (duck-typed — no `instanceof` checks in discord.ts) is
// emitted on the real Client discord.js constructs inside createDiscord;
// no network or login is involved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Events, type Message } from 'discord.js';
import { createDiscord } from '../src/discord/discord.js';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import type { GuildConfig } from '../src/config.js';
import type { MuteStore, MuteRow, MuteType } from '../src/store/mutes.js';
import { buildTestAgent, makeConfig, EMPTY_WAKE } from './helpers.js';

// Both channels are 'social' tier: a plain human message with no mention/reply
// classifies as 'ambient' there (wake.test.ts), which is the precondition for
// the escape hatch to even consider promoting it to 'wake'.
const FIXTURE_GUILD: GuildConfig = {
  id: 'g1', slug: 'alpha', slashCommands: false, quietHours: null, timezone: null,
  channels: { '1002': 'social', '1003': 'social' },
};

function scriptedLLM(responses: CompleteResult[]): LLM & { calls: number; onCall: ((n: number) => void) | null } {
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
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return Promise.resolve(r);
    },
    summarize(): Promise<string> { return Promise.resolve('SUMMARY'); },
  } as LLM & { calls: number; onCall: ((n: number) => void) | null };
}

function stubMutes(muted: Record<string, MuteType>): MuteStore {
  const row = (id: string, type: MuteType): MuteRow =>
    ({ channelId: id, type, setBy: 'operator', reason: null, createdAt: '2026-01-01T00:00:00Z' });
  return {
    get: (id) => (muted[id] ? row(id, muted[id]) : null),
    set: () => {}, clear: () => false,
    all: () => Object.entries(muted).map(([id, type]) => row(id, type)),
  };
}

/** Minimal duck-typed channel: only the members discord.ts's handler touches
 * (isThread/isTextBased/sendTyping/name — no `messages`, since these
 * fixtures never carry a `reference`). */
function fakeChannel(name: string) {
  return {
    name,
    isThread: () => false,
    isTextBased: () => true,
    sendTyping: async () => {},
  };
}

/** Minimal duck-typed Message: exactly the fields buildInboundAttachments(),
 * wakeInputFor, resolvePolicyChannelId, and the handler body read. Cast
 * through `unknown` — no discord.js `instanceof` checks exist on this path,
 * so a plain object satisfies it at runtime. */
function fakeMessage(opts: {
  id: string; guildId: string; channelId: string; content: string;
  mentions?: { users?: { id: string; displayName?: string; username?: string }[]; roles?: { id: string; name: string }[]; channels?: { id: string; name: string }[] };
}): Message {
  const channel = fakeChannel(opts.channelId);
  return {
    id: opts.id,
    guildId: opts.guildId,
    channelId: opts.channelId,
    channel,
    content: opts.content,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    reference: null,
    author: { id: 'u1', bot: false, displayName: 'Casey', username: 'casey' },
    mentions: {
      users: opts.mentions?.users ?? ([] as { id: string }[]),
      roles: opts.mentions?.roles ?? ([] as { id: string; name: string }[]),
      channels: opts.mentions?.channels ?? ([] as { id: string; name: string }[]),
    },
    attachments: new Map(),
  } as unknown as Message;
}

function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}
async function flush(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await microtask();
}

test('discord ingest: ambient_tick_ms=0 escape hatch wakes an unmuted social channel but a muted one never wakes', async () => {
  const llm = scriptedLLM([EMPTY_WAKE]);
  const mutes = stubMutes({ '1003': 'mute' }); // '1003' muted; '1002' is not
  const { agent, tmpDir, config } = buildTestAgent({
    llm,
    config: {
 // makeConfig's default ambientTickMs is already 0 (the escape hatch),
 // but pin it explicitly since the whole test depends on it.
      discord: { ...makeConfig().discord, guilds: [FIXTURE_GUILD], ambientTickMs: 0 },
    },
    agentDeps: { mutes },
    tmpPrefix: 'harness-discord-ingest-',
  });
  void tmpDir;
  const { client } = createDiscord(config, agent, { mutes });

  void agent.loop();

 // Muted channel first: classifyInbound downgrades it to 'ambient' (social
 // tier, no mention), and the escape hatch's muteType recheck must refuse to
 // promote it to 'wake' even though ambientTickMs===0 would otherwise
 // promote every non-drop ambient message.
  client.emit(Events.MessageCreate, fakeMessage({ id: 'm-muted', guildId: 'g1', channelId: '1003', content: 'chatter' }));
  await flush();

  assert.equal(llm.calls, 0, 'a muted channel must never wake the loop, escape hatch or not');
  assert.equal(agent.inboundQueueLengthForTest, 1, 'the muted message still entered the queue as ambient — read, not spoken to');

 // Contrast: the SAME config, an UNMUTED social channel — proves the escape
 // hatch is actually armed (not merely inert) and that the muted case above
 // is being blocked by the recheck, not by some unrelated reason.
  const { promise: done, resolve: signal } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 1) signal(); };
  client.emit(Events.MessageCreate, fakeMessage({ id: 'm-unmuted', guildId: 'g1', channelId: '1002', content: 'chatter' }));
  await done;
  await flush();

  assert.equal(llm.calls, 1, 'an unmuted social-tier message wakes immediately under the ambient_tick_ms=0 escape hatch');
  agent.stop();
});

test('discord ingest: mention markup in the body is resolved to names before it reaches the agent', async () => {
  const llm = scriptedLLM([EMPTY_WAKE]);
  const { agent, tmpDir, config } = buildTestAgent({
    llm,
    config: { discord: { ...makeConfig().discord, guilds: [FIXTURE_GUILD], ambientTickMs: 0 } },
    tmpPrefix: 'harness-discord-mentions-',
  });
  void tmpDir;
  const { client } = createDiscord(config, agent);

 // Capture what the handler hands the agent — this is the exact body that
 // lands in the one history and the transcript.
  const seen: { content: string }[] = [];
  const realEnqueue = agent.enqueue.bind(agent);
  (agent as unknown as { enqueue: (m: Parameters<typeof realEnqueue>[0]) => void }).enqueue = (m) => {
    seen.push({ content: m.content });
  };

  client.emit(Events.MessageCreate, fakeMessage({
    id: 'm-mention', guildId: 'g1', channelId: '1002',
    content: '<@111111111111111103> do mentions work too? ask <@&333333333333333333> in <#1002>',
    mentions: {
      users: [{ id: '111111111111111103', displayName: 'Echo', username: 'echo' }],
      roles: [{ id: '333333333333333333', name: 'friends' }],
      channels: [{ id: '1002', name: 'lounge' }],
    },
  }));
  await flush();

  assert.equal(seen.length, 1, 'the message reached the agent');
  assert.equal(
    seen[0].content,
    '@Echo do mentions work too? ask @friends in #lounge',
    'user/role/channel markup all resolved at ingest',
  );
  agent.stop();
});

test('discord ingest: guild default tier admits unknown channels and explicit drop overrides it', async () => {
  const listenGuild: GuildConfig = {
    id: 'g1', slug: 'alpha', slashCommands: false, quietHours: null, timezone: null,
    defaultTier: 'social', allowSend: true, defaultAllowSend: false,
    channels: { '1003': 'drop' }, channelAllowSend: { '1003': false },
  };
  const { agent, config } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds: [listenGuild], ambientTickMs: 60_000 } },
    tmpPrefix: 'harness-discord-default-tier-',
  });
  const { client } = createDiscord(config, agent);
  const seen: string[] = [];
  (agent as unknown as { enqueue: (m: { channelId: string }) => void }).enqueue = (m) => { seen.push(m.channelId); };

  client.emit(Events.MessageCreate, fakeMessage({ id: 'm-default', guildId: 'g1', channelId: '9999', content: 'ambient digest material' }));
  client.emit(Events.MessageCreate, fakeMessage({ id: 'm-drop', guildId: 'g1', channelId: '1003', content: 'must not enter' }));
  await flush();

  assert.deepEqual(seen, ['9999']);
  agent.stop();
});
