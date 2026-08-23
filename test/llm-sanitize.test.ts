// Unit tests for sanitizeAssistantMessage — the ingestion chokepoint that
// prevents leaked chain-of-thought and malformed tool-call `arguments` from
// poisoning the conversation, and reports whether anything was stripped so the
// loop can retry a fully-leaked response instead of hanging.
//
// These two failure modes were observed in production against
// umans-kimi-k2.7 (a reasoning model). They are NOT theoretical:
//
// 1. Leaked CoT in `content`: the model emits proprietary markers
// (`<|tool_calls_section_begin|>`, ...) into `content` instead of the
// separate `reasoning_content` field. Without sanitization this reasoning
// is echoed to Discord and re-fed to the model every turn.
//
// 2. Malformed `tool_calls[].function.arguments`: the model stuffs its CoT
// into the `arguments` string with RAW control chars (literal newlines)
// instead of escaped `\n`. The outer JSON body is valid (JSON.stringify
// escapes them), but the server re-parses `arguments` as nested JSON per
// the tool-call spec and rejects the raw control char with
// `400 unexpected control character` — every turn, until context clears.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeAssistantMessage } from '../src/llm/llm.js';

test('sanitize: passes through a clean assistant message with tool_calls', () => {
  const out = sanitizeAssistantMessage({
    content: '',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'run', arguments: JSON.stringify({ code: '1 + 1' }) },
      },
    ],
  });
  assert.equal(out.stripped, false, 'clean response is not stripped');
  assert.equal(out.message.role, 'assistant');
  assert.equal(out.message.content, '');
  assert.equal(out.message.tool_calls?.length, 1);
  assert.equal(out.message.tool_calls?.[0].id, 'call_1');
  assert.equal(
    out.message.tool_calls?.[0].function.arguments,
    JSON.stringify({ code: '1 + 1' }),
  );
});

test('sanitize: passes through a clean natural reply (no tool_calls)', () => {
  const out = sanitizeAssistantMessage({
    content: 'hello there',
    tool_calls: null,
  });
  assert.equal(out.stripped, false);
  assert.equal(out.message.content, 'hello there');
  assert.equal(out.message.tool_calls, undefined);
});

test('sanitize: a clean SHORT reply passes through untouched (no false clear)', () => {
  // Regression guard: the "pure leaked CoT" clear must only fire when markers
  // were actually stripped. A legit "ok." must survive.
  const out = sanitizeAssistantMessage({ content: 'ok.' });
  assert.equal(out.stripped, false);
  assert.equal(out.message.content, 'ok.');
  assert.equal(out.message.tool_calls, undefined);
});

test('sanitize: strips leaked-CoT markers from content, keeps real text', () => {
  const out = sanitizeAssistantMessage({
    content: '<|tool_calls_section_begin|><|tool_call_begin|>real answer here',
  });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, 'real answer here');
  assert.equal(out.message.tool_calls, undefined);
});

test('sanitize: clears content that is pure leaked CoT (markers only)', () => {
  const out = sanitizeAssistantMessage({
    content:
      '<|tool_calls_section_begin|><|tool_call_begin|><|tool_call_argument_begin|>',
  });
  assert.equal(out.stripped, true);
  // nothing printable remains -> cleared so reasoning never surfaces
  assert.equal(out.message.content, '');
});

test('sanitize: drops a tool call whose arguments contain a raw newline (the 400 cause)', () => {
  // Exact shape observed in production: Kimi leaked CoT into `arguments` with
  // a literal \n inside the JSON string value of "code".
  const leakedArgs =
    '{"code": "const fs =IRV F8 constants. But what did Bramble see?\n\nActually I should look."}';
  // sanity: this string is NOT valid JSON (raw control char)
  assert.throws(() => JSON.parse(leakedArgs), /control character/);

  const out = sanitizeAssistantMessage({
    content: '',
    tool_calls: [
      {
        id: 'functions.run:82',
        type: 'function',
        function: { name: 'run', arguments: leakedArgs },
      },
    ],
  });
  assert.equal(out.stripped, true);
  // the malformed tool call is dropped entirely -> can't orphan a tool_call_id
  // (the loop only dispatches what survives), and the next request won't 400.
  assert.equal(out.message.tool_calls, undefined);
  assert.equal(out.message.content, '');
});

