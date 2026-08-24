import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage, CompleteResult } from '../src/llm/llm.js';
import { SecretaryBrokerRequestError } from '../src/secretary/client.js';
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
  assert.match(
    completions[0][0].content,
    /use list to find bounded summaries globally/,
  );
  assert.match(
    completions[0][0].content,
    /durable comments, replies, and proposal creation/,
  );
  assert.equal(completions[1].at(-1)?.role, 'tool');
  assert.equal(completions[1].at(-1)?.tool_call_id, 'mind-1');
});

test('unsupported tool calls become bounded correction results without effects', async () => {
  let reads = 0;
  let round = 0;
  let correction: ChatMessage | undefined;
  const answer = await runSecretaryTurn(
    {
      async complete(messages) {
        round++;
        if (round === 1)
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
        correction = messages.at(-1);
        return result({ role: 'assistant', content: 'repaired' });
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
  );
  assert.equal(answer, 'repaired');
  assert.equal(reads, 0);
  assert.equal(correction?.role, 'tool');
  assert.deepEqual(JSON.parse(correction?.content ?? '{}'), {
    error: {
      type: 'invalid_tool_request',
      message: 'secretary completion requested an unsupported tool',
    },
  });
});

test('no-hint Mind 400 is returned to the model for an explicit-id correction', async () => {
  let round = 0;
  const reads: Record<string, unknown>[] = [];
  const answer = await runSecretaryTurn(
    {
      async complete(messages) {
        round++;
        if (round === 1)
          return result({
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'mind-missing',
                type: 'function',
                function: {
                  name: 'mind',
                  arguments: JSON.stringify({ operation: 'get' }),
                },
              },
            ],
          });
        if (round === 2) {
          assert.match(messages.at(-1)?.content ?? '', /Mind id is required/);
          return result({
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'mind-fixed',
                type: 'function',
                function: {
                  name: 'mind',
                  arguments: JSON.stringify({
                    operation: 'get',
                    id: 'elm-000000a1',
                  }),
                },
              },
            ],
          });
        }
        return result({ role: 'assistant', content: 'corrected answer' });
      },
      async mind(input) {
        reads.push(input);
        if (!input.id)
          throw new SecretaryBrokerRequestError(
            400,
            'secretary broker 400: Mind id is required when the secretary session has no hint',
          );
        return { protocol: 1, item: { id: input.id } };
      },
    },
    {
      id: 'stn-AAAAAAAAAAAAAAAAAAAAAA',
      sequence: 1,
      messages: [{ role: 'user', content: 'what is on deck?' }],
    },
  );
  assert.equal(answer, 'corrected answer');
  assert.deepEqual(reads, [
    { operation: 'get' },
    { operation: 'get', id: 'elm-000000a1' },
  ]);
});

test('authority failures from the Mind broker remain fatal', async () => {
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
                  id: 'mind-denied',
                  type: 'function',
                  function: {
                    name: 'mind',
                    arguments: JSON.stringify({ operation: 'get' }),
                  },
                },
              ],
            });
          },
          async mind() {
            throw new SecretaryBrokerRequestError(
              401,
              'secretary broker 401: unauthorized',
            );
          },
        },
        {
          id: 'stn-AAAAAAAAAAAAAAAAAAAAAA',
          sequence: 1,
          messages: [{ role: 'user', content: 'act' }],
        },
      ),
    /401: unauthorized/,
  );
});
