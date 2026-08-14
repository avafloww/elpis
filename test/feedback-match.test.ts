// Unit tests for the offline content-matcher in scripts/feedback.ts — the ONLY
// place fuzzy localization lives. Imported through tsx/esm, same as bench tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localizeByContent, renderContext, type LoadedFile } from '../scripts/feedback.js';
import { chunkText } from '../src/discord/discord.js';
import type { ChatMessage } from '../src/llm/llm.js';

function toolWithSend(channel: string, text: string): ChatMessage {
  return { role: 'tool', content: '[run ok]', tool_call_id: 'x', sends: [{ channel, text }] };
}

test('localizeByContent: exact single-chunk send matches', () => {
  const files: LoadedFile[] = [{ file: '/a.jsonl', messages: [toolWithSend('100', 'hello world')] }];
  const loc = localizeByContent(files, '100', 'hello world');
  assert.deepEqual(loc, { file: '/a.jsonl', sendChannel: '100', sendText: 'hello world' });
});

test('localizeByContent: matches a chunk of a long (multi-chunk) send across the trimmed boundary', () => {
 // Build a >1900-char send so chunkText splits it; react to the 2nd chunk.
  const para1 = 'A'.repeat(1850);
  const para2 = 'B'.repeat(400);
  const full = para1 + '\n' + para2;             // chunkText splits near the newline
  const chunks = chunkText(full);
  assert.ok(chunks.length >= 2, 'precondition: send splits into >=2 chunks');
  const files: LoadedFile[] = [{ file: '/a.jsonl', messages: [toolWithSend('100', full)] }];
  const loc = localizeByContent(files, '100', chunks[1]);
  assert.equal(loc?.sendText, full);
});

test('localizeByContent: no match returns null; wrong channel does not match', () => {
  const files: LoadedFile[] = [{ file: '/a.jsonl', messages: [toolWithSend('100', 'hello')] }];
  assert.equal(localizeByContent(files, '100', 'nope'), null);
  assert.equal(localizeByContent(files, '200', 'hello'), null);
});

test('localizeByContent: identical repeated sends → newest file/message wins', () => {
  const older: LoadedFile = { file: '/old.jsonl', messages: [toolWithSend('100', 'done')] };
  const newer: LoadedFile = { file: '/new.jsonl', messages: [toolWithSend('100', 'earlier'), toolWithSend('100', 'done')] };
 // Caller passes newest-first.
  const loc = localizeByContent([newer, older], '100', 'done');
  assert.equal(loc?.file, '/new.jsonl');
});

test('renderContext: renders a window ending at the matched send', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'how far apart for tomatoes?', channel: '100' },
    { role: 'assistant', content: 'let me answer', tool_calls: [{ id: 't1', type: 'function', function: { name: 'run', arguments: '{}' } }] },
    toolWithSend('100', '18–24 inches apart'),
  ];
  const out = renderContext(messages, '100', '18–24 inches apart', 12);
  assert.match(out, /tomatoes/);
  assert.match(out, /18–24 inches apart/);
});
