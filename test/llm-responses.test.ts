// Unit tests for the OpenAI Responses API path (src/llm/responses.ts) and its
// integration seams: message mapping, output assembly, usage mapping, the
// auto-fallback flip, reasoning-item preservation through the request diet and
// the transcript round-trip.
//
// Run with: npm run test:unit

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  toResponsesInput,
  fromResponseOutput,
  mapResponsesUsage,
  isResponsesUnsupported,
  responsesRunTool,
  responsesSummarize,
  failureToError,
  type ReasoningItemParam,
} from '../src/llm/responses.js';
import {
  createLLM,
  prepareForApi,
  sentChars,
  computeCharsSent,
  reasoningItemChars,
  NonRetriableError,
  type ChatMessage,
} from '../src/llm/llm.js';
import { createTranscriptStore, loadMostRecentMain, MAIN_TRANSCRIPT_ID } from '../src/store/sessions.js';
import { makeConfig } from './helpers.js';

const REASONING_ITEM: ReasoningItemParam = {
  id: 'rs_1',
  type: 'reasoning',
  summary: [{ type: 'summary_text', text: 'thought about it' }],
  encrypted_content: 'gAAAAABox-blob',
};

function chatStream(content: string): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content } }] };
      yield { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    },
  };
}

function responsesStream(output: unknown[], usage: Record<string, unknown> = {}): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const [output_index, item] of output.entries()) {
        yield { type: 'response.output_item.done', output_index, item };
      }
      yield { type: 'response.completed', response: { output, usage } };
    },
  };
}

// ─── toResponsesInput ────────────────────────────────────────────────────────

test('toResponsesInput: maps roles, tool results, and assistant item order', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'thinking out loud',
      reasoning_items: [REASONING_ITEM],
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"code":"1+1"}' } },
      ],
    },
    { role: 'tool', content: '[run ok]\n2', tool_call_id: 'call_1' },
  ];
  const items = toResponsesInput(messages) as any[];
  assert.equal(items.length, 6);
  assert.deepEqual(items[0], { role: 'system', content: 'sys' });
  assert.deepEqual(items[1], { role: 'user', content: 'hi' });
 // assistant expands to [reasoning, message, function_call] in that order.
  assert.equal(items[2].type, 'reasoning');
  assert.equal(items[2].encrypted_content, 'gAAAAABox-blob');
  assert.deepEqual(items[3], { role: 'assistant', content: 'thinking out loud' });
  assert.deepEqual(items[4], {
    type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{"code":"1+1"}',
  });
  assert.deepEqual(items[5], { type: 'function_call_output', call_id: 'call_1', output: '[run ok]\n2' });
});

test('toResponsesInput: converts chat multimodal parts to input_text/input_image', () => {
  const items = toResponsesInput([
    {
      role: 'user',
      content: 'fallback text',
      contentParts: [
        { type: 'text', text: 'look at this' },
        { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
      ],
    },
  ]) as any[];
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].content, [
    { type: 'input_text', text: 'look at this' },
    { type: 'input_image', image_url: 'https://example.com/x.png', detail: 'auto' },
  ]);
});

test('toResponsesInput: reasoning items with NO following item are dropped, not replayed dangling', () => {
 // An assistant message that spent its whole output budget thinking (empty
 // content, no tool calls) must contribute nothing — a replayed reasoning
 // item with no follower earns a permanent 400 ("provided without its
 // required following item") that poisons every subsequent request.
  const items = toResponsesInput([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '', reasoning_items: [REASONING_ITEM] },
    { role: 'user', content: 'nudge' },
  ]) as any[];
  assert.deepEqual(items.map((i) => i.type ?? i.role), ['user', 'user'],
    'the orphaned reasoning item (and the empty assistant message) are omitted');
});

