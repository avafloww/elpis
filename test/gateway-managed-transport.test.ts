import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_HEADERS,
  LLM_PROXY_PATHS,
  createNodeCredential,
  decodeLlmProxyRequest,
  encodeLlmResponseProvenance,
  serializeLlmProxyCatalog,
  type LlmProxyCatalogModel,
  type LlmProxyRequest,
  type LlmProxyTransportMetadata,
} from '@elpis/gateway-protocol';
import {
  configForLlmRef,
  configForLlmRole,
  isResolvedGatewayConfig,
  type ParsedConfig,
} from '../src/config.js';
import type {
  GatewayLlmFetch,
  GatewayLlmResidentStore,
} from '../src/llm/gateway-client.js';
import * as managedModule from '../src/llm/gateway-managed-config.js';
import {
  createGatewayManagedTransport,
  materializeGatewayConfig,
  type ResolvedGatewayConfig,
} from '../src/llm/gateway-managed-config.js';
import {
  createGatewayOpenAIClientTransport,
  GATEWAY_OPENAI_SDK_API_KEY,
} from '../src/llm/gateway-openai-transport.js';
import { createLLM } from '../src/llm/llm.js';
import { TOOL_CONTRACT_VERSION } from '../src/llm/tool-contract.js';
import { makeConfig } from './helpers.js';

type ScopedGatewayTransport = Readonly<{
  providerType: LlmProxyCatalogModel['providerType'];
  model: string;
  apiSurface:
    'responses' | 'chat-completions' | 'anthropic-messages' | 'codex-responses';
  dispatch(
    payload: Uint8Array,
    transport: LlmProxyTransportMetadata,
    signal?: AbortSignal,
  ): Promise<Response>;
}>;

type ManagedTransportModule = typeof managedModule & {
  createGatewayManagedTransport?: (
    config: ResolvedGatewayConfig,
  ) => ScopedGatewayTransport;
};

const gatewayAuthority = 'https://gateway.example.com';
const credential = createNodeCredential((size) => Buffer.alloc(size, 1));
const roles = {
  main: 'aster/main',
  classifier: 'aster/classifier',
  motor: null,
  secretary: null,
  compaction: null,
};

function model(
  modelRef: string,
  route: 'responses' | 'chat/completions',
): LlmProxyCatalogModel {
  return {
    modelRef,
    targetGeneration:
      route === 'responses'
        ? 'egt1.AAAAAAAAAAAAAAAAAAAAAA'
        : 'egt1.AQEBAQEBAQEBAQEBAQEBAQ',
    providerType: 'openai-compatible',
    model: 'upstream-' + modelRef.split('/')[1],
    allowedRoutes: [route],
    contextSize: 128_000,
    reasoningEffort: 'high',
    reasoningSummary: 'detailed',
    reasoningContext: 'preserved',
    toolTier: null,
    externalThinking: false,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    callTimeoutMs: 30_000,
    streamIdleTimeoutMs: 10_000,
  };
}

const anthropicModel: LlmProxyCatalogModel = {
  ...model('claude/main', 'responses'),
  targetGeneration: 'egt1.AgICAgICAgICAgICAgICAg',
  providerType: 'anthropic-oauth',
  model: 'claude-fixture',
  allowedRoutes: ['messages'],
  contextSize: 200_000,
  reasoningEffort: null,
  reasoningSummary: null,
  reasoningContext: null,
};

const codexModel: LlmProxyCatalogModel = {
  ...model('codex/main', 'responses'),
  targetGeneration: 'egt1.AwMDAwMDAwMDAwMDAwMDAw',
  providerType: 'codex-oauth',
  model: 'gpt-5.6-fixture',
  allowedRoutes: ['codex/responses'],
  externalThinking: true,
};

const catalogModels = [
  model('aster/main', 'responses'),
  model('aster/classifier', 'chat/completions'),
  anthropicModel,
  codexModel,
];

function pendingConfig(): ParsedConfig {
  const direct = makeConfig();
  const local = direct.dashboard.local;
  return {
    ...direct,
    llm: {
      registrySource: 'gateway',
      gatewayManaged: true,
      materialization: 'pending',
      registry: null,
      completionReserveTokens: 4096,
      roles,
    },
    dashboard: {
      local,
      remote: { url: gatewayAuthority, enrollmentToken: null },
    },
    console: local,
  };
}

