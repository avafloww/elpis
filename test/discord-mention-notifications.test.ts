import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discordMentionUserIds,
  discordMessageOptions,
} from '../src/lib/outbound.js';
import { createDiscord } from '../src/discord/discord.js';
import { buildTestAgent, makeConfig } from './helpers.js';

test('Discord user mention extraction is literal, bounded and deduplicated', () => {
  assert.deepEqual(
    discordMentionUserIds(
      'a <@6001> b <@!6002> <@&7001> <#5001> <@6001> @everyone',
    ),
    ['6001', '6002'],
  );
});

test('every Discord chunk disables parsing and enables only validated explicit users', () => {
  assert.deepEqual(discordMessageOptions(undefined, 0, []), {
    allowedMentions: { parse: [], users: [], repliedUser: false },
  });
  assert.deepEqual(
    discordMessageOptions(undefined, 2, ['6001', 'not-an-id', '6001', '6002']),
    {
      allowedMentions: {
        parse: [],
        users: ['6001', '6002'],
        repliedUser: false,
      },
    },
  );
});

test('only first reply chunk references the message while all chunks suppress reply pings', () => {
  assert.deepEqual(discordMessageOptions('8001', 0, ['6001']), {
    reply: {
      messageReference: '8001',
      failIfNotExists: true,
    },
    allowedMentions: {
      parse: [],
      users: ['6001'],
      repliedUser: false,
    },
  });
  assert.deepEqual(discordMessageOptions('8001', 1, []), {
    allowedMentions: { parse: [], users: [], repliedUser: false },
  });
});