test('toResponsesInput: replayed reasoning items are copies, not history references', () => {
  const msg: ChatMessage = { role: 'assistant', content: 'ok', reasoning_items: [{ ...REASONING_ITEM }] };
  const items = toResponsesInput([msg]) as any[];
  const replayed = items.find((i) => i.type === 'reasoning');
  replayed.encrypted_content = 'MUTATED';
  assert.equal(msg.reasoning_items![0].encrypted_content, REASONING_ITEM.encrypted_content,
    'mutating the request body must not reach in-memory history');
});

test('toResponsesInput: assistant with empty content emits no message item', () => {
  const items = toResponsesInput([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'run', arguments: '{}' } }],
    },
  ]) as any[];
  assert.equal(items.length, 1);
  assert.equal(items[0].type, 'function_call');
});

// ─── fromResponseOutput ──────────────────────────────────────────────────────

test('fromResponseOutput: extracts text, reasoning items, and tool calls', () => {
  const out = fromResponseOutput([
    {
      id: 'rs_1', type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'sum A' }],
      encrypted_content: 'blob',
    },
    {
      id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'hello ' }, { type: 'output_text', text: 'world' }],
    },
    { id: 'fc_1', type: 'function_call', call_id: 'call_9', name: 'run', arguments: '{"code":"x"}' },
  ]);
  assert.equal(out.content, 'hello world');
  assert.equal(out.reasoningContent, 'sum A');
  assert.equal(out.reasoningItems?.length, 1);
  assert.equal(out.reasoningItems?.[0].encrypted_content, 'blob');
  assert.deepEqual(out.toolCalls, [
    { id: 'call_9', type: 'function', function: { name: 'run', arguments: '{"code":"x"}' } },
  ]);
});

test('fromResponseOutput: prefers raw reasoning text over summary for the readable side', () => {
  const out = fromResponseOutput([
    {
      id: 'rs_1', type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'the summary' }],
      content: [{ type: 'reasoning_text', text: 'the raw chain of thought' }],
    },
  ]);
  assert.equal(out.reasoningContent, 'the raw chain of thought');
});

test('fromResponseOutput: a refusal part surfaces as content', () => {
  const out = fromResponseOutput([
    {
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'refusal', refusal: 'I cannot help with that.' }],
    },
  ]);
  assert.equal(out.content, 'I cannot help with that.');
});

test('fromResponseOutput: a function_call without call_id is dropped (chat-path parity)', () => {
  const out = fromResponseOutput([
    { id: 'fc_1', type: 'function_call', name: 'run', arguments: '{}' },
    { id: 'fc_2', type: 'function_call', call_id: 'call_ok', name: 'run', arguments: '{}' },
  ]);
  assert.equal(out.toolCalls?.length, 1);
  assert.equal(out.toolCalls?.[0].id, 'call_ok');
});

test('fromResponseOutput: empty output yields empty result', () => {
  const out = fromResponseOutput([]);
  assert.equal(out.content, '');
  assert.equal(out.reasoningContent, undefined);
  assert.equal(out.reasoningItems, undefined);
  assert.equal(out.toolCalls, undefined);
});

// ─── usage mapping ───────────────────────────────────────────────────────────

test('mapResponsesUsage: maps input/output tokens and cached_tokens', () => {
  assert.deepEqual(
    mapResponsesUsage({
      input_tokens: 100, output_tokens: 20, total_tokens: 120,
      input_tokens_details: { cached_tokens: 90 },
    }),
    { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cached_tokens: 90 },
  );
});

