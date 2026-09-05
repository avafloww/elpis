import assert from 'node:assert/strict';
import test from 'node:test';
import type { LLM } from '../src/llm/llm.js';
import { createGuardedSummarizer } from '../src/llm/summarize.js';

test('summary admission rejects before any model attempt and allows later recovery', async () => {
  const inputs: string[] = [];
  const results: string[] = [];
  const logs: string[] = [];
  const llm = {
    summarize: async (input: string) => {
      inputs.push(input);
      return 'accepted summary';
    },
  } as LLM;
  const summarizer = createGuardedSummarizer(llm, {
    retries: 3,
    validateInput(input) {
      if (input.length > 10)
        throw new Error('estimated summary input exceeds budget');
    },
    onResult: (summary) => {
      results.push(summary);
    },
    log: (line) => {
      logs.push(line);
    },
  });
  summarizer.start('oversized history');
  await summarizer.done();
  assert.equal(summarizer.running, false);
  assert.match(summarizer.lastError!, /exceeds budget/);
  assert.deepEqual(inputs, []);
  assert.deepEqual(results, []);
  assert.equal(logs.length, 1);
  summarizer.start('fits');
  await summarizer.done();
  assert.deepEqual(inputs, ['fits']);
  assert.deepEqual(results, ['accepted summary']);
  assert.equal(summarizer.lastError, null);
});

test('omitting admission preserves summary quality retries', async () => {
  let calls = 0;
  const results: string[] = [];
  const llm = {
    summarize: async () => (++calls === 1 ? 'x' : 'long enough'),
  } as LLM;
  const summarizer = createGuardedSummarizer(llm, {
    retries: 2,
    onResult: (summary) => {
      results.push(summary);
    },
  });
  summarizer.start('history', { minChars: 5 });
  await summarizer.done();
  assert.equal(calls, 2);
  assert.deepEqual(results, ['long enough']);
  assert.equal(summarizer.lastError, null);
});

test('reset clears an admission failure without delivering a result', async () => {
  const summarizer = createGuardedSummarizer(
    {
      summarize: async () => {
        throw new Error('must not call');
      },
    } as LLM,
    {
      validateInput() {
        throw new Error('does not fit');
      },
      onResult() {
        assert.fail('must not deliver');
      },
    },
  );
  summarizer.start('history');
  assert.match(summarizer.lastError!, /does not fit/);
  summarizer.reset();
  await summarizer.done();
  assert.equal(summarizer.lastError, null);
  assert.equal(summarizer.running, false);
});
