import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, CompleteResult } from '../src/llm/llm.js';
import { runSecretaryTurn } from '../src/secretary/loop.js';

function result(message: ChatMessage): CompleteResult {
  return {
    message,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    stripped: false,
  };
}

test('secretary turn executes only bounded Mind calls then returns final answer', async () => {
  const completions: ChatMessage[][] = [];
  const reads: unknown[] = [];
  let round = 0;
  const answer = await runSecretaryTurn(
    {
      async complete(messages) {
        completions.push(structuredClone(messages));
        round++;
        return round === 1
          ? result({
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'mind-1',
                  type: 'function',
                  function: {
                    name: 'mind',
                    arguments: JSON.stringify({ operation: 'tree', depth: 2 }),
                  },
                },
              ],
            })
          : result({ role: 'assistant', content: 'final from elm-root0001' });
      },
      async mind(input) {
        reads.push(input);
        return { protocol: 1, item: { id: 'elm-root0001' } };
      },
    },
    {
      id: 'stn-AAAAAAAAAAAAAAAAAAAAAA',
      sequence: 1,
      messages: [{ role: 'user', content: 'summarize' }],
    },
  );
  assert.equal(answer, 'final from elm-root0001');
  assert.deepEqual(reads, [{ operation: 'tree', depth: 2 }]);
  assert.equal(completions[0][0].role, 'system');
  assert.equal(completions[1].at(-1)?.role, 'tool');
  assert.equal(completions[1].at(-1)?.tool_call_id, 'mind-1');
});

test('secretary turn rejects malformed or unsupported tool calls before effects', async () => {
  let reads = 0;
  await assert.rejects(
    () =>
      runSecretaryTurn(
        {
          async complete() {
            return result({
              role: 'assistant',
              content: '',
              tool_calls: [
                {
                  id: 'bad-1',
                  type: 'function',
                  function: { name: 'run', arguments: '{}' },
                },
              ],
            });
          },
          async mind() {
            reads++;
            return {};
          },
        },
        {
          id: 'stn-AAAAAAAAAAAAAAAAAAAAAA',
          sequence: 1,
          messages: [{ role: 'user', content: 'act' }],
        },
      ),
    /unsupported tool/,
  );
  assert.equal(reads, 0);
});
