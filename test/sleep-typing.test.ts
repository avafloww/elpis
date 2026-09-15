// Typing-indicator pause/resume around elpis.sleep — a sleep
// is the agent *choosing to wait*, so the typing indicator must not show through it.
// Covers the Agent-side depth counter (pause/resume contract, turn-liveness
// guard, non-negative clamp) and the sandbox-side wiring (sleep hooks the
// pause/resume pair around its timer; timeout deliberately does not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/sandbox/index.js';
import { openDatabase } from '../src/store/db.js';
import { createChannelDirectory } from '../src/store/channels.js';
import { createBgRegistry } from '../src/sandbox/bg.js';
import type { SandboxDeps } from '../src/types.js';
import {
  buildTestAgent,
  makeConfig,
  makeStubLLM,
  EMPTY_WAKE,
} from './helpers.js';

/** A sandbox wired with just enough config/memory/logbuf to run, plus the two
 * sleep hooks under test. Centralizes the `as unknown as SandboxDeps` cast
 * the sandbox-level tests below all need, instead of repeating it. */
function sandboxWithSleepHooks(hooks: {
  sleepPause: () => void;
  sleepResume: () => void;
}) {
  return createSandbox({
    config: {
      sandbox: {
        syncTimeoutMs: 3000,
        asyncDeadlineMs: 8000,
        previewMaxBytes: 2048,
        logMaxBytes: 2048,
      },
      kagi: { apiKey: null },
      paths: { harnessRoot: '/tmp/hr', dataDirectory: '/tmp' },
    },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
    ...hooks,
  } as unknown as SandboxDeps);
}

/** A minimal 'wake'-class inbound message for driving one real turn through
 * the Agent loop (mirrors test/loop-multichannel.test.ts's `msg` helper). */
function inbound(id: string): {
  id: string;
  channelId: string;
  channelName: string;
  author: string;
  authorId: string;
  content: string;
  createdAt: string;
  replyTo: null;
  forwarded: null;
  mentions: string[];
  attachments: never[];
} {
  return {
    id,
    channelId: '100',
    channelName: '100',
    author: 'u',
    authorId: 'u',
    content: 'hi',
    createdAt: '2026-01-01T00:00:00Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
  };
}

test('sleep typing: pause clears typing, resume re-fires only while turn is live', () => {
  const thinking: string[] = [];
  let idleCalls = 0;
  const { agent, cleanup } = buildTestAgent({
    agentDeps: {
      onThinking: (channelId: string) => {
        thinking.push(channelId);
      },
      onIdle: () => {
        idleCalls++;
      },
    },
  });
  try {
    // No live turn (busy=false, no turnChannelId): pause still clears typing
    // (onIdle), but resume must not re-fire onThinking — nothing is "typing".
    const a = agent as any;
    a.busy = false;
    a.turnChannelId = null;
    agent.sleepPause();
    assert.equal(
      idleCalls,
      1,
      'sleepPause always clears typing on the 0->1 edge',
    );
    agent.sleepResume();
    assert.deepEqual(thinking, [], 'resume with no live turn re-fires nothing');

    // Simulate a live turn (what the loop sets before the LLM call).
    a.busy = true;
    a.turnChannelId = '100';
    agent.sleepPause();
    assert.equal(idleCalls, 2);
    assert.deepEqual(thinking, [], 'still paused — no re-fire yet');
    agent.sleepResume();
    assert.deepEqual(
      thinking,
      ['100'],
      'resume re-fires onThinking(turnChannelId) while the turn is live',
    );
  } finally {
    cleanup();
  }
});

test('sleep typing: mentions turn resume carries a live revocable authorization', () => {
  const authorizations: unknown[] = [];
  const guilds = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      allowSend: true,
      defaultTier: 'mentions' as const,
      defaultAllowSend: false,
      channels: {},
      channelAllowSend: {},
    },
  ];
  const { agent, cleanup } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds } },
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('100', 'mentions-room', 'g-mentions');
      return {
        channels,
        onThinking: (_channelId, authorization) => {
          authorizations.push(authorization);
        },
      };
    },
  });
  agent.setOutboundSendAuthorizationIssuer((channelId, guildId, isCurrent) =>
    Object.freeze({ kind: 'mentions-turn', channelId, guildId, isCurrent }),
  );
  try {
    const a = agent as any;
    a.busy = true;
    a.realUserTurn = true;
    a.turnChannelId = '100';
    a.mentionsTurnChannelId = '100';
    const turnToken = {};
    a.outboundTurnToken = turnToken;
    a.mentionsTurnToken = turnToken;
    a.mentionsTurnAuthorizationToken = Object.freeze({
      kind: 'mentions-turn',
      channelId: '100',
      guildId: 'g-mentions',
      isCurrent: () =>
        a.mentionsTurnToken === turnToken &&
        a.realUserTurn === true &&
        a.mentionsTurnChannelId === '100',
    });
    agent.sleepPause();
    agent.sleepResume();

    assert.equal(authorizations.length, 1);
    const authorization = authorizations[0] as
      | { channelId: string; guildId: string; isCurrent: () => boolean }
      | undefined;
    assert.equal(authorization?.channelId, '100');
    assert.equal(authorization?.isCurrent(), true);
    const oldScope = agent.captureSandboxOutboundScope();
    (agent.sleepPause as unknown as (scope: unknown) => void)(oldScope);
    const laterTurnToken = {};
    const laterMentionToken = {};
    a.outboundTurnToken = laterTurnToken;
    a.mentionsTurnToken = laterMentionToken;
    a.mentionsTurnAuthorizationToken = Object.freeze({
      kind: 'mentions-turn',
      channelId: '100',
      guildId: 'g-mentions',
      isCurrent: () => a.mentionsTurnToken === laterMentionToken,
    });
    a.sleepDepth = 0;
    (agent.sleepResume as unknown as (scope: unknown) => void)(oldScope);
    assert.equal(
      authorizations.length,
      1,
      'a stale sleep cannot inherit a later same-channel mention capability',
    );
    assert.equal(a.sleepDepth, 0);

    a.mentionsTurnToken = null;
    assert.equal(authorization?.isCurrent(), false);
  } finally {
    cleanup();
  }
});

