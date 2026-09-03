import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import type {
  ChatMessage,
  StandaloneCompleteOptions,
  StandaloneCompleteResult,
} from '../src/llm/llm.js';
import { createLlmModelRegistry } from '../src/llm/model-registry.js';
import {
  createLlmToolRuntime,
  LLM_TOOL_MAX_OUTPUT_BYTES,
  LLM_TOOL_MAX_PROMPT_BYTES,
} from '../src/llm/tool-runtime.js';
import { makeConfig, makeStubLLM } from './helpers.js';

function canonicalConfig(): Config {
  const config = makeConfig();
  config.llm.registry = createLlmModelRegistry({
    providers: {
      p: {
        providerType: 'openai-compatible',
        apiKey: 'never-return-this-key',
        baseUrl: 'https://private-endpoint.example/v1',
        api: 'responses',
        externalThinking: false,
        streamIdleTimeoutMs: 1000,
        callTimeoutMs: 2000,
        models: {
          weak: {
            name: 'wire-weak',
            contextSize: 32000,
            reasoningEffort: 'low',
            reasoningSummary: null,
            reasoningContext: null,
            toolTier: 'weak',
          },
          hidden: {
            name: 'wire-hidden',
            contextSize: 64000,
            reasoningEffort: 'medium',
            reasoningSummary: null,
            reasoningContext: null,
            toolTier: null,
          },
          strong: {
            name: 'wire-strong',
            contextSize: 128000,
            reasoningEffort: 'high',
            reasoningSummary: null,
            reasoningContext: null,
            toolTier: 'strong',
          },
        },
      },
    },
    roles: { main: 'p/strong', classifier: 'p/weak' },
  });
  config.llm.registrySource = 'canonical';
  return config;
}

function result(
  content: string,
  model: string,
  extra: Partial<StandaloneCompleteResult> = {},
): StandaloneCompleteResult {
  return {
    content,
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    model,
    providerType: 'openai-compatible',
    apiSurface: 'responses',
    ...extra,
  };
}

test('LLM tool runtime exposes only opted-in models and sends fresh user-only calls', async () => {
  const created: string[] = [];
  const seen: Array<{
    model: string;
    messages: ChatMessage[];
    options: StandaloneCompleteOptions | undefined;
  }> = [];
  const runtime = createLlmToolRuntime(canonicalConfig(), {
    create(config) {
      created.push(config.llm.model);
      return makeStubLLM({
        model: config.llm.model,
        async completeStandalone(messages, options) {
          seen.push({ model: config.llm.model, messages, options });
          return result('answer', config.llm.model, {
            reasoningContent: 'hidden reasoning',
            reasoningItems: [
              { type: 'reasoning', encrypted_content: 'opaque' },
            ] as never,
            apiEndpoint: 'https://private-endpoint.example/v1/responses',
            requestId: 'private-request-id',
          });
        },
      });
    },
  });
  assert(runtime);
  assert.deepEqual(created, ['wire-weak', 'wire-strong']);
  assert.deepEqual(runtime.list(), [
    {
      tier: 'weak',
      ref: 'p/weak',
      model: 'wire-weak',
      providerType: 'openai-compatible',
      contextSize: 32000,
    },
    {
      tier: 'strong',
      ref: 'p/strong',
      model: 'wire-strong',
      providerType: 'openai-compatible',
      contextSize: 128000,
    },
  ]);
  assert(Object.isFrozen(runtime.list()));
  assert(Object.isFrozen(runtime.list()[0]));

  const weak = await runtime.query({ prompt: 'plain prompt', model: 'weak' });
  const strong = await runtime.query({ prompt: 'second', model: 'p/strong' });
  assert.equal(weak.text, 'answer');
  assert.equal(strong.model.ref, 'p/strong');
  assert.deepEqual(seen[0].messages, [
    { role: 'user', content: 'plain prompt' },
  ]);
  assert.deepEqual(Object.keys(seen[0].options ?? {}).sort(), [
    'maxTokens',
    'signal',
  ]);
  assert.equal(seen[0].options?.maxTokens, 4096);
  const serialized = JSON.stringify(weak);
  assert.doesNotMatch(
    serialized,
    /hidden reasoning|opaque|private-endpoint|request-id|never-return/,
  );
  assert(Object.isFrozen(weak));
  assert(Object.isFrozen(weak.provenance));
  assert(Object.isFrozen(weak.usage));
});

