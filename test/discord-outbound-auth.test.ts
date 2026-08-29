import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuildConfig } from '../src/config.js';
import { createDiscord } from '../src/discord/discord.js';
import { buildTestAgent, makeConfig } from './helpers.js';

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
