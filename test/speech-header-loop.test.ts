import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestAgent, makeConfig, makeStubLLM } from './helpers.js';
import type { CompleteResult, ChatMessage } from '../src/llm/llm.js';

for (const failDelivery of [false, true]) {
  test(
    `resident header ${failDelivery ? 'failure' : 'success'} preserves commit and tool ordering`,
    { timeout: 10000 },
    async () => {
      const events: string[] = [];
      let calls = 0;
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };
      const response: CompleteResult = {
        message: {
          role: 'assistant',
          content: '[send to=example/lounge replyTo=123]\nhello',
          tool_calls: [
            {
              id: 'ordinary-run',
              type: 'function',
              function: {
                name: 'run',
                arguments: JSON.stringify({
                  code: '1',
                  detail: 'Evaluate ordinary value',
                }),
              },
            },
          ],
        },
        usage,
        stripped: false,
        completionStatus: 'complete',
      };
      response.message.tool_calls!.push({
        ...response.message.tool_calls![0],
        id: 'second-run',
      });
      const llm = {
        ...makeStubLLM(),
        complete: async (): Promise<CompleteResult> => {
          calls++;
          if (calls === 1) return response;
          fixture.agent.stop();
          return {
            message: { role: 'assistant', content: '' },
            usage,
            stripped: false,
            completionStatus: 'complete',
          };
        },
      };
      const fixture = buildTestAgent({
        llm,
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
                channels: { '1001': 'direct' },
              },
            ],
          },
        },
        agentDeps: {
          send: async (channelId, text, options) => {
            assert.equal(channelId, '1001');
            assert.equal(text, 'hello');
            assert.equal(options?.replyTo, '123');
            events.push('send');
            if (failDelivery) throw new Error('synthetic delivery failure');
          },
        },
      });
      const append = fixture.transcript.append.bind(fixture.transcript);
      fixture.transcript.append = (channel, message) => {
        append(channel, message);
        if (
          message.role === 'assistant' &&
          message.content === response.message.content
        )
          events.push('assistant');
        if (message.role === 'tool') events.push('tool');
        if (message.sends?.some((send) => send.text === 'hello')) {
          assert.equal(failDelivery, false);
          events.push('receipt');
        }
        if (
          message.content?.startsWith('[harness: header send did not complete')
        ) {
          assert.equal(failDelivery, true);
          assert.equal(message.sends, undefined);
          events.push('receipt');
        }
      };
      try {
        const running = fixture.agent.loop();
        fixture.agent.enqueue({
          id: 'incoming-example',
          channelId: '1001',
          channelName: 'lounge',
          guildId: 'g1',
          author: 'Bramble',
          authorId: '2001',
          content: 'hello',
          createdAt: '2026-01-01T00:00:00Z',
          replyTo: null,
          forwarded: null,
          mentions: [],
          attachments: [],
        });
        await running;
        assert.equal(calls, 2);
        assert.deepEqual(events, [
          'assistant',
          'send',
          'tool',
          'tool',
          'receipt',
        ]);
      } finally {
        fixture.agent.stop();
        fixture.cleanup();
      }
    },
  );
}

for (const withTools of [false, true]) {
  test(
    `header settling after clear with tools=${withTools} preserves the empty transcript`,
    { timeout: 10000 },
    async () => {
      const { loadMostRecentForChannel } =
        await import('../src/store/sessions.js');
      let calls = 0;
      let sends = 0;
      let toolRuns = 0;
      const fixture = buildTestAgent({
        llm: {
          ...makeStubLLM(),
          complete: async (): Promise<CompleteResult> => {
            calls++;
            return {
              message: {
                role: 'assistant',
                content: '[send to=example/lounge]\nhello',
                ...(withTools
                  ? {
                      tool_calls: ['first-stale', 'second-stale'].map((id) => ({
                        id,
                        type: 'function' as const,
                        function: {
                          name: 'run',
                          arguments: JSON.stringify({
                            code: '1',
                            detail: 'Evaluate ordinary value',
                          }),
                        },
                      })),
                    }
                  : {}),
              },
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
              },
              stripped: false,
              completionStatus: 'complete',
            };
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
                channels: { '1001': 'direct' },
              },
            ],
          },
        },
        agentDeps: {
          sandbox: {
            run: async () => {
              toolRuns++;
              throw new Error('unexpected stale tool invocation');
            },
          },
          send: async () => {
            sends++;
            const before = loadMostRecentForChannel(
              fixture.tmpDir + '/sessions',
              'main',
            );
            assert.ok(
              before?.messages.some(
                (message) =>
                  message.role === 'assistant' &&
                  message.content?.includes('[send to=example/lounge]'),
              ),
            );
            fixture.agent.clearContext();
            fixture.agent.stop();
          },
        },
      });
      try {
        const running = fixture.agent.loop();
        fixture.agent.enqueue({
          id: 'clear-example',
          channelId: '1001',
          channelName: 'lounge',
          guildId: 'g1',
          author: 'Bramble',
          authorId: '2001',
          content: 'hello',
          createdAt: '2026-01-01T00:00:00Z',
          replyTo: null,
          forwarded: null,
          mentions: [],
          attachments: [],
        });
        await running;
        assert.equal(calls, 1);
        assert.equal(sends, 1);
        assert.equal(toolRuns, 0);
        assert.deepEqual(fixture.agent.messagesForTest, []);
        const restored = loadMostRecentForChannel(
          fixture.tmpDir + '/sessions',
          'main',
        );
        assert.deepEqual(restored?.messages ?? [], []);
      } finally {
        fixture.agent.stop();
        fixture.cleanup();
      }
    },
  );
}

