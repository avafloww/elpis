// Unit tests for the authenticated ChatGPT Codex transport boundary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { OAuthStore } from '../src/llm/oauth/store.js';
import {
  buildCodexStandaloneRequest,
  codexStandaloneComplete,
  createCodexFetch,
  createCodexOAuthLLM,
  fetchCodexContextWindow,
  sanitizeCodexMessagesForReplay,
  shapeCodexResponsesLiteRequest,
  usesCodexResponsesLite,
} from '../src/llm/codex-client.js';
import type { Config } from '../src/config.js';
import { noopLogger } from '../src/lib/log.js';
import { SKILL_TOOL, SOCIAL_SUMMARIZE_PROMPT } from '../src/llm/llm.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

function codexConfig(model = 'gpt-test-codex'): Config {
  // These transport tests exercise only llm + compaction fields. Keep the
  // remaining Config surface behind the cast so the fixture does not import
  // helpers.ts (which opens node:sqlite transitively under the real test run).
  return {
    llm: {
      providerType: 'codex-oauth',
      apiKey: '',
      baseUrl: 'https://chatgpt.com/backend-api',
      model,
      contextSize: null,
      reasoningEffort: 'high',
      externalThinking: false,
      api: 'responses',
      reasoningSummary: null,
      reasoningContext: null,
      completionReserveTokens: 8192,
      streamIdleTimeoutMs: 30_000,
      callTimeoutMs: 120_000,
    },
    compaction: { triggerTokens: 180000, keepTokens: 50000 },
    logger: noopLogger,
  } as Config;
}

function fakeStore() {
  let token = 'access-1';
  let refreshes = 0;
  const store = {
    location: 'fake oauth store',
    read: () => ({
      access: token,
      refresh: 'r',
      expires: Date.now() + 60_000,
      accountId: 'acct-1',
    }),
    getAccessToken: async () => token,
    forceRefresh: async () => {
      refreshes++;
      token = 'access-2';
    },
  } as unknown as OAuthStore;
  return { store, refreshes: () => refreshes };
}

test('Codex fetch injects subscription headers and retries one 401 after refresh', async () => {
  const { store, refreshes } = fakeStore();
  const seen: Headers[] = [];
  const redirects: Array<RequestRedirect | undefined> = [];
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    redirects.push(init?.redirect);
    return new Response('', { status: seen.length === 1 ? 401 : 200 });
  }) as typeof fetch;
  const authenticated = createCodexFetch(
    store,
    () => 'session-1',
    fetchFn,
    true,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      headers: { 'x-api-key': 'must-disappear' },
      body: '{}',
    },
  );
  assert.equal(response.status, 200);
  assert.equal(refreshes(), 1);
  assert.equal(seen[0].get('authorization'), 'Bearer access-1');
  assert.equal(seen[1].get('authorization'), 'Bearer access-2');
  assert.equal(seen[1].get('chatgpt-account-id'), 'acct-1');
  assert.equal(seen[1].get('openai-beta'), 'responses=experimental');
  assert.equal(seen[1].get('x-openai-internal-codex-responses-lite'), 'true');
  assert.equal(seen[1].get('originator'), 'pi');
  assert.equal(seen[1].get('session_id'), 'session-1');
  assert.equal(seen[1].has('x-api-key'), false);
  assert.deepEqual(
    redirects,
    ['error', 'error'],
    'bearer requests must never follow redirects',
  );
});

test('Codex fetch refuses to expose the OAuth token to another host or path', async () => {
  const { store } = fakeStore();
  let networkCalls = 0;
  const authenticated = createCodexFetch(store, () => 's', (async () => {
    networkCalls++;
    return new Response();
  }) as typeof fetch);
  await assert.rejects(
    () => authenticated('https://example.com/backend-api/codex/responses'),
    /refusing/,
  );
  await assert.rejects(
    () => authenticated('https://chatgpt.com/evil'),
    /refusing/,
  );
  assert.equal(networkCalls, 0);
});

test('Codex model discovery uses authenticated primary route and reported window', async () => {
  const { store } = fakeStore();
  let requested = '';
  let headers = new Headers();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = input.toString();
    headers = new Headers(init?.headers);
    return new Response(
      JSON.stringify({
        models: [{ slug: 'gpt-test-codex', context_window: 300000 }],
      }),
    );
  }) as typeof fetch;
  const config = codexConfig();
  assert.equal(await fetchCodexContextWindow(config, store, fetchFn), 300000);
  assert.match(requested, /\/backend-api\/codex\/models\?client_version=/);
  assert.equal(headers.get('authorization'), 'Bearer access-1');
  assert.equal(headers.get('chatgpt-account-id'), 'acct-1');
});

