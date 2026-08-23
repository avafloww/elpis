// Unit tests for the non-destructive request projection in prepareForApi.
// Stored messages remain untouched; only completed-turn reasoning is omitted
// from the provider request.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsTurn, prepareForApi } from '../src/llm/llm.js';
import type { ChatMessage } from '../src/llm/llm.js';

function mk(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { role, content, ...extra };
}
function runCall(id: string, code: string): ChatMessage {
  return mk('assistant', '', {
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name: 'run', arguments: JSON.stringify({ code }) },
      },
    ],
  });
}

// ---------- 3a: reasoning strip ----------

test('reasoning strip: kept on the current open chain, dropped before the last natural turn-end', () => {
  const msgs: ChatMessage[] = [
    mk('user', 'q1'),
    mk('assistant', 'answer1', { reasoning_content: 'old thinking' }), // last natural turn-end (boundary)
    mk('user', 'q2'),
    mk('assistant', '', {
      reasoning_content: 'current thinking',
      tool_calls: [
        {
          id: 't1',
          type: 'function',
          function: { name: 'run', arguments: '{}' },
        },
      ],
    }), // open chain
    mk('tool', '[run ok]\n2', { tool_call_id: 't1' }),
  ];
  const out = prepareForApi(msgs);
  // The boundary is the last assistant with no tool_calls (index 1); its
  // reasoning (a completed turn) is stripped, the open chain's is kept.
  assert.equal(
    out[1].reasoning_content,
    undefined,
    'prior-turn reasoning stripped',
  );
  assert.equal(
    out[3].reasoning_content,
    'current thinking',
    'open-chain reasoning kept',
  );
  // Non-destructive: inputs untouched.
  assert.equal(msgs[1].reasoning_content, 'old thinking');
});

test('reasoning strip: keeps reasoning across a user message interleaved mid-chain', () => {
  const msgs: ChatMessage[] = [
    mk('assistant', 'done', { reasoning_content: 'r0' }), // last natural turn-end
    runCall('t1', 'x'), // open chain begins
    mk('tool', '[run ok]', { tool_call_id: 't1' }),
    mk('user', 'mid-chain nudge'), // interleaved user
    mk('assistant', '', {
      reasoning_content: 'r1',
      tool_calls: [
        {
          id: 't2',
          type: 'function',
          function: { name: 'run', arguments: '{}' },
        },
      ],
    }),
  ];
  const out = prepareForApi(msgs);
  assert.equal(
    out[0].reasoning_content,
    undefined,
    'reasoning before the last turn-end is stripped',
  );
  assert.equal(
    out[4].reasoning_content,
    'r1',
    'reasoning on the open chain (after a mid-chain user) is kept',
  );
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
  const out = prepareForApi(msgs);
  assert.equal(
    out[1].reasoning_content,
    undefined,
    'reasoning stripped past boundary',
  );
  assert.deepEqual(
    out[1].thinking_blocks,
    [{ type: 'thinking', thinking: 't', signature: 's' }],
    'thinking_blocks kept',
  );
});

// ---------- endsTurn ----------
// Current boundaries come from durable v3 wake metadata. The legacy cases below
// preserve the old final-call `end && ok` rule for restored transcripts.

test('endsTurn: a bare assistant message ends a turn (legacy shape)', () => {
  const messages: ChatMessage[] = [mk('assistant', 'done')];
  assert.equal(endsTurn(messages, 0), true);
});

test('endsTurn: a non-assistant message never ends a turn (role guard)', () => {
  // Without the role check, a user/tool message with no tool_calls would fall
  // into the "no tool_calls" branch and be mistaken for a boundary.
  const messages: ChatMessage[] = [
    mk('user', 'hi'),
    mk('tool', '[run ok]', { tool_call_id: 't1' }),
  ];
  assert.equal(endsTurn(messages, 0), false);
  assert.equal(endsTurn(messages, 1), false);
});

test('endsTurn: a SUCCESSFUL run call carrying end:true ends a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"","end":true}' },
        },
      ],
    }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), true);
});

test('endsTurn: a FAILED run carrying end:true does NOT end a turn', () => {
  // Important 1: a failure has to come back to the model, so its end:true is
  // not honoured — matches src/agent.ts's `wantsEnd && result.ok` exactly.
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"","end":true}' },
        },
      ],
    }),
    mk('tool', '[run FAILED]\nboom', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('endsTurn: a run call without end does NOT end a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"1+1"}' },
        },
      ],
    }),
    mk('tool', '[run ok]\n2', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('endsTurn: unparseable arguments do not end a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{not json' },
        },
      ],
    }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('endsTurn: only the LAST tool call in a multi-call response decides', () => {
  // Legacy history used the final call only: a later sibling overrides an earlier end:true.
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"","end":true}' },
        },
        {
          id: 'b',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"1+1"}' },
        },
      ],
    }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
    mk('tool', '[run ok]\n2', { tool_call_id: 'b' }),
  ];
  assert.equal(
    endsTurn(messages, 0),
    false,
    "ended by the LAST call, which didn't request end",
  );
});

test('endsTurn: an interrupted chain (no result yet for the ending call) does not end a turn', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"","end":true}' },
        },
      ],
    }),
  ];
  assert.equal(endsTurn(messages, 0), false);
});

