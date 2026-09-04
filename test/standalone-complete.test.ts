import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnthropicOAuthLLM } from '../src/llm/anthropic-client.js';
import { createLLM } from '../src/llm/llm.js';
import { makeConfig } from './helpers.js';

function config(api: 'responses' | 'chat' = 'responses') {
  const value = makeConfig();
  Object.assign(value.llm, {
    providerType: 'openai-compatible',
    apiKey: 'test-key',
    baseUrl: 'https://example.test/v1',
    model: 'wire-role-model',
    api,
    reasoningEffort: 'low',
    externalThinking: false,
  });
  return value;
}

function chatStream() {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: 'chat-ok' } }] };
      yield {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    },
  };
}

test('OpenAI Chat standalone omits tools and reports the resolved role identity', async () => {
  const llm = createLLM(config('chat'));
  let body: Record<string, unknown> | undefined;
  (llm.client as any).chat.completions.create = async (
    params: Record<string, unknown>,
  ) => {
    body = params;
    return chatStream();
  };
  const result = await llm.completeStandalone!(
    [{ role: 'user', content: 'classify' }],
    { maxTokens: 7, maxOutputBytes: 64 },
  );
  assert.ok(body && !Object.hasOwn(body, 'tools'));
  assert.equal(body?.max_tokens, 7);
  assert.equal(result.content, 'chat-ok');
  assert.equal(result.model, 'wire-role-model');
  assert.equal(result.providerType, 'openai-compatible');
  assert.equal(result.apiSurface, 'chat-completions');
  await assert.rejects(
    () => llm.completeStandalone!([{ role: 'tool', content: 'nope' }]),
    /requires allowHistoricalToolMessages/,
  );
  await assert.rejects(
    () =>
      llm.completeStandalone!([{ role: 'user', content: 'nope' }], {
        model: 'raw-wire-override',
      }),
    /configured role target/,
  );
});

test('OpenAI Chat standalone aborts before visible output exceeds its byte limit', async () => {
  const llm = createLLM(config('chat'));
  let signal: AbortSignal | undefined;
  let chunks = 0;
  (llm.client as any).chat.completions.create = async (
    _params: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ) => {
    signal = options.signal;
    return {
      async *[Symbol.asyncIterator]() {
        chunks++;
        yield { choices: [{ delta: { content: 'abcd' } }] };
        chunks++;
        yield { choices: [{ delta: { content: 'efgh' } }] };
        chunks++;
        yield { choices: [{ delta: { content: 'not-consumed' } }] };
      },
    };
  };
  await assert.rejects(
    llm.completeStandalone!([{ role: 'user', content: 'bounded' }], {
      maxOutputBytes: 5,
    }),
    /standalone visible output exceeds 5 UTF-8 bytes/,
  );
  assert.equal(signal?.aborted, true);
  assert.equal(chunks, 2);
});

test('OpenAI Chat standalone sends native tools and returns streamed function calls', async () => {
  const llm = createLLM(config('chat'));
  let body: Record<string, any> | undefined;
  (llm.client as any).chat.completions.create = async (
    params: Record<string, any>,
  ) => {
    body = params;
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { reasoning_content: 'locate target' } }] };
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_click',
                    type: 'function',
                    function: { name: 'click', arguments: '{"x":' },
                  },
                ],
              },
            },
          ],
        };
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '500,"y":250}' } },
                ],
              },
            },
          ],
        };
        yield {
          choices: [{ delta: {} }],
          usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
        };
      },
    };
  };
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'click',
        description: 'click a point',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { x: { type: 'integer' }, y: { type: 'integer' } },
          required: ['x', 'y'],
        },
      },
    },
  ];
  const history = [
    {
      role: 'assistant' as const,
      content: '',
      tool_calls: [
        {
          id: 'old_call',
          type: 'function' as const,
          function: { name: 'click', arguments: '{"x":1,"y":2}' },
        },
      ],
    },
    { role: 'tool' as const, content: 'ok', tool_call_id: 'old_call' },
    { role: 'user' as const, content: 'next frame' },
  ];
  const result = await llm.completeStandalone!(history, {
    tools,
    toolChoice: 'required',
    allowHistoricalToolMessages: true,
    reasoningEffort: 'medium',
    temperature: 0.8,
    topP: 0.95,
    topK: 20,
    maxTokens: 384,
    chatTemplateKwargs: { enable_thinking: true },
  });
  assert.deepEqual(body?.tools, tools);
  assert.equal(body?.tool_choice, 'required');
  assert.equal(body?.reasoning_effort, 'medium');
  assert.equal(body?.temperature, 0.8);
  assert.equal(body?.top_p, 0.95);
  assert.equal(body?.top_k, 20);
  assert.equal(body?.max_tokens, 384);
  assert.deepEqual(body?.chat_template_kwargs, { enable_thinking: true });
  assert.equal(body?.messages[0].tool_calls[0].id, 'old_call');
  assert.equal(body?.messages[1].tool_call_id, 'old_call');
  assert.equal(result.reasoningContent, 'locate target');
  assert.deepEqual(result.toolCalls, [
    {
      id: 'call_click',
      type: 'function',
      function: { name: 'click', arguments: '{"x":500,"y":250}' },
    },
  ]);
  assert.equal(result.apiSurface, 'chat-completions');
});