test('sleep typing: overlapping sleeps only resume after both settle, and never go negative', () => {
  const thinking: string[] = [];
  let idleCalls = 0;
  const { agent, cleanup } = buildTestAgent({
    agentDeps: {
      onThinking: (channelId: string) => {
        thinking.push(channelId);
      },
      onIdle: () => {
        idleCalls++;
      },
    },
  });
  try {
    const a = agent as any;
    a.busy = true;
    a.turnChannelId = '100';

    agent.sleepPause();
    agent.sleepPause();
    assert.equal(
      idleCalls,
      1,
      'onIdle only fires on the 0->1 depth transition',
    );

    agent.sleepResume();
    assert.deepEqual(thinking, [], 'one sleep still pending — no re-fire yet');

    agent.sleepResume();
    assert.deepEqual(
      thinking,
      ['100'],
      'both sleeps settled — typing re-fires once',
    );

    // An extra, unbalanced resume must clamp at zero rather than go negative.
    agent.sleepResume();
    assert.equal(a.sleepDepth, 0, 'depth clamps at zero, never negative');
  } finally {
    cleanup();
  }
});

test('sleep typing: a sleep that outlives its turn re-fires nothing', () => {
  const thinking: string[] = [];
  const { agent, cleanup } = buildTestAgent({
    agentDeps: {
      onThinking: (channelId: string) => {
        thinking.push(channelId);
      },
      onIdle: () => {},
    },
  });
  try {
    const a = agent as any;
    a.busy = true;
    a.turnChannelId = 'chan-3';
    agent.sleepPause();

    // The turn ends (or context clears) before the sleep settles.
    a.busy = false;
    a.turnChannelId = null;

    agent.sleepResume();
    assert.deepEqual(
      thinking,
      [],
      'a stranded sleep resuming after its turn ended re-fires nothing',
    );
  } finally {
    cleanup();
  }
});

test('sleep typing: detached resume cannot inherit an immediately queued same-channel mention turn', async () => {
  const guilds = [
    {
      id: 'g-mentions',
      slug: 'mentions',
      slashCommands: false,
      quietHours: null,
      timezone: null,
      allowSend: true,
      defaultTier: 'mentions' as const,
      defaultAllowSend: false,
      channels: { '100': 'mentions' as const },
      channelAllowSend: { '100': true },
    },
  ];
  const futureSettled = Promise.withResolvers<void>();
  const secondObserved = Promise.withResolvers<void>();
  let agent!: ReturnType<typeof buildTestAgent>['agent'];
  let completeCalls = 0;
  let thinkingEffects = 0;
  let thinkingAtSecondStart = -1;
  let thinkingAfterOldResume = -1;
  const llm = makeStubLLM({
    complete: async () => {
      completeCalls++;
      if (completeCalls === 1) {
        const result = await agent.execSandbox('await elpis.sleep(60)');
        assert.equal(result.detached, true);
        return EMPTY_WAKE;
      }
      thinkingAtSecondStart = thinkingEffects;
      await futureSettled.promise;
      thinkingAfterOldResume = thinkingEffects;
      secondObserved.resolve();
      return EMPTY_WAKE;
    },
  });
  const built = buildTestAgent({
    llm,
    config: {
      discord: { ...makeConfig().discord, guilds },
      sandbox: {
        ...makeConfig().sandbox,
        asyncDeadlineMs: 10,
        persistentRetirementGraceMs: 1000,
      },
    },
    sandboxDeps: ({ tmpDir }) => ({
      bg: createBgRegistry(tmpDir),
      onFutureSettled: () => futureSettled.resolve(),
    }),
    agentDeps: ({ tmpDir }) => {
      const db = openDatabase(tmpDir);
      const channels = createChannelDirectory(db, tmpDir, guilds);
      channels.set('100', 'mentions-room', 'g-mentions');
      return {
        channels,
        onThinking: () => {
          thinkingEffects++;
        },
      };
    },
    tmpPrefix: 'harness-sleep-queued-mention-',
  });
  agent = built.agent;
  agent.setOutboundSendAuthorizationIssuer((channelId, guildId, isCurrent) =>
    Object.freeze({ kind: 'mentions-turn', channelId, guildId, isCurrent }),
  );
  const mention = (id: string) => ({
    ...inbound(id),
    guildId: 'g-mentions',
    guildSlug: 'mentions',
    kind: 'discord' as const,
    wakeClass: 'wake' as const,
    policyChannelId: '100',
  });
  const scheduler = built.scheduler;
  const originalCreate = scheduler.create.bind(scheduler);
  let queued = false;
  scheduler.create = (input) => {
    const task = originalCreate(input);
    if (!queued) {
      queued = true;
      agent.enqueue(mention('queued-mention'));
    }
    return task;
  };

  const running = agent.loop();
  agent.enqueue(mention('first-mention'));
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      secondObserved.promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('queued mention sleep test timed out')),
          1000,
        );
      }),
    ]);
    assert.equal(completeCalls, 2);
    assert.equal(thinkingAfterOldResume, thinkingAtSecondStart);
    assert.equal((agent as any).sleepDepth, 0);
  } finally {
    if (timeout) clearTimeout(timeout);
    agent.stop();
    await running;
    built.cleanup();
  }
});