test('Codex discovery uses the known 5.6 fallback when upstream omits context_window', async () => {
  const { store } = fakeStore();
  const fetchFn = (async () =>
    new Response(
      JSON.stringify({ data: [{ id: 'gpt-5.6-sol' }] }),
    )) as typeof fetch;
  const config = codexConfig('gpt-5.6-sol');
  assert.equal(await fetchCodexContextWindow(config, store, fetchFn), 372000);
});

test('Astra enables the Codex Responses Lite grammar', () => {
  assert.equal(usesCodexResponsesLite('gpt-6-astra'), true);
  assert.equal(usesCodexResponsesLite('gpt-6-astra-2026-09-04'), true);
  assert.equal(usesCodexResponsesLite('gpt-6-unknown'), false);
});

test('GPT-5.6 Codex uses Responses Lite request shaping', () => {
  assert.equal(usesCodexResponsesLite('gpt-5.6-sol'), true);
  assert.equal(usesCodexResponsesLite('gpt-5.6-terra'), true);
  assert.equal(usesCodexResponsesLite('gpt-5.3-codex'), false);
  const shaped = shapeCodexResponsesLiteRequest({
    model: 'gpt-5.6-sol',
    input: [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'hello' },
    ],
    tools: [{ type: 'function', name: 'run' }],
    reasoning: { effort: 'high' },
    tool_choice: 'required',
  });
  assert.equal('tools' in shaped, false);
  assert.equal(
    (shaped.input as Array<Record<string, unknown>>)[0].type,
    'additional_tools',
  );
  assert.equal(
    (shaped.input as Array<Record<string, unknown>>)[1].role,
    'developer',
  );
  assert.deepEqual(shaped.reasoning, { effort: 'high', context: 'all_turns' });
  assert.equal(shaped.tool_choice, 'required');

  const external = shapeCodexResponsesLiteRequest({
    model: 'gpt-5.6-sol',
    input: [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'hello' },
    ],
    tools: [
      { type: 'function', name: 'run' },
      { type: 'function', name: 'think' },
    ],
    reasoning: { effort: 'none' },
    tool_choice: { type: 'function', name: 'think' },
  });
  const toolItem = (external.input as Array<Record<string, unknown>>)[0];
  assert.deepEqual(
    (toolItem.tools as Array<Record<string, unknown>>).map((tool) => tool.name),
    ['run', 'think'],
  );
  assert.deepEqual(external.reasoning, {
    effort: 'none',
    context: 'all_turns',
  });
  assert.deepEqual(external.tool_choice, { type: 'function', name: 'think' });
});

async function captureOutboundSummary(
  model: string,
  foldText: string,
): Promise<Record<string, unknown>> {
  const { store } = fakeStore();
  const llm = createCodexOAuthLLM(codexConfig(model), store);
  let body: Record<string, unknown> | undefined;
  (llm.client!.responses as any).create = async (
    request: Record<string, unknown>,
  ) => {
    body = request;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'summary' }],
              },
            ],
          },
        };
      },
    };
  };
  assert.equal(await llm.summarize(foldText), 'summary');
  assert.ok(body);
  return body;
}

test('GPT-5.6 Lite summary emits developer/user input with no turn tools', async () => {
  const foldText = 'fold this conversation';
  const body = await captureOutboundSummary('gpt-5.6-sol', foldText);
  assert.equal('instructions' in body, false);
  assert.equal('tools' in body, false);
  assert.equal('additional_tools' in body, false);
  assert.equal('tool_choice' in body, false);
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.input, [
    { role: 'developer', content: SOCIAL_SUMMARIZE_PROMPT },
    { role: 'user', content: foldText },
  ]);
  assert.equal(
    (body.input as Array<Record<string, unknown>>).some(
      (item) => item.type === 'additional_tools',
    ),
    false,
  );
  assert.deepEqual(body.reasoning, { effort: 'high', context: 'all_turns' });
  assert.match(
    (body.input as Array<{ content: string }>)[0].content,
    /first person as a note to your future self/,
  );
});