test('OpenAI Responses standalone rejects caller-defined native tools', async () => {
  const llm = createLLM(config('responses'));
  await assert.rejects(
    () =>
      llm.completeStandalone!([{ role: 'user', content: 'act' }], {
        tools: [
          {
            type: 'function',
            function: { name: 'act', parameters: { type: 'object' } },
          },
        ],
      }),
    /require the Chat Completions API surface/,
  );
});

test('OpenAI Responses standalone omits tools and carries an isolated cache key', async () => {
  const llm = createLLM(config('responses'));
  let body: Record<string, unknown> | undefined;
  (llm.client as any).responses.create = async (
    params: Record<string, unknown>,
  ) => {
    body = params;
    return {
      _request_id: 'req-responses',
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'responses-ok' }],
              },
            ],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        };
      },
    };
  };
  const result = await llm.completeStandalone!(
    [{ role: 'user', content: 'classify' }],
    { cacheKey: 'classifier-lane', maxTokens: 7, maxOutputBytes: 64 },
  );
  assert.ok(body && !Object.hasOwn(body, 'tools'));
  assert.equal(body?.max_output_tokens, 7);
  assert.equal(body?.prompt_cache_key, 'classifier-lane');
  assert.equal(result.content, 'responses-ok');
  assert.equal(result.requestId, 'req-responses');
  assert.equal(result.apiSurface, 'responses');
});

test('OpenAI Responses standalone aborts before visible output exceeds its byte limit', async () => {
  const llm = createLLM(config('responses'));
  let signal: AbortSignal | undefined;
  let chunks = 0;
  let returnCalls = 0;
  let returnSettled = false;
  (llm.client as any).responses.create = async (
    _params: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ) => {
    signal = options.signal;
    const events = [
      { type: 'response.output_text.delta', delta: 'abcd' },
      { type: 'response.output_text.delta', delta: 'efgh' },
      { type: 'response.output_text.delta', delta: 'not-consumed' },
    ];
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const value = events[chunks++];
            return value ? { done: false, value } : { done: true };
          },
          async return() {
            returnCalls++;
            await new Promise((resolve) => setTimeout(resolve, 5));
            returnSettled = true;
            return { done: true };
          },
        };
      },
    };
  };
  await assert.rejects(
    llm.completeStandalone!([{ role: 'user', content: 'bounded' }], {
      maxOutputBytes: 5,
    }),
    /standalone visible output exceeds 5 UTF-8 bytes/,
  );
  assert.equal(signal?.aborted, true);
  assert.equal(chunks, 2);
  assert.equal(returnCalls, 1);
  assert.equal(returnSettled, true);
});

test('OpenAI Responses closes immediately after a failed terminal event', async () => {
  const llm = createLLM(config('responses'));
  let signal: AbortSignal | undefined;
  let nextCalls = 0;
  let returnCalls = 0;
  (llm.client as any).responses.create = async (
    _params: Record<string, unknown>,
    options: { signal?: AbortSignal },
  ) => {
    signal = options.signal;
    const events = [
      {
        type: 'response.failed',
        response: { error: { code: 'server_error', message: 'failed' } },
      },
      { type: 'response.output_text.delta', delta: 'must-not-be-consumed' },
    ];
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            const value = events[nextCalls++];
            return value ? { done: false, value } : { done: true };
          },
          async return() {
            returnCalls++;
            return { done: true };
          },
        };
      },
    };
  };
  await assert.rejects(
    llm.completeStandalone!([{ role: 'user', content: 'bounded' }]),
  );
  assert.equal(signal?.aborted, true);
  assert.equal(nextCalls, 1);
  assert.equal(returnCalls, 1);
});

