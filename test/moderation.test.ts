// moderation.test.ts — the killswitch's single transition implementation
// Agent.moderateChannel asymmetry under test: 'self' may
// only mute; release ('unmute'/'undeafen') and 'deafen' are operator-only, and
// a self actor can never override an existing operator row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildTestAgent,
  EMPTY_WAKE,
  makeConfig,
  makeStubLLM,
} from './helpers.js';
import { createMuteStore, type MuteStore } from '../src/store/mutes.js';
import { createChannelDirectory } from '../src/store/channels.js';
import { openDatabase } from '../src/store/db.js';
import { createBgRegistry } from '../src/sandbox/bg.js';
import type { GuildConfig } from '../src/config.js';
import type { Agent } from '../src/agent.js';
import type {
  OutboundEffectScope,
  OutboundSendAuthorization,
} from '../src/types.js';

const guilds: GuildConfig[] = [
  {
    id: 'g2',
    slug: 'friends-a',
    slashCommands: false,
    quietHours: null,
    timezone: null,
    channels: { '2001': 'social' },
  },
];

function build() {
  let mutesRef!: MuteStore;
  const built = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
      // The self-moderation notice names the agent from SOUL.md frontmatter —
      // written here (over the helper's bare '# Soul') to test the derivation.
      fs.writeFileSync(
        path.join(tmpDir, 'SOUL.md'),
        '---\nname: Echo\n---\n\n# Soul\n',
      );
      const db = openDatabase(tmpDir);
      const mutes = createMuteStore(db);
      mutesRef = mutes;
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('2001', 'lounge', 'g2');
      return { mutes, channels };
    },
    tmpPrefix: 'harness-moderation-',
  });
  return { ...built, mutes: mutesRef };
}

/** The last internal-provenance ([harness] ...) message drained into history. */
function lastInternalNotice(agent: Agent): string {
  const users = agent.messagesForTest.filter(
    (m) =>
      m.role === 'user' &&
      m.content.includes('channel="harness"') &&
      m.content.includes('author="harness"'),
  );
  return users[users.length - 1]?.content ?? '';
}

test('moderate: self-mute writes a self row and appends an internal notice', async () => {
  const { agent, mutes, cleanup } = build();

  const r = agent.moderateChannel('2001', 'mute', 'self', 'asked to stop');
  assert.equal(r.ok, true);
  assert.equal(mutes.get('2001')!.setBy, 'self');

  void agent.loop();
  await new Promise((res) => setTimeout(res, 20));
  assert.match(
    lastInternalNotice(agent),
    /friends-a\/lounge muted by Echo \(self\): asked to stop/,
  );
  agent.stop();
  cleanup();
});

test('send rejects an unconfigured raw channel before transport', async () => {
  const { agent, sent, cleanup } = build();

  await assert.rejects(
    () => agent.send('999999', 'must not leave'),
    /channel is not configured/,
  );
  assert.equal(sent.length, 0);
  agent.stop();
  cleanup();
});

test('moderate: send to a muted channel throws with reason and release note', async () => {
  const { agent, cleanup } = build();

  agent.moderateChannel('2001', 'mute', 'self', 'asked to stop');
  await assert.rejects(
    () => agent.send('2001', 'hi'),
    /muted.*asked to stop.*release is operator-only/s,
  );
  agent.stop();
  cleanup();
});

// A thread inherits its parent's policy on the way IN (resolvePolicyChannelId)
// but has its own Discord channel id and never gets a mute row of its own. If
// send checked the raw target only, muting #general would leave every thread
// under it wide open — and a thread is the natural reply target for any
// threaded conversation, so the bypass is the DEFAULT path, not an edge case.
// The parent link is recorded by enqueue (policyChannelId → channels.set).
test('moderate: a mute on a parent channel holds for a send into its thread', async () => {
  const { agent, mutes, sent, cleanup } = build();

  // A thread message as discord.ts builds it: the thread's own id/name for
  // provenance, the PARENT id for policy.
  agent.enqueue({
    id: 'm1',
    channelId: '2050',
    channelName: 'side-quest',
    author: 'ana',
    authorId: 'u1',
    content: 'over here',
    createdAt: new Date().toISOString(),
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    guildId: 'g2',
    wakeClass: 'ambient',
    policyChannelId: '2001',
  });

  agent.moderateChannel('2001', 'mute', 'operator', 'quiet please');
  await assert.rejects(
    () => agent.send('2050', 'hi'),
    /parent.*muted.*quiet please.*release is operator-only/s,
  );
  assert.equal(sent.length, 0, 'nothing reached Discord');
  assert.equal(
    mutes.get('2050'),
    null,
    'the block comes from the parent — the thread has no row of its own',
  );

  // Releasing the parent releases the thread with it.
  agent.moderateChannel('2001', 'unmute', 'operator');
  await agent.send('2050', 'hi');
  assert.equal(sent.length, 1);

  agent.stop();
  cleanup();
});

