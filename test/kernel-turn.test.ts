import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatMessage } from '../src/llm/llm.js';
import { applyKernelTurn, dispatchKernelTools } from '../src/kernel/turn.js';

function assistant(...names: string[]): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: names.map((name, index) => ({
      id: `call-${index}`,
      type: 'function',
      function: { name, arguments: JSON.stringify({ index }) },
    })),
  };
}

test('applyKernelTurn appends the assistant before ordered tool results', async () => {
  const events: string[] = [];
  const message = assistant('run');
  const applied = await applyKernelTurn(
    message,
    async () => {
      events.push('handle');
      return { content: 'done' };
    },
    {
      appendAssistant: (value) => events.push(`assistant:${value.role}`),
      appendTool: (value) => events.push(`tool:${value.content}`),
    },
  );
  assert.deepEqual(events, ['assistant:assistant', 'handle', 'tool:done']);
  assert.equal(applied.assistant, message);
  assert.equal(applied.shouldContinue, true);
  assert.equal(applied.toolMessages.length, 1);
});

test('applyKernelTurn ends without invoking tools when none were requested', async () => {
  const events: string[] = [];
  const applied = await applyKernelTurn(
    assistant(),
    async () => {
      throw new Error('unexpected tool');
    },
    {
      appendAssistant: () => events.push('assistant'),
      appendTool: () => events.push('tool'),
    },
  );
  assert.deepEqual(events, ['assistant']);
  assert.equal(applied.shouldContinue, false);
  assert.deepEqual(applied.toolMessages, []);
});

test('applyKernelTurn rejects non-assistant messages before appending', async () => {
  let appended = false;
  await assert.rejects(
    applyKernelTurn(
      { role: 'user', content: 'no' },
      async () => ({ content: 'unexpected' }),
      {
        appendAssistant: () => {
          appended = true;
        },
        appendTool: () => {
          appended = true;
        },
      },
    ),
    /requires an assistant message/,
  );
  assert.equal(appended, false);
});

test('dispatchKernelTools executes and appends calls in order', async () => {
  const handled: string[] = [];
  const appended: ChatMessage[] = [];
  const messages = await dispatchKernelTools(
    assistant('first', 'second'),
    async (call, context) => {
      handled.push(
        `${context.callIndex}/${context.callCount}:${call.function.name}`,
      );
      return {
        content: `result:${call.function.arguments}`,
        ...(context.callIndex === 1
          ? { sends: [{ channel: 'room', text: 'sent' }] }
          : {}),
      };
    },
    (message) => {
      appended.push(message);
    },
  );

  assert.deepEqual(handled, ['0/2:first', '1/2:second']);
  assert.deepEqual(messages, appended);
  assert.deepEqual(messages, [
    { role: 'tool', tool_call_id: 'call-0', content: 'result:{"index":0}' },
    {
      role: 'tool',
      tool_call_id: 'call-1',
      content: 'result:{"index":1}',
      sends: [{ channel: 'room', text: 'sent' }],
    },
  ]);
});

test('dispatchKernelTools is a no-op without calls', async () => {
  let invoked = false;
  const messages = await dispatchKernelTools(
    { tool_calls: [] },
    async () => {
      invoked = true;
      return { content: 'unexpected' };
    },
    () => {
      invoked = true;
    },
  );
  assert.deepEqual(messages, []);
  assert.equal(invoked, false);
});

test('dispatchKernelTools stops before appending a failed call', async () => {
  const appended: string[] = [];
  await assert.rejects(
    dispatchKernelTools(
      assistant('ok', 'fail', 'never'),
      async (call) => {
        if (call.function.name === 'fail') throw new Error('tool failed');
        return { content: call.function.name };
      },
      (message) => appended.push(message.content),
    ),
    /tool failed/,
  );
  assert.deepEqual(appended, ['ok']);
});
