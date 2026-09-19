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

test('Discord adds feedback controls after completed text and voice delivery', async () => {
  const feedbackGuild = {
    ...guild,
    feedbackReactions: true,
    channels: { '1002': 'direct', '1003': 'direct', '1004': 'direct' },
    channelAllowSend: { '1002': true, '1003': true, '1004': true },
    channelFeedbackReactions: { '1003': false, '1004': false },
  } satisfies GuildConfig;
  const channelOnlyGuild = {
    ...guild,
    id: 'g2',
    slug: 'friends',
    feedbackReactions: false,
    channels: { '2002': 'direct' },
    channelAllowSend: { '2002': true },
    channelFeedbackReactions: { '2002': true },
  } satisfies GuildConfig;
  const fixture = buildTestAgent({
    config: {
      discord: {
        ...makeConfig().discord,
        guilds: [feedbackGuild, channelOnlyGuild],
      },
    },
    tmpPrefix: 'harness-discord-feedback-reactions-',
  });
  const effects: string[] = [];
  const voice = {
    channelId: null,
    join: async () => {},
    leave: () => {},
    speak: async (text: string) => ({
      status: 'played' as const,
      transcript: text,
      playedMs: 0,
    }),
    captureSpeech: () => async (text: string) => {
      effects.push('voice');
      return {
        status: 'played' as const,
        transcript: text,
        playedMs: 0,
      };
    },
  } as never;
  const { client } = createDiscord(fixture.config, fixture.agent, { voice });
  const sends: string[] = [];
  const reactions: Array<{ message: number; emoji: string }> = [];
  Object.defineProperty(client.channels, 'fetch', {
    configurable: true,
    value: async (id: string) => ({
      ...fetchedChannel(id === '2002' ? 'g2' : 'g1', () => {}),
      isThread: () => id === '1004',
      parentId: id === '1004' ? '1002' : null,
      send: async () => {
        const message = sends.length;
        sends.push(id);
        effects.push('text');
        return {
          react: async (emoji: string) => {
            reactions.push({ message, emoji });
            effects.push(`reaction:${emoji}`);
            if (message === 0 && emoji === '👍') {
              throw new Error('synthetic reaction failure');
            }
          },
        };
      },
    }),
  });

  try {
    await fixture.agent.send('1002', 'a'.repeat(4000));
    const enabledSends = sends.length;
    assert.ok(
      enabledSends > 1,
      'fixture must exercise multiple Discord chunks',
    );
    assert.deepEqual(
      reactions,
      Array.from({ length: enabledSends }, (_unused, message) => [
        { message, emoji: '👍' },
        { message, emoji: '👎' },
      ]).flat(),
      'each delivered chunk gets both controls even when one reaction rejects',
    );
    assert.ok(
      effects.indexOf('voice') > effects.lastIndexOf('text') &&
        effects.indexOf('voice') < effects.indexOf('reaction:👍'),
      'optional controls do not delay captured speech after text delivery',
    );

    await fixture.agent.send('1003', 'channel override keeps controls off');
    assert.equal(sends.length, enabledSends + 1);
    assert.equal(reactions.length, enabledSends * 2);

    await fixture.agent.send('1004', 'thread inherits enabled parent controls');
    assert.equal(sends.length, enabledSends + 2);
    assert.deepEqual(reactions.slice(-2), [
      { message: enabledSends + 1, emoji: '👍' },
      { message: enabledSends + 1, emoji: '👎' },
    ]);

    await fixture.agent.send('2002', 'channel override enables controls');
    assert.equal(sends.length, enabledSends + 3);
    assert.deepEqual(reactions.slice(-2), [
      { message: enabledSends + 2, emoji: '👍' },
      { message: enabledSends + 2, emoji: '👎' },
    ]);
  } finally {
    fixture.agent.stop();
    client.destroy();
    fixture.cleanup();
  }
});

