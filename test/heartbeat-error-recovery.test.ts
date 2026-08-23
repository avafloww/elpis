// Regression test: a heartbeat turn whose LLM call fails with a non-retriable
// error must still reschedule the next heartbeat. Before the fix, the error
// path (`continue turn`) parked the loop at the wake-gate without ever invoking
// `rescheduleBeat` — leaving the callback set but never called. The setTimeout
// chain died, so no future heartbeats ever fired. In production a 400 on a
// ponder beat silenced the agent for 10h until a manual restart.
//
// We drive the real loop with a heartbeat enabled, stub the LLM to throw once
// (NonRetriableError, as a 400 would classify), then assert:
// 1. The loop parked at the wake-gate (idle, not crashed).
// 2. rescheduleBeat was cleared — the chain survived and a new beat is armed.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { NonRetriableError } from '../src/llm/llm.js';
import { buildTestAgent, makeConfig } from './helpers.js';

const EMPTY_WAKE: CompleteResult = {
  message: { role: 'assistant', content: '' },
  stripped: false,
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
};

function buildAgent(opts: { intervalMs: number; llm: LLM }) {
  const { agent, sent, tmpDir } = buildTestAgent({
    llm: opts.llm,
    config: {
      heartbeat: {
        intervalMs: opts.intervalMs,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        reflectionMinMessages: 99,
        socialNudgeMs: 12 * 60 * 60 * 1000,
      },
      discord: { ...makeConfig().discord, errorChannelId: 'errors' },
    },
    tmpPrefix: 'harness-hb-err-',
  });
  // Mark a real inbound as seen so the heartbeat's "no conversation yet" guard
  // passes — without this, every beat is skipped.
  agent.primeForHeartbeatTest();
  return { agent, sent, tmpDir };
}

/** Resolve on the next microtask — lets the loop drain past an await. */
function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

test('heartbeat: a non-retriable LLM error on a beat does not kill the scheduler chain', async () => {
  // An LLM that throws NonRetriableError once (as a 400 would), then returns
  // a clean empty turn-end on subsequent calls.
  let threw = false;
  const llm: LLM = {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete(): Promise<CompleteResult> {
      if (!threw) {
        threw = true;
        return Promise.reject(
          new NonRetriableError(
            new Error('400 Extra inputs are not permitted'),
          ),
        );
      }
      return Promise.resolve(EMPTY_WAKE);
    },
    summarize: () => Promise.resolve('SUMMARY'),
  } as LLM;

  // Short interval so the scheduler arms a beat quickly. We DO start the
  // real heartbeat (unlike the multichannel tests) because the bug is in the
  // scheduler-chain survival across an error turn.
  const { agent, sent } = buildAgent({ intervalMs: 20, llm });

  // Capture the send (the error path calls deps.send with the failure notice).
  // Hook BEFORE starting the loop to avoid a race with the 20ms beat timer.
  const { promise: errored, resolve: signalError } =
    Promise.withResolvers<void>();
  const deps = agent['deps'];
  const origSend = deps.send;
  deps.send = async (channelId, text) => {
    sent.push({ channelId, text });
    signalError();
  };

  void agent.loop();
  agent.startHeartbeat();

  // Wait for the first beat to fire, hit the LLM error, surface the notice,
  // and park at the wake-gate.
  await errored;
  await microtask();
  deps.send = origSend;

  // The critical assertion: rescheduleBeat must be null (the callback was
  // invoked at the wake-gate), not still dangling. A dangling callback means
  // the setTimeout chain is dead — no future heartbeat will ever fire.
  assert.equal(
    agent.rescheduleBeatPendingForTest,
    false,
    'heartbeat reschedule callback must be invoked after an error turn; ' +
      'a dangling callback means the scheduler chain is broken',
  );

  // A new heartbeat is armed (heartbeatTimeout is set).
  assert.ok(
    agent['heartbeatTimeout'],
    'a new heartbeat is scheduled after the error',
  );

  agent.stop();
});

test('heartbeat: a beat that completes normally still reschedules (no regression)', async () => {
  // Sanity: the happy path still clears rescheduleBeat at natural turn-end.
  const llm: LLM = {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete: () => Promise.resolve(EMPTY_WAKE),
    summarize: () => Promise.resolve('SUMMARY'),
  } as LLM;

  const { agent } = buildAgent({ intervalMs: 20, llm });

  // Use the send hook to detect the first beat completing (a normal beat with
  // no sends still reaches natural turn-end → idle, which we detect via a
  // one-shot onIdle override).
  const { promise: beatDone, resolve: signalBeat } =
    Promise.withResolvers<void>();
  const deps = agent['deps'];
  const origOnIdle = deps.onIdle;
  let idleCount = 0;
  deps.onIdle = () => {
    idleCount++;
    if (idleCount === 1) signalBeat();
  };

  void agent.loop();
  agent.startHeartbeat();

  await beatDone;
  await microtask();
  deps.onIdle = origOnIdle;

  assert.equal(
    agent.rescheduleBeatPendingForTest,
    false,
    'a normal beat must clear the reschedule callback at natural turn-end',
  );
  assert.ok(
    agent['heartbeatTimeout'],
    'a new heartbeat is scheduled after a normal beat',
  );

  agent.stop();
});