test('sanitize: keeps the valid tool calls and drops only the malformed ones', () => {
  const good = JSON.stringify({ code: 'elpis.sh("whoami").stdout.trim()' });
  const leakedArgs = '{"code": "thinking\n\nmore thinking"}';
  const out = sanitizeAssistantMessage({
    content: '',
    tool_calls: [
      {
        id: 'bad',
        type: 'function',
        function: { name: 'run', arguments: leakedArgs },
      },
      {
        id: 'good',
        type: 'function',
        function: { name: 'run', arguments: good },
      },
    ],
  });
  assert.equal(out.stripped, true);
  assert.equal(out.message.tool_calls?.length, 1);
  assert.equal(out.message.tool_calls?.[0].id, 'good');
  assert.equal(out.message.tool_calls?.[0].function.arguments, good);
});

test('sanitize: drops a tool call with empty arguments', () => {
  const out = sanitizeAssistantMessage({
    content: '',
    tool_calls: [
      { id: 'x', type: 'function', function: { name: 'run', arguments: '' } },
    ],
  });
  assert.equal(out.stripped, true);
  assert.equal(out.message.tool_calls, undefined);
});

test('sanitize: drops non-function tool calls (type guard)', () => {
  const out = sanitizeAssistantMessage({
    content: '',
    tool_calls: [
      {
        id: 'x',
        type: 'code_interpreter',
        function: { name: 'run', arguments: '{}' },
      },
    ],
  });
  assert.equal(out.stripped, true);
  assert.equal(out.message.tool_calls, undefined);
});

test('sanitize: null content becomes empty string', () => {
  const out = sanitizeAssistantMessage({ content: null });
  assert.equal(out.stripped, false);
  assert.equal(out.message.content, '');
  assert.equal(out.message.tool_calls, undefined);
});

test("sanitize: the resulting message survives the server's nested-JSON parse of arguments", () => {
  // Regression: the server re-parses tool-call `arguments` as JSON. Confirm
  // every `arguments` that survives sanitization parses cleanly under a strict
  // (Python-equivalent) check — i.e. JSON.parse succeeds AND the re-stringified
  // value round-trips (no raw control chars hiding in nested strings).
  const cases = [
    JSON.stringify({ code: '1+1' }),
    JSON.stringify({ code: 'elpis.sh("echo hi\\nthere")' }),
    JSON.stringify({ code: 'const x = "line1\\nline2"' }),
  ];
  for (const args of cases) {
    const out = sanitizeAssistantMessage({
      content: '',
      tool_calls: [
        {
          id: 'c',
          type: 'function',
          function: { name: 'run', arguments: args },
        },
      ],
    });
    assert.equal(out.stripped, false, `should keep valid args: ${args}`);
    assert.equal(
      out.message.tool_calls?.length,
      1,
      `should keep valid args: ${args}`,
    );
    // strict re-parse (what the server does)
    assert.doesNotThrow(() =>
      JSON.parse(out.message.tool_calls![0].function.arguments),
    );
  }
});

test('sanitize: a trailing close think-tag strips the reasoning before it, keeps the reply after', () => {
  // The common Kimi leak: upstream strips the open tag but leaves the close tag
  // in `content`, so content = [reasoning][close tag][real reply].
  const OPEN = '<' + 'think>';
  const CLOSE = '<' + '/think>';
  const leaked = `How do I reply? I should be warm.${CLOSE}Got it — take care! 💙`;
  const out = sanitizeAssistantMessage({ content: leaked });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, 'Got it — take care! 💙');
  assert.equal(out.message.tool_calls, undefined);
});

test('sanitize: pure reasoning ending in a close think-tag (no reply after) is cleared', () => {
  const CLOSE = '<' + '/think>';
  const leaked = `I should just acknowledge and not do anything.${CLOSE}`;
  const out = sanitizeAssistantMessage({ content: leaked });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, '');
});