test('Discord error notices never receive feedback controls', async () => {
  const feedbackGuild = {
    ...guild,
    feedbackReactions: true,
  } satisfies GuildConfig;
  const fixture = buildTestAgent({
    config: {
      discord: {
        ...makeConfig().discord,
        guilds: [feedbackGuild],
        errorChannelId: '1002',
      },
    },
    tmpPrefix: 'harness-discord-error-feedback-',
  });
  const { client } = createDiscord(fixture.config, fixture.agent);
  const texts: string[] = [];
  const reactions: Array<{ message: number; emoji: string }> = [];
  Object.defineProperty(client.channels, 'fetch', {
    configurable: true,
    value: async () => ({
      ...fetchedChannel('g1', () => {}),
      send: async (payload: { content: string }) => {
        const message = texts.length;
        texts.push(payload.content);
        return {
          react: async (emoji: string) => {
            reactions.push({ message, emoji });
          },
        };
      },
    }),
  });

  try {
    await fixture.agent.send(
      '1002',
      '(internal error: resident-authored text)',
    );
    await (
      fixture.agent as unknown as { sendError(text: string): Promise<void> }
    ).sendError('(internal error: harness notice)');

    assert.deepEqual(texts, [
      '(internal error: resident-authored text)',
      '(internal error: harness notice)',
    ]);
    assert.deepEqual(reactions, [
      { message: 0, emoji: '👍' },
      { message: 0, emoji: '👎' },
    ]);
  } finally {
    fixture.agent.stop();
    client.destroy();
    fixture.cleanup();
  }
});

test('Discord feedback reactions stop after mentions authority expires without failing sent text', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const config = makeConfig();
  config.discord.guilds = [
    {
      ...guild,
      defaultTier: 'mentions',
      feedbackReactions: true,
      channels: { '1002': 'mentions' },
      channelAllowSend: { '1002': true },
    },
  ];
  let send!: (
    channelId: string,
    text: string,
    opts?: Parameters<
      Parameters<import('../src/agent.js').Agent['setSend']>[0]
    >[2],
    authorization?: Parameters<
      Parameters<import('../src/agent.js').Agent['setSend']>[0]
    >[3],
  ) => Promise<unknown>;
  let issueAuthorization!: (
    channelId: string,
    guildId: string,
    isCurrent: () => boolean,
  ) => NonNullable<Parameters<typeof send>[3]>;
  const agent = {
    setSend: (fn: typeof send) => {
      send = fn;
    },
    setOutboundSendAuthorizationIssuer: (fn: typeof issueAuthorization) => {
      issueAuthorization = fn;
    },
    enqueue: () => {},
  } as never;
  const wiring = createDiscord(config, agent);
  let current = true;
  let sends = 0;
  const reactions: string[] = [];
  Object.defineProperty(wiring.client.channels, 'fetch', {
    configurable: true,
    value: async () => ({
      ...fetchedChannel('g1', () => sends++),
      send: async () => {
        sends++;
        return {
          react: async (emoji: string) => {
            reactions.push(emoji);
            if (emoji === '👍') current = false;
          },
        };
      },
    }),
  });

  try {
    const authorization = issueAuthorization('1002', 'g1', () => current);
    await send('1002', 'a'.repeat(4000), undefined, authorization);
    assert.ok(sends > 1, 'all readable chunks survive optional control expiry');
    assert.deepEqual(reactions, ['👍']);
  } finally {
    wiring.stopTyping();
    wiring.client.destroy();
  }
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
    assert.deepEqual(payloads[0].allowedMentions, {
      parse: [],
      users: [],
      repliedUser: false,
    });
    assert.equal(payloads[0].files.length, 1);
    for (const payload of payloads.slice(1)) {
      assert.equal(payload.reply, undefined);
      assert.equal(payload.files, undefined);
      assert.deepEqual(payload.allowedMentions, {
        parse: [],
        users: [],
        repliedUser: false,
      });
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
    assert.deepEqual(payloads, [
      {
        content: 'plain',
        allowedMentions: { parse: [], users: [], repliedUser: false },
      },
    ]);
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