test('Anthropic standalone omits tools and tool choice on the wire', async () => {
  const value = config('responses');
  Object.assign(value.llm, {
    providerType: 'anthropic-oauth',
    apiKey: '',
    baseUrl: 'https://api.anthropic.test',
    model: 'claude-role-model',
  });
  const store = {
    read: () => null,
    getAccessToken: async () => 'test-oauth-token',
    forceRefresh: async () => {},
  } as any;
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(
      new TextDecoder().decode(init?.body as Uint8Array),
    ) as Record<string, unknown>;
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"anthropic-ok"}}',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    return new Response(sse, {
      status: 200,
      headers: { 'request-id': 'req-anthropic' },
    });
  };
  try {
    const llm = createAnthropicOAuthLLM(value, store, undefined);
    await assert.rejects(
      () =>
        llm.completeStandalone!([{ role: 'user', content: 'act' }], {
          tools: [
            {
              type: 'function',
              function: { name: 'act', parameters: { type: 'object' } },
            },
          ],
        }),
      /does not support caller-defined native tools/,
    );
    const result = await llm.completeStandalone!(
      [{ role: 'user', content: 'classify' }],
      { maxTokens: 7, maxOutputBytes: 64 },
    );
    assert.ok(body && !Object.hasOwn(body, 'tools'));
    assert.equal(body?.max_tokens, 7);
    assert.ok(body && !Object.hasOwn(body, 'tool_choice'));
    assert.equal(result.content, 'anthropic-ok');
    assert.equal(result.requestId, 'req-anthropic');
    assert.equal(result.providerType, 'anthropic-oauth');
    assert.equal(result.apiSurface, 'anthropic-messages');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic standalone rejects error events and missing message_stop', async () => {
  const value = config('responses');
  Object.assign(value.llm, {
    providerType: 'anthropic-oauth',
    apiKey: '',
    baseUrl: 'https://api.anthropic.test',
    model: 'claude-role-model',
  });
  const store = {
    read: () => null,
    getAccessToken: async () => 'test-oauth-token',
    forceRefresh: async () => {},
  } as any;
  const originalFetch = globalThis.fetch;
  let request = 0;
  globalThis.fetch = async () => {
    request++;
    const sse =
      request === 1
        ? [
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
            'event: error',
            'data: {"error":{"type":"overloaded_error","message":"overloaded"}}',
            '',
          ].join('\n')
        : request === 2
          ? [
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}',
              '',
            ].join('\n')
          : ['data: {malformed', 'data: {"type":"message_stop"}', ''].join(
              '\n',
            );
    return new Response(sse, { status: 200 });
  };
  try {
    const llm = createAnthropicOAuthLLM(value, store, undefined);
    await assert.rejects(
      llm.completeStandalone!([{ role: 'user', content: 'bounded' }]),
      /anthropic stream error/,
    );
    await assert.rejects(
      llm.completeStandalone!([{ role: 'user', content: 'bounded' }]),
      /ended without message_stop/,
    );
    await assert.rejects(
      llm.completeStandalone!([{ role: 'user', content: 'bounded' }]),
      /malformed JSON event/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Anthropic standalone aborts before visible output exceeds its byte limit', async () => {
  const value = config('responses');
  Object.assign(value.llm, {
    providerType: 'anthropic-oauth',
    apiKey: '',
    baseUrl: 'https://api.anthropic.test',
    model: 'claude-role-model',
  });
  const store = {
    read: () => null,
    getAccessToken: async () => 'test-oauth-token',
    forceRefresh: async () => {},
  } as any;
  const originalFetch = globalThis.fetch;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_input, init) => {
    signal = init?.signal;
    const sse = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"abcd"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"efgh"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"not-consumed"}}',
      '',
    ].join('\n');
    return new Response(sse, { status: 200 });
  };
  try {
    const llm = createAnthropicOAuthLLM(value, store, undefined);
    await assert.rejects(
      llm.completeStandalone!([{ role: 'user', content: 'bounded' }], {
        maxOutputBytes: 5,
      }),
      /standalone visible output exceeds 5 UTF-8 bytes/,
    );
    assert.equal(signal?.aborted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