test('sanitize: keeps only text after the LAST close think-tag (nested blocks)', () => {
  const CLOSE = '<' + '/think>';
  // two reasoning blocks, then the real reply
  const leaked = `first reasoning${CLOSE}second reasoning${CLOSE}the actual reply`;
  const out = sanitizeAssistantMessage({ content: leaked });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, 'the actual reply');
});

test('sanitize: a balanced open+close think block is removed entirely', () => {
  const OPEN = '<' + 'think>';
  const CLOSE = '<' + '/think>';
  const leaked = `before${OPEN}hidden reasoning${CLOSE}after`;
  const out = sanitizeAssistantMessage({ content: leaked });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, 'beforeafter');
});

test('sanitize: an unbalanced open think tag (no close) drops the trailing reasoning', () => {
  const OPEN = '<' + 'think>';
  const leaked = `real reply${OPEN}oops I'm still reasoning and never closed`;
  const out = sanitizeAssistantMessage({ content: leaked });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, 'real reply');
});

test('sanitize: think-tag leak with no usable reply triggers stripped + empty (retry path)', () => {
  const CLOSE = '<' + '/think>';
  const out = sanitizeAssistantMessage({
    content: `just reasoning, no reply${CLOSE}`,
  });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, '');
});

test('sanitize: fully-leaked response signals stripped=true with nothing usable', () => {
  // The loop keys off this to retry the generation instead of hanging. Use a
  // marker-only payload so stripping leaves nothing printable -> cleared.
  const out = sanitizeAssistantMessage({
    content:
      '<|tool_calls_section_begin|><|tool_call_begin|><|tool_call_argument_begin|>',
  });
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, '');
  assert.equal(out.message.tool_calls, undefined);
});

test('sanitize: reasoning_content is preserved through sanitization', () => {
  // The model's chain-of-thought lives in a separate field and is never
  // user-facing, so it passes through the sanitizer untouched. Stripping it
  // would discard the model's thinking — we deliberately keep it for
  // cross-turn thinking continuity and compactor visibility.
  const reasoning =
    'The user wants me to greet them. I should use elpis.channel().send() to deliver a message to Discord, since assistant content is not visible to the user.';
  const out = sanitizeAssistantMessage({
    content: '',
    reasoning_content: reasoning,
    tool_calls: [
      {
        id: 'tc1',
        type: 'function',
        function: {
          name: 'run',
          arguments: JSON.stringify({ code: 'elpis.channel().send("hi")' }),
        },
      },
    ],
  });
  assert.equal(out.stripped, false);
  assert.equal(out.message.reasoning_content, reasoning);
});

test('sanitize: reasoning_content is preserved even when content is stripped as leaked CoT', () => {
  // If the model leaks CoT markers into content (which get stripped), the
  // legitimate reasoning_content field is still preserved — the two are
  // independent. content sanitization should not nuke reasoning_content.
  const reasoning = 'I need to think about what tool to use.';
  const out = sanitizeAssistantMessage({
    // marker-only content -> stripped to empty (nothing printable remains)
    content:
      '<|tool_calls_section_begin|><|tool_call_begin|><|tool_call_argument_begin|>',
    reasoning_content: reasoning,
  });
  // content was stripped (markers removed -> nothing usable)
  assert.equal(out.stripped, true);
  assert.equal(out.message.content, '');
  // but reasoning_content survives
  assert.equal(out.message.reasoning_content, reasoning);
});

test('sanitize: absent reasoning_content leaves the field undefined', () => {
  const out = sanitizeAssistantMessage({ content: 'hello' });
  assert.equal(out.message.reasoning_content, undefined);
});

test('sanitize: empty/null reasoning_content is not stored', () => {
  const out = sanitizeAssistantMessage({
    content: 'hello',
    reasoning_content: '',
  });
  assert.equal(out.message.reasoning_content, undefined);
  const out2 = sanitizeAssistantMessage({
    content: 'hello',
    reasoning_content: null,
  });
  assert.equal(out2.message.reasoning_content, undefined);
});