test('LLM tool runtime validates exact JSON against a bounded schema', async () => {
  const outputs = [
    '{"answer":3}',
    '{"answer":"wrong"}',
    '```json\n{"answer":3}\n```',
  ];
  const prompts: string[] = [];
  const runtime = createLlmToolRuntime(canonicalConfig(), {
    create(config) {
      return makeStubLLM({
        model: config.llm.model,
        async completeStandalone(messages) {
          prompts.push(messages[0]?.content ?? '');
          return result(outputs.shift() ?? '{}', config.llm.model);
        },
      });
    },
  });
  assert(runtime);
  const schema = {
    type: 'object',
    properties: { answer: { type: 'integer' } },
    required: ['answer'],
    additionalProperties: false,
  };
  const valid = await runtime.query({
    prompt: 'give a number',
    model: 'weak',
    schema,
  });
  assert.deepEqual(valid.parsed, { answer: 3 });
  assert(Object.isFrozen(valid.parsed));
  assert.match(prompts[0], /Return exactly one JSON value/);
  assert.match(prompts[0], /"additionalProperties":false/);
  await assert.rejects(
    runtime.query({ prompt: 'again', model: 'weak', schema }),
    /failed schema validation/,
  );
  await assert.rejects(
    runtime.query({ prompt: 'again', model: 'weak', schema }),
    /was not exact JSON/,
  );
  await assert.rejects(
    runtime.query({
      prompt: 'bad schema',
      model: 'weak',
      schema: { $ref: 'https://example.test/schema.json' },
    }),
    /schema keyword \$ref is not supported/,
  );
});

test('LLM tool runtime rejects unexposed models, malformed input, and byte overflow before or after calls', async () => {
  let calls = 0;
  const runtime = createLlmToolRuntime(canonicalConfig(), {
    create(config) {
      return makeStubLLM({
        model: config.llm.model,
        async completeStandalone() {
          calls++;
          return result(
            'x'.repeat(LLM_TOOL_MAX_OUTPUT_BYTES + 1),
            config.llm.model,
          );
        },
      });
    },
  });
  assert(runtime);
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'p/hidden' }),
    /model must be an exposed tier or ref/,
  );
  await assert.rejects(
    runtime.query({ prompt: '', model: 'weak' }),
    /prompt must be a non-empty string/,
  );
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak', extra: true }),
    /unknown option/,
  );
  await assert.rejects(
    runtime.query({
      prompt: 'x'.repeat(LLM_TOOL_MAX_PROMPT_BYTES + 1),
      model: 'weak',
    }),
    /prompt exceeds/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    /output exceeds/,
  );
  assert.equal(calls, 1);
});

test('LLM tool runtime aborts timed-out calls and rejects provenance or tool-call drift', async () => {
  let mode: 'timeout' | 'provider' | 'model' | 'surface' | 'tools' = 'timeout';
  const runtime = createLlmToolRuntime(canonicalConfig(), {
    timeoutMs: 5,
    create(config) {
      return makeStubLLM({
        model: config.llm.model,
        async completeStandalone(_messages, options) {
          if (mode === 'timeout') {
            return await new Promise<StandaloneCompleteResult>(
              (_resolve, reject) => {
                options?.signal?.addEventListener(
                  'abort',
                  () => reject(new Error('aborted')),
                  {
                    once: true,
                  },
                );
              },
            );
          }
          if (mode === 'provider')
            throw new Error(
              'request failed at https://private-endpoint.example with secret-token',
            );
          if (mode === 'model') return result('x', 'wrong-model');
          if (mode === 'surface')
            return result('x', config.llm.model, {
              apiSurface: 'https://private-endpoint.example' as never,
            });
          return result('x', config.llm.model, {
            toolCalls: [
              {
                id: 'unexpected',
                type: 'function',
                function: { name: 'act', arguments: '{}' },
              },
            ],
          });
        },
      });
    },
  });
  assert(runtime);
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    /timed out after 5ms/,
  );
  mode = 'provider';
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    (error: Error) => {
      assert.match(error.message, /provider request failed for p\/weak/);
      assert.doesNotMatch(error.message, /private-endpoint|secret-token/);
      return true;
    },
  );
  mode = 'model';
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    /model provenance mismatch/,
  );
  mode = 'surface';
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    /API surface provenance mismatch/,
  );
  mode = 'tools';
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    /unexpected tool call/,
  );
});

test('legacy and canonical registries without tool tiers expose no runtime', () => {
  assert.equal(
    createLlmToolRuntime(makeConfig(), { create: () => makeStubLLM() }),
    null,
  );
  const config = canonicalConfig();
  for (const provider of Object.values(config.llm.registry.providers))
    for (const model of Object.values(provider.models)) model.toolTier = null;
  assert.equal(
    createLlmToolRuntime(config, { create: () => makeStubLLM() }),
    null,
  );
});