test('non-Lite Codex summary uses the generalized standalone input grammar', async () => {
  const foldText = 'fold this older conversation';
  const body = await captureOutboundSummary('gpt-5.3-codex', foldText);
  assert.equal('instructions' in body, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body.input, [
    { role: 'system', content: SOCIAL_SUMMARIZE_PROMPT },
    { role: 'user', content: foldText },
  ]);
  assert.equal('tools' in body, false);
  assert.equal('additional_tools' in body, false);
  assert.equal('tool_choice' in body, false);
  assert.equal('parallel_tool_calls' in body, false);
  assert.deepEqual(body.reasoning, { effort: 'high' });
});

test('Lite standalone request carries image input without inheriting turn tools', () => {
  const body = buildCodexStandaloneRequest(
    codexConfig('gpt-5.6-sol'),
    [
      { role: 'system', content: 'Return one JSON action.' },
      {
        role: 'user',
        content: 'current frame',
        contentParts: [
          { type: 'text', text: 'current frame' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'low' },
          },
        ],
      },
    ],
    'motor-lane',
    true,
  ) as unknown as Record<string, unknown>;
  assert.equal(body.prompt_cache_key, 'motor-lane');
  assert.equal(body.parallel_tool_calls, false);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);
  const input = body.input as Array<Record<string, unknown>>;
  assert.equal(input[0].role, 'developer');
  const content = input[1].content as Array<Record<string, unknown>>;
  assert.deepEqual(content[0], { type: 'input_text', text: 'current frame' });
  assert.deepEqual(content[1], {
    type: 'input_image',
    image_url: 'data:image/png;base64,aGVsbG8=',
  });
  const replay = buildCodexStandaloneRequest(
    codexConfig('gpt-5.6-sol'),
    [
      {
        role: 'assistant',
        content: '{"keys":["Up"]}',
        reasoning_items: [
          {
            id: 'rs_old',
            type: 'reasoning',
            status: 'completed',
            summary: [],
            encrypted_content: 'old-opaque',
          },
        ],
      },
      { role: 'user', content: 'next frame' },
    ],
    'motor-lane',
    true,
  ) as unknown as Record<string, unknown>;
  const replayInput = replay.input as Array<Record<string, unknown>>;
  assert.deepEqual(replayInput[0], {
    type: 'reasoning',
    summary: [],
    encrypted_content: 'old-opaque',
  });
  assert.equal(replayInput[1].role, 'assistant');
  assert.equal(replayInput[2].role, 'user');
  assert.throws(
    () =>
      buildCodexStandaloneRequest(
        codexConfig(),
        [{ role: 'tool', content: 'no', tool_call_id: 'x' }],
        'lane',
        false,
      ),
    /does not accept tool messages/,
  );
});

test('standalone historical tool context is opt-in and balanced without exposing tools', () => {
  const messages = [
    { role: 'system', content: 'Choose a wake.' },
    {
      role: 'assistant',
      content: '',
      reasoning_items: [
        {
          id: 'rs_wait',
          type: 'reasoning',
          status: 'completed',
          summary: [],
          encrypted_content: 'opaque-wait',
        },
      ],
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'run', arguments: '{"detail":"check job"}' },
        },
      ],
    },
    { role: 'tool', content: '[run ok] still running', tool_call_id: 'call-1' },
    { role: 'user', content: 'Choose now.' },
  ] as any;
  assert.throws(
    () =>
      buildCodexStandaloneRequest(
        codexConfig('gpt-5.6-luna'),
        messages,
        'wake-lane',
        true,
      ),
    /does not accept tool messages/,
  );
  const body = buildCodexStandaloneRequest(
    codexConfig('gpt-5.6-luna'),
    messages,
    'wake-lane',
    true,
    {
      allowHistoricalToolMessages: true,
    } as any,
  ) as unknown as Record<string, unknown>;
  assert.equal('tools' in body, false);
  assert.equal('tool_choice' in body, false);
  assert.deepEqual(body.input, [
    { role: 'developer', content: 'Choose a wake.' },
    { type: 'reasoning', summary: [], encrypted_content: 'opaque-wait' },
    {
      type: 'function_call',
      call_id: 'call-1',
      name: 'run',
      arguments: '{"detail":"check job"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call-1',
      output: '[run ok] still running',
    },
    { role: 'user', content: 'Choose now.' },
  ]);
  assert.throws(
    () =>
      buildCodexStandaloneRequest(
        codexConfig(),
        [{ role: 'tool', content: 'orphan', tool_call_id: 'missing' }],
        'lane',
        false,
        { allowHistoricalToolMessages: true } as any,
      ),
    /orphan historical tool output/,
  );
  assert.throws(
    () =>
      buildCodexStandaloneRequest(
        codexConfig(),
        [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'pending',
                type: 'function',
                function: { name: 'run', arguments: '{}' },
              },
            ],
          },
        ],
        'lane',
        false,
        { allowHistoricalToolMessages: true } as any,
      ),
    /unresolved historical tool call/,
  );
});

