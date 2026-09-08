import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chatCompletionStatus,
  anthropicCompletionStatus,
  responsesCompletionStatus,
} from '../src/llm/completion-status.js';
import { streamComplete } from '../src/llm/llm.js';
import { streamResponsesComplete } from '../src/llm/responses.js';
import { createAnthropicOAuthLLM } from '../src/llm/anthropic-client.js';
import { makeConfig } from './helpers.js';

const chatCases = [
  ['stop', 'complete'],
  ['tool_calls', 'complete'],
  ['function_call', 'complete'],
  ['length', 'incomplete'],
  ['content_filter', 'incomplete'],
  [undefined, 'unknown'],
  [null, 'unknown'],
  ['future', 'unknown'],
] as const;
const anthropicCases = [
  ['end_turn', 'complete'],
  ['stop_sequence', 'complete'],
  ['tool_use', 'complete'],
  ['max_tokens', 'incomplete'],
  ['model_context_window_exceeded', 'incomplete'],
  ['pause_turn', 'incomplete'],
  ['refusal', 'unknown'],
  [undefined, 'unknown'],
  [null, 'unknown'],
  ['future', 'unknown'],
] as const;
function stream(events: unknown[]): any {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
  };
}

test('terminal mappings also accept nonstreaming provider metadata without inference', () => {
  for (const [reason, expected] of chatCases)
    assert.equal(chatCompletionStatus(reason), expected);
  for (const [reason, expected] of anthropicCases)
    assert.equal(anthropicCompletionStatus(reason), expected);
  for (const [status, expected] of [
    ['completed', 'complete'],
    ['incomplete', 'incomplete'],
    ['failed', 'unknown'],
    ['cancelled', 'unknown'],
    ['in_progress', 'unknown'],
    ['queued', 'unknown'],
    ['future', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
  ] as const)
    assert.equal(responsesCompletionStatus({ status }), expected);
  assert.equal(
    responsesCompletionStatus({
      incomplete_details: { reason: 'max_output_tokens' },
    }),
    'incomplete',
  );
  assert.equal(
    responsesCompletionStatus({
      status: 'completed',
      incomplete_details: { reason: 'content_filter' },
    }),
    'incomplete',
  );
  assert.equal(
    responsesCompletionStatus({ status: 'future' }, 'response.completed'),
    'unknown',
  );
});

test('Chat streaming preserves output and usage while exposing the finish reason', async () => {
  for (const [finish_reason, expected] of chatCases) {
    const client = {
      chat: {
        completions: {
          create: async () =>
            stream([
              { choices: [{ delta: { content: 'unchanged' } }] },
              { choices: [{ delta: {}, finish_reason }] },
              {
                choices: [],
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 2,
                  total_tokens: 5,
                },
              },
            ]),
        },
      },
    };
    const result = await streamComplete(client as any, makeConfig(), []);
    assert.equal(result.completionStatus, expected);
    assert.equal(result.message.content, 'unchanged');
    assert.equal(result.stripped, false);
    assert.equal(result.usage.total_tokens, 5);
    assert.equal('completionStatus' in result.message, false);
  }
});

test('Responses terminal envelope maps status even with Codex usage-only terminal payloads', async () => {
  for (const [type, status, expected] of [
    ['response.completed', undefined, 'complete'],
    ['response.completed', 'completed', 'complete'],
    ['response.completed', 'future', 'unknown'],
    ['response.incomplete', undefined, 'incomplete'],
    ['response.completed', 'incomplete', 'incomplete'],
  ] as const) {
    const client = {
      responses: {
        create: async () =>
          stream([
            { type: 'response.output_text.delta', delta: 'unchanged' },
            {
              type,
              response: {
                status,
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              },
            },
          ]),
      },
    };
    const result = await streamResponsesComplete(
      client as any,
      makeConfig(),
      [],
    );
    assert.equal(result.completionStatus, expected);
    assert.equal(result.message.content, 'unchanged');
    assert.equal(result.stripped, false);
    assert.equal(result.usage.total_tokens, 5);
    assert.equal('completionStatus' in result.message, false);
  }
});

test('Anthropic resident reads message_delta stop_reason, not mere message_stop', async () => {
  const originalFetch = globalThis.fetch;
  const store = {
    read: () => null,
    getAccessToken: async () => 'test-access-token',
    forceRefresh: async () => undefined,
  };
  try {
    for (const [stop_reason, expected] of anthropicCases) {
      globalThis.fetch = async () =>
        new Response(
          [
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'unchanged' },
            },
            {
              type: 'message_delta',
              delta: { stop_reason },
              usage: { output_tokens: 2 },
            },
            { type: 'message_stop' },
          ]
            .map((event) => 'data: ' + JSON.stringify(event) + '\n\n')
            .join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      const config = makeConfig();
      const result = await createAnthropicOAuthLLM(
        config,
        store as any,
      ).complete([]);
      assert.equal(result.completionStatus, expected);
      assert.equal(result.message.content, 'unchanged');
      assert.equal(result.stripped, false);
      assert.equal(result.usage.completion_tokens, 2);
      assert.equal('completionStatus' in result.message, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('completion status stays independent of sanitizer and surviving tool calls', async () => {
  for (const finish_reason of ['stop', 'length', undefined]) {
    const client = {
      chat: {
        completions: {
          create: async () =>
            stream([
              {
                choices: [
                  {
                    delta: {
                      content: '<think>private</think>visible',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_valid',
                          type: 'function',
                          function: { name: 'run', arguments: '{"code":"1"}' },
                        },
                        {
                          index: 1,
                          id: 'call_bad',
                          type: 'function',
                          function: { name: 'run', arguments: 'invalid' },
                        },
                      ],
                    },
                  },
                ],
              },
              { choices: [{ delta: {}, finish_reason }] },
            ]),
        },
      },
    };
    const result = await streamComplete(client as any, makeConfig(), []);
    assert.equal(result.completionStatus, chatCompletionStatus(finish_reason));
    assert.equal(result.stripped, true);
    // Existing sanitizer drops this short leaked-CoT fixture entirely.
    assert.equal(result.message.content, '');
    assert.equal(result.message.tool_calls?.length, 1);
    assert.equal(result.message.tool_calls?.[0].id, 'call_valid');
  }
});
