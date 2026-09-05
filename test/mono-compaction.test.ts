// Loop-level tests for the V1 compaction checkpoint: the pre-compaction memory
// flush nudge (DECIDED #5) and the escalation nudge (fail plainly, review S3).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  COMPACTION_RETRY_BASE_MS,
  COMPACTION_RETRY_MAX_MS,
  compactionRetryBackoffMs,
  computeEffectiveTrigger,
  shouldAlertOnCompactionFailure,
  type Agent,
} from '../src/agent.js';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { createContextTracker } from '../src/llm/context-tracker.js';
// EMPTY_WAKE is the shared empty-run one-shot wake idiom (helpers.ts). The
// local bare-assistant constant that used to live here stopped ending turns on
// — a response with no run call is no longer an ending — so the loop
// never reached the wake-gate and `onIdle` never fired.
import { buildTestAgent, makeConfig, EMPTY_WAKE } from './helpers.js';
import { ContextResourceInterrupt } from '../src/context-resources.js';

/** LLM whose complete() always yields with a wake; summarize() is controllable. */
function stubLLM(summarize: () => Promise<string>): LLM {
  return {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete: () => Promise.resolve(EMPTY_WAKE),
    summarize,
  } as LLM;
}

/** Long enough to clear the compactor's summary quality-gate floor
 * (min(2000, 10 × fold size) chars) for these small test folds. */
const SUMMARY_OK = 'SUMMARY ' + 'z'.repeat(200);

function bigUserMsg(): Parameters<Agent['enqueue']>[0] {
  return {
    id: 'm1',
    channelId: 'c',
    channelName: 'c',
    author: 'u',
    authorId: 'u',
    content: 'x'.repeat(6000),
    createdAt: '2026-01-01T00:00:00Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
  };
}

function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

test('effective trigger clamps to the real window on a small-window config (S3)', () => {
  const config = makeConfig({
    compaction: { triggerTokens: 100000, keepTokens: 20000 },
    llm: { ...makeConfig().llm, completionReserveTokens: 8192 },
  });
  const smallWindow = createContextTracker(20000, 8192); // usableBudget 11808
  const eff = computeEffectiveTrigger(config, smallWindow);
  assert.ok(
    eff < config.compaction.triggerTokens,
    'trigger clamped below the configured value',
  );
  assert.equal(eff, 11808 - 8192, 'clamp = usableBudget − completionReserve');
  // A large window leaves the configured value intact.
  const bigWindow = createContextTracker(1_000_000, 8192);
  assert.equal(computeEffectiveTrigger(config, bigWindow), 100000);
});

test('compaction checkpoint: crossing the trigger pushes the memory-flush nudge', async () => {
  const { agent } = buildTestAgent({
    llm: stubLLM(() => Promise.resolve(SUMMARY_OK)),
    config: {
      compaction: { triggerTokens: 500, keepTokens: 20000 },
      llm: { ...makeConfig().llm, completionReserveTokens: 100 },
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        reflectionMinMessages: 3,
        socialNudgeMs: 12 * 60 * 60 * 1000,
      },
    },
    tracker: createContextTracker(100000, 100),
    compactorOpts: { keepTokens: 100 },
    tmpPrefix: 'harness-compact-',
  });
  const { promise: idle, resolve: onIdle } = Promise.withResolvers<void>();
  agent['deps'].onIdle = () => onIdle();

  void agent.loop();
  // Two big messages so the boundary walk leaves an older message to fold (a
  // single giant message is a trivial fold and is correctly skipped).
  agent.enqueue({ ...bigUserMsg(), id: 'm1' });
  agent.enqueue({ ...bigUserMsg(), id: 'm2' });
  await idle;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(
    users.some((m) => m.content.includes('compaction threshold')),
    'the pre-compaction memory-flush nudge should be in history',
  );
  agent.stop();
});

