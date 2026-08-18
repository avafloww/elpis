// Loop-level test: a fully-leaked model response (sanitizer strips everything
// usable) triggers a bounded retry of the generation rather than hanging the
// conversation on a silent no-op turn.
//
// Reproduces the production failure mode against umans-kimi-k2.7: the model
// emits chain-of-thought into `content` (proprietary markers) and/or malformed
// `tool_calls[].function.arguments` (raw control chars). Without the retry, a
// fully-stripped response leaves the loop blocked at the wake-gate with nothing
// sent to the channel.
//
// We stub at the LLM boundary (above sanitization): complete returns the
// post-sanitize CompleteResult the loop consumes, so `stripped` is part of the
// contract being exercised.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { buildTestAgent, makeConfig, EMPTY_WAKE } from './helpers.js';

/** A scripted LLM: returns each queued response in order, one per complete()
 * call. Exposes `calls` so tests can assert how many generations ran.
 * `onCall(n)` fires (via queueMicrotask) after the Nth complete resolves,
 * giving tests a deterministic "the loop has consumed response N" signal
 * without polling or sleeping. */
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
 // Fire the hook on a microtask so the loop's await of complete
 // resolves first — the Nth response has been *returned* by the time
 // the hook fires, and the loop will process it on the next tick.
      queueMicrotask(() => hook?.(n));
      return Promise.resolve(r);
    },
    summarize(): Promise<string> {
      return Promise.resolve('SUMMARY');
    },
  } as LLM & { calls: number; onCall: ((n: number) => void) | null };
}

/** A fully-leaked response as the loop sees it post-sanitize: empty content, no
 * tool calls, stripped=true. The sanitizer already did its work; this is the
 * shape complete returns to the loop. */
function leaked(): CompleteResult {
  return {
    message: { role: 'assistant', content: '' },
    stripped: true,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function buildAgentWith(llm: LLM) {
  const { agent, sent, tmpDir } = buildTestAgent({ llm, config: { discord: { ...makeConfig().discord, errorChannelId: 'errors' } }, tmpPrefix: 'harness-leak-' });
  return { agent, sent, tmpDir };
}

/** Resolve on the next microtask — lets the loop drain the post-complete()
 * path (push message, reach turn-end / wake-gate) before we assert. */
function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

test('loop: a fully-leaked response is retried, then the clean reply enters history', async () => {
 // The clean reply is the shared empty-run one-shot wake — the only
 // sanctioned turn-end since , and it writes no content so the
 // ghost-nudge doesn't fire either. This test is about leak retry.
  const llm = scriptedLLM([leaked(), EMPTY_WAKE]);
  const { agent, sent } = buildAgentWith(llm);

 // Signal on the 2nd complete return — that's the clean generation —
 // then let the loop push it + reach turn-end.
  const { promise: cleanGenerated, resolve: signalClean } = Promise.withResolvers<void>();
  llm.onCall = (n) => { if (n === 2) signalClean(); };

  void agent.loop();
  agent.enqueue({ channelId: 'c', channelName: 'c', author: 'u', content: 'hi' });
  await cleanGenerated;
 // Let the loop process the clean response: push to history + turn-end.
  await microtask();

  assert.equal(llm.calls, 2, 'should retry once after the leak then succeed');
  assert.equal(sent.length, 0, 'nothing sent to the channel');
 // The leaked response was NOT pushed to history (only the clean one was).
  const assistants = agent.messagesForTest.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, 'only the clean assistant message enters history');
  agent.stop();
});

test('loop: after MAX_LEAK_RETRIES the loop surfaces a notice and ends the turn', async () => {
 // The model keeps leaking every retry. After the cap the loop must NOT hang —
 // it surfaces a notice (via deps.send), drops the triggering user message,
 // and blocks at the wake-gate.
  const llm = scriptedLLM(Array.from({ length: 10 }, leaked));
  const { agent, sent } = buildAgentWith(llm);

 // The leak-cap path calls deps.send with a notice. That IS our signal.
  const { promise: noticeSent, resolve: signalNotice } = Promise.withResolvers<void>();
  const deps = agent['deps'];
  const origSend = deps.send;
  deps.send = async (channelId, text) => {
    sent.push({ channelId, text });
    signalNotice();
  };
  void agent.loop();
  agent.enqueue({ channelId: 'c', channelName: 'c', author: 'u', content: 'hi' });
  await noticeSent;
 // Let the post-send path (drop user message + continue to wake-gate) settle.
  await microtask();
  deps.send = origSend;

 // MAX_LEAK_RETRIES is 2, so calls = 1 (initial) + 2 (retries) = 3.
  assert.equal(llm.calls, 3, 'should stop after the retry cap, not loop forever');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /malformed|leaked/i);
 // The triggering user message was dropped to avoid a tight re-leak loop.
  assert.equal(agent.messagesForTest.length, 0, 'triggering user message should be dropped');
  agent.stop();
});
