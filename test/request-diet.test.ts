// Unit tests for the V1 request-assembly diet (prepareForApi in llm.ts):
// 3a strip prior-turn reasoning, 3b tool aging (stub old results, head-cap old
// code, render recorded sends verbatim). Both NON-DESTRUCTIVE — the inputs are
// never mutated; only what would be SENT changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsTurn, prepareForApi } from '../src/llm/llm.js';
import type { ChatMessage } from '../src/llm/llm.js';

function mk(role: ChatMessage['role'], content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return { role, content, ...extra };
}
function runCall(id: string, code: string): ChatMessage {
  return mk('assistant', '', { tool_calls: [{ id, type: 'function', function: { name: 'run', arguments: JSON.stringify({ code }) } }] });
}

// ---------- 3a: reasoning strip ----------

test('reasoning strip: kept on the current open chain, dropped before the last natural turn-end', () => {
  const msgs: ChatMessage[] = [
    mk('user', 'q1'),
    mk('assistant', 'answer1', { reasoning_content: 'old thinking' }), // last natural turn-end (boundary)
    mk('user', 'q2'),
    mk('assistant', '', { reasoning_content: 'current thinking', tool_calls: [{ id: 't1', type: 'function', function: { name: 'run', arguments: '{}' } }] }), // open chain
    mk('tool', '[run ok]\n2', { tool_call_id: 't1' }),
  ];
  const out = prepareForApi(msgs, 0);
 // The boundary is the last assistant with no tool_calls (index 1); its
 // reasoning (a completed turn) is stripped, the open chain's is kept.
  assert.equal(out[1].reasoning_content, undefined, 'prior-turn reasoning stripped');
  assert.equal(out[3].reasoning_content, 'current thinking', 'open-chain reasoning kept');
 // Non-destructive: inputs untouched.
  assert.equal(msgs[1].reasoning_content, 'old thinking');
});

test('reasoning strip: keeps reasoning across a user message interleaved mid-chain', () => {
  const msgs: ChatMessage[] = [
    mk('assistant', 'done', { reasoning_content: 'r0' }),   // last natural turn-end
    runCall('t1', 'x'),                                     // open chain begins
    mk('tool', '[run ok]', { tool_call_id: 't1' }),
    mk('user', 'mid-chain nudge'),                          // interleaved user
    mk('assistant', '', { reasoning_content: 'r1', tool_calls: [{ id: 't2', type: 'function', function: { name: 'run', arguments: '{}' } }] }),
  ];
  const out = prepareForApi(msgs, 0);
  assert.equal(out[0].reasoning_content, undefined, 'reasoning before the last turn-end is stripped');
  assert.equal(out[4].reasoning_content, 'r1', 'reasoning on the open chain (after a mid-chain user) is kept');
});

test('reasoning strip: thinking_blocks are preserved even past the strip boundary', () => {
  const msgs: ChatMessage[] = [
    mk('user', 'q1'),
 // A completed turn: reasoning_content is stripped, but thinking_blocks (replayed
 // verbatim on the Anthropic path) must survive.
    mk('assistant', 'answer1', {
      reasoning_content: 'old thinking',
      thinking_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
    }),
    mk('user', 'q2'),
  ];
  const out = prepareForApi(msgs, 0);
  assert.equal(out[1].reasoning_content, undefined, 'reasoning stripped past boundary');
  assert.deepEqual(out[1].thinking_blocks, [{ type: 'thinking', thinking: 't', signature: 's' }], 'thinking_blocks kept');
});

test('tool aging: thinking_blocks survive an aged assistant tool-call message', () => {
  const msgs: ChatMessage[] = [
    { role: 'assistant', content: '', thinking_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }], tool_calls: [{ id: 't1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ code: 'x'.repeat(2000) }) } }] },
    mk('tool', '[run ok]', { tool_call_id: 't1' }),
    mk('user', 'y'.repeat(9000)),
  ];
  const out = prepareForApi(msgs, 100); // tiny window → first message is aged
  assert.deepEqual(out[0].thinking_blocks, [{ type: 'thinking', thinking: 't', signature: 's' }]);
});

// ---------- 3b: tool aging ----------

test('tool aging: 0 disables aging (everything untouched)', () => {
  const msgs: ChatMessage[] = [runCall('t1', 'x'.repeat(2000)), mk('tool', '[run ok]\n' + 'y'.repeat(9000), { tool_call_id: 't1' })];
  const out = prepareForApi(msgs, 0);
  assert.equal(out[1].content.length, msgs[1].content.length, 'result not stubbed when aging disabled');
});

test('tool aging: old tool results are stubbed to status line + verbatim sends; recent untouched', () => {
 // Build many messages so the OLD ones fall outside the keep window and the
 // NEWEST stay inside it.
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(runCall(`t${i}`, 'console.log(' + i + ')\n' + 'x'.repeat(2000)));
    const tool: ChatMessage = { role: 'tool', tool_call_id: `t${i}`, content: `[run ok]\n${'y'.repeat(4000)}` };
    if (i === 0) tool.sends = [{ channel: 'general', text: 'hi there' }];
    msgs.push(tool);
  }
  const out = prepareForApi(msgs, 2000); // keep ~2000 tokens of tail
 // Oldest tool result is stubbed to status line + sends + elision marker.
  assert.match(out[1].content, /^\[run ok\]/, 'status line preserved');
  assert.match(out[1].content, /→ #general: "hi there"/, 'recorded send rendered verbatim');
  assert.match(out[1].content, /result elided by harness/);
  assert.ok(out[1].content.length < msgs[1].content.length, 'old result shrank');
 // Newest tool result is inside the window → untouched.
  const last = out.length - 1;
  assert.equal(out[last].content, msgs[last].content, 'recent result untouched');
});

test('tool aging: old tool-call arguments stay valid JSON after head-capping code', () => {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(runCall(`t${i}`, Array.from({ length: 40 }, (_, k) => `line ${k}`).join('\n')));
    msgs.push({ role: 'tool', tool_call_id: `t${i}`, content: `[run ok]\n${'y'.repeat(4000)}` });
  }
  const out = prepareForApi(msgs, 2000);
 // Every aged assistant tool_call's arguments MUST round-trip through JSON.parse
 // (head-capping the raw string would emit invalid JSON → permanent 400).
  for (const m of out) {
    if (m.role !== 'assistant' || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      assert.doesNotThrow(() => JSON.parse(tc.function.arguments), 'aged arguments must be valid JSON');
    }
  }
 // The oldest tool-call code was actually capped.
  assert.match(JSON.parse(out[0].tool_calls![0].function.arguments).code, /code elided by harness/);
});