test('moderate: self cannot release, self cannot override operator row', () => {
  const { agent, mutes, cleanup } = build();

  agent.moderateChannel('2001', 'mute', 'operator', 'op call');
  assert.equal(agent.moderateChannel('2001', 'mute', 'self').ok, false);
  assert.equal(agent.moderateChannel('2001', 'unmute', 'self').ok, false);
  assert.equal(mutes.get('2001')!.setBy, 'operator');
  cleanup();
});

test('moderate: deafen is operator-only, implies mute, replaces mute row', () => {
  const { agent, mutes, cleanup } = build();

  assert.equal(agent.moderateChannel('2001', 'deafen', 'self').ok, false);
  agent.moderateChannel('2001', 'mute', 'self');
  agent.moderateChannel('2001', 'deafen', 'operator', 'funky');
  assert.equal(mutes.get('2001')!.type, 'deafen');
  assert.equal(agent.moderateChannel('2001', 'mute', 'self').ok, false); // already deafened note
  cleanup();
});

test('moderate: operator release clears; release of a clean channel reports not-muted', () => {
  const { agent, mutes, cleanup } = build();

  agent.moderateChannel('2001', 'mute', 'self');
  assert.equal(agent.moderateChannel('2001', 'unmute', 'operator').ok, true);
  assert.equal(mutes.get('2001'), null);
  assert.equal(agent.moderateChannel('2001', 'unmute', 'operator').ok, false);
  cleanup();
});

test('moderate: unmute clears a deafen row (deafen implies mute, one row either verb releases)', () => {
  const { agent, mutes, cleanup } = build();

  agent.moderateChannel('2001', 'deafen', 'operator', 'noisy');
  assert.equal(mutes.get('2001')!.type, 'deafen');
  assert.equal(agent.moderateChannel('2001', 'unmute', 'operator').ok, true);
  assert.equal(mutes.get('2001'), null);
  cleanup();
});

test('roomsSnapshot: a configured-but-never-spoken-in channel still renders, carrying guildSlug/tier/muteState', () => {
  const localGuilds: GuildConfig[] = [
    {
      id: 'g3',
      slug: 'quiet-town',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      channels: { '3001': 'quiet' },
    },
  ];
  const { agent, cleanup } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds: localGuilds } },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const mutes = createMuteStore(db);
      const channels = createChannelDirectory(db, tmpDir, localGuilds);
      // deliberately never call channels.set('3001', ...) — it has never been spoken in
      return { mutes, channels };
    },
    tmpPrefix: 'harness-rooms-',
  });

  const rooms = agent.roomsSnapshot();
  const room = rooms.find((r) => r.id === '3001');
  assert.ok(room, 'configured-but-never-spoken channel still renders');
  assert.equal(room!.guildSlug, 'quiet-town');
  assert.equal(room!.tier, 'quiet');
  assert.equal(room!.muteState, null);
  assert.equal(room!.count, 0);

  agent.moderateChannel('3001', 'deafen', 'operator');
  assert.equal(
    agent.roomsSnapshot().find((r) => r.id === '3001')!.muteState,
    'deafen',
  );

  const internal = rooms.find((r) => r.group === 'harness');
  assert.ok(internal, 'internal room present');
  assert.equal(internal!.guildSlug, null);
  assert.equal(internal!.tier, null);
  assert.equal(internal!.muteState, null);

  cleanup();
});