function store(): GatewayLlmResidentStore {
  return {
    read: () => ({
      instanceId: 'egi1.AAAAAAAAAAAAAAAAAAAAAA',
      phase: 'active',
      endpoint: gatewayAuthority,
      displayName: 'Aster Gateway',
      requestId: null,
      activeCredentialId: credential.id,
      pendingCredentialId: null,
      createdAt: 1,
      updatedAt: 1,
      enrollmentStartedAt: 1,
      activatedAt: 1,
      rotationStartedAt: null,
      rotationProposedAt: null,
    }),
    activeNodeToken: () => credential.token,
  };
}

function gatewayFetch(
  requests: LlmProxyRequest[],
  respond?: (
    request: LlmProxyRequest,
    init: Parameters<GatewayLlmFetch>[1],
  ) => Response | Promise<Response>,
): GatewayLlmFetch {
  const catalogWire = serializeLlmProxyCatalog({
    format: LLM_PROXY_FORMATS.catalog,
    revision: 7,
    models: [...catalogModels].sort((a, b) =>
      a.modelRef.localeCompare(b.modelRef),
    ),
  });
  return async (input, init) => {
    if (input === gatewayAuthority + LLM_PROXY_PATHS.catalog) {
      return new Response(catalogWire, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    assert.equal(input, gatewayAuthority + LLM_PROXY_PATHS.request);
    const request = decodeLlmProxyRequest(init.body as string);
    requests.push(request);
    if (respond) return respond(request, init);
    return new Response('provider-response', {
      status: 200,
      headers: {
        [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
          format: LLM_PROXY_FORMATS.responseProvenance,
          requestId: request.requestId,
          modelRef: request.modelRef,
          targetGeneration: request.targetGeneration,
          route: request.route,
          status: 200,
          headers: [{ name: 'content-type', value: 'text/plain' }],
        }),
      },
    });
  };
}

function transportFactory() {
  const create = (managedModule as ManagedTransportModule)
    .createGatewayManagedTransport;
  assert.equal(
    typeof create,
    'function',
    'implement createGatewayManagedTransport on the managed materializer module',
  );
  return create;
}

function forbiddenDatabaseAccess(): {
  db: NonNullable<Parameters<typeof createLLM>[2]>;
  count: () => number;
} {
  let accesses = 0;
  const db = new Proxy(
    {},
    {
      get() {
        accesses += 1;
        throw new Error('managed provider accessed the local OAuth database');
      },
    },
  ) as NonNullable<Parameters<typeof createLLM>[2]>;
  return { db, count: () => accesses };
}

test('materialization binds one target-scoped transport to every authentic projection', async () => {
  const requests: LlmProxyRequest[] = [];
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(requests),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');

  const createTransport = transportFactory();
  const main = createTransport(resolved);
  assert.equal(Object.isFrozen(main), true);
  assert.deepEqual(
    {
      providerType: main.providerType,
      model: main.model,
      apiSurface: main.apiSurface,
    },
    {
      providerType: 'openai-compatible',
      model: 'upstream-main',
      apiSurface: 'responses',
    },
  );

  await assert.rejects(
    main.dispatch(Buffer.from('{"model":"upstream-main"}'), {
      kind: 'codex',
      sessionId: 'must-not-widen-ordinary-target',
    }),
    /provider transport has unexpected config keys or symbols/,
  );
  assert.equal(requests.length, 0);

  const mainPayload = Buffer.from('{"model":"upstream-main","input":"hello"}');
  const mainResponse = await main.dispatch(mainPayload, { kind: 'none' });
  assert.equal(await mainResponse.text(), 'provider-response');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].modelRef, 'aster/main');
  assert.equal(requests[0].route, 'responses');
  assert.deepEqual(requests[0].transport, { kind: 'none' });
  assert.deepEqual(Buffer.from(requests[0].payload), mainPayload);

  const classifierConfig = configForLlmRole(resolved, 'classifier');
  assert.strictEqual(classifierConfig.llm.registry, resolved.llm.registry);
  const classifier = createTransport(classifierConfig);
  assert.equal(classifier.model, 'upstream-classifier');
  assert.equal(classifier.apiSurface, 'chat-completions');
  await classifier.dispatch(Buffer.from('{"model":"upstream-classifier"}'), {
    kind: 'none',
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].modelRef, 'aster/classifier');
  assert.equal(requests[1].route, 'chat/completions');
});