test('compaction checkpoint: successful apply pushes a compacted notice', async () => {
  const { agent, contextResources, tmpDir } = buildTestAgent({
    llm: stubLLM(() => Promise.resolve(SUMMARY_OK)),
    config: {
      compaction: { triggerTokens: 500, keepTokens: 20000 },
      llm: { ...makeConfig().llm, completionReserveTokens: 100 },
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        reflectionMinMessages: 3,
        socialNudgeMs: 12 * 60 * 60 * 1000,
      },
    },
    tracker: createContextTracker(100000, 100),
    compactorOpts: { keepTokens: 100 },
    tmpPrefix: 'harness-compact-notice-',
  });
  const agentsPath = path.join(tmpDir, 'AGENTS.md');
  const targetPath = path.join(tmpDir, 'file.ts');
  fs.writeFileSync(agentsPath, 'local compacted contract\n');
  fs.writeFileSync(targetPath, 'value\n');
  let interrupted: ContextResourceInterrupt | null = null;
  assert.throws(
    () => contextResources.beforeFileAccess(targetPath, 'file'),
    (error: unknown) => {
      assert.ok(error instanceof ContextResourceInterrupt);
      interrupted = error;
      return true;
    },
  );
  contextResources.acknowledge([interrupted!.resource]);
  const { promise: idle, resolve: onIdle } = Promise.withResolvers<void>();
  agent['deps'].onIdle = () => onIdle();

  void agent.loop();
  agent.enqueue({ ...bigUserMsg(), id: 'm1' });
  agent.enqueue({ ...bigUserMsg(), id: 'm2' });
  await idle;
  await microtask();

  // Compaction runs in the background; wait for it to finish, then trigger one
  // more turn so the checkpoint applies the result and pushes the notice.
  await agent['deps'].compactor.done();
  const { promise: idle2, resolve: onIdle2 } = Promise.withResolvers<void>();
  agent['deps'].onIdle = () => onIdle2();
  agent.enqueue({ ...bigUserMsg(), id: 'm3' });
  await idle2;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(
    users.some((m) => m.content.includes('context compacted')),
    'the post-compaction notice should be in history',
  );
  // Finding 5: applyCompaction (compactor.ts) already appends its own
  // structural notice as part of the swapped [summary, ...kept, notice] —
  // runCompactionCheckpoint must not push a second, agent-side notice (the old
  // compactionAppliedNotice push was removed as part of finding 5).
  const noticeCount = users.filter((m) =>
    /context compacted|earlier messages? were folded/.test(m.content),
  ).length;
  assert.equal(
    noticeCount,
    1,
    'exactly one compaction-applied notice, not a duplicate',
  );
  const notice = users.find((message) =>
    message.content.includes('context compacted'),
  );
  assert.match(notice?.content ?? '', /context resources were present/);
  assert.match(notice?.content ?? '', new RegExp(agentsPath));
  assert.deepEqual(contextResources.snapshot(), {
    skills: [],
    agentsFiles: [],
  });
  agent.stop();
});

test('shouldAlertOnCompactionFailure: fires on the first failed cycle, then every 5th', () => {
  const fired = [1, 2, 3, 4, 5, 6, 7, 10, 11, 16].filter(
    shouldAlertOnCompactionFailure,
  );
  assert.deepEqual(fired, [1, 6, 11, 16]);
});

test('compaction retry backoff grows exponentially and stays bounded', () => {
  assert.equal(compactionRetryBackoffMs(1), COMPACTION_RETRY_BASE_MS);
  assert.equal(compactionRetryBackoffMs(2), 2 * COMPACTION_RETRY_BASE_MS);
  assert.equal(compactionRetryBackoffMs(5), COMPACTION_RETRY_MAX_MS);
  assert.equal(compactionRetryBackoffMs(100), COMPACTION_RETRY_MAX_MS);
});

