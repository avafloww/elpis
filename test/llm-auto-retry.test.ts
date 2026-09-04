// Loop-level test: transient LLM errors are auto-retried in-loop with backoff
// before anything is surfaced to the channel. Previously a single 503 posted
// "(transient error; say retry to re-attempt)" and parked the loop until a
// human typed something — observed stalling the agent mid-conversation.
//
// Mirrors the ghost-reply test's stub pattern.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { RetriableError, classifyError } from '../src/llm/llm.js';
import { buildTestAgent, makeConfig } from './helpers.js';

/** LLM stub whose complete() rejects with RetriableError `failures` times, then
 * plays `responses` in order (repeating the LAST one — which must therefore be
 * a natural turn-end, i.e. no tool_calls, or the loop rightly runs forever). */
function flakyLLM(
  failures: number,
  responses: CompleteResult[],
): LLM & { calls: number; onCall: ((n: number) => void) | null } {
  let calls = 0;
  let served = 0;
  let hook: ((n: number) => void) | null = null;
  return {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    get calls() {
      return calls;
    },
    set onCall(fn) {
      hook = fn;
    },
    get onCall() {
      return hook;
    },
    complete(): Promise<CompleteResult> {
      calls++;
      const n = calls;
      queueMicrotask(() => hook?.(n));
      if (n <= failures) {
        return Promise.reject(
          new RetriableError(
            new Error('503 The service is temporarily unavailable.'),
          ),
        );
      }
      const r = responses[Math.min(served, responses.length - 1)];
      served++;
      return Promise.resolve(r);
    },
    summarize(): Promise<string> {
      return Promise.resolve('SUMMARY');
    },
  } as LLM & { calls: number; onCall: ((n: number) => void) | null };
}

const emptyEnd: CompleteResult = {
  message: { role: 'assistant', content: '' },
  stripped: false,
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function buildAgentWith(llm: LLM) {
  const { agent, sent, tmpDir } = buildTestAgent({
    llm,
    config: { discord: { ...makeConfig().discord, errorChannelId: 'errors' } },
    tmpPrefix: 'harness-retry-',
  });
  return { agent, sent, tmpDir };
}

function microtask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  queueMicrotask(resolve);
  return promise;
}

function userMsg(): Parameters<Agent['enqueue']>[0] {
  return {
    // channelId is a raw numeric id (bare non-numeric names now throw
    // even when unique — resolveChannelRef requires guild qualification).
    id: 'm1',
    channelId: '100',
    channelName: '100',
    author: 'u',
    authorId: 'u',
    content: 'hi, can you help me?',
    createdAt: '2026-01-01T00:00:00Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
  };
}

test('outer call deadline aborts and surfaces a provider call that never settles', async () => {
  let aborted = false;
  const llm: LLM = {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete(_messages, options) {
      options?.signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
        },
        { once: true },
      );
      return new Promise<CompleteResult>(() => {});
    },
    summarize: () => Promise.resolve('SUMMARY'),
  };
  const base = makeConfig();
  const { agent, sent } = buildTestAgent({
    llm,
    config: {
      llm: { ...base.llm, callTimeoutMs: 20 },
      discord: { ...base.discord, errorChannelId: 'errors' },
    },
    tmpPrefix: 'harness-call-deadline-',
  });
  agent.llmRetryDelays = [];

  void agent.loop();
  agent.enqueue(userMsg());
  for (let i = 0; i < 100 && sent.length === 0; i++)
    await new Promise((r) => setTimeout(r, 5));

  assert.equal(aborted, true, 'outer deadline aborts the provider call');
  assert.equal(
    sent.length,
    1,
    'exhausted outer deadline surfaces exactly one error',
  );
  assert.match(sent[0].text, /LLM call exceeded 20ms outer deadline/);
  agent.stop();
});

test('auto-retry: default outage policy provides ten retries with exponential capped backoff', () => {
  const llm = flakyLLM(0, [emptyEnd]);
  const { agent } = buildAgentWith(llm);
  assert.deepEqual(
    agent.llmRetryDelays,
    [
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
      300_000,
    ],
  );
  agent.stop();
});