test('mentions tier binds every outbound attempt to the exact waking thread', async () => {
  const mentionGuilds: GuildConfig[] = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      defaultTier: 'mentions',
      allowSend: true,
      defaultAllowSend: false,
      channels: { '5002': 'direct' },
      channelAllowSend: { '5002': true },
    },
  ];
  let agent!: Agent;
  let exactError: unknown;
  let parentError: unknown;
  let otherError: unknown;
  let consoleError: unknown;
  let issuedAuthorization:
    { channelId: string; isCurrent: () => boolean } | undefined;
  const completed = Promise.withResolvers<void>();
  const queuedTurnStarted = Promise.withResolvers<void>();
  const afterTurn = Promise.withResolvers<void>();
  let turnCompleted = false;
  let completeCalls = 0;
  let oldAuthorizationCurrentInQueuedTurn: boolean | undefined;
  const llm = makeStubLLM({
    complete: async () => {
      completeCalls++;
      if (completeCalls === 2) {
        oldAuthorizationCurrentInQueuedTurn = issuedAuthorization?.isCurrent();
        queuedTurnStarted.resolve();
        return EMPTY_WAKE;
      }
      try {
        await agent.send('5050', 'exact thread');
      } catch (error) {
        exactError = error;
      }
      try {
        await agent.send('5001', 'parent room');
      } catch (error) {
        parentError = error;
      }
      try {
        await agent.send('5002', 'other room');
      } catch (error) {
        otherError = error;
      }
      try {
        await agent.send('console', 'operator console');
      } catch (error) {
        consoleError = error;
      }
      turnCompleted = true;
      completed.resolve();
      return EMPTY_WAKE;
    },
  });
  const built = buildTestAgent({
    llm,
    config: {
      discord: { ...makeConfig().discord, guilds: mentionGuilds },
    },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, mentionGuilds);
      channels.set('5001', 'mentions-parent', 'g-mentions');
      channels.set('5050', 'asked-thread', 'g-mentions', '5001');
      channels.set('5002', 'not-asked-here', 'g-mentions');
      return {
        channels,
        onThinking: (_channelId, authorization) => {
          if (authorization) issuedAuthorization = authorization;
        },
        onIdle: () => {
          if (turnCompleted) afterTurn.resolve();
        },
      };
    },
    tmpPrefix: 'harness-mentions-send-qualifier-',
  });
  agent = built.agent;
  agent.setOutboundSendAuthorizationIssuer((channelId, guildId, isCurrent) =>
    Object.freeze({ kind: 'mentions-turn', channelId, guildId, isCurrent }),
  );
  const scheduler = (
    agent as unknown as {
      deps: { scheduler: { create(input: unknown): unknown } };
    }
  ).deps.scheduler;
  const originalCreate = scheduler.create.bind(scheduler);
  let queuedAtWakeArm = false;
  scheduler.create = (input) => {
    const task = originalCreate(input);
    if (!queuedAtWakeArm) {
      queuedAtWakeArm = true;
      agent.notifyBackgroundJob(
        'mentions-expiry-test',
        'finished',
        'queued turn boundary',
      );
    }
    return task;
  };

  await assert.rejects(
    agent.send('5050', 'outside a turn'),
    /disabled by configuration/i,
  );
  void agent.loop();
  agent.enqueue({
    id: 'mention-1',
    channelId: '5050',
    channelName: 'asked-thread',
    author: 'Aster',
    authorId: 'person-1',
    content: '@Agent answer this',
    createdAt: '2026-09-14T12:00:00.000Z',
    replyTo: null,
    forwarded: null,
    mentions: ['@Agent'],
    attachments: [],
    guildId: 'g-mentions',
    guildSlug: 'mentions',
    kind: 'discord',
    wakeClass: 'wake',
    policyChannelId: '5001',
  });
  await completed.promise;
  await queuedTurnStarted.promise;

  assert.equal(exactError, undefined);
  assert.equal(
    oldAuthorizationCurrentInQueuedTurn,
    false,
    'the token expires before an already-queued internal turn begins',
  );
  assert.match(
    String(otherError),
    /mentions-turn authorization.*exact waking channel/i,
  );
  assert.match(
    String(consoleError),
    /mentions-turn authorization.*exact waking channel/i,
  );
  assert.match(
    String(parentError),
    /mentions-turn authorization.*exact waking channel/i,
  );
  assert.deepEqual(built.sent, [{ channelId: '5050', text: 'exact thread' }]);
  await afterTurn.promise;
  await assert.rejects(
    agent.send('5050', 'after the turn'),
    /disabled by configuration/i,
  );
  assert.equal(issuedAuthorization?.isCurrent(), false);
  const internals = agent as unknown as {
    realUserTurn: boolean;
    mentionsTurnChannelId: string | null;
    mentionsTurnToken: object | null;
  };
  internals.realUserTurn = true;
  internals.mentionsTurnChannelId = '5050';
  internals.mentionsTurnToken = {};
  assert.equal(
    issuedAuthorization?.isCurrent(),
    false,
    'an old capability cannot revive in a later turn for the same room',
  );
  agent.stop();
  built.cleanup();
});