test('compaction checkpoint: a cycle ending with no accepted summary alerts the operator', async () => {
  // summarize always returns a floor-rejected fragment (the fold here is ONE
  // message — m2 sits in the keep-tail — so the scaled floor is 10 chars and
  // the stub must come in under it) → the cycle burns all its retries as
  // rejections; the NEXT checkpoint detects the dead cycle and fires the
  // operator alert to the error channel
  // finding 1 — a silent restart would be an unbounded token spin with no
  // signal).
  const base = makeConfig();
  let summarizeCalls = 0;
  const { agent, sent } = buildTestAgent({
    llm: stubLLM(() => {
      summarizeCalls++;
      return Promise.resolve('nope.');
    }),
    config: {
      discord: { ...base.discord, errorChannelId: 'err-ch' },
      compaction: { triggerTokens: 500, keepTokens: 20000 },
      llm: { ...base.llm, completionReserveTokens: 100 },
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        reflectionMinMessages: 3,
        socialNudgeMs: 12 * 60 * 60 * 1000,
      },
    },
    tracker: createContextTracker(100000, 100),
    compactorOpts: { keepTokens: 100 },
    tmpPrefix: 'harness-failcycle-',
  });
  let idleResolve: (() => void) | null = null;
  agent['deps'].onIdle = () => idleResolve?.();
  void agent.loop();
  const idle = new Promise<void>((r) => {
    idleResolve = r;
  });
  agent.enqueue({ ...bigUserMsg(), id: 'm1' });
  agent.enqueue({ ...bigUserMsg(), id: 'm2' });
  await idle;
  await agent['deps'].compactor.done(); // cycle over: every attempt rejected by the gate
  const idle2 = new Promise<void>((r) => {
    idleResolve = r;
  });
  agent.enqueue({ ...bigUserMsg(), id: 'm3' });
  await idle2;
  await microtask();
  assert.ok(
    sent.some(
      (s) =>
        s.channelId === 'err-ch' &&
        /compaction has failed 1 full cycle/.test(s.text),
    ),
    `operator alert delivered to the error channel; sent=${JSON.stringify(sent.map((s) => s.text))}`,
  );
  assert.ok(
    sent.some((s) => /automatic retry is paused for 60s/.test(s.text)),
    'the operator alert names the retry latch rather than implying an immediate restart',
  );
  assert.equal(
    summarizeCalls,
    3,
    'the immediately following turn must not start another three-attempt cycle',
  );

  // An elapsed latch (or explicit /compact) permits a later bounded retry.
  agent['compactionRetryNotBefore'] = 0;
  const idle3 = new Promise<void>((r) => {
    idleResolve = r;
  });
  agent.enqueue({ ...bigUserMsg(), id: 'm4' });
  await idle3;
  await agent['deps'].compactor.done();
  assert.equal(
    summarizeCalls,
    6,
    'a later eligible checkpoint retries one bounded cycle',
  );
  agent.stop();
});

test('compaction checkpoint: synchronous admission rejection alerts once and backs off automatic retry', async () => {
  const base = makeConfig();
  const logs: string[] = [];
  let summarizeCalls = 0;
  const { agent, sent, tracker, compactor, cleanup } = buildTestAgent({
    llm: stubLLM(() => {
      summarizeCalls++;
      return Promise.resolve(SUMMARY_OK);
    }),
    config: {
      discord: { ...base.discord, errorChannelId: 'err-ch' },
      compaction: { triggerTokens: 500, keepTokens: 20000 },
      llm: { ...base.llm, completionReserveTokens: 100 },
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        reflectionMinMessages: 3,
        socialNudgeMs: 12 * 60 * 60 * 1000,
      },
    },
    tracker: createContextTracker(100000, 100),
    compactorOpts: {
      keepTokens: 100,
      log: (line) => logs.push(line),
      summaryInputBudget: {
        contextWindowTokens: 200,
        outputReserveTokens: 100,
        framingTokens: 0,
        estimateTokens: (text) => text.length,
      },
    },
    tmpPrefix: 'harness-admission-auto-',
  });
  let idleResolve: (() => void) | null = null;
  agent['deps'].onIdle = () => idleResolve?.();
  void agent.loop();

  const idle = new Promise<void>((resolve) => {
    idleResolve = resolve;
  });
  agent.enqueue({ ...bigUserMsg(), id: 'm1' });
  agent.enqueue({ ...bigUserMsg(), id: 'm2' });
  await idle;
  await microtask();

  assert.equal(summarizeCalls, 0, 'admission fails before provider attempts');
  assert.equal(agent['failedCompactionCycles'], 1);
  assert.ok(agent['compactionRetryNotBefore'] > Date.now());
  assert.equal(
    logs.filter((line) => line.startsWith('summarize admission rejected:'))
      .length,
    1,
    'the real fold is validated only once at the first checkpoint',
  );
  assert.equal(
    sent.filter(
      (item) =>
        item.channelId === 'err-ch' &&
        /compaction has failed 1 full cycle/.test(item.text),
    ).length,
    1,
    'the synchronous failure reaches the configured error observer',
  );

  // Another over-trigger turn lands during the retry latch. The stale
  // compactor error must neither count the old cycle again nor revalidate it.
  const idle2 = new Promise<void>((resolve) => {
    idleResolve = resolve;
  });
  agent.enqueue({ ...bigUserMsg(), id: 'm3' });
  await idle2;
  await microtask();
  assert.equal(agent['failedCompactionCycles'], 1);
  assert.equal(summarizeCalls, 0);
  assert.equal(
    logs.filter((line) => line.startsWith('summarize admission rejected:'))
      .length,
    1,
  );
  assert.ok(
    !agent.messagesForTest.some((message) =>
      message.content.startsWith('=== Summary of earlier conversation'),
    ),
    'rejected admission leaves the original history live',
  );

  // Exercise a later trivial request while the rejection remains in lastError.
  // Its explicit skipped outcome must not turn that stale error into cycle 2.
  assert.ok(compactor.lastError);
  agent['messages'] = [];
  tracker.recompute([]);
  agent.compactNow();
  await microtask();
  assert.equal(agent['failedCompactionCycles'], 1);
  assert.equal(
    sent.filter((item) => /compaction has failed/.test(item.text)).length,
    1,
    'a trivial fold neither fails nor recounts the stale admission error',
  );
  agent.stop();
  cleanup();
});

