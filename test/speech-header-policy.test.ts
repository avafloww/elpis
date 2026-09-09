import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestAgent, makeConfig, makeStubLLM } from './helpers.js';
import type { CompleteResult } from '../src/llm/llm.js';
import type { MuteRow } from '../src/store/mutes.js';

for (const scenario of [
  'allowed',
  'muted',
  'unknown-destination',
  'incomplete',
  'unknown-status',
  'missing-status',
  'stripped',
  'unqualified',
  'guild-denied',
  'channel-denied',
  'observe-only',
  'parent-allowed',
  'parent-muted',
] as const) {
  test(`resident header respects ${scenario}`, { timeout: 10000 }, async () => {
    const parentScenario = scenario.startsWith('parent-');
    const allowed = scenario === 'allowed' || scenario === 'parent-allowed';
    const idle = Promise.withResolvers<void>();
    let calls = 0;
    let sends = 0;
    let muteActive = false;
    const mute: MuteRow = {
      channelId: parentScenario ? '1000' : '1001',
      type: 'mute',
      setBy: 'operator',
      reason: null,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const fixture = buildTestAgent({
      llm: {
        ...makeStubLLM(),
        complete: async (): Promise<CompleteResult> => {
          calls++;
          if (calls > 2) {
            fixture.agent.stop();
            idle.reject(new Error('unexpected repeated completion'));
          }
          muteActive = scenario === 'muted' || scenario === 'parent-muted';
          assert.equal(
            fixture.agent.resolveChannelRef('example/lounge'),
            '1001',
          );
          const target =
            scenario === 'unknown-destination'
              ? 'example/missing'
              : scenario === 'unqualified'
                ? 'lounge'
                : 'example/lounge';
          const result: CompleteResult = {
            message: {
              role: 'assistant',
              content: calls === 1 ? `[send to=${target}]\nhello` : '',
              tool_calls: [
                {
                  id: `wake-${calls}`,
                  type: 'function',
                  function: {
                    name: 'run',
                    arguments: JSON.stringify({
                      code: '',
                      detail: 'Choose next wake',
                      wake: { after: '1h' },
                    }),
                  },
                },
              ],
            },
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
            stripped: calls === 1 && scenario === 'stripped',
            completionStatus:
              calls === 1 && scenario === 'incomplete'
                ? 'incomplete'
                : calls === 1 && scenario === 'unknown-status'
                  ? 'unknown'
                  : 'complete',
          };
          if (calls === 1 && scenario === 'missing-status')
            delete result.completionStatus;
          return result;
        },
      },
      config: {
        discord: {
          ...makeConfig().discord,
          guilds: [
            {
              id: 'g1',
              slug: 'example',
              slashCommands: false,
              quietHours: null,
              timezone: null,
              channels: parentScenario
                ? { '1000': 'direct' }
                : { '1001': 'direct' },
              allowSend: scenario !== 'guild-denied',
              channelAllowSend: { '1001': scenario !== 'channel-denied' },
            },
          ],
        },
      },
      agentDeps: {
        send: async (channel, text) => {
          assert.equal(channel, '1001');
          assert.equal(text, 'hello');
          sends++;
        },
        mutes: {
          get: (id) => (muteActive && id === mute.channelId ? mute : null),
          set: () => {},
          clear: () => false,
          all: () => (muteActive ? [mute] : []),
        },
        onIdle: () => {
          if (calls > 0) idle.resolve();
        },
      },
    });
    const running = fixture.agent.loop();
    try {
      fixture.agent.enqueue({
        id: 'policy-example',
        channelId: '1001',
        channelName: 'lounge',
        guildId: 'g1',
        ...(parentScenario ? { policyChannelId: '1000' } : {}),
        ...(scenario === 'observe-only'
          ? { kind: 'harness' as const, sendScope: 'observe_only' as const }
          : {}),
        author: 'Bramble',
        authorId: '2001',
        content: 'hello',
        createdAt: '2026-01-01T00:00:00Z',
        replyTo: null,
        forwarded: null,
        mentions: [],
        attachments: [],
      });
      await idle.promise;
      assert.equal(sends, allowed ? 1 : 0);
      const successes = fixture.agent.messagesForTest.flatMap(
        (message) => message.sends ?? [],
      );
      assert.equal(successes.length, allowed ? 1 : 0);
      assert.ok(
        fixture.agent.messagesForTest.some(
          (message) => message.role === 'tool',
        ),
      );
    } finally {
      fixture.agent.stop();
      await running;
      fixture.cleanup();
    }
  });
}