test('completeStandalone uses its lane key for authenticated transport and request cache identity', async () => {
  const { store } = fakeStore();
  let headers = new Headers();
  let body: Record<string, unknown> | undefined;
  let transportSignal: AbortSignal | null | undefined;
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers = new Headers(init?.headers);
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    transportSignal = init?.signal;
    const events = [
      { type: 'response.output_text.delta', delta: '{"keys":["Up"]}' },
      {
        type: 'response.completed',
        response: {
          id: 'resp_motor',
          output: [
            {
              id: 'rs_motor',
              type: 'reasoning',
              status: 'completed',
              summary: [],
              encrypted_content: 'opaque-motor-state',
            },
            {
              type: 'message',
              content: [{ type: 'output_text', text: '{"keys":["Up"]}' }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
        },
      },
    ];
    const sse =
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      'data: [DONE]\n\n';
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  const llm = createCodexOAuthLLM(
    codexConfig('gpt-5.6-sol'),
    store,
    undefined,
    fetchFn,
  );
  const controller = new AbortController();
  const result = await llm.completeStandalone!(
    [{ role: 'user', content: 'choose one action' }],
    {
      cacheKey: 'motor-lane',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      maxTokens: 7,
      maxOutputBytes: 64,
      signal: controller.signal,
    },
  );
  assert.equal(headers.get('session_id'), 'motor-lane');
  assert.equal(headers.get('conversation_id'), 'motor-lane');
  assert.equal(headers.get('x-client-request-id'), 'motor-lane');
  assert.ok(transportSignal);
  controller.abort();
  assert.equal(
    transportSignal.aborted,
    false,
    'completed calls detach caller cancellation',
  );
  assert.equal(body?.prompt_cache_key, 'motor-lane');
  assert.equal(body?.model, 'gpt-5.6-luna');
  assert.deepEqual(body?.include, ['reasoning.encrypted_content']);
  assert.deepEqual(body?.reasoning, { effort: 'low', context: 'all_turns' });
  assert.equal('max_output_tokens' in (body ?? {}), false);
  assert.equal('tools' in (body ?? {}), false);
  assert.equal(result.content, '{"keys":["Up"]}');
  assert.deepEqual(result.usage, {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
  });
  assert.equal(result.requestId, 'resp_motor');
  assert.equal(result.model, 'gpt-5.6-luna');
  assert.equal(result.providerType, 'codex-oauth');
  assert.equal(result.reasoningEffort, 'low');
  assert.deepEqual(result.reasoningItems, [
    {
      id: 'rs_motor',
      type: 'reasoning',
      status: 'completed',
      summary: [],
      encrypted_content: 'opaque-motor-state',
    },
  ]);
  await assert.rejects(
    llm.completeStandalone!([{ role: 'user', content: 'wrong grammar' }], {
      model: 'gpt-5.3-codex',
    }),
    /different Codex wire grammar/,
  );
});

for (const phase of ['acquisition', 'stream']) {
  test(`Codex standalone bounds idle ${phase} even when the provider ignores abort`, async () => {
    const { store } = fakeStore();
    const config = codexConfig('gpt-6-astra');
    config.llm.streamIdleTimeoutMs = 20;
    const llm = createCodexOAuthLLM(config, store);
    let signal: AbortSignal | undefined;
    let closed = false;
    (llm.client!.responses as any).create = async (
      _body: unknown,
      opts: { signal: AbortSignal },
    ) => {
      signal = opts.signal;
      if (phase === 'acquisition') return new Promise(() => {});
      return {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise(() => {}),
            return: async () => {
              closed = true;
              return { done: true };
            },
          };
        },
      };
    };
    await assert.rejects(
      codexStandaloneComplete(
        llm.client!,
        config,
        [{ role: 'user', content: 'Summarize synthetic notes.' }],
        'test-lane',
        true,
      ),
      /standalone stream idle/,
    );
    assert.equal(signal?.aborted, true);
    assert.equal(closed, phase === 'stream');
  });
}

test('Codex standalone returns a terminal response without waiting for stream EOF', async () => {
  const { store } = fakeStore();
  const config = codexConfig('gpt-6-astra');
  config.llm.streamIdleTimeoutMs = 20;
  const llm = createCodexOAuthLLM(config, store);
  let closed = false;
  (llm.client!.responses as any).create = async () => ({
    [Symbol.asyncIterator]() {
      let sent = false;
      return {
        next: async () => {
          if (sent) return new Promise(() => {});
          sent = true;
          return {
            done: false,
            value: {
              type: 'response.completed',
              response: {
                output: [
                  {
                    type: 'message',
                    content: [
                      { type: 'output_text', text: 'Compact synthetic notes.' },
                    ],
                  },
                ],
              },
            },
          };
        },
        return: async () => {
          closed = true;
          return { done: true };
        },
      };
    },
  });
  const result = await codexStandaloneComplete(
    llm.client!,
    config,
    [{ role: 'user', content: 'Summarize.' }],
    'terminal-test',
    true,
  );
  assert.equal(result.content, 'Compact synthetic notes.');
  assert.equal(closed, true);
});

test('Codex standalone aborts before visible output exceeds its byte limit', async () => {
  const { store } = fakeStore();
  let signal: AbortSignal | null | undefined;
  const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal;
    const events = [
      { type: 'response.output_text.delta', delta: 'abcd' },
      { type: 'response.output_text.delta', delta: 'efgh' },
      { type: 'response.output_text.delta', delta: 'not-consumed' },
    ];
    const sse =
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
      'data: [DONE]\n\n';
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
  const llm = createCodexOAuthLLM(
    codexConfig('gpt-5.6-sol'),
    store,
    undefined,
    fetchFn,
  );
  await assert.rejects(
    llm.completeStandalone!([{ role: 'user', content: 'bounded' }], {
      cacheKey: 'bounded-lane',
      maxOutputBytes: 5,
    }),
    /standalone visible output exceeds 5 UTF-8 bytes/,
  );
  assert.equal(signal?.aborted, true);
});

test('Codex LLM defaults to required tools, permits auto, and rotates cache identity on reset', async () => {
  const { store } = fakeStore();
  const config = codexConfig('stub');
  const llm = createCodexOAuthLLM(config, store);
  const bodies: Array<Record<string, unknown>> = [];
  (llm.client!.responses as any).create = async (
    body: Record<string, unknown>,
  ) => {
    bodies.push(body);
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
          },
        };
      },
    };
  };
  await llm.complete([{ role: 'user', content: 'one' }], {
    skillTool: SKILL_TOOL,
  });
  const firstKey = bodies[0].prompt_cache_key;
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[0].parallel_tool_calls, false);
  assert.equal(bodies[0].tool_choice, 'required');
  assert.deepEqual(
    (bodies[0].tools as Array<{ name: string }>).map((tool) => tool.name),
    ['run', 'skill'],
  );
  assert.equal('max_output_tokens' in bodies[0], false);
  assert.equal(typeof firstKey, 'string');
  llm.resetSession?.();
  await llm.complete([{ role: 'user', content: 'two' }], {
    toolChoice: 'auto',
  });
  assert.equal(bodies[1].tool_choice, 'auto');
  assert.notEqual(bodies[1].prompt_cache_key, firstKey);
});

