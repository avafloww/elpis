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
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } };
    },
  };
}

test('OpenAI Chat standalone omits tools and reports the resolved role identity', async () => {
  const llm = createLLM(config('chat'));
  let body: Record<string, unknown> | undefined;
  (llm.client as any).chat.completions.create = async (params: Record<string, unknown>) => {
    body = params;
    return chatStream();
  };
  const result = await llm.completeStandalone!([{ role: 'user', content: 'classify' }]);
  assert.ok(body && !Object.hasOwn(body, 'tools'));
  assert.equal(result.content, 'chat-ok');
  assert.equal(result.model, 'wire-role-model');
  assert.equal(result.providerType, 'openai-compatible');
  assert.equal(result.apiSurface, 'chat-completions');
  await assert.rejects(
    () => llm.completeStandalone!([{ role: 'tool', content: 'nope' }]),
    /does not accept tool messages/,
  );
  await assert.rejects(
    () => llm.completeStandalone!([{ role: 'user', content: 'nope' }], { model: 'raw-wire-override' }),
    /configured role target/,
  );
});

test('OpenAI Responses standalone omits tools and carries an isolated cache key', async () => {
  const llm = createLLM(config('responses'));
  let body: Record<string, unknown> | undefined;
  (llm.client as any).responses.create = async (params: Record<string, unknown>) => {
    body = params;
    return {
      _request_id: 'req-responses',
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'response.completed',
          response: {
            output: [{ type: 'message', content: [{ type: 'output_text', text: 'responses-ok' }] }],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          },
        };
      },
    };
  };
  const result = await llm.completeStandalone!([{ role: 'user', content: 'classify' }], { cacheKey: 'classifier-lane' });
  assert.ok(body && !Object.hasOwn(body, 'tools'));
  assert.equal(body?.prompt_cache_key, 'classifier-lane');
  assert.equal(result.content, 'responses-ok');
  assert.equal(result.requestId, 'req-responses');
  assert.equal(result.apiSurface, 'responses');
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
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"anthropic-ok"}}',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'request-id': 'req-anthropic' } });
  };
  try {
    const llm = createAnthropicOAuthLLM(value, store, undefined);
    const result = await llm.completeStandalone!([{ role: 'user', content: 'classify' }]);
    assert.ok(body && !Object.hasOwn(body, 'tools'));
    assert.ok(body && !Object.hasOwn(body, 'tool_choice'));
    assert.equal(result.content, 'anthropic-ok');
    assert.equal(result.requestId, 'req-anthropic');
    assert.equal(result.providerType, 'anthropic-oauth');
    assert.equal(result.apiSurface, 'anthropic-messages');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