test('reasoning is stripped at or before the last SUCCESSFUL end:true turn-end', () => {
  // Shape: [turn-1 run+end (reasoning), tool ok, user, turn-2 run (reasoning), tool ok]
  // The boundary is the turn-1 end call; its reasoning goes, the open chain keeps its own.
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      reasoning_content: 'OLD',
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"","end":true}' },
        },
      ],
    }),
    mk('tool', '[run ok]', { tool_call_id: 'a' }),
    mk('user', 'next'),
    mk('assistant', '', {
      reasoning_content: 'NEW',
      tool_calls: [
        {
          id: 'b',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"1+1"}' },
        },
      ],
    }),
    mk('tool', '[run ok]\n2', { tool_call_id: 'b' }),
  ];
  const out = prepareForApi(messages);
  assert.equal(
    out[0].reasoning_content,
    undefined,
    'reasoning at the boundary is stripped',
  );
  assert.equal(
    out[3].reasoning_content,
    'NEW',
    'the open chain keeps its reasoning',
  );
  // Non-destructive: inputs untouched (matches the legacy-shape test above).
  assert.equal(messages[0].reasoning_content, 'OLD');
});

test('reasoning is NOT stripped ahead of a FAILED end:true call — the model needs it for the retry', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      reasoning_content: 'WHY IT FAILED',
      tool_calls: [
        {
          id: 'a',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"","end":true}' },
        },
      ],
    }),
    mk('tool', '[run FAILED]\nboom', { tool_call_id: 'a' }),
  ];
  const out = prepareForApi(messages);
  assert.equal(
    out[0].reasoning_content,
    'WHY IT FAILED',
    'no turn-end found in this array — reasoning survives the diet',
  );
});

test('endsTurn: durable v3 wake states are boundaries; elapsed/rejected/pre-arm states are not', () => {
  for (const state of ['armed', 'preempted', 'fired'] as const) {
    const messages: ChatMessage[] = [
      mk('assistant', '', {
        tool_calls: [
          {
            id: 'v3',
            type: 'function',
            function: {
              name: 'run',
              arguments: '{"code":"","wake":{"after":"1h"}}',
            },
          },
        ],
      }),
      mk('tool', '[run ok]', {
        tool_call_id: 'v3',
        run: {
          toolContractVersion: 'elpis-run-v3',
          ok: true,
          wake: {
            kind: 'after',
            state,
            requestedAt: 1,
            targetAt: 2,
            taskId: 3,
          },
        },
      }),
    ];
    assert.equal(
      endsTurn(messages, 0),
      true,
      `${state} preserves the completed yield boundary`,
    );
  }
  for (const state of ['elapsed', 'rejected'] as const) {
    const messages: ChatMessage[] = [
      mk('assistant', '', {
        tool_calls: [
          {
            id: 'v3',
            type: 'function',
            function: {
              name: 'run',
              arguments: '{"code":"","wake":{"after":"1h"}}',
            },
          },
        ],
      }),
      mk('tool', '[run ok]', {
        tool_call_id: 'v3',
        run: {
          toolContractVersion: 'elpis-run-v3',
          ok: true,
          wake: { kind: 'after', state, requestedAt: 1, targetAt: 2 },
        },
      }),
    ];
    assert.equal(
      endsTurn(messages, 0),
      false,
      `${state} continues the open chain`,
    );
  }
  const preArm: ChatMessage[] = [
    mk('assistant', '', {
      tool_calls: [
        {
          id: 'v3',
          type: 'function',
          function: {
            name: 'run',
            arguments: '{"code":"","wake":{"after":"1h"}}',
          },
        },
      ],
    }),
    mk('tool', '[run ok]', {
      tool_call_id: 'v3',
      run: {
        toolContractVersion: 'elpis-run-v3',
        ok: true,
        wake: {
          kind: 'after',
          state: 'preempted',
          requestedAt: 1,
          targetAt: 2,
        },
      },
    }),
  ];
  assert.equal(
    endsTurn(preArm, 0),
    false,
    'preemption before durable task creation is not a yield',
  );
});

test('reasoning strip recognizes a successful v3 wake boundary', () => {
  const messages: ChatMessage[] = [
    mk('assistant', '', {
      reasoning_content: 'OLD',
      tool_calls: [
        {
          id: 'v3',
          type: 'function',
          function: {
            name: 'run',
            arguments: '{"code":"","wake":{"after":"1h"}}',
          },
        },
      ],
    }),
    mk('tool', '[run ok]', {
      tool_call_id: 'v3',
      run: {
        toolContractVersion: 'elpis-run-v3',
        ok: true,
        wake: {
          kind: 'after',
          state: 'armed',
          requestedAt: 1,
          targetAt: 2,
          taskId: 3,
        },
      },
    }),
    mk('user', 'next'),
    mk('assistant', '', {
      reasoning_content: 'NEW',
      tool_calls: [
        {
          id: 'open',
          type: 'function',
          function: { name: 'run', arguments: '{"code":"1+1"}' },
        },
      ],
    }),
    mk('tool', '[run ok]\n2', { tool_call_id: 'open' }),
  ];
  const out = prepareForApi(messages);
  assert.equal(out[0].reasoning_content, undefined);
  assert.equal(out[3].reasoning_content, 'NEW');
});