test('mentions turn confines an explicitly sendable source and error channel', async () => {
  const guilds: GuildConfig[] = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      defaultTier: 'mentions',
      allowSend: true,
      defaultAllowSend: false,
      channels: { '5201': 'mentions', '5202': 'direct' },
      channelAllowSend: { '5201': true, '5202': true },
    },
  ];
  let agent!: Agent;
  let exactError: unknown;
  let otherError: unknown;
  let consoleError: unknown;
  let issuedAuthorization: OutboundSendAuthorization | undefined;
  let capturedScope: OutboundEffectScope | undefined;
  const transportCalls: {
    channelId: string;
    text: string;
    authorization?: OutboundSendAuthorization;
  }[] = [];
  const typingAuthorizations: Array<OutboundSendAuthorization | undefined> = [];
  const completed = Promise.withResolvers<void>();
  const afterTurn = Promise.withResolvers<void>();
  let turnCompleted = false;
  const llm = makeStubLLM({
    complete: async () => {
      try {
        await agent.send('5201', 'exact source');
      } catch (error) {
        exactError = error;
      }
      try {
        await agent.send('5202', 'other room');
      } catch (error) {
        otherError = error;
      }
      try {
        await agent.send('console', 'operator console');
      } catch (error) {
        consoleError = error;
      }
      await (
        agent as unknown as { sendError(text: string): Promise<void> }
      ).sendError('harness fault');
      capturedScope = agent.captureSandboxOutboundScope();
      turnCompleted = true;
      completed.resolve();
      return EMPTY_WAKE;
    },
  });
  const built = buildTestAgent({
    llm,
    config: {
      discord: {
        ...makeConfig().discord,
        guilds,
        errorChannelId: '5202',
      },
    },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('5201', 'asked-here', 'g-mentions');
      channels.set('5202', 'elsewhere', 'g-mentions');
      return {
        channels,
        send: async (channelId, text, _options, authorization) => {
          transportCalls.push({ channelId, text, authorization });
        },
        onThinking: (_channelId, authorization) => {
          typingAuthorizations.push(authorization);
          if (authorization) issuedAuthorization = authorization;
        },
        onIdle: () => {
          if (turnCompleted) afterTurn.resolve();
        },
      };
    },
    tmpPrefix: 'harness-mentions-sendable-source-scope-',
  });
  agent = built.agent;
  agent.setOutboundSendAuthorizationIssuer((channelId, guildId, isCurrent) =>
    Object.freeze({ kind: 'mentions-turn', channelId, guildId, isCurrent }),
  );
  const unscoped = agent.captureSandboxOutboundScope();

  const running = agent.loop();
  agent.enqueue({
    id: 'mention-sendable-source',
    channelId: '5201',
    channelName: 'asked-here',
    author: 'Aster',
    authorId: 'person-1',
    content: '@Agent answer this',
    createdAt: '2026-09-14T12:00:00.000Z',
    replyTo: null,
    forwarded: null,
    mentions: ['@Agent'],
    attachments: [],
    guildId: 'g-mentions',
    guildSlug: 'mentions',
    kind: 'discord',
    wakeClass: 'wake',
    policyChannelId: '5201',
  });
  await completed.promise;

  assert.equal(exactError, undefined);
  assert.equal(issuedAuthorization?.channelId, '5201');
  assert.equal(issuedAuthorization?.guildId, 'g-mentions');
  assert.equal(issuedAuthorization?.isCurrent(), true);
  assert.match(
    String(otherError),
    /mentions-turn authorization.*exact waking channel/i,
  );
  assert.match(
    String(consoleError),
    /mentions-turn authorization.*exact waking channel/i,
  );
  assert.deepEqual(
    transportCalls.map(({ channelId, text }) => ({ channelId, text })),
    [{ channelId: '5201', text: 'exact source' }],
  );
  assert.strictEqual(capturedScope?.authorization, issuedAuthorization);

  await afterTurn.promise;
  assert.equal(issuedAuthorization?.isCurrent(), false);
  const staleScope = capturedScope!;
  await assert.rejects(
    agent.send('5202', 'late other room', undefined, staleScope),
    /mentions-turn authorization.*exact waking channel/i,
  );
  await agent.send('5201', 'late exact source', undefined, staleScope);
  assert.strictEqual(transportCalls.at(-1)?.authorization, issuedAuthorization);
  const typingBeforeStale = typingAuthorizations.length;
  agent.typing('5201', staleScope);
  assert.strictEqual(
    typingAuthorizations[typingBeforeStale],
    issuedAuthorization,
  );

  agent.clearContext();
  await agent.send('5201', 'late exact after clear', undefined, staleScope);
  assert.strictEqual(transportCalls.at(-1)?.authorization, issuedAuthorization);
  agent.typing('5201', staleScope);
  assert.strictEqual(typingAuthorizations.at(-1), issuedAuthorization);

  await agent.send('5202', 'unscoped after expiry', undefined, unscoped);
  assert.equal(transportCalls.at(-1)?.authorization, undefined);
  agent.typing('5202', unscoped);
  assert.equal(typingAuthorizations.at(-1), undefined);

  const internals = agent as unknown as {
    realUserTurn: boolean;
    mentionsTurnChannelId: string | null;
    mentionsTurnToken: object | null;
    mentionsTurnAuthorizationToken: OutboundSendAuthorization | null;
  };
  const laterToken = {};
  const laterAuthorization = Object.freeze({
    kind: 'mentions-turn' as const,
    channelId: '5201',
    guildId: 'g-mentions',
    isCurrent: () => internals.mentionsTurnToken === laterToken,
  });
  internals.realUserTurn = true;
  internals.mentionsTurnChannelId = '5201';
  internals.mentionsTurnToken = laterToken;
  internals.mentionsTurnAuthorizationToken = laterAuthorization;
  const transportsBeforeLater = transportCalls.length;
  const typingsBeforeLater = typingAuthorizations.length;
  await assert.rejects(
    agent.send('5201', 'old scope in later generation', undefined, staleScope),
    /mentions-turn authorization.*unavailable/i,
  );
  await assert.rejects(
    agent.send('5201', 'unscoped in later generation', undefined, unscoped),
    /mentions-turn authorization.*unavailable/i,
  );
  agent.typing('5201', staleScope);
  agent.typing('5201', unscoped);
  assert.equal(transportCalls.length, transportsBeforeLater);
  assert.equal(typingAuthorizations.length, typingsBeforeLater);

  agent.stop();
  await running;
  built.cleanup();
});