test('Codex external thinking forces named think and sends native reasoning effort none', async () => {
  const { store } = fakeStore();
  const base = codexConfig('stub');
  const config = { ...base, llm: { ...base.llm, externalThinking: true } };
  const llm = createCodexOAuthLLM(config, store);
  let body: Record<string, any> | undefined;
  (llm.client!.responses as any).create = async (
    request: Record<string, unknown>,
  ) => {
    body = request;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'response.completed',
          response: {
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 },
          },
        };
      },
    };
  };

  await llm.complete([{ role: 'user', content: 'inspect first' }], {
    forceThink: true,
  });
  assert.deepEqual(body?.tool_choice, { type: 'function', name: 'think' });
  assert.deepEqual(body?.reasoning, { effort: 'none' });
  assert.deepEqual(
    body?.tools.map((tool: any) => tool.name),
    ['run', 'think'],
  );
});

test('Codex replay strips response-only reasoning id/status without mutating history', () => {
  const nativeItem = {
    id: 'rs_native',
    type: 'reasoning' as const,
    status: 'completed',
    summary: [{ type: 'summary_text' as const, text: 'summary' }],
    content: [{ type: 'reasoning_text' as const, text: 'readable' }],
    encrypted_content: 'opaque',
    server_only_future_field: true,
  };
  const messages = [
    {
      role: 'assistant' as const,
      content: 'done',
      reasoning_items: [nativeItem],
    },
  ];
  const sanitized = sanitizeCodexMessagesForReplay(messages);
  assert.deepEqual(sanitized[0].reasoning_items, [
    {
      type: 'reasoning',
      summary: nativeItem.summary,
      content: nativeItem.content,
      encrypted_content: 'opaque',
    },
  ]);
  assert.equal(
    messages[0].reasoning_items[0].status,
    'completed',
    'stored history must remain native/verbatim',
  );
  assert.notEqual(sanitized, messages);
});

