import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import { createLlmRoleClients, type LLM } from '../src/llm/llm.js';
import { completeStandaloneForRole } from '../src/index.js';
import { createLlmModelRegistry } from '../src/llm/model-registry.js';
import { makeConfig } from './helpers.js';

function roleConfig(): Config {
  const config = makeConfig();
  const provider = {
    providerType: 'openai-compatible' as const,
    apiKey: 'stub',
    baseUrl: 'https://example.test/v1',
    api: 'responses' as const,
    externalThinking: false,
    streamIdleTimeoutMs: 1_000,
    callTimeoutMs: 2_000,
    models: {
      main: { name: 'wire-main', contextSize: 100_000, reasoningEffort: 'high', reasoningSummary: null, reasoningContext: null },
      classifier: { name: 'wire-classifier', contextSize: 20_000, reasoningEffort: 'low', reasoningSummary: null, reasoningContext: null },
      motor: { name: 'wire-motor', contextSize: 30_000, reasoningEffort: 'medium', reasoningSummary: null, reasoningContext: null },
    },
  };
  config.llm.registry = createLlmModelRegistry({
    providers: { p: provider },
    roles: { main: 'p/main', classifier: 'p/classifier', motor: 'p/motor' },
  });
  config.llm.registrySource = 'canonical';
  return config;
}

function fakeLlm(model: string): LLM {
  return {
    model,
    runTool: { type: 'function', function: { name: 'run', description: '', parameters: { type: 'object' } } },
    async complete() { throw new Error('not called'); },
    async summarize() { throw new Error('not called'); },
  };
}

test('role clients are independently constructed from resolved role targets', () => {
  const calls: Array<{ model: string; hub: unknown }> = [];
  const hub = {} as never;
  const clients = createLlmRoleClients(roleConfig(), {
    hub,
    motorActive: true,
    create(config, passedHub) {
      calls.push({ model: config.llm.model, hub: passedHub });
      return fakeLlm(config.llm.model);
    },
  });
  assert.deepEqual(calls.map((call) => call.model), ['wire-main', 'wire-classifier', 'wire-motor']);
  assert.equal(calls[0].hub, hub);
  assert.equal(calls[1].hub, undefined);
  assert.equal(calls[2].hub, undefined);
  assert.notEqual(clients.main, clients.classifier);
  assert.notEqual(clients.main, clients.motor);
});

test('inactive motor is not resolved or constructed', () => {
  const config = roleConfig();
  config.llm.registry = createLlmModelRegistry({
    providers: config.llm.registry.providers,
    roles: { main: 'p/main', classifier: 'p/classifier', motor: null },
  });
  const models: string[] = [];
  const clients = createLlmRoleClients(config, {
    motorActive: false,
    create(projected) {
      models.push(projected.llm.model);
      return fakeLlm(projected.llm.model);
    },
  });
  assert.deepEqual(models, ['wire-main', 'wire-classifier']);
  assert.equal(clients.motor, null);
});
test('standalone role dispatch never sends motor work through classifier', async () => {
  const calls: string[] = [];
  const result = {
    content: '',
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    toolCalls: [{ id: 'motor-call', type: 'function' as const, function: { name: 'click', arguments: '{"element":"safe","x":1,"y":1}' } }],
    model: 'motor-model', providerType: 'openai-compatible' as const,
    apiSurface: 'chat-completions' as const, apiEndpoint: 'http://motor/v1/chat/completions',
  };
  const classifier = fakeLlm('classifier');
  classifier.completeStandalone = async () => { calls.push('classifier'); throw new Error('classifier must not receive motor tools'); };
  const motor = fakeLlm('motor');
  motor.completeStandalone = async () => { calls.push('motor'); return result; };
  const llms = { main: fakeLlm('main'), classifier, motor };

  assert.equal(await completeStandaloneForRole(llms, 'motor', [{ role: 'user', content: 'move' }]), result);
  assert.deepEqual(calls, ['motor']);
});