test('lookalike managed registries fail before transport activity', async () => {
  const requests: LlmProxyRequest[] = [];
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(requests),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const createTransport = transportFactory();
  const copiedRegistry = Object.freeze({ ...resolved.llm.registry });
  const copied = {
    ...resolved,
    llm: Object.freeze({ ...resolved.llm, registry: copiedRegistry }),
  } as ResolvedGatewayConfig;

  assert.throws(() => createTransport(copied), Error);
  assert.equal(requests.length, 0);
});

test('managed OpenAI Responses keeps resident shaping and dispatches once through Gateway', async () => {
  const requests: LlmProxyRequest[] = [];
  const completed = {
    type: 'response.completed',
    response: {
      id: 'resp-managed',
      status: 'completed',
      output: [
        {
          id: 'msg-managed',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'managed reply',
              annotations: [],
            },
          ],
        },
      ],
      usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
    },
  };
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(
      requests,
      (request) =>
        new Response(
          `event: response.completed\ndata: ${JSON.stringify(completed)}\n\n`,
          {
            status: 200,
            headers: {
              [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
                format: LLM_PROXY_FORMATS.responseProvenance,
                requestId: request.requestId,
                modelRef: request.modelRef,
                targetGeneration: request.targetGeneration,
                route: request.route,
                status: 200,
                headers: [
                  { name: 'content-type', value: 'text/event-stream' },
                  { name: 'x-request-id', value: 'req-managed' },
                ],
              }),
            },
          },
        ),
    ),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');

  const nativeFetch = globalThis.fetch;
  let forbiddenFetches = 0;
  globalThis.fetch = (async () => {
    forbiddenFetches += 1;
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    const llm = createLLM(resolved);
    assert.equal(llm.client, undefined);
    const result = await llm.complete([
      { role: 'system', content: 'system fixture' },
      { role: 'user', content: 'hello from fixture' },
    ]);
    assert.equal(result.message.content, 'managed reply');
    assert.deepEqual(result.usage, {
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
    assert.equal(forbiddenFetches, 0);
    assert.equal(requests.length, 1);
    const wire = requests[0];
    assert.equal(wire.modelRef, 'aster/main');
    assert.equal(wire.route, 'responses');
    assert.deepEqual(wire.transport, { kind: 'none' });
    const body = JSON.parse(
      Buffer.from(wire.payload).toString('utf8'),
    ) as Record<string, unknown>;
    assert.equal(body.model, 'upstream-main');
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.equal(Array.isArray(body.input), true);
    assert.equal(Array.isArray(body.tools), true);
    assert.doesNotMatch(
      Buffer.from(wire.payload).toString('utf8'),
      /synthetic-provider-key|elpis-transport-owned|authorization/i,
    );
    assert.deepEqual(
      {
        providerType: result.message.provenance?.providerType,
        model: result.message.provenance?.model,
        apiSurface: result.message.provenance?.apiSurface,
        apiEndpoint: result.message.provenance?.apiEndpoint,
        gateway: result.message.provenance?.gateway,
        toolContractVersion: result.message.provenance?.toolContractVersion,
        requestId: result.message.provenance?.requestId,
      },
      {
        providerType: 'openai-compatible',
        model: 'upstream-main',
        apiSurface: 'responses',
        apiEndpoint: gatewayAuthority + LLM_PROXY_PATHS.request,
        gateway: {
          authority: gatewayAuthority + '/',
          modelRef: 'aster/main',
          targetGeneration: 'egt1.AAAAAAAAAAAAAAAAAAAAAA',
        },
        toolContractVersion: TOOL_CONTRACT_VERSION,
        requestId: 'req-managed',
      },
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed OpenAI Chat uses its exact projection without Responses fallback', async () => {
  const requests: LlmProxyRequest[] = [];
  const chatStream =
    'data: ' +
    JSON.stringify({
      id: 'chat-managed',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'upstream-classifier',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          delta: { content: 'managed chat reply' },
        },
      ],
    }) +
    '\n\ndata: ' +
    JSON.stringify({
      id: 'chat-managed',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'upstream-classifier',
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
    }) +
    '\n\ndata: [DONE]\n\n';
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(
      requests,
      (request) =>
        new Response(chatStream, {
          status: 200,
          headers: {
            [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
              format: LLM_PROXY_FORMATS.responseProvenance,
              requestId: request.requestId,
              modelRef: request.modelRef,
              targetGeneration: request.targetGeneration,
              route: request.route,
              status: 200,
              headers: [
                { name: 'content-type', value: 'text/event-stream' },
                { name: 'x-request-id', value: 'req-managed-chat' },
              ],
            }),
          },
        }),
    ),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const classifier = configForLlmRole(resolved, 'classifier');

  const nativeFetch = globalThis.fetch;
  let forbiddenFetches = 0;
  globalThis.fetch = (async () => {
    forbiddenFetches += 1;
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    const llm = createLLM(classifier);
    const result = await llm.complete([
      { role: 'system', content: 'system fixture' },
      { role: 'user', content: 'classify fixture' },
    ]);
    assert.equal(result.message.content, 'managed chat reply');
    assert.deepEqual(result.usage, {
      prompt_tokens: 4,
      completion_tokens: 3,
      total_tokens: 7,
      cached_tokens: undefined,
    });
    assert.equal(forbiddenFetches, 0);
    assert.equal(requests.length, 1);
    const wire = requests[0];
    assert.equal(wire.modelRef, 'aster/classifier');
    assert.equal(wire.route, 'chat/completions');
    assert.deepEqual(wire.transport, { kind: 'none' });
    const body = JSON.parse(
      Buffer.from(wire.payload).toString('utf8'),
    ) as Record<string, unknown>;
    assert.equal(body.model, 'upstream-classifier');
    assert.equal(body.stream, true);
    assert.equal(Array.isArray(body.messages), true);
    assert.equal(Array.isArray(body.tools), true);
    assert.deepEqual(
      {
        providerType: result.message.provenance?.providerType,
        model: result.message.provenance?.model,
        apiSurface: result.message.provenance?.apiSurface,
        apiEndpoint: result.message.provenance?.apiEndpoint,
        gateway: result.message.provenance?.gateway,
        toolContractVersion: result.message.provenance?.toolContractVersion,
        requestId: result.message.provenance?.requestId,
      },
      {
        providerType: 'openai-compatible',
        model: 'upstream-classifier',
        apiSurface: 'chat-completions',
        apiEndpoint: gatewayAuthority + LLM_PROXY_PATHS.request,
        gateway: {
          authority: gatewayAuthority + '/',
          modelRef: 'aster/classifier',
          targetGeneration: 'egt1.AQEBAQEBAQEBAQEBAQEBAQ',
        },
        toolContractVersion: TOOL_CONTRACT_VERSION,
        requestId: 'req-managed-chat',
      },
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed Anthropic keeps resident Messages shaping without local OAuth', async () => {
  const requests: LlmProxyRequest[] = [];
  const anthropicStream = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'managed anthropic reply' },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(
      requests,
      (request) =>
        new Response(anthropicStream, {
          status: 200,
          headers: {
            [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
              format: LLM_PROXY_FORMATS.responseProvenance,
              requestId: request.requestId,
              modelRef: request.modelRef,
              targetGeneration: request.targetGeneration,
              route: request.route,
              status: 200,
              headers: [
                { name: 'content-type', value: 'text/event-stream' },
                { name: 'x-request-id', value: 'req-managed-anthropic' },
              ],
            }),
          },
        }),
    ),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const anthropic = configForLlmRef(resolved, 'claude/main');
  const forbiddenDb = forbiddenDatabaseAccess();

  const nativeFetch = globalThis.fetch;
  let forbiddenFetches = 0;
  globalThis.fetch = (async () => {
    forbiddenFetches += 1;
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    const llm = createLLM(anthropic, undefined, forbiddenDb.db);
    const result = await llm.complete([
      { role: 'system', content: 'system fixture' },
      { role: 'user', content: 'hello anthropic' },
    ]);
    assert.equal(result.message.content, 'managed anthropic reply');
    assert.deepEqual(result.usage, {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
      cached_tokens: undefined,
    });
    assert.equal(forbiddenFetches, 0);
    assert.equal(forbiddenDb.count(), 0);
    assert.equal(requests.length, 1);
    const wire = requests[0];
    assert.equal(wire.modelRef, 'claude/main');
    assert.equal(wire.route, 'messages');
    assert.deepEqual(wire.transport, { kind: 'none' });
    const body = JSON.parse(
      Buffer.from(wire.payload).toString('utf8'),
    ) as Record<string, unknown>;
    assert.equal(body.model, 'claude-fixture');
    assert.equal(body.stream, true);
    assert.equal(Array.isArray(body.messages), true);
    assert.equal(Array.isArray(body.system), true);
    assert.equal(Array.isArray(body.tools), true);
    assert.deepEqual(
      {
        providerType: result.message.provenance?.providerType,
        model: result.message.provenance?.model,
        apiSurface: result.message.provenance?.apiSurface,
        apiEndpoint: result.message.provenance?.apiEndpoint,
        gateway: result.message.provenance?.gateway,
        toolContractVersion: result.message.provenance?.toolContractVersion,
        requestId: result.message.provenance?.requestId,
      },
      {
        providerType: 'anthropic-oauth',
        model: 'claude-fixture',
        apiSurface: 'anthropic-messages',
        apiEndpoint: gatewayAuthority + LLM_PROXY_PATHS.request,
        gateway: {
          authority: gatewayAuthority + '/',
          modelRef: 'claude/main',
          targetGeneration: 'egt1.AgICAgICAgICAgICAgICAg',
        },
        toolContractVersion: TOOL_CONTRACT_VERSION,
        requestId: 'req-managed-anthropic',
      },
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed Codex keeps Lite shaping and exact main and standalone sessions', async () => {
  const requests: LlmProxyRequest[] = [];
  let responseIndex = 0;
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(requests, (request) => {
      const index = ++responseIndex;
      const text =
        index === 1 ? 'managed codex reply' : 'standalone codex reply';
      const responseId = `req-managed-codex-${index}`;
      const stream =
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
        `data: ${JSON.stringify({
          type: 'response.completed',
          response: {
            id: responseId,
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text }],
              },
            ],
            usage: { input_tokens: 6, output_tokens: 2, total_tokens: 8 },
          },
        })}\n\n` +
        'data: [DONE]\n\n';
      return new Response(stream, {
        status: 200,
        headers: {
          [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
            format: LLM_PROXY_FORMATS.responseProvenance,
            requestId: request.requestId,
            modelRef: request.modelRef,
            targetGeneration: request.targetGeneration,
            route: request.route,
            status: 200,
            headers: [
              { name: 'content-type', value: 'text/event-stream' },
              { name: 'x-request-id', value: responseId },
            ],
          }),
        },
      });
    }),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const codex = configForLlmRef(resolved, 'codex/main');
  const forbiddenDb = forbiddenDatabaseAccess();

  const nativeFetch = globalThis.fetch;
  let forbiddenFetches = 0;
  globalThis.fetch = (async () => {
    forbiddenFetches += 1;
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    const llm = createLLM(codex, undefined, forbiddenDb.db);
    assert.equal(llm.client, undefined);
    const result = await llm.complete([
      { role: 'system', content: 'system fixture' },
      { role: 'user', content: 'hello codex' },
    ]);
    assert.equal(result.message.content, 'managed codex reply');
    const standalone = await llm.completeStandalone!(
      [{ role: 'user', content: 'standalone fixture' }],
      { cacheKey: 'standalone-lane-fixture' },
    );
    assert.equal(standalone.content, 'standalone codex reply');
    assert.equal(forbiddenFetches, 0);
    assert.equal(forbiddenDb.count(), 0);
    assert.equal(requests.length, 2);
    for (const [index, wire] of requests.entries()) {
      assert.equal(wire.modelRef, 'codex/main');
      assert.equal(wire.route, 'codex/responses');
      assert.equal(wire.transport.kind, 'codex');
      const body = JSON.parse(
        Buffer.from(wire.payload).toString('utf8'),
      ) as Record<string, unknown>;
      assert.equal(body.model, 'gpt-5.6-fixture');
      assert.equal(body.stream, true);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal('tools' in body, false);
      const input = body.input as Array<Record<string, unknown>>;
      if (index === 0) assert.equal(input[0]?.type, 'additional_tools');
      else assert.equal(input[0]?.role, 'user');
      assert.equal(
        body.prompt_cache_key,
        wire.transport.kind === 'codex' ? wire.transport.sessionId : null,
      );
    }
    assert.notEqual(
      requests[0].transport.kind === 'codex'
        ? requests[0].transport.sessionId
        : null,
      'standalone-lane-fixture',
    );
    assert.deepEqual(requests[1].transport, {
      kind: 'codex',
      sessionId: 'standalone-lane-fixture',
    });
    assert.deepEqual(
      {
        providerType: result.message.provenance?.providerType,
        model: result.message.provenance?.model,
        apiSurface: result.message.provenance?.apiSurface,
        apiEndpoint: result.message.provenance?.apiEndpoint,
        gateway: result.message.provenance?.gateway,
        toolContractVersion: result.message.provenance?.toolContractVersion,
        requestId: result.message.provenance?.requestId,
      },
      {
        providerType: 'codex-oauth',
        model: 'gpt-5.6-fixture',
        apiSurface: 'codex-responses',
        apiEndpoint: gatewayAuthority + LLM_PROXY_PATHS.request,
        gateway: {
          authority: gatewayAuthority + '/',
          modelRef: 'codex/main',
          targetGeneration: 'egt1.AwMDAwMDAwMDAwMDAwMDAw',
        },
        toolContractVersion: TOOL_CONTRACT_VERSION,
        requestId: 'req-managed-codex-1',
      },
    );
    assert.deepEqual(
      {
        providerType: standalone.providerType,
        model: standalone.model,
        apiSurface: standalone.apiSurface,
        apiEndpoint: standalone.apiEndpoint,
        gateway: standalone.gateway,
        toolContractVersion: standalone.toolContractVersion,
        requestId: standalone.requestId,
      },
      {
        providerType: 'codex-oauth',
        model: 'gpt-5.6-fixture',
        apiSurface: 'codex-responses',
        apiEndpoint: gatewayAuthority + LLM_PROXY_PATHS.request,
        gateway: {
          authority: gatewayAuthority + '/',
          modelRef: 'codex/main',
          targetGeneration: 'egt1.AwMDAwMDAwMDAwMDAwMDAw',
        },
        toolContractVersion: TOOL_CONTRACT_VERSION,
        requestId: 'req-managed-codex-2',
      },
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed provider failures dispatch exactly once without retry or fallback', async () => {
  const requests: LlmProxyRequest[] = [];
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(
      requests,
      (request) =>
        new Response('{"error":{"message":"synthetic upstream failure"}}', {
          status: 503,
          headers: {
            [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
              format: LLM_PROXY_FORMATS.responseProvenance,
              requestId: request.requestId,
              modelRef: request.modelRef,
              targetGeneration: request.targetGeneration,
              route: request.route,
              status: 503,
              headers: [
                { name: 'content-type', value: 'application/json' },
                { name: 'x-request-id', value: 'req-managed-failure' },
              ],
            }),
          },
        }),
    ),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const cases = [
    { ref: 'aster/main', route: 'responses' },
    { ref: 'aster/classifier', route: 'chat/completions' },
    { ref: 'claude/main', route: 'messages' },
    { ref: 'codex/main', route: 'codex/responses' },
  ] as const;
  const nativeFetch = globalThis.fetch;
  let forbiddenFetches = 0;
  globalThis.fetch = (async () => {
    forbiddenFetches += 1;
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    for (const providerCase of cases) {
      const before = requests.length;
      const llm = createLLM(configForLlmRef(resolved, providerCase.ref));
      await assert.rejects(
        () =>
          llm.complete([
            { role: 'system', content: 'failure fixture' },
            { role: 'user', content: 'fail once' },
          ]),
        /503|synthetic upstream failure/,
      );
      assert.equal(requests.length, before + 1);
      assert.equal(requests[before].route, providerCase.route);
      assert.equal(requests[before].modelRef, providerCase.ref);
    }
    assert.equal(forbiddenFetches, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed Responses does not fall back when the selected surface is unsupported', async () => {
  const requests: LlmProxyRequest[] = [];
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(
      requests,
      (request) =>
        new Response('{"error":{"message":"responses unsupported"}}', {
          status: 404,
          headers: {
            [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
              format: LLM_PROXY_FORMATS.responseProvenance,
              requestId: request.requestId,
              modelRef: request.modelRef,
              targetGeneration: request.targetGeneration,
              route: request.route,
              status: 404,
              headers: [{ name: 'content-type', value: 'application/json' }],
            }),
          },
        }),
    ),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const nativeFetch = globalThis.fetch;
  let forbiddenFetches = 0;
  globalThis.fetch = (async () => {
    forbiddenFetches += 1;
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        createLLM(resolved).complete([
          { role: 'system', content: 'fallback fixture' },
          { role: 'user', content: 'do not change surfaces' },
        ]),
      /404|responses unsupported/,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].route, 'responses');
    assert.equal(requests[0].modelRef, 'aster/main');
    assert.equal(forbiddenFetches, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed Anthropic and Codex authentication failures never read local OAuth', async () => {
  const requests: LlmProxyRequest[] = [];
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(
      requests,
      (request) =>
        new Response('{"error":{"message":"synthetic unauthorized"}}', {
          status: 401,
          headers: {
            [LLM_PROXY_HEADERS.provenance]: encodeLlmResponseProvenance({
              format: LLM_PROXY_FORMATS.responseProvenance,
              requestId: request.requestId,
              modelRef: request.modelRef,
              targetGeneration: request.targetGeneration,
              route: request.route,
              status: 401,
              headers: [{ name: 'content-type', value: 'application/json' }],
            }),
          },
        }),
    ),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const nativeFetch = globalThis.fetch;
  const forbiddenDb = forbiddenDatabaseAccess();
  let forbiddenFetches = 0;
  globalThis.fetch = (async () => {
    forbiddenFetches += 1;
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    for (const providerCase of [
      { ref: 'claude/main', route: 'messages' },
      { ref: 'codex/main', route: 'codex/responses' },
    ] as const) {
      const before = requests.length;
      const llm = createLLM(
        configForLlmRef(resolved, providerCase.ref),
        undefined,
        forbiddenDb.db,
      );
      await assert.rejects(
        () =>
          llm.complete([
            { role: 'system', content: 'authentication fixture' },
            { role: 'user', content: 'fail once' },
          ]),
        /401|unauthorized/i,
      );
      assert.equal(requests.length, before + 1);
      assert.equal(requests[before].route, providerCase.route);
    }
    assert.equal(forbiddenDb.count(), 0);
    assert.equal(forbiddenFetches, 0);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed SDK abort propagates into the single Gateway dispatch', async () => {
  const requests: LlmProxyRequest[] = [];
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let passedSignal: AbortSignal | undefined;
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(requests, (_request, init) => {
      passedSignal = init.signal;
      started();
      return new Promise<Response>((_resolve, reject) => {
        if (init.signal?.aborted) reject(init.signal.reason);
        else
          init.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          );
      });
    }),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('managed provider must not use global/direct fetch');
  }) as typeof fetch;
  try {
    const controller = new AbortController();
    const pending = createLLM(resolved).complete(
      [
        { role: 'system', content: 'abort fixture' },
        { role: 'user', content: 'wait for abort' },
      ],
      { signal: controller.signal },
    );
    await entered;
    const reason = new DOMException('managed fixture abort', 'AbortError');
    controller.abort(reason);
    await assert.rejects(pending);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].route, 'responses');
    assert.equal(passedSignal?.aborted, true);
    assert.equal(passedSignal?.reason?.name, reason.name);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('managed SDK bridge rejects a mismatched body model before Gateway dispatch', async () => {
  const requests: LlmProxyRequest[] = [];
  const resolved = await materializeGatewayConfig(pendingConfig(), {
    store: store(),
    fetch: gatewayFetch(requests),
  });
  assert.equal(isResolvedGatewayConfig(resolved), true);
  if (!isResolvedGatewayConfig(resolved))
    throw new Error('expected managed config');
  const transport = createGatewayManagedTransport(resolved);
  const bridge = createGatewayOpenAIClientTransport(transport);
  await assert.rejects(
    () =>
      bridge.fetch(`${bridge.baseURL}/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${GATEWAY_OPENAI_SDK_API_KEY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'different-model', stream: true }),
      }),
    /model.*authorized|authorized.*model/i,
  );
  assert.equal(requests.length, 0);
});