test('Codex LLM applies the replay sanitizer to the actual request body', async () => {
  const { store } = fakeStore();
  const llm = createCodexOAuthLLM(codexConfig('stub'), store);
  let body: Record<string, unknown> | undefined;
  (llm.client!.responses as any).create = async (
    request: Record<string, unknown>,
  ) => {
    body = request;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'response.completed',
          response: { output: [], usage: {} },
        };
      },
    };
  };
  await llm.complete([
    {
      role: 'assistant',
      content: 'prior output',
      reasoning_items: [
        {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
          summary: [],
          encrypted_content: 'blob',
        },
      ],
    },
    { role: 'user', content: 'continue' },
  ]);
  const reasoning = (body?.input as Array<Record<string, unknown>>).find(
    (item) => item.type === 'reasoning',
  );
  assert.deepEqual(reasoning, {
    type: 'reasoning',
    summary: [],
    encrypted_content: 'blob',
  });
});

for (const model of ['gpt-5.6-sol', 'gpt-6-astra']) {
  test(`${model} reconstructs run from output_item.done when terminal response omits output`, async () => {
    const { store } = fakeStore();
    const llm = createCodexOAuthLLM(codexConfig(model), store);
    let body: Record<string, unknown> | undefined;
    (llm.client!.responses as any).create = async (
      request: Record<string, unknown>,
    ) => {
      body = request;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              call_id: 'call_run',
              name: 'run',
              arguments: '{"code":"","end":true}',
            },
          };
          yield {
            type: 'response.completed',
            response: {
              usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
            },
          };
        },
      };
    };
    const result = await llm.complete([{ role: 'user', content: 'finish' }]);
    const input = body?.input as Array<Record<string, unknown>>;
    assert.equal(input[0].type, 'additional_tools');
    assert.equal('tools' in (body ?? {}), false);
    assert.equal(result.message.tool_calls?.[0].id, 'call_run');
    assert.equal(result.message.tool_calls?.[0].function.name, 'run');
  });
}

test('Codex fetch seals exact wire request and flagged response without consuming it', async () => {
  const { store } = fakeStore();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-codex-flight-'),
  );
  const config = {
    ...codexConfig('gpt-5.6-sol'),
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
  } as Config;
  const body =
    '{"model":"gpt-5.6-sol","input":[{"role":"user","content":"harmless"}]}';
  const flagged =
    '{"error":{"message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy."}}';
  const authenticated = createCodexFetch(
    store,
    () => 'captured-session',
    (async () =>
      new Response(flagged, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    true,
    config,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    },
  );
  assert.equal(
    await response.text(),
    flagged,
    'capture must consume only a response clone',
  );
  const root = resolveDataLayout(dataDirectory).policyDenials;
  const bundles = fs.readdirSync(root);
  assert.equal(bundles.length, 1);
  const bundle = path.join(root, bundles[0]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'),
  );
  assert.equal(
    fs.readFileSync(path.join(bundle, manifest.request.bodyFile), 'utf8'),
    body,
  );
  assert.equal(
    fs.readFileSync(path.join(bundle, manifest.response.bodyFile), 'utf8'),
    flagged,
  );
  assert.equal(manifest.request.headers.authorization, undefined);
  assert.equal(manifest.request.headers['chatgpt-account-id'], undefined);
  assert.equal(manifest.request.headers.session_id, 'captured-session');
});

test('Codex fetch seals a policy denial delivered inside an HTTP 200 SSE stream', async () => {
  const { store } = fakeStore();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-codex-sse-flight-'),
  );
  const config = {
    ...codexConfig('gpt-5.6-sol'),
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
  } as Config;
  const body =
    '{"model":"gpt-5.6-sol","input":[{"role":"user","content":"harmless"}]}';
  const flagged =
    'event: error\ndata: {"error":{"message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy."}}\n\n';
  const authenticated = createCodexFetch(
    store,
    () => 'sse-session',
    (async () =>
      new Response(flagged, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch,
    true,
    config,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    },
  );
  assert.equal(
    await response.text(),
    flagged,
    'monitor must consume only the cloned stream',
  );
  const root = resolveDataLayout(dataDirectory).policyDenials;
  for (let i = 0; i < 100 && !fs.existsSync(root); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(root), true);
  const bundles = fs.readdirSync(root);
  assert.equal(bundles.length, 1);
  const bundle = path.join(root, bundles[0]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.response.status, 200);
  assert.equal(manifest.response.bodyComplete, false);
  assert.equal(manifest.response.captureTrigger, 'stream-policy-event');
  assert.equal(
    fs.readFileSync(path.join(bundle, manifest.request.bodyFile), 'utf8'),
    body,
  );
  assert.equal(
    fs.readFileSync(path.join(bundle, manifest.response.bodyFile), 'utf8'),
    flagged,
  );
});

