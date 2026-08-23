import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { buildTestAgent } from './helpers.js';
import { loadMostRecentMain } from '../src/store/sessions.js';
import {
  clearThinkingConfirmCustomId,
  clearThinkingCancelCustomId,
  SLASH_COMMAND_NAMES,
} from '../src/discord/discord.js';
import type { ChatMessage } from '../src/llm/llm.js';

test('clear-thinking custom-ids are namespaced by user and distinct from /clear', () => {
  assert.equal(clearThinkingConfirmCustomId('u1'), 'clear-thinking-confirm:u1');
  assert.equal(clearThinkingCancelCustomId('u1'), 'clear-thinking-cancel:u1');
  assert.notEqual(
    clearThinkingConfirmCustomId('u1'),
    clearThinkingConfirmCustomId('u2'),
  );
  assert.ok(
    (SLASH_COMMAND_NAMES as readonly string[]).includes('clear-thinking'),
  );
});

test('clearThinking: strips thinking_blocks + reasoning_items in memory and on disk, keeps everything else', () => {
  const { agent, tmpDir, cleanup } = buildTestAgent();
  try {
    const msgs = agent.messagesForTest;
    msgs.push({ role: 'user', content: 'hi' });
    const assistant: ChatMessage = {
      role: 'assistant',
      content: 'answer',
      reasoning_content: 'kept',
      thinking_blocks: [{ type: 'thinking', thinking: 't', signature: 's' }],
      reasoning_items: [
        {
          id: 'rs-old',
          type: 'reasoning',
          summary: [],
          encrypted_content: 'gAAA-old-model',
        },
      ],
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'run', arguments: '{"end":true}' },
        },
      ],
    };
    msgs.push(assistant);

    const n = agent.clearThinking();
    assert.equal(n, 1);
    // In-memory: both provider-native replay payloads gone, everything else intact.
    assert.equal(agent.messagesForTest[1].thinking_blocks, undefined);
    assert.equal(agent.messagesForTest[1].reasoning_items, undefined);
    assert.equal(agent.messagesForTest[1].content, 'answer');
    assert.equal(agent.messagesForTest[1].reasoning_content, 'kept');
    assert.ok(agent.messagesForTest[1].tool_calls);

    // On disk: the rewritten transcript has neither replay payload form.
    const loaded = loadMostRecentMain(path.join(tmpDir, 'sessions'));
    assert.ok(loaded);
    const persisted = loaded!.messages.find((m) => m.role === 'assistant');
    assert.ok(persisted);
    assert.equal(persisted!.thinking_blocks, undefined);
    assert.equal(persisted!.reasoning_items, undefined);
    assert.equal(persisted!.content, 'answer');
  } finally {
    cleanup();
  }
});
