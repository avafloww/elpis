import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  translate,
  anthropicModelTool,
  createBillingHeader,
  patchCch,
  createAnthropicOAuthLLM,
} from '../src/llm/anthropic-client.js';
import { build } from '../src/llm/prompt.js';
import { RUN_TOOL, SKILL_TOOL, type ChatMessage } from '../src/llm/llm.js';
import { makeConfig } from './helpers.js';

const sys = (): ChatMessage => ({
  role: 'system',
  content: build({
    soul: 'SOUL_X',
    memory: 'MEM_X',
    now: 'NOW_X',
    harnessRoot: '/HR',
    dataDirectory: '/DD',
    guildCount: 1,
  }),
});

test('anthropicModelTool preserves run and skill input schemas', () => {
  const run = anthropicModelTool(RUN_TOOL);
  const skill = anthropicModelTool(SKILL_TOOL);
  assert.equal(run.name, 'run');
  assert.equal(skill.name, 'skill');
  assert.equal(skill.input_schema, SKILL_TOOL.function.parameters);
});

test('Anthropic completion sends the resident skill declaration in its wire body', async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: any = null;
  globalThis.fetch = async (_input, init) => {
    capturedBody = JSON.parse(String(init?.body));
    return new Response('data: {"type":"message_stop"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
  const config = makeConfig({
    llm: {
      ...makeConfig().llm,
      baseUrl: 'https://anthropic.invalid',
      model: 'test-anthropic',
    },
  });
  const store = {
    read: () => null,
    getAccessToken: async () => 'test-access-token',
    forceRefresh: async () => undefined,
  };
  try {
    const llm = createAnthropicOAuthLLM(config, store as any, undefined);
    await llm.complete([sys(), { role: 'user', content: 'hello' }], {
      skillTool: SKILL_TOOL,
    });
    assert.ok(capturedBody);
    assert.ok(
      capturedBody.tools.some((tool: any) => tool.name === 'skill'),
      'the resident skill declaration must reach the Anthropic wire body',
    );
    assert.equal(capturedBody.tool_choice.disable_parallel_tool_use, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('translate: system blocks lead with billing + CC identity, then tiered body', () => {
  const { system } = translate([sys(), { role: 'user', content: 'hello' }]);
  assert.ok(system[0].text.startsWith('x-anthropic-billing-header:'));
  assert.equal(
    system[1].text,
    "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  );
  // stable, boundary, perturn(soul) follow.
  assert.equal(system.length, 5);
  assert.ok(system[4].text.startsWith('## Your soul'));
});

test('translate: cache breakpoints on last stable + last boundary blocks only', () => {
  const { system } = translate([sys(), { role: 'user', content: 'hi' }]);
  // Blocks: [0]=billing [1]=identity [2]=stable [3]=boundary [4]=perturn(soul)
  assert.equal(system[0].cache_control, undefined);
  assert.equal(system[1].cache_control, undefined);
  assert.deepEqual(system[2].cache_control, { type: 'ephemeral' }); // stable break
  assert.deepEqual(system[3].cache_control, { type: 'ephemeral' }); // boundary break
  assert.equal(system[4].cache_control, undefined); // perturn (SOUL) uncached
});

test('translate: tool_calls → tool_use, tool result → user tool_result', () => {
  const msgs: ChatMessage[] = [
    sys(),
    { role: 'user', content: 'do it' },
    {
      role: 'assistant',
      content: 'ok',
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: {
            name: 'run',
            arguments: '{"code":"1+1","wake":{"auto":true}}',
          },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'tc1', content: '[run ok] 2' },
  ];
  const { wire } = translate(msgs);
  assert.equal(wire.length, 3);
  assert.equal(wire[0].role, 'user');
  assert.equal(wire[1].role, 'assistant');
  const toolUse = wire[1].content.find((b) => b.type === 'tool_use') as {
    type: 'tool_use';
    name: string;
    input: unknown;
  };
  assert.equal(toolUse.name, 'run');
  assert.deepEqual(toolUse.input, { code: '1+1', wake: { auto: true } }); // parsed object, not a string
  assert.equal(wire[2].role, 'user');
  const toolResult = wire[2].content[0] as {
    type: string;
    tool_use_id: string;
    content: string;
  };
  assert.equal(toolResult.type, 'tool_result');
  assert.equal(toolResult.tool_use_id, 'tc1');
});

test('translate: consecutive same-role messages are coalesced (Anthropic alternation)', () => {
  const msgs: ChatMessage[] = [
    sys(),
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' }, // two consecutive user messages
  ];
  const { wire } = translate(msgs);
  assert.equal(wire.length, 1);
  assert.equal(wire[0].role, 'user');
  assert.equal(wire[0].content.length, 2);
});

test('translate: tool_result followed by a user envelope coalesce into one user turn', () => {
  const msgs: ChatMessage[] = [
    sys(),
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'run', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 't1', content: '[run ok]' },
    { role: 'user', content: 'meanwhile, another message' },
  ];
  const { wire } = translate(msgs);
  // user(q) | assistant(tool_use) | user(tool_result + envelope)
  assert.equal(wire.length, 3);
  assert.equal(wire[2].role, 'user');
  assert.equal(wire[2].content[0].type, 'tool_result');
  assert.equal(wire[2].content[1].type, 'text');
});

test('translate: empty ghost assistant message contributes no wire message', () => {
  const msgs: ChatMessage[] = [
    sys(),
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '' },
  ];
  const { wire } = translate(msgs);
  assert.equal(wire.length, 1); // only the user turn
});

test('translate: thinking blocks are replayed verbatim, FIRST in the assistant turn', () => {
  const msgs: ChatMessage[] = [
    sys(),
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: 'answer',
      thinking_blocks: [
        { type: 'thinking', thinking: 'let me reason', signature: 'sig123' },
      ],
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'run', arguments: '{"end":true}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'tc1', content: '[run ok]' },
  ];
  const { wire } = translate(msgs);
  const assistant = wire[1];
  // Order must be: thinking, then text, then tool_use.
  assert.equal(assistant.content[0].type, 'thinking');
  assert.deepEqual(assistant.content[0], {
    type: 'thinking',
    thinking: 'let me reason',
    signature: 'sig123',
  });
  assert.equal(assistant.content[1].type, 'text');
  assert.equal(assistant.content[2].type, 'tool_use');
});

test('translate: redacted_thinking blocks replay verbatim', () => {
  const msgs: ChatMessage[] = [
    sys(),
    { role: 'user', content: 'q' },
    {
      role: 'assistant',
      content: 'a',
      thinking_blocks: [{ type: 'redacted_thinking', data: 'ENCRYPTED' }],
    },
  ];
  const { wire } = translate(msgs);
  assert.deepEqual(wire[1].content[0], {
    type: 'redacted_thinking',
    data: 'ENCRYPTED',
  });
});

test('translate: last message gets a cache breakpoint', () => {
  const { wire } = translate([sys(), { role: 'user', content: 'hi' }]);
  const last = wire[wire.length - 1];
  const lastBlock = last.content[last.content.length - 1] as {
    cache_control?: unknown;
  };
  assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' });
});

test('patchCch: replaces the placeholder with a stable 5-hex attestation', () => {
  const header = createBillingHeader('hello world this is a test message');
  assert.ok(header.includes('cch=00000'));
  const body = JSON.stringify({
    system: [{ type: 'text', text: header }],
    messages: [],
  });
  const patched = patchCch(body);
  const m = /cch=([0-9a-f]{5})/.exec(patched);
  assert.ok(m, 'cch present');
  assert.notEqual(m![1], '00000');
  // Deterministic for a fixed body.
  assert.equal(patchCch(body), patched);
});

test('patchCch: no-op when no billing header present', () => {
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(patchCch(body), body);
});