test('idle manual compaction admission rejection is observed as one failed cycle', async () => {
  const base = makeConfig();
  const logs: string[] = [];
  let summarizeCalls = 0;
  const { agent, sent, cleanup } = buildTestAgent({
    llm: stubLLM(() => {
      summarizeCalls++;
      return Promise.resolve(SUMMARY_OK);
    }),
    config: {
      discord: { ...base.discord, errorChannelId: 'err-ch' },
      compaction: { triggerTokens: 50000, keepTokens: 20000 },
      llm: { ...base.llm, completionReserveTokens: 100 },
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        reflectionMinMessages: 3,
        socialNudgeMs: 12 * 60 * 60 * 1000,
      },
    },
    tracker: createContextTracker(100000, 100),
    compactorOpts: {
      keepTokens: 100,
      log: (line) => logs.push(line),
      summaryInputBudget: {
        contextWindowTokens: 200,
        outputReserveTokens: 100,
        framingTokens: 0,
        estimateTokens: (text) => text.length,
      },
    },
    tmpPrefix: 'harness-admission-manual-',
  });
  let idleResolve: (() => void) | null = null;
  agent['deps'].onIdle = () => idleResolve?.();
  void agent.loop();
  const idle = new Promise<void>((resolve) => {
    idleResolve = resolve;
  });
  agent.enqueue({ ...bigUserMsg(), id: 'm1' });
  agent.enqueue({ ...bigUserMsg(), id: 'm2' });
  await idle;
  const historyBefore = agent.messagesForTest.slice();

  agent.compactNow();
  await microtask();

  assert.equal(summarizeCalls, 0, 'manual admission makes no provider attempt');
  assert.equal(agent['failedCompactionCycles'], 1);
  assert.ok(agent['compactionRetryNotBefore'] > Date.now());
  assert.equal(agent['compactRequested'], false, 'manual request is consumed');
  assert.deepEqual(
    agent.messagesForTest,
    historyBefore,
    'idle rejection cannot replace or append to conversation history',
  );
  assert.equal(
    logs.filter((line) => line.startsWith('summarize admission rejected:'))
      .length,
    1,
  );
  assert.ok(
    sent.some(
      (item) =>
        item.channelId === 'err-ch' &&
        /compaction has failed 1 full cycle/.test(item.text) &&
        /estimated summary request exceeds/.test(item.text),
    ),
    'idle /compact reaches the actual configured error observer immediately',
  );
  agent.stop();
  cleanup();
});

test('compaction checkpoint: past 2× trigger with no successful apply escalates', async () => {
  // summarize never resolves → compaction stays running, compactingSince stays set.
  const { agent } = buildTestAgent({
    llm: stubLLM(() => new Promise<string>(() => {})),
    config: {
      compaction: { triggerTokens: 500, keepTokens: 20000 },
      llm: { ...makeConfig().llm, completionReserveTokens: 100 },
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        reflectionMinMessages: 3,
        socialNudgeMs: 12 * 60 * 60 * 1000,
      },
    },
    tracker: createContextTracker(100000, 100),
    compactorOpts: { keepTokens: 100 },
    tmpPrefix: 'harness-escalate-',
  });
  const { promise: idle, resolve: onIdle } = Promise.withResolvers<void>();
  agent['deps'].onIdle = () => onIdle();

  void agent.loop();
  agent.enqueue(bigUserMsg()); // ~1500 tokens > 2×500
  await idle;
  await microtask();

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(
    users.some((m) => m.content.includes("compaction hasn't succeeded")),
    'the escalation nudge should fire past 2× trigger with no successful apply',
  );
  agent.stop();
});
