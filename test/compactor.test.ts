// Unit tests for the V1 Compactor: boundary walk (keep ~keepTokens tail),
// pair-integrity, prior-summary carry, skip-guard, async non-blocking, reset.
// Uses a fake LLM with controllable summarize.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCompactor,
  enforcePairIntegrity,
  walkKeepBoundary,
  SUMMARY_FLOOR_CAP,
  SUMMARY_FLOOR_PER_MESSAGE,
} from '../src/llm/compactor.js';
import { createContextTracker } from '../src/llm/context-tracker.js';
import { serializeHistory } from '../src/llm/summarize.js';
import {
  SOCIAL_SUMMARIZE_PROMPT,
  SUMMARIZE_TAIL_REMINDER,
  computeCharsSent,
  RUN_TOOL,
} from '../src/llm/llm.js';
import type { ChatMessage, LLM } from '../src/llm/llm.js';

function mk(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra };
}
/** ~400-char message ≈ 102 tokens. */
function big(tag: string): ChatMessage {
  return mk('user', `${tag} ${'x'.repeat(400)}`);
}

/** Pad a test summary past the quality-gate floor (min(2000, 10 × fold size)
 * chars) so tests exercising apply mechanics aren't rejected by the gate; the
 * original text stays a prefix, so include/match assertions are unaffected. */
function padOk(summary: string): string {
  return summary.padEnd(300, '░');
}