test('missing mentions issuer stays fail-closed across detached finish and clear', async () => {
  const guilds: GuildConfig[] = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      allowSend: true,
      defaultTier: 'mentions',
      defaultAllowSend: false,
      channels: { '5101': 'mentions', '5102': 'direct' },
      channelAllowSend: { '5101': true, '5102': true },
    },
  ];
  const settled = [
    Promise.withResolvers<void>(),
    Promise.withResolvers<void>(),
  ];
  let settledCount = 0;
  let typingEffects = 0;
  const built = buildTestAgent({
    config: {
      discord: { ...makeConfig().discord, guilds },
      sandbox: {
        ...makeConfig().sandbox,
        asyncDeadlineMs: 10,
        persistentRetirementGraceMs: 1000,
      },
    },
    sandboxDeps: ({ tmpDir, agentRef }) => ({
      bg: createBgRegistry(tmpDir),
      sleepPause: (scope) => agentRef.current!.sleepPause(scope),
      sleepResume: (scope) => agentRef.current!.sleepResume(scope),
      onFutureSettled: () => settled[settledCount++]?.resolve(),
    }),
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('5101', 'issuer-required', 'g-mentions');
      channels.set('5102', 'other-sendable', 'g-mentions');
      return {
        channels,
        onThinking: () => {
          typingEffects++;
        },
      };
    },
    tmpPrefix: 'harness-mentions-issuer-required-',
  });
  const internals = built.agent as unknown as {
    busy: boolean;
    realUserTurn: boolean;
    turnChannelId: string | null;
    outboundTurnToken: object | null;
    mentionsTurnChannelId: string | null;
    mentionsTurnToken: object | null;
    finishTurn(): void;
  };
  const activateBrokenMention = () => {
    internals.busy = true;
    internals.realUserTurn = true;
    internals.turnChannelId = '5101';
    internals.outboundTurnToken = {};
    internals.mentionsTurnChannelId = '5101';
    internals.mentionsTurnToken = {};
  };
  const startDetachedEffects = async () => {
    const result = await built.sandbox.run(`
      await elpis.sleep(40);
      await Promise.allSettled([
        elpis.channel('5101').send('late exact', { files: [{ path: '/tmp/must-not-be-read' }] }),
        elpis.channel('5102').send('late elsewhere'),
      ]);
      elpis.channel('5101').typing();
      elpis.channel('5102').typing();
    `);
    assert.equal(result.detached, true);
  };
  const waitFor = async (promise: Promise<void>) => {
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('detached missing-issuer test timed out')),
            500,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  try {
    activateBrokenMention();
    await assert.rejects(
      built.agent.send('5101', 'must not reach transport'),
      /mentions-turn authorization.*unavailable/i,
    );
    await startDetachedEffects();
    internals.finishTurn();
    await waitFor(settled[0].promise);

    activateBrokenMention();
    await startDetachedEffects();
    built.agent.clearContext();
    await waitFor(settled[1].promise);

    assert.deepEqual(built.sent, []);
    assert.equal(typingEffects, 0);
  } finally {
    built.cleanup();
  }
});