test('auto-retry: two transient failures then success — nothing surfaced to the channel', async () => {
  const llm = flakyLLM(2, [
    {
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'run',
              arguments:
                '{"code":"elpis.channel(\\"100\\").send(\\"back!\\")","detail":"Send the recovery reply"}',
            },
          },
        ],
      },
      stripped: false,
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
    emptyEnd, // natural end after the send's tool result
  ]);
  const { agent, sent } = buildAgentWith(llm);
  agent.llmRetryDelays = [1, 1, 1]; // shrink the backoff for the test

  const { promise: fourthCall, resolve: signalFourth } =
    Promise.withResolvers<void>();
  // calls: 1 fail, 2 fail, 3 success (tool call), 4 follow-up
  llm.onCall = (n) => {
    if (n === 4) signalFourth();
  };

  void agent.loop();
  agent.enqueue(userMsg());
  await fourthCall;
  await microtask();

  assert.equal(sent.length, 1, "only the model's own send reaches the channel");
  assert.equal(sent[0].text, 'back!');
  assert.ok(
    !sent.some((s) => s.text.includes('transient error')),
    'no transient-error notice when a retry succeeds',
  );
  assert.equal(llm.calls >= 3, true, 'the LLM was retried');
  agent.stop();
});

test('auto-retry: retries exhausted — error surfaced once, user message kept in history', async () => {
  const llm = flakyLLM(Number.POSITIVE_INFINITY, [emptyEnd]);
  const { agent, sent } = buildAgentWith(llm);
  agent.llmRetryDelays = [1, 1];

  // 1 initial + 2 retries = 3 calls, then the error is surfaced and the turn ends.
  const { promise: surfaced, resolve: signalSurfaced } =
    Promise.withResolvers<void>();
  llm.onCall = (n) => {
    if (n === 3) queueMicrotask(() => queueMicrotask(signalSurfaced));
  };

  void agent.loop();
  agent.enqueue(userMsg());
  await surfaced;
  // give the error path a few ticks to send the notice
  for (let i = 0; i < 20 && sent.length === 0; i++)
    await new Promise((r) => setTimeout(r, 5));

  assert.equal(
    llm.calls,
    3,
    'initial attempt + exactly llmRetryDelays.length retries',
  );
  assert.equal(
    sent.length,
    1,
    'the transient-error notice is surfaced exactly once',
  );
  assert.match(sent[0].text, /transient error persisted/);
  // RetriableError contract: the failing user message STAYS in history so a
  // later "retry" sees the same context.
  const users = agent.messagesForTest.filter(
    (m) => m.role === 'user' && m.personContext?.kind === 'inbound',
  );
  assert.equal(users.length, 1, 'the user message is kept in history');
  agent.stop();
});

test('policy denials stop retries and preserve inputs across repeated turns', async () => {
  const llm = flakyLLM(0, [emptyEnd]);
  let calls = 0;
  llm.complete = async () => {
    calls++;
    throw classifyError(
      new Error('This content was flagged for possible cybersecurity risk.'),
    );
  };
  const { agent, sent } = buildAgentWith(llm);
  agent.llmRetryDelays = [1, 1];
  const running = agent.loop();
  try {
    for (let n = 1; n <= 2; n++) {
      agent.enqueue({ ...userMsg(), id: `policy-input-${n}` });
      for (let i = 0; i < 100 && sent.length < n; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(calls, n, 'one attempt per explicit input');
      assert.equal(sent.length, n);
      assert.match(sent[n - 1].text, /provider policy denial/);
      assert.doesNotMatch(sent[n - 1].text, /corrupted|\/clear|internal error/);
      assert.equal(
        agent.messagesForTest.filter(
          (m) => m.role === 'user' && m.personContext?.kind === 'inbound',
        ).length,
        n,
        'denied inputs remain in history',
      );
    }
  } finally {
    agent.stop();
    await running;
  }
});
