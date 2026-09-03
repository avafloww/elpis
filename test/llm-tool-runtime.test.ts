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
  LLM_TOOL_MAX_SCHEMA_BYTES,
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
    'maxOutputBytes',
    'maxTokens',
    'signal',
  ]);
  assert.equal(seen[0].options?.maxTokens, 4096);
  assert.equal(seen[0].options?.maxOutputBytes, LLM_TOOL_MAX_OUTPUT_BYTES);
  const serialized = JSON.stringify(weak);
  assert.doesNotMatch(
    serialized,
    /hidden reasoning|opaque|private-endpoint|request-id|never-return/,
  );
  assert(Object.isFrozen(weak));
  assert(Object.isFrozen(weak.provenance));
  assert(Object.isFrozen(weak.usage));
});

test('LLM tool runtime prepares one canonical semantic snapshot', async () => {
  const prompts: string[] = [];
  const runtime = createLlmToolRuntime(canonicalConfig(), {
    create(config) {
      return makeStubLLM({
        model: config.llm.model,
        async completeStandalone(messages) {
          prompts.push(messages[0]?.content ?? '');
          return result('"ok"', config.llm.model);
        },
      });
    },
  });
  assert(runtime);
  await assert.rejects(
    runtime.queryPrepared(
      Object.freeze({
        prompt: 'forged',
        selector: 'weak',
        schema: null,
        schemaJson: null,
        inputBytes: 1,
      }),
    ),
    /prepared query was not created by this runtime/,
  );
  assert.deepEqual(prompts, []);
  const schema = { type: 'string' };
  const input = { prompt: 'before', model: 'weak', schema };
  const prepared = runtime.prepare(input);
  assert(Object.isFrozen(prepared));
  assert.equal(
    prepared.inputBytes,
    Buffer.byteLength(JSON.stringify(input), 'utf8'),
  );
  input.prompt = 'after';
  schema.type = 'number';
  assert.equal(Reflect.set(prepared.schema ?? {}, 'type', 'number'), false);
  assert.equal(prepared.schema?.type, 'string');
  await runtime.queryPrepared(prepared);
  assert.match(prompts[0] ?? '', /^before\n\n/);
  assert.match(prompts[0] ?? '', /"type":"string"/);
  assert.doesNotMatch(prompts[0] ?? '', /after|number/);
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
  await assert.rejects(
    runtime.query({
      prompt: 'bad schema',
      model: 'weak',
      schema: { type: 'string', pattern: '(a+)+$' },
    }),
    /schema keyword pattern is not supported/,
  );
  await assert.rejects(
    runtime.query({
      prompt: 'bad schema',
      model: 'weak',
      schema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'string',
      },
    }),
    /only JSON Schema draft-07 is supported/,
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
  let queryProxyTrapCalls = 0;
  const queryProxy = new Proxy(
    { prompt: 'x', model: 'weak' },
    {
      ownKeys(target) {
        queryProxyTrapCalls++;
        return Reflect.ownKeys(target);
      },
    },
  );
  await assert.rejects(
    runtime.query(queryProxy),
    /query option proxies are not supported/,
  );
  assert.equal(queryProxyTrapCalls, 0);
  let optionPrototypeTrapCalls = 0;
  const optionPrototype = new Proxy(Object.prototype, {
    getOwnPropertyDescriptor(target, property) {
      optionPrototypeTrapCalls++;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const optionPrototypeInput = Object.create(optionPrototype);
  Object.defineProperties(optionPrototypeInput, {
    prompt: { value: 'x', enumerable: true },
    model: { value: 'weak', enumerable: true },
  });
  assert.throws(
    () => runtime.prepare(optionPrototypeInput),
    /query option prototype proxies are not supported/,
  );
  assert.equal(optionPrototypeTrapCalls, 0);
  const hiddenPrompt = { model: 'weak' } as Record<string, unknown>;
  Object.defineProperty(hiddenPrompt, 'prompt', {
    value: 'x',
    enumerable: false,
  });
  await assert.rejects(
    runtime.query(hiddenPrompt),
    /prompt must be a non-empty string/,
  );
  const getterPrompt = { model: 'weak' } as Record<string, unknown>;
  let topLevelGetterCalls = 0;
  Object.defineProperty(getterPrompt, 'prompt', {
    enumerable: true,
    get: () => {
      topLevelGetterCalls++;
      return 'x';
    },
  });
  await assert.rejects(
    runtime.query(getterPrompt),
    /own enumerable data properties/,
  );
  assert.equal(topLevelGetterCalls, 0);
  let ignoredAccessorCalls = 0;
  const inertSchema: Record<PropertyKey, unknown> = { type: 'string' };
  Object.defineProperty(inertSchema, 'hidden', {
    enumerable: false,
    get: () => {
      ignoredAccessorCalls++;
      return 'must-not-run';
    },
  });
  Object.defineProperty(inertSchema, Symbol('hidden-schema'), {
    enumerable: true,
    get: () => {
      ignoredAccessorCalls++;
      return 'must-not-run';
    },
  });
  const inertInput: Record<PropertyKey, unknown> = {
    prompt: 'x',
    model: 'weak',
    schema: inertSchema,
  };
  Object.defineProperty(inertInput, 'hidden', {
    enumerable: false,
    get: () => {
      ignoredAccessorCalls++;
      return 'must-not-run';
    },
  });
  Object.defineProperty(inertInput, Symbol('hidden-option'), {
    enumerable: true,
    get: () => {
      ignoredAccessorCalls++;
      return 'must-not-run';
    },
  });
  const inertPrepared = runtime.prepare(inertInput);
  assert.deepEqual(Object.keys(inertPrepared.schema ?? {}), ['type']);
  assert.equal(inertPrepared.schema?.type, 'string');
  assert.equal(ignoredAccessorCalls, 0);
  const tooManyOptions: Record<string, unknown> = {
    prompt: 'x',
    model: 'weak',
  };
  for (let index = 0; index < 100; index++)
    tooManyOptions[`extra${index}`] = index;
  assert.throws(() => runtime.prepare(tooManyOptions), /too many options/);
  let nestedGetterCalls = 0;
  const getterSchema = {};
  Object.defineProperty(getterSchema, 'type', {
    enumerable: true,
    get: () => {
      nestedGetterCalls++;
      return 'string';
    },
  });
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak', schema: getterSchema }),
    /schema values must use own enumerable data properties/,
  );
  assert.equal(nestedGetterCalls, 0);
  let toJsonCalls = 0;
  await assert.rejects(
    runtime.query({
      prompt: 'x',
      model: 'weak',
      schema: {
        type: 'string',
        toJSON: () => {
          toJsonCalls++;
          return { type: 'number' };
        },
      },
    }),
    /schema values must contain only JSON-compatible data/,
  );
  assert.equal(toJsonCalls, 0);
  let proxyTrapCalls = 0;
  const proxySchema = new Proxy(
    { type: 'string' },
    {
      ownKeys(target) {
        proxyTrapCalls++;
        return Reflect.ownKeys(target);
      },
    },
  );
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak', schema: proxySchema }),
    /schema proxies are not supported/,
  );
  assert.equal(proxyTrapCalls, 0);
  let prototypeProxyTrapCalls = 0;
  const prototypeProxy = new Proxy(Object.prototype, {
    getOwnPropertyDescriptor(target, property) {
      prototypeProxyTrapCalls++;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  const prototypeProxySchema = Object.create(prototypeProxy);
  Object.defineProperty(prototypeProxySchema, 'type', {
    value: 'string',
    enumerable: true,
  });
  await assert.rejects(
    runtime.query({
      prompt: 'x',
      model: 'weak',
      schema: prototypeProxySchema,
    }),
    /schema prototype proxies are not supported/,
  );
  assert.equal(prototypeProxyTrapCalls, 0);
  let constructorProxyTrapCalls = 0;
  const constructorProxy = new Proxy(function Object() {}, {
    get(target, property, receiver) {
      constructorProxyTrapCalls++;
      return Reflect.get(target, property, receiver);
    },
  });
  const maliciousPrototype = Object.create(null);
  Object.defineProperty(maliciousPrototype, 'constructor', {
    value: constructorProxy,
  });
  const exoticSchema = Object.assign(Object.create(maliciousPrototype), {
    type: 'string',
  });
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak', schema: exoticSchema }),
    /schema values must be plain objects or arrays/,
  );
  assert.equal(constructorProxyTrapCalls, 0);
  const laterProxy = new Proxy(
    { type: 'number' },
    {
      ownKeys() {
        throw new Error('late proxy was visited');
      },
    },
  );
  await assert.rejects(
    runtime.query({
      prompt: 'x',
      model: 'weak',
      schema: {
        description: 'x'.repeat(LLM_TOOL_MAX_SCHEMA_BYTES + 1),
        later: laterProxy,
      },
    }),
    /schema exceeds 16384 UTF-8 bytes/,
  );
  const oversizedKeySchema: Record<string, unknown> = {};
  Object.defineProperty(
    oversizedKeySchema,
    'k'.repeat(LLM_TOOL_MAX_SCHEMA_BYTES + 1),
    { value: true, enumerable: true },
  );
  Object.defineProperty(oversizedKeySchema, 'later', {
    value: laterProxy,
    enumerable: true,
  });
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak', schema: oversizedKeySchema }),
    /schema exceeds 16384 UTF-8 bytes/,
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
  await assert.rejects(
    runtime.query({
      prompt: 'x',
      model: 'weak',
      schema: { type: 'object' },
    }),
    /output exceeds/,
  );
  assert.equal(calls, 2);
});

test('LLM tool runtime bounds parsed JSON traversal before freezing', async () => {
  const outputs = [
    `${'['.repeat(10_000)}0${']'.repeat(10_000)}`,
    JSON.stringify(Array.from({ length: 5_000 }, () => 0)),
  ];
  const runtime = createLlmToolRuntime(canonicalConfig(), {
    create(config) {
      return makeStubLLM({
        model: config.llm.model,
        async completeStandalone() {
          return result(outputs.shift() ?? 'null', config.llm.model);
        },
      });
    },
  });
  assert(runtime);
  await assert.rejects(
    runtime.query({ prompt: 'deep', model: 'weak', schema: {} }),
    /model output JSON exceeds depth/,
  );
  await assert.rejects(
    runtime.query({ prompt: 'wide', model: 'weak', schema: {} }),
    /model output JSON exceeds [0-9]+ nodes/,
  );
});

test('LLM tool runtime aborts timed-out calls and rejects provenance or tool-call drift', async () => {
  let mode:
    | 'timeout'
    | 'provider'
    | 'limit'
    | 'hostile-error'
    | 'model'
    | 'surface'
    | 'wrong-surface'
    | 'tools' = 'timeout';
  let timeoutAborted = false;
  const runtime = createLlmToolRuntime(canonicalConfig(), {
    timeoutMs: 5,
    create(config) {
      return makeStubLLM({
        model: config.llm.model,
        completeStandalone(_messages, options) {
          if (mode === 'timeout') {
            options?.signal?.addEventListener(
              'abort',
              () => {
                timeoutAborted = true;
              },
              { once: true },
            );
            return new Promise<StandaloneCompleteResult>(() => {});
          }
          if (mode === 'provider')
            throw new Error(
              'request failed at https://private-endpoint.example with secret-token',
            );
          if (mode === 'limit')
            throw Object.assign(new Error('secret provider detail'), {
              cause: Object.assign(new Error('internal limit detail'), {
                code: 'standalone_output_limit',
              }),
            });
          if (mode === 'hostile-error') {
            const error = {};
            Object.defineProperty(error, 'code', {
              get: () => {
                throw new Error('getter-secret');
              },
            });
            throw error;
          }
          if (mode === 'model') return result('x', 'wrong-model');
          if (mode === 'surface')
            return Promise.resolve(
              result('x', config.llm.model, {
                apiSurface: 'https://private-endpoint.example' as never,
              }),
            );
          if (mode === 'wrong-surface')
            return Promise.resolve(
              result('x', config.llm.model, {
                apiSurface: 'anthropic-messages',
              }),
            );
          return Promise.resolve(
            result('x', config.llm.model, {
              toolCalls: [
                {
                  id: 'unexpected',
                  type: 'function',
                  function: { name: 'act', arguments: '{}' },
                },
              ],
            }),
          );
        },
      });
    },
  });
  assert(runtime);
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    /timed out after 5ms/,
  );
  assert.equal(timeoutAborted, true);
  mode = 'provider';
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    (error: Error) => {
      assert.match(error.message, /provider request failed for p\/weak/);
      assert.doesNotMatch(error.message, /private-endpoint|secret-token/);
      return true;
    },
  );
  mode = 'limit';
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    (error: Error) => {
      assert.match(error.message, /output exceeds 65536 UTF-8 bytes/);
      assert.doesNotMatch(error.message, /secret|internal limit detail/);
      return true;
    },
  );
  mode = 'hostile-error';
  await assert.rejects(
    runtime.query({ prompt: 'x', model: 'weak' }),
    (error: Error) => {
      assert.match(error.message, /provider request failed for p\/weak/);
      assert.doesNotMatch(error.message, /getter-secret/);
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
  mode = 'wrong-surface';
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
