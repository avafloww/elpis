// Typing-indicator pause/resume around elpis.sleep — a sleep
// is the agent *choosing to wait*, so the typing indicator must not show through it.
// Covers the Agent-side depth counter (pause/resume contract, turn-liveness
// guard, non-negative clamp) and the sandbox-side wiring (sleep hooks the
// pause/resume pair around its timer; timeout deliberately does not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/sandbox/index.js';
import type { SandboxDeps } from '../src/types.js';
import { buildTestAgent, makeStubLLM, EMPTY_WAKE } from './helpers.js';

/** A sandbox wired with just enough config/memory/logbuf to run, plus the two
 * sleep hooks under test. Centralizes the `as unknown as SandboxDeps` cast
 * the sandbox-level tests below all need, instead of repeating it. */
function sandboxWithSleepHooks(hooks: { sleepPause: () => void; sleepResume: () => void }) {
  return createSandbox({
    config: { sandbox: { syncTimeoutMs: 3000, asyncDeadlineMs: 8000, previewMaxBytes: 2048, logMaxBytes: 2048 }, kagi: { apiKey: null }, paths: { harnessRoot: '/tmp/hr', dataDirectory: '/tmp' } },
    memory: { read: () => '', append: () => {}, overwrite: () => {} },
    logbuf: [],
    ...hooks,
  } as unknown as SandboxDeps);
}

/** A minimal 'wake'-class inbound message for driving one real turn through
 * the Agent loop (mirrors test/loop-multichannel.test.ts's `msg` helper). */
function inbound(id: string): { id: string; channelId: string; channelName: string; author: string; authorId: string; content: string; createdAt: string; replyTo: null; forwarded: null; mentions: string[]; attachments: never[] } {
  return {
    id, channelId: '100', channelName: '100', author: 'u', authorId: 'u',
    content: 'hi', createdAt: '2026-01-01T00:00:00Z',
    replyTo: null, forwarded: null, mentions: [], attachments: [],
  };
}

test('sleep typing: pause clears typing, resume re-fires only while turn is live', () => {
  const thinking: string[] = [];
  let idleCalls = 0;
  const { agent, cleanup } = buildTestAgent({
    agentDeps: {
      onThinking: (channelId: string) => { thinking.push(channelId); },
      onIdle: () => { idleCalls++; },
    },
  });
  try {
 // No live turn (busy=false, no turnChannelId): pause still clears typing
 // (onIdle), but resume must not re-fire onThinking — nothing is "typing".
    const a = agent as any;
    a.busy = false;
    a.turnChannelId = null;
    agent.sleepPause();
    assert.equal(idleCalls, 1, 'sleepPause always clears typing on the 0->1 edge');
    agent.sleepResume();
    assert.deepEqual(thinking, [], 'resume with no live turn re-fires nothing');

 // Simulate a live turn (what the loop sets before the LLM call).
    a.busy = true;
    a.turnChannelId = 'chan-1';
    agent.sleepPause();
    assert.equal(idleCalls, 2);
    assert.deepEqual(thinking, [], 'still paused — no re-fire yet');
    agent.sleepResume();
    assert.deepEqual(thinking, ['chan-1'], 'resume re-fires onThinking(turnChannelId) while the turn is live');
  } finally {
    cleanup();
  }
});

test('sleep typing: overlapping sleeps only resume after both settle, and never go negative', () => {
  const thinking: string[] = [];
  let idleCalls = 0;
  const { agent, cleanup } = buildTestAgent({
    agentDeps: {
      onThinking: (channelId: string) => { thinking.push(channelId); },
      onIdle: () => { idleCalls++; },
    },
  });
  try {
    const a = agent as any;
    a.busy = true;
    a.turnChannelId = 'chan-2';

    agent.sleepPause();
    agent.sleepPause();
    assert.equal(idleCalls, 1, 'onIdle only fires on the 0->1 depth transition');

    agent.sleepResume();
    assert.deepEqual(thinking, [], 'one sleep still pending — no re-fire yet');

    agent.sleepResume();
    assert.deepEqual(thinking, ['chan-2'], 'both sleeps settled — typing re-fires once');

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
      onThinking: (channelId: string) => { thinking.push(channelId); },
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
    assert.deepEqual(thinking, [], 'a stranded sleep resuming after its turn ended re-fires nothing');
  } finally {
    cleanup();
  }
});

test('sleep typing: depth resets at turn start, so a stranded sleep cannot suppress the next turn', async () => {
 // The reset (agent.ts's `this.sleepDepth = 0;` at turn start) happens
 // synchronously before the LLM is called, so a stub `complete` that
 // snapshots `sleepDepth` on entry observes the post-reset value — driving a
 // real turn through the loop rather than poking the private field directly.
  let depthAtCall: number | null = null;
  const { promise: called, resolve: signalCalled } = Promise.withResolvers<void>();
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
    assert.equal(depthAtCall, 0, 'turn start resets the stranded depth to 0 before the LLM is ever called');
  } finally {
    agent.stop();
    cleanup();
  }
});

test('sleep typing: sleep(0) still pauses and resumes typing (one macrotask, no delay)', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => { calls.push('pause'); },
    sleepResume: () => { calls.push('resume'); },
  });
  const r = await sb.run('await elpis.sleep(0)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('sandbox: elpis.sleep calls sleepPause/sleepResume around the timer, in order', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => { calls.push('pause'); },
    sleepResume: () => { calls.push('resume'); },
  });
  const r = await sb.run('await elpis.sleep(5)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('sandbox: elpis.wait (sleep alias) also pauses/resumes typing', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => { calls.push('pause'); },
    sleepResume: () => { calls.push('resume'); },
  });
  const r = await sb.run('await elpis.wait(5)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, ['pause', 'resume']);
});

test('sandbox: elpis.timeout does not touch the sleep hooks', async () => {
  const calls: string[] = [];
  const sb = sandboxWithSleepHooks({
    sleepPause: () => { calls.push('pause'); },
    sleepResume: () => { calls.push('resume'); },
  });
  const r = await sb.run('await elpis.timeout(Promise.resolve(1), 50)');
  assert.equal(r.ok, true, String(r.error));
  assert.deepEqual(calls, []);
});