test('tool aging: never removes a message or a tool_call_id (structure preserved)', () => {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < 20; i++) {
    msgs.push(runCall(`t${i}`, 'x'.repeat(2000)));
    msgs.push({ role: 'tool', tool_call_id: `t${i}`, content: `[run ok]\n${'y'.repeat(4000)}` });
  }
  const out = prepareForApi(msgs, 2000);
  assert.equal(out.length, msgs.length, 'no message removed');
  const ids = out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  assert.deepEqual(ids, msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), 'all tool_call_ids survive');
});

// ---------- endsTurn ----------
// endsTurn(messages, i) mirrors src/agent.ts's own `endedByFlag = wantsEnd &&
// result.ok` rule exactly: only the LAST tool call in a response can end a
// turn, and only when its matching `tool` result (found by tool_call_id)
// shows the run actually succeeded ([run ok…], not [run FAILED]).

test('endsTurn: a bare assistant message ends a turn (legacy shape)', () => {
  const messages: ChatMessage[] = [mk('assistant', 'done')];
  assert.equal(endsTurn(messages, 0), true);
});

test('endsTurn: a non-assistant message never ends a turn (role guard)', () => {
 // Without the role check, a user/tool message with no tool_calls would fall
 // into the "no tool_calls" branch and be mistaken for a boundary.
  const messages: ChatMessage[] = [mk('user', 'hi'), mk('tool', '[run ok]', { tool_call_id: 't1' })];
  assert.equal(endsTurn(messages, 0), false);
  assert.equal(endsTurn(messages, 1), false);
});

test('endsTurn: a SUCCESSFUL run call carrying end:true ends a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', { tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{"code":"","end":true}' } }] }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), true);
});

test('endsTurn: a FAILED run carrying end:true does NOT end a turn', () => {
 // Important 1: a failure has to come back to the model, so its end:true is
 // not honoured — matches src/agent.ts's `wantsEnd && result.ok` exactly.
  const messages: ChatMessage[] = [
    mk('assistant', '', { tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{"code":"","end":true}' } }] }),
    mk('tool', '[run FAILED]\nboom', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('endsTurn: a run call without end does NOT end a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', { tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{"code":"1+1"}' } }] }),
    mk('tool', '[run ok]\n2', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('endsTurn: unparseable arguments do not end a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', { tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{not json' } }] }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('endsTurn: only the LAST tool call in a multi-call response decides', () => {
 // The loop's endedByFlag is a plain per-call ASSIGNMENT, not an OR: a later
 // call in the same response always overrides an earlier one's end:true.
  const messages: ChatMessage[] = [
    mk('assistant', '', { tool_calls: [
      { id: 'a', type: 'function', function: { name: 'run', arguments: '{"code":"","end":true}' } },
      { id: 'b', type: 'function', function: { name: 'run', arguments: '{"code":"1+1"}' } },
    ] }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
    mk('tool', '[run ok]\n2', { tool_call_id: 'b' }),
  ];
  assert.equal(endsTurn(messages, 0), false, "ended by the LAST call, which didn't request end");
});

test('endsTurn: an interrupted chain (no result yet for the ending call) does not end a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', { tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{"code":"","end":true}' } }] }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('reasoning is stripped at or before the last SUCCESSFUL end:true turn-end', () => {
 // Shape: [turn-1 run+end (reasoning), tool ok, user, turn-2 run (reasoning), tool ok]
 // The boundary is the turn-1 end call; its reasoning goes, the open chain keeps its own.
  const messages: ChatMessage[] = [
    mk('assistant', '', { reasoning_content: 'OLD', tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{"code":"","end":true}' } }] }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
    mk('user', 'next'),
    mk('assistant', '', { reasoning_content: 'NEW', tool_calls: [{ id: 'b', type: 'function', function: { name: 'run', arguments: '{"code":"1+1"}' } }] }),
    mk('tool', '[run ok]\n2', { tool_call_id: 'b' }),
  ];
  const out = prepareForApi(messages, 0);
  assert.equal(out[0].reasoning_content, undefined, 'reasoning at the boundary is stripped');
  assert.equal(out[3].reasoning_content, 'NEW', 'the open chain keeps its reasoning');
 // Non-destructive: inputs untouched (matches the legacy-shape test above).
  assert.equal(messages[0].reasoning_content, 'OLD');
});

test('reasoning is NOT stripped ahead of a FAILED end:true call — the model needs it for the retry', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', { reasoning_content: 'WHY IT FAILED', tool_calls: [{ id: 'a', type: 'function', function: { name: 'run', arguments: '{"code":"","end":true}' } }] }),
    mk('tool', '[run FAILED]\nboom', { tool_call_id: 'a' }),
  ];
  const out = prepareForApi(messages, 0);
  assert.equal(out[0].reasoning_content, 'WHY IT FAILED', 'no turn-end found in this array — reasoning survives the diet');
});