test('mapResponsesUsage: missing details yields undefined cached_tokens, not 0', () => {
  const u = mapResponsesUsage({ input_tokens: 5, output_tokens: 1, total_tokens: 6 });
  assert.equal(u.cached_tokens, undefined);
  assert.ok(!('cached_tokens' in u));
  const empty = mapResponsesUsage(undefined);
  assert.deepEqual(empty, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

// ─── response.failed classification ──────────────────────────────────────────

// ---------- responsesSummarize (truncation attribution, finding 2 ) ----------

function fakeResponsesClient(resp: object, capture?: (body: Record<string, unknown>) => void) {
  return { responses: { create: async (body: Record<string, unknown>) => { capture?.(body); return resp; } } } as unknown as Parameters<typeof responsesSummarize>[0];
}

test('responsesSummarize: returns content and requests encrypted reasoning', async () => {
  let body: Record<string, unknown> | undefined;
  const client = fakeResponsesClient({
    status: 'completed',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'THE SUMMARY' }] }],
  }, (request) => { body = request; });
  const out = await responsesSummarize(client, makeConfig(), 'sys', 'fold');
  assert.equal(out, 'THE SUMMARY');
  assert.deepEqual(body?.include, ['reasoning.encrypted_content']);
  assert.equal(body?.store, false);
});

test('responsesSummarize: an incomplete response THROWS with the real cause, not a short summary', async () => {
 // max_output_tokens covers reasoning on this surface — a long think can cut
 // the visible summary to a sentence. Returning that sentence would make the
 // quality gate misattribute a config ceiling to model laziness; throwing
 // routes the true reason into the guarded summarizer's lastError.
  const client = fakeResponsesClient({
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: 'a terse cut-off line' }] }],
  });
  await assert.rejects(
    () => responsesSummarize(client, makeConfig(), 'sys', 'fold'),
    /max_output_tokens/,
  );
});

test('failureToError: terminal codes classify non-retriable with a readable message', () => {
  const e = failureToError({ code: 'context_length_exceeded', message: 'too long' }) as Error & { status: number };
  assert.equal(e.status, 400);
  assert.ok(e.message.includes('context_length_exceeded'));
  assert.ok(e.message.includes('too long'));
  assert.ok(new NonRetriableError(e).message !== '[object Object]');
});

test('failureToError: transient codes stay retriable', () => {
  assert.equal((failureToError({ code: 'server_error', message: 'oops' }) as any).status, 503);
  assert.equal((failureToError({ code: 'rate_limit_exceeded', message: 'slow down' }) as any).status, 503);
  assert.equal((failureToError(undefined) as any).status, 400);
});

// ─── unsupported detection ───────────────────────────────────────────────────

test('isResponsesUnsupported: 404/405 raw and classify-wrapped; other statuses no', () => {
  const notFound = Object.assign(new Error('Not Found'), { status: 404 });
  assert.equal(isResponsesUnsupported(notFound), true);
  assert.equal(isResponsesUnsupported(Object.assign(new Error('nope'), { status: 405 })), true);
  assert.equal(isResponsesUnsupported(new NonRetriableError(notFound)), true);
  assert.equal(isResponsesUnsupported(Object.assign(new Error('bad'), { status: 400 })), false);
  assert.equal(isResponsesUnsupported(Object.assign(new Error('boom'), { status: 500 })), false);
  assert.equal(isResponsesUnsupported(new Error('no status')), false);
  assert.equal(isResponsesUnsupported(undefined), false);
});

// ─── run tool shape ──────────────────────────────────────────────────────────

test('responsesRunTool: flattened FunctionTool with the same schema, strict off', () => {
  const t = responsesRunTool();
  assert.equal(t.type, 'function');
  assert.equal(t.name, 'run');
  assert.equal(t.strict, false);
  assert.deepEqual(Object.keys((t.parameters as any).properties), ['code', 'end']);
});

// ─── auto fallback in createLLM ──────────────────────────────────────────────