test('Codex fetch does not seal an ordinary successful SSE stream', async () => {
  const { store } = fakeStore();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-codex-clean-sse-'),
  );
  const config = {
    ...codexConfig('gpt-5.6-sol'),
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
  } as Config;
  const clean =
    'event: response.completed\ndata: {"response":{"status":"completed"}}\n\n';
  const authenticated = createCodexFetch(
    store,
    () => 'clean-session',
    (async () =>
      new Response(clean, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch,
    true,
    config,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    { method: 'POST', body: '{}' },
  );
  assert.equal(await response.text(), clean);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    fs.existsSync(resolveDataLayout(dataDirectory).policyDenials),
    false,
  );
});

test('Codex fetch seals a denial event without waiting for the SSE connection to close', async () => {
  const { store } = fakeStore();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-codex-open-sse-'),
  );
  const config = {
    ...codexConfig('gpt-5.6-sol'),
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
  } as Config;
  const body = '{"model":"gpt-5.6-sol","input":[]}';
  const flagged =
    'event: error\ndata: {"error":{"message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy."}}\n\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(flagged));
    },
  });
  const authenticated = createCodexFetch(
    store,
    () => 'open-sse-session',
    (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })) as typeof fetch,
    true,
    config,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    { method: 'POST', body },
  );
  const first = await response.body?.getReader().read();
  assert.equal(new TextDecoder().decode(first?.value), flagged);
  const root = resolveDataLayout(dataDirectory).policyDenials;
  for (let i = 0; i < 100 && !fs.existsSync(root); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    fs.existsSync(root),
    true,
    'capture must land before stream EOF',
  );
  const bundle = path.join(root, fs.readdirSync(root)[0]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.response.bodyComplete, false);
  assert.equal(manifest.response.captureTrigger, 'stream-policy-event');
  assert.equal(
    fs.readFileSync(path.join(bundle, manifest.response.bodyFile), 'utf8'),
    flagged,
  );
});

test('Codex fetch seals policy bytes before a final SSE blank-line delimiter', async () => {
  const { store } = fakeStore();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-codex-undelimited-sse-'),
  );
  const logs: string[] = [];
  const base = codexConfig('gpt-5.6-sol');
  const logger = {
    debug: (...args: unknown[]) => logs.push(args.join(' ')),
    info: (...args: unknown[]) => logs.push(args.join(' ')),
    warn: (...args: unknown[]) => logs.push(args.join(' ')),
    error: (...args: unknown[]) => logs.push(args.join(' ')),
  };
  const config = {
    ...base,
    logger,
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
  } as Config;
  const body = '{"model":"gpt-5.6-sol","input":[]}';
  const flagged =
    'event: error\ndata: {"error":{"message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy."}}';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(flagged));
    },
  });
  const authenticated = createCodexFetch(
    store,
    () => 'undelimited-session',
    (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })) as typeof fetch,
    true,
    config,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    { method: 'POST', body },
  );
  const first = await response.body?.getReader().read();
  assert.equal(new TextDecoder().decode(first?.value), flagged);
  const root = resolveDataLayout(dataDirectory).policyDenials;
  for (let i = 0; i < 100 && !fs.existsSync(root); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(
    fs.existsSync(root),
    true,
    'capture must not require a trailing SSE delimiter',
  );
  const bundle = path.join(root, fs.readdirSync(root)[0]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.response.captureTrigger, 'stream-policy-bytes');
  assert.equal(manifest.response.bodyComplete, false);
  assert.equal(
    fs.readFileSync(path.join(bundle, manifest.response.bodyFile), 'utf8'),
    flagged,
  );
  assert.equal(
    logs.some((line) => /attached .*status=200/.test(line)),
    true,
  );
  assert.equal(
    logs.some((line) =>
      /progress .*policy_text=true .*error_event=true/.test(line),
    ),
    true,
  );
  assert.equal(
    logs.some((line) => /matched .*complete_events=0/.test(line)),
    true,
  );
  assert.equal(
    logs.some((line) => line.includes(flagged)),
    false,
    'diagnostics must not print response payload',
  );
});