test('false or throwing mention-current proofs capture permanently denied scope', async () => {
  const guilds: GuildConfig[] = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      allowSend: true,
      defaultTier: 'mentions',
      defaultAllowSend: false,
      channels: { '5141': 'mentions' },
      channelAllowSend: { '5141': true },
    },
  ];
  const built = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('5141', 'invalid-current-proof', 'g-mentions');
      return { channels };
    },
    tmpPrefix: 'harness-mentions-invalid-current-',
  });
  const internals = built.agent as unknown as {
    busy: boolean;
    realUserTurn: boolean;
    turnChannelId: string | null;
    outboundTurnToken: object | null;
    mentionsTurnChannelId: string | null;
    mentionsTurnToken: object | null;
    mentionsTurnAuthorizationToken: {
      kind: 'mentions-turn';
      channelId: string;
      guildId: string;
      isCurrent(): boolean;
    } | null;
  };
  internals.busy = true;
  internals.realUserTurn = true;
  internals.turnChannelId = '5141';
  internals.outboundTurnToken = {};
  internals.mentionsTurnChannelId = '5141';
  internals.mentionsTurnToken = {};

  try {
    for (const isCurrent of [
      () => false,
      () => {
        throw new Error('synthetic current-proof failure');
      },
    ]) {
      internals.mentionsTurnAuthorizationToken = Object.freeze({
        kind: 'mentions-turn',
        channelId: '5141',
        guildId: 'g-mentions',
        isCurrent,
      });
      assert.equal(
        built.agent.captureSandboxOutboundScope().kind,
        'sandbox-run-denied',
      );
      await assert.rejects(
        built.agent.send('5141', 'invalid proof must not send'),
        /authorization.*unavailable/i,
      );
    }
    const throwingFields = Object.defineProperty(
      {
        kind: 'mentions-turn' as const,
        guildId: 'g-mentions',
        isCurrent: () => true,
      },
      'channelId',
      {
        enumerable: true,
        get: () => {
          throw new Error('synthetic authorization field failure');
        },
      },
    );
    internals.mentionsTurnAuthorizationToken =
      throwingFields as typeof internals.mentionsTurnAuthorizationToken;
    assert.equal(
      built.agent.captureSandboxOutboundScope().kind,
      'sandbox-run-denied',
    );
    await assert.rejects(
      built.agent.send('5141', 'throwing fields must not send'),
      /authorization.*unavailable/i,
    );
    assert.deepEqual(built.sent, []);
  } finally {
    built.cleanup();
  }
});