test('createLLM auto: 404 on /responses falls back to chat in the same call, then skips responses', async () => {
  const config = makeConfig(); // llm.api: 'auto' starts on the Responses surface
  const llm = createLLM(config);
  let responsesCalls = 0;
  let chatCalls = 0;
  (llm.client.responses as any).create = async () => {
    responsesCalls++;
    throw Object.assign(new Error('Not Found'), { status: 404 });
  };
  (llm.client.chat.completions as any).create = async () => {
    chatCalls++;
    return chatStream('from chat');
  };

  const first = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(first.message.content, 'from chat');
  assert.equal(responsesCalls, 1, 'responses tried once');
  assert.equal(chatCalls, 1, 'fell back within the same call');

  await llm.complete([{ role: 'user', content: 'again' }]);
  assert.equal(responsesCalls, 1, 'after the flip, responses is never tried again');
  assert.equal(chatCalls, 2);
});

test('createLLM auto: first-contact non-404 failure probes chat and commits the flip on success', async () => {
 // Gateways answer an unimplemented /responses with 400/500/501/…, not just
 // 404 — before the first Responses success, any failure probes the chat
 // path with the same request and commits the flip only if chat succeeds.
  const config = makeConfig();
  const llm = createLLM(config);
  let responsesCalls = 0;
  let chatCalls = 0;
  (llm.client.responses as any).create = async () => {
    responsesCalls++;
    throw Object.assign(new Error('Responses API not supported for this model'), { status: 501 });
  };
  (llm.client.chat.completions as any).create = async () => {
    chatCalls++;
    return chatStream('from chat');
  };
  const r = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(r.message.content, 'from chat');
  await llm.complete([{ role: 'user', content: 'again' }]);
  assert.equal(responsesCalls, 1, 'flip committed — responses not retried');
  assert.equal(chatCalls, 2);
});

test('createLLM auto: first-contact failure with chat ALSO failing propagates the responses error, mode undecided', async () => {
  const config = makeConfig();
  const llm = createLLM(config);
  let responsesCalls = 0;
  const outage = Object.assign(new Error('gateway down'), { status: 503 });
  (llm.client.responses as any).create = async () => { responsesCalls++; throw outage; };
  (llm.client.chat.completions as any).create = async () => {
    throw Object.assign(new Error('gateway down'), { status: 503 });
  };
  await assert.rejects(
    () => llm.complete([{ role: 'user', content: 'hi' }]),
    (e: any) => e.cause === outage || e.message.includes('gateway down'),
  );
 // A transient outage must NOT lock chat mode in: the next call tries
 // responses again.
  (llm.client.chat.completions as any).create = async () => chatStream('x');
  await llm.complete([{ role: 'user', content: 'retry' }]).catch(() => {});
  assert.equal(responsesCalls, 2, 'responses re-attempted after an undecided failure');
});