function fakeLLM(opts: { summary?: string; fail?: boolean } = {}): LLM & {
  calls: number;
  inputs: string[];
  resolveAll(): void;
} {
  let calls = 0;
  let settled = false;
  const inputs: string[] = [];
  const pending: Array<{
    resolve: (s: string) => void;
    reject: (e: Error) => void;
  }> = [];
  const llm: LLM = {
    client: {} as unknown as LLM['client'],
    model: 'test',
    runTool: {} as unknown as LLM['runTool'],
    complete: async () => ({
      message: mk('assistant', ''),
      stripped: false,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    summarize(text: string): Promise<string> {
      calls++;
      inputs.push(text);
      if (settled) {
        return opts.fail
          ? Promise.reject(new Error('summarize failed'))
          : Promise.resolve(padOk(opts.summary ?? 'SUMMARY'));
      }
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  };
  const result = Object.assign(llm, {
    get calls() {
      return calls;
    },
    inputs,
    resolveAll() {
      settled = true;
      for (const p of pending) {
        if (opts.fail) p.reject(new Error('summarize failed'));
        else p.resolve(padOk(opts.summary ?? 'SUMMARY'));
      }
      pending.length = 0;
    },
  });
  Object.defineProperty(result, 'calls', { get: () => calls });
  return result;
}

test('compaction prompt requires a first-person note to the future self at both ends', () => {
  assert.match(
    SOCIAL_SUMMARIZE_PROMPT,
    /first person as a note to your future self/,
  );
  assert.match(SOCIAL_SUMMARIZE_PROMPT, /I told Bramble/);
  assert.doesNotMatch(SOCIAL_SUMMARIZE_PROMPT, /write in second person/i);
  assert.match(SUMMARIZE_TAIL_REMINDER, /FIRST PERSON/);
  assert.match(SUMMARIZE_TAIL_REMINDER, /"I…", never "you…"/);
});

test('compaction excludes transient resource bodies from both summary input and kept tail', async () => {
  const llm = fakeLLM();
  const tracker = createContextTracker(100000, 0);
  const compactor = createCompactor(llm, tracker, {
    keepTokens: 1,
    ratio: () => 4,
  });
  const descriptor = {
    kind: 'skill' as const,
    key: 'private-skill',
    display: 'private-skill',
    version: 'a'.repeat(64),
  };
  const messages = [
    mk('user', `SECRET FOLD INSTRUCTIONS ${'x'.repeat(400)}`, {
      contextResources: [descriptor],
    }),
    mk('user', `SECRET KEPT INSTRUCTIONS ${'y'.repeat(400)}`, {
      contextResources: [descriptor],
    }),
  ];

  compactor.start(messages);
  await Promise.resolve();
  assert.equal(llm.inputs.length, 1);
  assert.doesNotMatch(llm.inputs[0], /SECRET FOLD INSTRUCTIONS/);
  assert.match(llm.inputs[0], /context resource body removed/);
  llm.resolveAll();
  await compactor.done();
  const applied = compactor.applyCompaction(messages);
  assert.doesNotMatch(
    applied.map((message) => message.content).join('\n'),
    /SECRET (?:FOLD|KEPT) INSTRUCTIONS/,
  );
  const resourceMessages = applied.filter((message) =>
    /context resource body removed/.test(message.content),
  );
  assert.ok(resourceMessages.length > 0);
  assert.ok(
    resourceMessages.every(
      (message) =>
        message.contextResources === undefined &&
        /context resource body removed/.test(message.content),
    ),
  );
});

// ---------- walkKeepBoundary ----------

test('walkKeepBoundary: keeps ~keepTokens verbatim tail', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`)); // ~102 tok each
  const b = walkKeepBoundary(msgs, 250); // 3 messages ≈ 306 tokens
  assert.equal(b, 7, 'tail keeps the last 3 messages (>= keepTokens)');
});

test('walkKeepBoundary: returns 0 when everything fits in keep (nothing to fold)', () => {
  const msgs = [big('a'), big('b')];
  assert.equal(walkKeepBoundary(msgs, 100000), 0);
});

test('walkKeepBoundary: a smaller ratio (denser tokens) folds fewer messages', () => {
  // 10 messages, each 400 content chars → sentChars ≈ 400 + role + 4.
  const msgs = Array.from({ length: 10 }, () => ({
    role: 'user' as const,
    content: 'x'.repeat(400),
  }));
  // At ratio 4: each ~101 tokens; at ratio 2: each ~202 tokens. Keep budget 500.
  const b4 = walkKeepBoundary(msgs, 500); // default ratio 4
  const b2 = walkKeepBoundary(msgs, 500, 2); // denser → hits 500 sooner → higher boundary index
  assert.ok(
    b2 > b4,
    `denser ratio keeps fewer messages (b2=${b2} should exceed b4=${b4})`,
  );
});

// ---------- computeCharsSent ----------

test('computeCharsSent: sums per-message sentChars plus the tool-schema constant', () => {
  const toolChars = JSON.stringify([RUN_TOOL]).length;
  const msgs = [
    { role: 'system' as const, content: 'S'.repeat(100) }, // 100 + 6 + 4 = 110
    { role: 'user' as const, content: 'U'.repeat(40) }, // 40 + 4 + 4 = 48
  ];
  // Σ sentChars = 110 + 48 = 158, plus the tool schema.
  assert.equal(computeCharsSent(msgs), 158 + toolChars);
});

// ---------- CompactorOpts.ratio (fixes reviewer M2) ----------

test('createCompactor: opts.ratio feeds the keep-boundary walk (denser → higher boundary)', () => {
  const msgs = Array.from({ length: 10 }, () => ({
    role: 'user' as const,
    content: 'x'.repeat(400),
  }));
  const tracker = createContextTracker(1_000_000, 2000);
  const stubLLM = { summarize: async () => 'x' } as unknown as LLM;
  const cAt4 = createCompactor(stubLLM, tracker, {
    keepTokens: 500,
    ratio: () => 4,
  });
  const cAt2 = createCompactor(stubLLM, tracker, {
    keepTokens: 500,
    ratio: () => 2,
  });
  cAt4.start(msgs);
  cAt2.start(msgs);
  assert.ok(
    cAt2.boundaryIndex > cAt4.boundaryIndex,
    `denser ratio folds a shorter tail (b2=${cAt2.boundaryIndex} > b4=${cAt4.boundaryIndex})`,
  );
});

// ---------- enforcePairIntegrity ----------

test('pairIntegrity: boundary after assistant-with-tool_calls advances past tool results', () => {
  const msgs: ChatMessage[] = [
    mk('user', 'q'),
    mk('assistant', '', {
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'run', arguments: '{}' },
        },
      ],
    }),
    mk('tool', 'r1', { tool_call_id: 't1' }),
    mk('user', 'next'),
  ];
  assert.equal(enforcePairIntegrity(msgs, 2), 3);
});

test('pairIntegrity: boundary on tool message advances past contiguous tool block', () => {
  const msgs: ChatMessage[] = [
    mk('user', 'q'),
    mk('tool', 'r1', { tool_call_id: 't1' }),
    mk('tool', 'r2', { tool_call_id: 't2' }),
    mk('user', 'next'),
  ];
  assert.equal(enforcePairIntegrity(msgs, 1), 3);
});

// ---------- start / apply ----------

test('compactor: start is non-blocking, folds older, keeps the tail', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  assert.equal(c.running, true);
  assert.equal(c.hasCompletedResult(), false);
  assert.equal(
    c.boundaryIndex,
    7,
    'fold everything before the ~keepTokens tail',
  );
});

test('compactor: applyCompaction swaps [summary, ...tail, notice]', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ summary: 'SUMMARY-TEXT' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs); // boundary = 7
  llm.resolveAll();
  await c.done();
  const result = c.applyCompaction(msgs);
  assert.equal(result[0].role, 'system');
  assert.match(
    result[0].content,
    /Summary of earlier conversation \(7 earlier messages compacted\)/,
  );
  assert.match(result[0].content, /SUMMARY-TEXT/);
  // tail (3 messages) preserved verbatim, then the notice
  assert.equal(result.length, 5);
  assert.match(result[1].content, /m7/);
  assert.match(result[3].content, /m9/);
  assert.equal(result[4].role, 'user');
  assert.match(result[4].content, /context compacted — 7 earlier messages/);
});

test('compactor: a changed frozen prefix discards the completed result', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const logs: string[] = [];
  const llm = fakeLLM({ summary: 'STALE' });
  const c = createCompactor(llm, tracker, {
    keepTokens: 250,
    log: (line) => logs.push(line),
  });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  llm.resolveAll();
  await c.done();
  msgs[0] = big('replacement');

  const result = c.applyCompaction(msgs);
  assert.equal(result, msgs);
  assert.equal(result[0], msgs[0]);
  assert.doesNotMatch(
    result.map((message) => message.content).join('\n'),
    /STALE/,
  );
  assert.equal(c.hasCompletedResult(), false);
  assert.equal(c.boundaryIndex, 0);
  assert.ok(
    logs.includes('compaction result discarded: frozen prefix changed'),
  );
});

test('compactor: in-place frozen-prefix mutation discards the completed result', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ summary: 'STALE-MUTATION' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  llm.resolveAll();
  await c.done();
  msgs[0].content = 'mutated in place';

  const result = c.applyCompaction(msgs);
  assert.equal(result, msgs);
  assert.equal(result[0].content, 'mutated in place');
  assert.doesNotMatch(
    result.map((message) => message.content).join('\n'),
    /STALE-MUTATION/,
  );
});

test('compactor: messages appended DURING compaction survive verbatim', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ summary: 'S' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs); // boundary = 7
  const postStartResource = mk('tool', 'post-start resource body', {
    tool_call_id: 'skill-after-start',
    contextResources: [
      {
        kind: 'skill',
        key: 'after-start',
        display: 'after-start',
        version: 'b'.repeat(64),
      },
    ],
  });
  msgs.push(mk('user', 'during-compaction'));
  msgs.push(mk('assistant', 'reply-during'));
  msgs.push(postStartResource);
  llm.resolveAll();
  await c.done();
  const result = c.applyCompaction(msgs);
  assert.match(result[result.length - 4].content, /during-compaction/);
  assert.match(result[result.length - 3].content, /reply-during/);
  assert.equal(result[result.length - 2], postStartResource);
  assert.equal(
    result[result.length - 2].contextResources?.[0].key,
    'after-start',
  );
});

test('compactor: skip-guard — a trivial fold (single message tail) does not summarize', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const c = createCompactor(llm, tracker, { keepTokens: 1 });
  const msgs = [big('only')];
  c.start(msgs);
  assert.equal(c.running, false, 'nothing worth summarizing');
  assert.equal(llm.calls, 0);
  assert.equal(c.boundaryIndex, 0);
});

test('compactor: failure leaves resultSummary null, lastError set', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ fail: true });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  llm.resolveAll();
  await c.done();
  assert.equal(c.hasCompletedResult(), false);
  assert.ok(c.lastError);
});

test('compactor: applyCompaction without a result returns messages unchanged', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = [mk('user', 'hi')];
  assert.equal(c.applyCompaction(msgs), msgs);
});

test('compactor: ratio drops after applyCompaction (recompute)', async () => {
  const tracker = createContextTracker(10000, 2000);
  const llm = fakeLLM({ summary: 'short summary' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  tracker.update({
    prompt_tokens: 7000,
    completion_tokens: 1000,
    total_tokens: 8000,
  });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  llm.resolveAll();
  await c.done();
  const before = tracker.usageRatio();
  c.applyCompaction(msgs);
  assert.ok(tracker.usageRatio() < before, 'ratio should drop after apply');
});

test('compactor: start-then-start-again is idempotent while running', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ summary: 'S' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  const firstCalls = llm.calls;
  c.start(msgs);
  assert.equal(llm.calls, firstCalls);
  llm.resolveAll();
  await c.done();
});

// ---------- prior-summary carry (#4) ----------

test('compactor: prior summary is carried out of the fold into EARLIER MEMORY', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ summary: 'FRESH-SUMMARY' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  // First cycle produces [summary, tail..., notice].
  let msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  llm.resolveAll();
  await c.done();
  msgs = c.applyCompaction(msgs);
  assert.match(msgs[0].content, /Summary of earlier conversation/);
  // Grow again so a second fold is worthwhile.
  for (let i = 0; i < 10; i++) msgs.push(big(`n${i}`));
  const inputsBefore = llm.inputs.length;
  c.start(msgs);
  const input = llm.inputs[inputsBefore];
  assert.ok(
    input.includes('EARLIER MEMORY'),
    'prior summary carried as a labeled section',
  );
  assert.ok(
    input.includes('FRESH-SUMMARY'),
    'the prior summary text is in the EARLIER MEMORY section',
  );
  assert.ok(
    input.includes('RECENT CONVERSATION TO FOLD IN'),
    'the recent fold body follows',
  );
});

test('compactor: prior summary survives even when the fold body exceeds totalCap', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ summary: 'PRIOR' });
  // Tiny fold-serialize cap so the recent body is truncated, but the EARLIER
  // MEMORY carry is OUTSIDE that cap and must survive.
  const c = createCompactor(llm, tracker, {
    keepTokens: 250,
    foldSerializeCap: 200,
  });
  let msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  llm.resolveAll();
  await c.done();
  msgs = c.applyCompaction(msgs);
  for (let i = 0; i < 10; i++) msgs.push(big(`n${i}`));
  const before = llm.inputs.length;
  c.start(msgs);
  const input = llm.inputs[before];
  assert.ok(input.includes('PRIOR'), 'the prior summary is not truncated away');
});

// ---------- selected-summary-model input admission ----------

test('compactor: summary budget counts instructions, reminder, framing, and output reserve without changing admitted input', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));

  const noBudgetLLM = fakeLLM();
  const noBudget = createCompactor(noBudgetLLM, tracker, { keepTokens: 250 });
  noBudget.start(msgs);
  const assembledInput = noBudgetLLM.inputs[0];
  assert.ok(assembledInput.endsWith(SUMMARIZE_TAIL_REMINDER));

  const framingTokens = 17;
  const outputReserveTokens = 101;
  const estimatedPieces: string[] = [];
  const exactContext =
    SOCIAL_SUMMARIZE_PROMPT.length +
    assembledInput.length +
    framingTokens +
    outputReserveTokens;
  const admittedLLM = fakeLLM();
  let boundaryRatioCalls = 0;
  const admitted = createCompactor(admittedLLM, tracker, {
    keepTokens: 250,
    ratio: () => {
      boundaryRatioCalls++;
      return 4;
    },
    summaryInputBudget: {
      contextWindowTokens: exactContext,
      outputReserveTokens,
      framingTokens,
      estimateTokens: (text) => {
        estimatedPieces.push(text);
        return text.length;
      },
    },
  });
  admitted.start(msgs);

  assert.deepEqual(estimatedPieces, [SOCIAL_SUMMARIZE_PROMPT, assembledInput]);
  assert.equal(
    boundaryRatioCalls,
    1,
    'the foreground ratio is used only for boundary selection, not admission',
  );
  assert.equal(admittedLLM.calls, 1, 'the exact-fit request is admitted');
  assert.equal(
    admittedLLM.inputs[0],
    assembledInput,
    'admission observes but does not rewrite the assembled summarize input',
  );

  const rejectedLLM = fakeLLM();
  const rejected = createCompactor(rejectedLLM, tracker, {
    keepTokens: 250,
    summaryInputBudget: {
      contextWindowTokens: exactContext - 1,
      outputReserveTokens,
      framingTokens,
      estimateTokens: (text) => text.length,
    },
  });
  rejected.start(msgs);
  assert.equal(
    rejectedLLM.calls,
    0,
    'one token below the complete request budget is rejected',
  );
  assert.match(rejected.lastError!, /estimated_input_tokens=/);
  assert.match(rejected.lastError!, /output_reserve_tokens=101/);
  assert.match(
    rejected.lastError!,
    /estimates, not exact tokenizer guarantees/,
  );
});

test('compactor: over-budget large carried summary is observable and retains original history', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const logs: string[] = [];
  const estimatedPieces: string[] = [];
  const c = createCompactor(llm, tracker, {
    keepTokens: 250,
    foldSerializeCap: 30,
    summaryInputBudget: {
      contextWindowTokens: 10_000,
      outputReserveTokens: 500,
      framingTokens: 20,
      estimateTokens: (text) => {
        estimatedPieces.push(text);
        return text.length;
      },
    },
    log: (line) => logs.push(line),
  });
  const prior =
    '=== Summary of earlier conversation (99 earlier messages compacted) ===\n' +
    'P'.repeat(20_000);
  const msgs = [
    mk('system', prior),
    ...Array.from({ length: 10 }, (_, i) => big(`recent-${i}`)),
  ];
  const original = msgs.map((message) => ({ ...message }));
  const expectedBoundary = enforcePairIntegrity(
    msgs,
    walkKeepBoundary(msgs, 250),
  );

  c.start(msgs);
  await c.done();

  assert.equal(
    c.boundaryIndex,
    expectedBoundary,
    'admission does not move the boundary',
  );
  assert.equal(llm.calls, 0, 'rejection happens before every model attempt');
  assert.equal(c.running, false);
  assert.equal(c.hasCompletedResult(), false);
  assert.match(c.lastError!, /estimated summary request exceeds/);
  assert.ok(
    logs.some((line) => line.startsWith('summarize admission rejected:')),
  );
  assert.equal(estimatedPieces[0], SOCIAL_SUMMARIZE_PROMPT);
  assert.ok(
    estimatedPieces[1].includes('P'.repeat(20_000)),
    'the carried prior summary is counted outside the small recent serialization cap',
  );
  assert.ok(estimatedPieces[1].includes('EARLIER MEMORY'));
  assert.ok(estimatedPieces[1].includes('RECENT CONVERSATION TO FOLD IN'));
  assert.ok(estimatedPieces[1].endsWith(SUMMARIZE_TAIL_REMINDER));
  assert.deepEqual(msgs, original, 'start does not mutate the source history');
  assert.equal(
    c.applyCompaction(msgs),
    msgs,
    'no rejected result can replace history',
  );
});

test('compactor: no summary budget preserves legacy no-admission behavior', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const c = createCompactor(llm, tracker, {
    keepTokens: 250,
    foldSerializeCap: 1,
  });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));

  c.start(msgs);

  assert.equal(llm.calls, 1);
  assert.equal(c.running, true);
  assert.equal(c.lastError, null);
});

test('compactor: rejects nonsensical summary budget numbers at construction', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const make = (
    contextWindowTokens: number,
    outputReserveTokens: number,
    framingTokens: number,
  ) =>
    createCompactor(llm, tracker, {
      summaryInputBudget: {
        contextWindowTokens,
        outputReserveTokens,
        framingTokens,
        estimateTokens: (text) => text.length,
      },
    });

  assert.throws(() => make(Number.NaN, 0, 0), /contextWindowTokens/);
  assert.throws(() => make(100, -1, 0), /outputReserveTokens/);
  assert.throws(() => make(100, 0, -1), /framingTokens/);
  assert.throws(() => make(100, 80, 20), /leave input capacity/);
});

test('compactor: a nonsensical runtime token estimate is rejected before a model call', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const c = createCompactor(llm, tracker, {
    keepTokens: 250,
    summaryInputBudget: {
      contextWindowTokens: 10_000,
      outputReserveTokens: 100,
      framingTokens: 10,
      estimateTokens: () => Number.NaN,
    },
  });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));

  c.start(msgs);

  assert.equal(llm.calls, 0);
  assert.match(c.lastError!, /non-finite or negative estimate/);
});

// ---------- reset (context clear) ----------

test('compactor: reset drops all idle state and zeroes the tracker', () => {
  const tracker = createContextTracker(10000, 2000);
  const llm = fakeLLM({ summary: 'S' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  tracker.estimateAppended('some tokens here');
  c.reset();
  assert.equal(c.running, false);
  assert.equal(c.boundaryIndex, 0);
  assert.equal(c.hasCompletedResult(), false);
  assert.equal(c.lastError, null);
  assert.equal(tracker.currentTokens, 0);
});

test('compactor: reset discards an in-flight summary — stale result never applies', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM({ summary: 'STALE-SUMMARY' });
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  assert.equal(c.running, true);
  c.reset();
  llm.resolveAll();
  await c.done();
  assert.equal(
    c.hasCompletedResult(),
    false,
    'stale summary must not become a completed result',
  );
  assert.equal(c.boundaryIndex, 0);
});

// ---------- serializeHistory (reasoning visibility) ----------

test('serializeHistory: includes assistant reasoning_content', () => {
  const reasoning =
    'I need to call elpis.channel().send() because assistant content is not visible.';
  const text = serializeHistory([
    mk('user', 'hi'),
    mk('assistant', '', { reasoning_content: reasoning }),
  ]);
  assert.ok(text.includes('[reasoning]'));
  assert.ok(text.includes(reasoning));
});

test('serializeHistory: over-cap history drops the OLDEST, keeps the NEWEST', () => {
  const pad = 'y'.repeat(500);
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 40; i++) msgs.push(mk('user', `MSG_${i} ${pad}`));
  const text = serializeHistory(msgs, { contentCap: 600, totalCap: 2000 });
  assert.ok(text.includes('MSG_39'), 'newest survives');
  assert.ok(!text.includes('MSG_0 '), 'oldest dropped');
  assert.ok(text.startsWith('[oldest history truncated]'));
});

test('SOCIAL_SUMMARIZE_PROMPT asks for multi-paragraph summaries', () => {
  assert.ok(SOCIAL_SUMMARIZE_PROMPT.includes('Write several paragraphs'));
  assert.ok(SOCIAL_SUMMARIZE_PROMPT.includes('not a single sentence'));
});

// ---------- summary quality gate + instruction sandwich ----------
// A 658-message fold once collapsed to one in-voice monologue sentence — a
// successful API call, so nothing retried and the carried prior summary was
// severed. The gate makes "success" mean more than non-empty; the tail
// restatement attacks the pattern-continuation failure directly.

test('compactor: summarize input ends with the tail restatement, after the fold body', () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const llm = fakeLLM();
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  const input = llm.inputs[0];
  assert.ok(
    input.endsWith(SUMMARIZE_TAIL_REMINDER),
    'reminder is the LAST thing the model reads',
  );
  assert.ok(
    input.indexOf('m0') < input.indexOf(SUMMARIZE_TAIL_REMINDER),
    'fold body precedes the reminder',
  );
});

test('compactor: a degenerate short summary is rejected and retried (quality gate)', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  let calls = 0;
  const good = 'GOOD-SUMMARY '.padEnd(300, 'z');
  const llm = {
    summarize: async () =>
      ++calls === 1 ? 'one terse in-voice sentence.' : good,
  } as unknown as LLM;
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`)); // fold = 7 → floor 70 chars
  c.start(msgs);
  await c.done();
  assert.equal(calls, 2, 'short first attempt consumed a retry');
  assert.equal(c.hasCompletedResult(), true);
  assert.equal(
    c.lastError,
    null,
    'the interim rejection is cleared by the later success — a stale rejection would be misreported by the escalation nudge (finding 4)',
  );
  const result = c.applyCompaction(msgs);
  assert.match(result[0].content, /GOOD-SUMMARY/);
});

