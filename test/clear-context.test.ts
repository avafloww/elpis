// Unit tests for Agent.clearContext — the /clear & /new entry point.
// Verifies the fresh-context contract: history, queued inbound, tracker, and
// compactor state all reset, and an in-flight LLM call is discarded rather
// than leaked into the cleared history.
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatMessage, LLM, CompleteResult } from '../src/llm/llm.js';
import { buildTestAgent } from './helpers.js';

interface FakeLLMState {
  /** Resolves when an in-flight complete() should return. */
  resolve?: (r: CompleteResult) => void;
  /** Resolves once the loop has entered the fake LLM call (deterministic signal
 * that the queued message was drained + complete was invoked). */
  entered?: () => void;
  summarizeCalls: number;
  resetCalls: number;
}

/** An LLM whose complete() parks until released — lets us test the
 * clear-during-LLM-call race without a network. summarize resolves at once.
 * Exposes an `entered` promise so callers can await the deterministic "the
 * loop drained and is now parked in complete" signal instead of a sleep. */
function fakeLLM(state: FakeLLMState): LLM {
  return {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete(): Promise<CompleteResult> {
      const { promise, resolve } = Promise.withResolvers<CompleteResult>();
      state.resolve = resolve;
      state.entered?.();
      return promise;
    },
    summarize(): Promise<string> {
      state.summarizeCalls++;
 // Long enough to clear the compactor's quality-gate floor (10 chars/msg).
      return Promise.resolve('SUMMARY '.padEnd(300, 'z'));
    },
    resetSession(): void {
      state.resetCalls++;
    },
  };
}

function buildAgent() {
  const llmState: FakeLLMState = { summarizeCalls: 0, resetCalls: 0 };
  const { agent, tracker, compactor, sent, tmpDir } = buildTestAgent({
    llm: fakeLLM(llmState),
    compactorOpts: { keepTokens: 1 },
    tmpPrefix: 'harness-clear-',
  });
  return { agent, tracker, compactor, sent, llmState, tmpDir };
}

test('clearContext: empties history, queued inbound, zeroes the tracker, and resets provider session state', () => {
  const { agent, tracker, llmState } = buildAgent();
 // populate state without driving the loop (enqueue doesn't drain into messages)
  agent.enqueue({ channelId: 'c1', channelName: 'general', author: 'a', content: 'hello' });
  agent.enqueue({ channelId: 'c1', channelName: 'general', author: 'b', content: 'world' });
  tracker.estimateAppended('a'.repeat(400));
  assert.ok(tracker.currentTokens > 0);

  const had = agent.clearContext();
  assert.equal(had, true, 'should report it cleared something');
  assert.equal(agent.messagesForTest.length, 0, 'history must be empty');
  assert.equal(tracker.currentTokens, 0, 'tracker must be zeroed');
  assert.equal(tracker.usageRatio(), 0);
  assert.equal(llmState.resetCalls, 1, 'provider conversation/cache identity must rotate with the whole mind');
});

test('clearContext: no-op clear returns false and stays consistent', () => {
  const { agent, tracker } = buildAgent();
  const had = agent.clearContext();
  assert.equal(had, false);
  assert.equal(agent.messagesForTest.length, 0);
  assert.equal(tracker.currentTokens, 0);
});

test('clearContext: resets compactor boundary and drops pending summary', async () => {
  const { agent, compactor, llmState } = buildAgent();
 // Establish a current context (F1: compactor is per-context; the seed compactor
 // is reused for the first context, so enqueue to bind it).
  agent.enqueue({ channelId: 'c1', channelName: 'general', author: 'a', content: 'x' });
 // fakeLLM.summarize resolves immediately, but the result lands on a microtask;
 // await done so the summary is settled before we assert.
  const msgs: ChatMessage[] = [
    { role: 'user', content: 'x'.repeat(500) },
    { role: 'assistant', content: 'y'.repeat(500) },
  ];
  compactor.start(msgs);
  await compactor.done();
  assert.equal(compactor.hasCompletedResult(), true);
  assert.ok(llmState.summarizeCalls >= 1);

  agent.clearContext();
  assert.equal(compactor.hasCompletedResult(), false, 'pending summary must be dropped');
  assert.equal(compactor.boundaryIndex, 0);
  assert.equal(compactor.running, false);
});

test('clearContext: in-flight LLM response is discarded, not appended to fresh history', async () => {
  const { agent, tracker, sent, llmState } = buildAgent();
 // drive the loop: it drains the queued msg, then parks on the fake LLM call
  const { promise: entered, resolve: signalEntered } = Promise.withResolvers<void>();
  llmState.entered = signalEntered;
  agent.enqueue({ channelId: 'c', channelName: 'g', author: 'a', content: 'pre-clear' });
  void agent.loop();

 // await the deterministic signal that the loop drained + entered complete
  await entered;
  assert.equal(agent.messagesForTest.length, 1, 'pre-clear msg should be in history');
  assert.ok(llmState.resolve, 'loop should be parked on the fake LLM call');

 // clear WHILE the LLM call is in flight
  agent.clearContext();
  assert.equal(agent.messagesForTest.length, 0);

 // now release the in-flight completion — the epoch guard must discard it
  llmState.resolve!({
    message: { role: 'assistant', content: 'STALE REPLY FROM PRE-CLEAR TURN' },
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  });

 // await the loop processing the discarded response + blocking at wake-gate.
 // The discard path is synchronous after resolve; one microtask settles it.
  await new Promise<void>((resolve) => queueMicrotask(resolve));

 // the stale reply must NOT have been appended to history or sent to channel
  assert.equal(agent.messagesForTest.length, 0, 'stale response must not be appended');
  assert.equal(sent.length, 0, 'stale reply must not be sent to the channel');
  assert.equal(tracker.currentTokens, 0, 'tracker must stay zeroed (no usage update)');

 // wake the loop with a post-clear message; it parks on the LLM again
  const { promise: entered2, resolve: signalEntered2 } = Promise.withResolvers<void>();
  llmState.entered = signalEntered2;
  agent.enqueue({ channelId: 'c', channelName: 'g', author: 'b', content: 'post-clear' });
  await entered2;
  assert.equal(agent.messagesForTest.length, 1, 'only the post-clear msg should be in history');
  assert.match(agent.messagesForTest[0].content, /post-clear/);

 // Release the parked LLM call + stop the loop so the process can exit.
 // The loop is mid-complete; resolving it lets the turn drain to the
 // wake-gate, where stop breaks the loop.
  if (llmState.resolve) llmState.resolve({ message: { role: 'assistant', content: 'done' }, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  agent.stop();
});