test('createLLM auto: after a responses success, later errors propagate without flipping', async () => {
  const config = makeConfig();
  const llm = createLLM(config);
  let chatCalls = 0;
  let fail = false;
  (llm.client.responses as any).create = async () => {
    if (fail) throw Object.assign(new Error('server exploded'), { status: 500 });
    return responsesStream(
      [{ id: 'msg', type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
      { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    );
  };
  (llm.client.chat.completions as any).create = async () => { chatCalls++; return {}; };
  await llm.complete([{ role: 'user', content: 'hi' }]);
  fail = true;
  await assert.rejects(() => llm.complete([{ role: 'user', content: 'again' }]));
  assert.equal(chatCalls, 0, 'a 5xx on a proven-working route must not silently flip to chat');
});

test('createLLM forced responses: 404 propagates instead of falling back', async () => {
  const config = makeConfig({ llm: { ...makeConfig().llm, api: 'responses' } });
  const llm = createLLM(config);
  (llm.client.responses as any).create = async () => {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  };
  let chatCalls = 0;
  (llm.client.chat.completions as any).create = async () => { chatCalls++; return {}; };
  await assert.rejects(() => llm.complete([{ role: 'user', content: 'hi' }]));
  assert.equal(chatCalls, 0);
});

test('createLLM responses: streamed result carries reasoning items + mapped usage', async () => {
  const config = makeConfig({ llm: { ...makeConfig().llm, api: 'responses' } });
  const llm = createLLM(config);
  (llm.client.responses as any).create = async (body: any) => {
    assert.equal(body.store, false);
    assert.ok(body.include.includes('reasoning.encrypted_content'));
    assert.equal(body.reasoning.effort, 'high');
    return responsesStream(
      [
        { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'blob' },
        {
          id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'run',
          arguments: '{"code":"1","end":true}',
        },
      ],
      {
        input_tokens: 50, output_tokens: 9, total_tokens: 59,
        input_tokens_details: { cached_tokens: 40 },
      },
    );
  };
  const r = await llm.complete([{ role: 'user', content: 'hi' }]);
  assert.equal(r.message.reasoning_items?.length, 1);
  assert.equal(r.message.tool_calls?.[0].id, 'call_1');
  assert.deepEqual(r.usage, { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59, cached_tokens: 40 });
  assert.ok(typeof r.promptChars === 'number' && r.promptChars > 0);
});

test('createLLM auto: summarize also falls back on 404', async () => {
  const config = makeConfig();
  const llm = createLLM(config);
  (llm.client.responses as any).create = async () => {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  };
  (llm.client.chat.completions as any).create = async () => ({
    choices: [{ message: { content: 'chat summary' } }],
  });
  assert.equal(await llm.summarize('some history'), 'chat summary');
});

// ─── diet + estimator integration ────────────────────────────────────────────

test('prepareForApi: reasoning_items survive the 3a strip that drops reasoning_content', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'q1' },
    {
      role: 'assistant', content: 'done', reasoning_content: 'kimi-style thinking',
      reasoning_items: [REASONING_ITEM],
    }, // no tool calls → ended a turn (pre-flag shape) → at/before boundary
    { role: 'user', content: 'q2' },
  ];
  const out = prepareForApi(messages, 0);
  assert.equal(out[1].reasoning_content, undefined, 'legacy reasoning text is stripped on completed turns');
  assert.deepEqual(out[1].reasoning_items, [REASONING_ITEM], 'encrypted reasoning items are preserved');
});

test('sentChars counts reasoning_items (blob + readable text)', () => {
  const bare: ChatMessage = { role: 'assistant', content: 'x' };
  const withItems: ChatMessage = { ...bare, reasoning_items: [REASONING_ITEM] };
  const expected = reasoningItemChars(REASONING_ITEM);
  assert.equal(expected, 'gAAAAABox-blob'.length + 'thought about it'.length);
  assert.equal(sentChars(withItems) - sentChars(bare), expected);
});

test('computeCharsSent excludes reasoning_items on the chat path (includeReasoningItems: false)', () => {
 // The chat wire format never sends the items; counting them there would
 // train the density EWMA on chars that were never sent.
  const messages: ChatMessage[] = [
    { role: 'assistant', content: 'x', reasoning_items: [REASONING_ITEM] },
  ];
  assert.equal(
    computeCharsSent(messages) - computeCharsSent(messages, false),
    reasoningItemChars(REASONING_ITEM),
  );
});

// ─── transcript round-trip ───────────────────────────────────────────────────

test('transcript: reasoning_items survive an append → load round-trip', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-resp-transcript-'));
  const store = createTranscriptStore(tmpDir);
  const msg: ChatMessage = {
    role: 'assistant',
    content: 'hi',
    reasoning_content: 'readable side',
    reasoning_items: [REASONING_ITEM],
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run', arguments: '{}' } }],
    channel: '123',
  };
  store.append(MAIN_TRANSCRIPT_ID, msg);
  store.flush(MAIN_TRANSCRIPT_ID);
  const loaded = loadMostRecentMain(tmpDir);
  assert.ok(loaded);
  assert.equal(loaded.messages.length, 1);
  assert.deepEqual(loaded.messages[0].reasoning_items, [REASONING_ITEM]);
  assert.equal(loaded.messages[0].reasoning_content, 'readable side');
});