test('compactor: persistently short summaries exhaust retries and leave no result', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  let calls = 0;
  const llm = {
    summarize: async () => {
      calls++;
      return 'nope.';
    },
  } as unknown as LLM;
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  await c.done();
  assert.equal(calls, 3, 'all three attempts used');
  assert.equal(
    c.hasCompletedResult(),
    false,
    'a degenerate summary never applies',
  );
  assert.match(c.lastError!, /floor/);
});

test('compactor: the floor scales with fold size (small folds may be terse)', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  // Fold of 2 messages → floor min(2000, 20) = 20 chars; 25 chars passes.
  const llm = { summarize: async () => 'a'.repeat(25) } as unknown as LLM;
  const c = createCompactor(llm, tracker, { keepTokens: 250 });
  const msgs = Array.from({ length: 5 }, (_, i) => big(`m${i}`)); // boundary = 2
  c.start(msgs);
  await c.done();
  assert.equal(c.boundaryIndex, 2);
  assert.equal(
    c.hasCompletedResult(),
    true,
    'a legitimately small fold is not held to the cap',
  );
  assert.equal(Math.min(SUMMARY_FLOOR_CAP, SUMMARY_FLOOR_PER_MESSAGE * 2), 20);
});

test('compactor: applyCompaction logs replaced count and summary length', async () => {
  const tracker = createContextTracker(1_000_000, 2000);
  const lines: string[] = [];
  const llm = fakeLLM({ summary: 'SUMMARY-TEXT' });
  const c = createCompactor(llm, tracker, {
    keepTokens: 250,
    log: (l) => lines.push(l),
  });
  const msgs = Array.from({ length: 10 }, (_, i) => big(`m${i}`));
  c.start(msgs);
  llm.resolveAll();
  await c.done();
  c.applyCompaction(msgs);
  assert.ok(
    lines.some((l) =>
      /^compaction applied \| replaced=7 \| summary_chars=\d+$/.test(l),
    ),
    `apply line present in: ${JSON.stringify(lines)}`,
  );
});

test('SUMMARIZE_TAIL_REMINDER names the observed failure (voice continuation)', () => {
  assert.ok(SUMMARIZE_TAIL_REMINDER.includes('not a conversation to continue'));
  assert.ok(SUMMARIZE_TAIL_REMINDER.includes('do not continue its voice'));
});