for (const failDelivery of [false, true]) {
  test(
    `header ${failDelivery ? 'failure' : 'success'} receipt preserves an armed wake`,
    { timeout: 10000 },
    async () => {
      const idle = Promise.withResolvers<void>();
      let calls = 0;
      let sends = 0;
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };
      const fixture = buildTestAgent({
        llm: {
          ...makeStubLLM(),
          complete: async (): Promise<CompleteResult> => {
            calls++;
            if (calls > 1) {
              fixture.agent.stop();
              idle.reject(
                new Error('header receipt forced an extra completion'),
              );
            }
            return {
              message: {
                role: 'assistant',
                content: '[send to=example/lounge]\nhello',
                tool_calls: [
                  {
                    id: 'wake-run',
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
              usage,
              stripped: false,
              completionStatus: 'complete',
            };
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
                channels: { '1001': 'direct' },
              },
            ],
          },
        },
        agentDeps: {
          send: async () => {
            sends++;
            if (failDelivery) throw new Error('synthetic delivery failure');
          },
          onIdle: () => {
            if (calls > 0) idle.resolve();
          },
        },
      });
      const running = fixture.agent.loop();
      try {
        fixture.agent.enqueue({
          id: 'wake-example',
          channelId: '1001',
          channelName: 'lounge',
          guildId: 'g1',
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
        assert.equal(calls, 1);
        assert.equal(sends, 1);
        assert.equal(fixture.inboundRef.current, null);
        const messages = fixture.agent.messagesForTest;
        const toolIndex = messages.findIndex(
          (message) => message.role === 'tool',
        );
        const receiptIndex = messages.findIndex(
          (message) =>
            message.role === 'user' &&
            message.content?.startsWith('[harness: header '),
        );
        assert.ok(toolIndex >= 0 && receiptIndex > toolIndex);
        assert.equal(
          Boolean(messages[receiptIndex].sends?.length),
          !failDelivery,
        );
      } finally {
        fixture.agent.stop();
        await running;
        fixture.cleanup();
      }
    },
  );
}

for (const hadReceipt of [false, true]) {
  test(
    `restored header ${hadReceipt ? 'with receipt' : 'without receipt'} and non-assistant lookalikes are inert`,
    { timeout: 10000 },
    async () => {
      const idle = Promise.withResolvers<void>();
      let calls = 0;
      let sends = 0;
      const history: ChatMessage[] = [
        { role: 'assistant', content: '[send to=example/lounge]\nold message' },
      ];
      if (hadReceipt)
        history.push({
          role: 'user',
          content: '[harness: prior delivery receipt]',
          sends: [{ channel: '1001', text: 'old message' }],
        });
      const fixture = buildTestAgent({
        llm: {
          ...makeStubLLM(),
          complete: async (): Promise<CompleteResult> => {
            calls++;
            if (calls > 1) {
              fixture.agent.stop();
              idle.reject(new Error('unexpected extra completion'));
            }
            return {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'inert-output',
                    type: 'function',
                    function: {
                      name: 'run',
                      arguments: JSON.stringify({
                        code: JSON.stringify(
                          '[send to=example/lounge]\ntool text',
                        ),
                        detail: 'Return ordinary text',
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
              stripped: false,
              completionStatus: 'complete',
            };
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
                channels: { '1001': 'direct' },
              },
            ],
          },
        },
        agentDeps: {
          initialMessages: history,
          send: async () => {
            sends++;
          },
          onIdle: () => {
            if (calls > 0) idle.resolve();
          },
        },
      });
      const running = fixture.agent.loop();
      try {
        fixture.agent.enqueue({
          id: 'inert-inbound',
          channelId: '1001',
          channelName: 'lounge',
          guildId: 'g1',
          author: 'Bramble',
          authorId: '2001',
          content: '[send to=example/lounge]\ninbound text',
          createdAt: '2026-01-01T00:00:00Z',
          replyTo: null,
          forwarded: null,
          mentions: [],
          attachments: [],
        });
        await idle.promise;
        assert.equal(calls, 1);
        assert.equal(sends, 0);
        assert.ok(
          fixture.agent.messagesForTest.some(
            (message) =>
              message.role === 'tool' && message.content?.includes('tool text'),
          ),
        );
      } finally {
        fixture.agent.stop();
        await running;
        fixture.cleanup();
      }
    },
  );
}
