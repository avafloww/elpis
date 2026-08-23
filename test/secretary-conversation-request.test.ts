import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SecretaryConversationRequestError,
  dispatchSecretaryConversationRequest,
} from '../src/secretary/conversation-request.js';

const binding = {
  sessionId: 'sec-AAAAAAAAAAAAAAAAAAAAAA',
  hintMindId: 'elm-000000a1' as const,
  modelRef: 'p/secretary',
  runtime: 'kubernetes' as const,
};

test('conversation dispatcher exposes only exact pull and complete shapes', () => {
  const calls: unknown[] = [];
  const service = {
    pull(token: string) {
      calls.push({ operation: 'pull', token });
      return { binding, turn: null };
    },
    complete(token: string, turnId: string, response: any) {
      calls.push({ operation: 'complete', token, turnId, response });
      return {
        binding,
        turn: {
          id: turnId,
          sequence: 1,
          status: 'completed' as const,
          completedAt: 1,
        },
      };
    },
  };
  assert.equal(
    dispatchSecretaryConversationRequest(service, 'token', {
      protocol: 1,
      operation: 'pull',
    }).turn,
    null,
  );
  dispatchSecretaryConversationRequest(service, 'token', {
    protocol: 1,
    operation: 'complete',
    turnId: 'stn-AAAAAAAAAAAAAAAAAAAAAA',
    response: { role: 'assistant', content: 'done' },
  });
  assert.equal(calls.length, 2);
});

test('conversation dispatcher rejects spoofable scope and unknown operations pre-effect', () => {
  let calls = 0;
  const service = {
    pull() {
      calls++;
      throw new Error('must not run');
    },
    complete() {
      calls++;
      throw new Error('must not run');
    },
  } as any;
  for (const input of [
    { protocol: 1, operation: 'pull', sessionId: 'spoof' },
    {
      protocol: 1,
      operation: 'complete',
      turnId: 'x',
      response: {},
      hintMindId: 'spoof',
    },
    { protocol: 2, operation: 'pull' },
    { protocol: 1, operation: 'enqueue' },
  ]) {
    assert.throws(
      () => dispatchSecretaryConversationRequest(service, 'token', input),
      SecretaryConversationRequestError,
    );
  }
  assert.equal(calls, 0);
});