test('sleep typing: depth resets at turn start, so a stranded sleep cannot suppress the next turn', async () => {
  // The reset (agent.ts's `this.sleepDepth = 0;` at turn start) happens
  // synchronously before the LLM is called, so a stub `complete` that
  // snapshots `sleepDepth` on entry observes the post-reset value — driving a
  // real turn through the loop rather than poking the private field directly.
  let depthAtCall: number | null = null;
  const { promise: called, resolve: signalCalled } =
    Promise.withResolvers<void>();
  const llm = makeStubLLM({
    complete: () => {
      depthAtCall = (agent as any).sleepDepth;
      signalCalled();
      return Promise.resolve(EMPTY_WAKE);
    },
  });
  const { agent, cleanup } = buildTestAgent({ llm });
  try {
    const a = agent as any;
    a.sleepDepth = 3; // simulate a sleep stranded from a previous turn
    void agent.loop();
    agent.enqueue(inbound('m-1'));
    await called;
    assert.equal(
      depthAtCall,
      0,
      'turn start resets the stranded depth to 0 before the LLM is ever called',
    );
  } finally {
    agent.stop();
    cleanup();
  }
});

test('sleep typing: sleep(0) still pauses and resumes typing (one macrotask, no delay)', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => {
      calls.push('pause');
    },
    sleepResume: () => {
      calls.push('resume');
    },
  });
  const r = await sb.run('await elpis.sleep(0)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('sandbox: elpis.sleep passes the exact captured outbound scope to both hooks', async () => {
  const scope = Object.freeze({
    kind: 'sandbox-run-denied' as const,
    authorization: null,
    turnToken: {},
    turnChannelId: '100',
  });
  const pauses: unknown[] = [];
  const resumes: unknown[] = [];
  const sb = createSandbox({
    config: {
      sandbox: {
        syncTimeoutMs: 3000,
        asyncDeadlineMs: 8000,
        previewMaxBytes: 2048,
        logMaxBytes: 2048,
      },
      kagi: { apiKey: null },
      paths: { harnessRoot: '/tmp/hr', dataDirectory: '/tmp' },
    },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
    captureOutboundScope: () => scope,
    sleepPause: (captured: unknown) => pauses.push(captured),
    sleepResume: (captured: unknown) => resumes.push(captured),
  } as unknown as SandboxDeps);
  const r = await sb.run('await elpis.sleep(0)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(pauses, [scope]);
  assert.deepEqual(resumes, [scope]);
});

test('sandbox: elpis.sleep calls sleepPause/sleepResume around the timer, in order', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => {
      calls.push('pause');
    },
    sleepResume: () => {
      calls.push('resume');
    },
  });
  const r = await sb.run('await elpis.sleep(5)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('sandbox: elpis.wait (sleep alias) also pauses/resumes typing', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => {
      calls.push('pause');
    },
    sleepResume: () => {
      calls.push('resume');
    },
  });
  const r = await sb.run('await elpis.wait(5)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('sandbox: elpis.timeout does not touch the sleep hooks', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => {
      calls.push('pause');
    },
    sleepResume: () => {
      calls.push('resume');
    },
  });
  const r = await sb.run('await elpis.timeout(Promise.resolve(1), 50)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, []);
});