test('Codex fetch monitors a stream request when the response omits Content-Type', async () => {
  const { store } = fakeStore();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-codex-no-content-type-'),
  );
  const logs: string[] = [];
  const base = codexConfig('gpt-5.6-sol');
  const logger = {
    debug: (...args: unknown[]) => logs.push(args.join(' ')),
    info: (...args: unknown[]) => logs.push(args.join(' ')),
    warn: (...args: unknown[]) => logs.push(args.join(' ')),
    error: (...args: unknown[]) => logs.push(args.join(' ')),
  };
  const config = {
    ...base,
    logger,
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
  } as Config;
  const body = '{"model":"gpt-5.6-sol","stream":true,"input":[]}';
  const flagged =
    'event: error\ndata: {"error":{"message":"Invalid prompt: your prompt was flagged as potentially violating our usage policy."}}';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(flagged));
    },
  });
  const authenticated = createCodexFetch(
    store,
    () => 'no-content-type-session',
    (async () => new Response(stream, { status: 200 })) as typeof fetch,
    true,
    config,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    { method: 'POST', body },
  );
  const first = await response.body?.getReader().read();
  assert.equal(new TextDecoder().decode(first?.value), flagged);
  const root = resolveDataLayout(dataDirectory).policyDenials;
  for (let i = 0; i < 100 && !fs.existsSync(root); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(root), true);
  const bundle = path.join(root, fs.readdirSync(root)[0]);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(bundle, 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.response.captureTrigger, 'stream-policy-bytes');
  assert.equal(
    logs.some((line) =>
      /transport .*request_stream=true .*content_type_sse=false .*content_type_present=false/.test(
        line,
      ),
    ),
    true,
  );
  assert.equal(
    logs.some((line) =>
      /attached .*request_stream=true .*content_type_sse=false/.test(line),
    ),
    true,
  );
  assert.equal(
    logs.some((line) => line.includes(flagged)),
    false,
  );
});

test('Codex fetch ignores policy words in ordinary output and tool-argument events', async () => {
  const phrases = [
    [
      'response.output_text.delta',
      {
        type: 'response.output_text.delta',
        delta: 'quoted prompt was flagged as violating our usage policy',
      },
    ],
    [
      'response.function_call_arguments.delta',
      {
        type: 'response.function_call_arguments.delta',
        delta: '{"note":"flagged by usage policy"}',
      },
    ],
  ] as const;
  for (const [event, payload] of phrases) {
    const { store } = fakeStore();
    const dataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'elpis-codex-policy-quote-'),
    );
    const config = {
      ...codexConfig('gpt-5.6-sol'),
      paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
    } as Config;
    const streamText = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n`;
    const authenticated = createCodexFetch(
      store,
      () => 'quoted-policy-session',
      (async () => new Response(streamText, { status: 200 })) as typeof fetch,
      true,
      config,
    );
    const response = await authenticated(
      'https://chatgpt.com/backend-api/codex/responses',
      {
        method: 'POST',
        body: '{"model":"gpt-5.6-sol","stream":true,"input":[]}',
      },
    );
    assert.equal(await response.text(), streamText);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      fs.existsSync(resolveDataLayout(dataDirectory).policyDenials),
      false,
      `${event} must not seal`,
    );
  }
});

test('Codex fetch recognizes response.failed policy envelopes', async () => {
  const { store } = fakeStore();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-codex-failed-policy-'),
  );
  const config = {
    ...codexConfig('gpt-5.6-sol'),
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
  } as Config;
  const failed =
    'event: response.failed\ndata: {"type":"response.failed","response":{"error":{"message":"Invalid prompt: flagged as potentially violating our usage policy"}}}\n\n';
  const authenticated = createCodexFetch(
    store,
    () => 'failed-policy-session',
    (async () => new Response(failed, { status: 200 })) as typeof fetch,
    true,
    config,
  );
  const response = await authenticated(
    'https://chatgpt.com/backend-api/codex/responses',
    {
      method: 'POST',
      body: '{"model":"gpt-5.6-sol","stream":true,"input":[]}',
    },
  );
  assert.equal(await response.text(), failed);
  const root = resolveDataLayout(dataDirectory).policyDenials;
  for (let i = 0; i < 100 && !fs.existsSync(root); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.existsSync(root), true);
});
