import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuildConfig } from '../src/config.js';
import { createDiscord } from '../src/discord/discord.js';
import { buildTestAgent, makeConfig, makeStubLLM } from './helpers.js';
import type { CompleteResult } from '../src/llm/llm.js';

const guild: GuildConfig = {
  id: 'g1',
  slug: 'home',
  slashCommands: false,
  quietHours: null,
  timezone: null,
  channels: { '1002': 'direct' },
  channelAllowSend: { '1002': true },
};

function fetchedChannel(guildId: string, onSend: () => void) {
  return {
    name: 'general',
    guildId,
    isTextBased: () => true,
    isThread: () => false,
    send: async () => {
      onSend();
    },
  };
}

test('Discord send revalidates fetched channel guild before delivery', async () => {
  const { agent, config, cleanup } = buildTestAgent({
    config: {
      discord: { ...makeConfig().discord, guilds: [guild] },
    },
    tmpPrefix: 'harness-discord-outbound-auth-',
  });
  const { client } = createDiscord(config, agent);
  let sends = 0;
  Object.defineProperty(client.channels, 'fetch', {
    configurable: true,
    value: async () => fetchedChannel('unconfigured-guild', () => sends++),
  });

  await assert.rejects(
    () => agent.send('1002', 'must not cross'),
    /fetched channel is not configured/,
  );
  assert.equal(sends, 0);

  Object.defineProperty(client.channels, 'fetch', {
    configurable: true,
    value: async () => fetchedChannel('g1', () => sends++),
  });
  await agent.send('1002', 'configured destination');
  assert.equal(sends, 1);

  agent.stop();
  client.destroy();
  cleanup();
});

test('Discord replies use first chunk only and never retry a rejected reference', async () => {
  const { agent, config, cleanup } = buildTestAgent({
    config: { discord: { ...makeConfig().discord, guilds: [guild] } },
  });
  const { client } = createDiscord(config, agent);
  const payloads: any[] = [];
  let fail = false;
  Object.defineProperty(client.channels, 'fetch', {
    configurable: true,
    value: async (id: string) => {
      assert.equal(id, '1002');
      return {
        ...fetchedChannel('g1', () => {}),
        send: async (payload: any) => {
          payloads.push(payload);
          if (fail) throw new Error('reference unavailable');
        },
      };
    },
  });
  try {
    await agent.send('1002', 'a'.repeat(4000), {
      replyTo: '123',
      files: [{ path: '/tmp/example.txt' }],
    });
    assert.deepEqual(payloads[0].reply, {
      messageReference: '123',
      failIfNotExists: true,
    });
    assert.deepEqual(payloads[0].allowedMentions, { repliedUser: false });
    assert.equal(payloads[0].files.length, 1);
    for (const payload of payloads.slice(1)) {
      assert.equal(payload.reply, undefined);
      assert.equal(payload.files, undefined);
    }
    payloads.length = 0;
    fail = true;
    await assert.rejects(
      agent.send('1002', 'a'.repeat(4000), { replyTo: '123' }),
      /reference unavailable/,
    );
    assert.equal(payloads.length, 1);
    fail = false;
    payloads.length = 0;
    await agent.send('1002', 'plain');
    assert.deepEqual(payloads, [{ content: 'plain' }]);
  } finally {
    agent.stop();
    client.destroy();
    cleanup();
  }
});

for (const [label, channel] of [
  ['missing', null],
  ['non-text', { isTextBased: () => false }],
  ['non-sendable text', { isTextBased: () => true }],
] as const) {
  for (const replyTo of [undefined, '123']) {
    test(`Discord rejects ${label} channels with reply=${replyTo !== undefined}`, async () => {
      const fixture = buildTestAgent({
        config: { discord: { ...makeConfig().discord, guilds: [guild] } },
      });
      const { client } = createDiscord(fixture.config, fixture.agent);
      const fetched: string[] = [];
      Object.defineProperty(client.channels, 'fetch', {
        configurable: true,
        value: async (id: string) => {
          fetched.push(id);
          return channel;
        },
      });
      try {
        await assert.rejects(
          fixture.agent.send(
            '1002',
            'ordinary message',
            replyTo === undefined ? undefined : { replyTo },
          ),
          /channel is not sendable/,
        );
        assert.deepEqual(fetched, ['1002']);
      } finally {
        fixture.agent.stop();
        client.destroy();
        fixture.cleanup();
      }
    });
  }
}

for (const [label, channel] of [
  ['missing', null],
  ['non-text', { isTextBased: () => false }],
  ['non-sendable text', { isTextBased: () => true }],
] as const) {
  test(
    `header through Discord adapter records failure for ${label} channel`,
    { timeout: 10000 },
    async () => {
      let calls = 0;
      const fetched: string[] = [];
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      };
      const fixture = buildTestAgent({
        config: {
          discord: {
            ...makeConfig().discord,
            guilds: [{ ...guild, slug: 'example' }],
          },
        },
        llm: {
          ...makeStubLLM(),
          complete: async (): Promise<CompleteResult> => {
            calls++;
            if (calls > 1) {
              fixture.agent.stop();
              return {
                message: { role: 'assistant', content: '' },
                usage,
                stripped: false,
                completionStatus: 'complete',
              };
            }
            return {
              message: {
                role: 'assistant',
                content: '[send to=example/general]\nordinary message',
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
          },
        },
      });
      const { client } = createDiscord(fixture.config, fixture.agent);
      Object.defineProperty(client.channels, 'fetch', {
        configurable: true,
        value: async (id: string) => {
          fetched.push(id);
          return channel;
        },
      });
      try {
        const running = fixture.agent.loop();
        fixture.agent.enqueue({
          id: 'delivery-example',
          channelId: '1002',
          channelName: 'general',
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
        assert.ok(fetched.length > 0);
        assert.ok(fetched.every((id) => id === '1002'));
        const messages = fixture.agent.messagesForTest;
        assert.deepEqual(
          messages.flatMap((message) => message.sends ?? []),
          [],
        );
        const toolIndex = messages.findIndex(
          (message) => message.role === 'tool',
        );
        const failureIndex = messages.findIndex(
          (message) =>
            message.role === 'user' &&
            message.content?.startsWith(
              '[harness: header send did not complete',
            ),
        );
        assert.ok(toolIndex >= 0 && failureIndex > toolIndex);
        assert.ok(
          !messages.some((message) =>
            message.content?.startsWith('[harness: header message delivered'),
          ),
        );
      } finally {
        fixture.agent.stop();
        client.destroy();
        fixture.cleanup();
      }
    },
  );
}