test('a throwing mentions authorization issuer keeps the loop alive but outbound-denied', async () => {
  const guilds: GuildConfig[] = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      allowSend: true,
      defaultTier: 'mentions',
      defaultAllowSend: false,
      channels: { '5151': 'mentions' },
      channelAllowSend: { '5151': true },
    },
  ];
  let agent!: Agent;
  let capturedKind: OutboundEffectScope['kind'] | undefined;
  let sendError: unknown;
  const completed = Promise.withResolvers<void>();
  const llm = makeStubLLM({
    complete: async () => {
      capturedKind = agent.captureSandboxOutboundScope().kind;
      try {
        await agent.send('5151', 'must remain denied');
      } catch (error) {
        sendError = error;
      }
      completed.resolve();
      return EMPTY_WAKE;
    },
  });
  const built = buildTestAgent({
    llm,
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('5151', 'throwing-issuer', 'g-mentions');
      return { channels };
    },
    tmpPrefix: 'harness-mentions-throwing-issuer-',
  });
  agent = built.agent;
  agent.setOutboundSendAuthorizationIssuer(() => {
    throw new Error('synthetic issuer failure');
  });
  const running = agent.loop();
  agent.enqueue({
    id: 'throwing-issuer-mention',
    channelId: '5151',
    channelName: 'throwing-issuer',
    author: 'Aster',
    authorId: 'person-1',
    content: '@Agent answer this',
    createdAt: '2026-09-14T12:00:00.000Z',
    replyTo: null,
    forwarded: null,
    mentions: ['@Agent'],
    attachments: [],
    guildId: 'g-mentions',
    guildSlug: 'mentions',
    kind: 'discord',
    wakeClass: 'wake',
    policyChannelId: '5151',
  });

  let timeout: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      completed.promise.then(() => 'completed' as const),
      running.then(
        () => 'loop-exited' as const,
        (error) => error,
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('throwing issuer test timed out')),
          500,
        );
      }),
    ]);
    assert.equal(outcome, 'completed');
    assert.equal(capturedKind, 'sandbox-run-denied');
    assert.match(String(sendError), /authorization.*unavailable/i);
    assert.deepEqual(built.sent, []);
  } finally {
    if (timeout) clearTimeout(timeout);
    agent.stop();
    await running.catch(() => {});
    built.cleanup();
  }
});

test('mentions-default send denial can still establish a runtime mute', () => {
  const guilds: GuildConfig[] = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      allowSend: true,
      defaultTier: 'mentions',
      defaultAllowSend: false,
      channels: {},
      channelAllowSend: {},
    },
  ];
  let mutes!: ReturnType<typeof createMuteStore>;
  const { agent, cleanup } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('4101', 'mentions-room', 'g-mentions');
      mutes = createMuteStore(db);
      return { mutes, channels };
    },
    tmpPrefix: 'harness-mentions-runtime-mute-',
  });

  try {
    const muted = agent.moderateChannel('4101', 'mute', 'self', 'stop here');
    assert.equal(muted.ok, true);
    assert.equal(mutes.get('4101')?.type, 'mute');
  } finally {
    cleanup();
  }
});

test('config send deny blocks delivery and makes runtime mute redundant', async () => {
  const lockedGuilds: GuildConfig[] = [
    {
      id: 'g-lock',
      slug: 'locked',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      allowSend: true,
      defaultTier: 'drop',
      defaultAllowSend: false,
      channels: { '4001': 'social' },
      channelAllowSend: { '4001': false },
    },
  ];
  const { agent, sent, cleanup } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds: lockedGuilds } },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      return {
        mutes: createMuteStore(db),
        channels: createChannelDirectory(db, tmpDir, lockedGuilds),
      };
    },
    tmpPrefix: 'harness-config-send-deny-',
  });

  await assert.rejects(
    agent.send('4001', 'must not leave'),
    /sending.*disabled by configuration/i,
  );
  assert.equal(sent.length, 0);
  const muted = agent.moderateChannel('4001', 'mute', 'self');
  assert.equal(muted.ok, false);
  assert.match(muted.note, /already disabled by configuration/i);
  const room = agent.roomsSnapshot().find((r) => r.id === '4001');
  assert.equal(room?.allowSend, false);
  assert.equal(room?.sendDeniedBy, 'channel');
  assert.equal(
    (
      agent as unknown as { guildFullyMuted: (slug: string) => boolean }
    ).guildFullyMuted('locked'),
    true,
    'a guild with no config-permitted output room is structurally unspeakable',
  );
  cleanup();
});