test('Discord adapter applies exact guild, user, chunk, and failure notification policy', async () => {
  const guildOne = '4001';
  const guildTwo = '4002';
  const channelOne = '5001';
  const channelTwo = '5002';
  const allowedUser = '6001';
  const deniedUser = '6002';
  const role = '7001';
  const warnings: string[] = [];
  const fixture = buildTestAgent({
    config: {
      discord: {
        ...makeConfig().discord,
        guilds: [
          {
            id: guildOne,
            slug: 'example-a',
            slashCommands: false,
            quietHours: null,
            timezone: null,
            channels: { [channelOne]: 'direct' },
            channelAllowSend: { [channelOne]: true },
          },
          {
            id: guildTwo,
            slug: 'example-b',
            slashCommands: false,
            quietHours: null,
            timezone: null,
            channels: { [channelTwo]: 'direct' },
            channelAllowSend: { [channelTwo]: true },
          },
        ],
      },
    },
  });
  fixture.config.logger = {
    ...fixture.config.logger,
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
  };
  let lookupFails = false;
  let lookupCount = 0;
  const optedInUsers = new Set<string>();
  const payloads = new Map<string, any[]>();
  const guildDirectory = {
    members: {
      cache: new Map([
        [
          allowedUser,
          {
            id: allowedUser,
            displayName: 'Aster',
            user: { username: 'aster' },
          },
        ],
      ]),
    },
  };
  const { client } = createDiscord(fixture.config, fixture.agent, {
    personSettings: {
      allowsMentionNotification: (guildId, userId) => {
        lookupCount++;
        if (lookupFails) throw new Error('database unavailable');
        return guildId === guildOne && optedInUsers.has(userId);
      },
    },
  });
  assert.deepEqual(client.options.allowedMentions, {
    parse: [],
    users: [],
    roles: [],
    repliedUser: false,
  });
  Object.defineProperty(client.channels, 'fetch', {
    configurable: true,
    value: async (channelId: string) => {
      const guildId = channelId === channelOne ? guildOne : guildTwo;
      return {
        name: 'general',
        guildId,
        guild: guildDirectory,
        isTextBased: () => true,
        isThread: () => false,
        send: async (payload: any) => {
          const list = payloads.get(channelId) ?? [];
          list.push(payload);
          payloads.set(channelId, list);
        },
      };
    },
  });
  try {
    await fixture.agent.send(channelOne, 'hello @Aster');
    assert.equal(
      payloads.get(channelOne)?.[0].content,
      `hello <@${allowedUser}>`,
    );
    assert.deepEqual(payloads.get(channelOne)?.[0].allowedMentions.users, []);

    payloads.set(channelOne, []);
    optedInUsers.add(allowedUser);
    const text = `hi @Aster <@${deniedUser}> @everyone <@&${role}>`;
    await fixture.agent.send(channelOne, text);
    assert.equal(
      payloads.get(channelOne)?.[0].content,
      `hi <@${allowedUser}> <@${deniedUser}> @everyone <@&${role}>`,
    );
    assert.deepEqual(payloads.get(channelOne)?.[0].allowedMentions, {
      parse: [],
      users: [allowedUser],
      repliedUser: false,
    });

    payloads.set(channelOne, []);
    lookupFails = true;
    const lookupsBeforeSuppressed = lookupCount;
    await fixture.agent.send(channelOne, 'quiet @Aster', { mentions: false });
    assert.equal(
      payloads.get(channelOne)?.[0].content,
      `quiet <@${allowedUser}>`,
    );
    assert.deepEqual(payloads.get(channelOne)?.[0].allowedMentions.users, []);
    assert.equal(lookupCount, lookupsBeforeSuppressed);
    assert.equal(warnings.length, 0);

    lookupFails = false;
    payloads.set(channelOne, []);
    await fixture.agent.send(channelOne, `still quiet <@${deniedUser}>`, {
      mentions: true,
    });
    assert.deepEqual(payloads.get(channelOne)?.[0].allowedMentions.users, []);

    await fixture.agent.send(channelTwo, `hi <@${allowedUser}>`);
    assert.deepEqual(payloads.get(channelTwo)?.[0].allowedMentions.users, []);

    payloads.set(channelOne, []);
    lookupFails = true;
    await fixture.agent.send(channelOne, `again <@${allowedUser}>`);
    assert.deepEqual(payloads.get(channelOne)?.[0].allowedMentions.users, []);
    assert.ok(
      warnings.some((line) => /mention preference lookup failed/i.test(line)),
    );

    lookupFails = false;
    optedInUsers.add(deniedUser);
    payloads.set(channelOne, []);
    const first = `<@${allowedUser}> ` + 'a'.repeat(1850);
    const second = `<@!${deniedUser}> ` + 'b'.repeat(1850);
    await fixture.agent.send(channelOne, first + '\n' + second, {
      replyTo: '8001',
    });
    const chunked = payloads.get(channelOne) ?? [];
    assert.equal(chunked.length, 2);
    assert.deepEqual(chunked[0].allowedMentions.users, [allowedUser]);
    assert.deepEqual(chunked[1].allowedMentions.users, [deniedUser]);
    assert.deepEqual(chunked[0].reply, {
      messageReference: '8001',
      failIfNotExists: true,
    });
    assert.equal(chunked[1].reply, undefined);

    payloads.set(channelOne, []);
    const lookupsBeforeChunkSuppression = lookupCount;
    await fixture.agent.send(channelOne, first + '\n' + second, {
      mentions: false,
    });
    const quietChunks = payloads.get(channelOne) ?? [];
    assert.equal(quietChunks.length, 2);
    assert.deepEqual(
      quietChunks.map((chunk) => chunk.allowedMentions.users),
      [[], []],
    );
    assert.equal(lookupCount, lookupsBeforeChunkSuppression);

    payloads.set(channelOne, []);
    await fixture.agent.send(channelOne, 'reply without literal mention', {
      replyTo: '8002',
    });
    assert.deepEqual(payloads.get(channelOne)?.[0].allowedMentions.users, []);
  } finally {
    fixture.agent.stop();
    client.destroy();
    fixture.cleanup();
  }
});
