import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GuildConfig } from '../src/config.js';
import { buildTestAgent, makeConfig } from './helpers.js';

const GUILDS: GuildConfig[] = [
  {
    id: 'g1',
    slug: 'alpha',
    slashCommands: false,
    quietHours: null,
    timezone: null,
    channels: { '1001': 'direct' },
  },
  {
    id: 'g2',
    slug: 'beta',
    slashCommands: false,
    quietHours: null,
    timezone: null,
    channels: { '2001': 'direct' },
  },
  {
    id: 'g3',
    slug: 'gamma',
    slashCommands: false,
    quietHours: null,
    timezone: null,
    channels: { '3001': 'direct' },
  },
];

function buildAgent() {
  const built = buildTestAgent({
    config: {
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        socialNudgeMs: 1,
        reflectionMinMessages: 1,
      },
      discord: { ...makeConfig().discord, guilds: GUILDS },
    },
    tmpPrefix: 'harness-hb-minimal-multi-',
  });
  built.agent.primeForHeartbeatTest();
  return built;
}

function lastSendAt(
  agent: ReturnType<typeof buildAgent>['agent'],
): Map<string, number> {
  return agent['lastSendAt'] as Map<string, number>;
}

function channelDirectory(
  agent: ReturnType<typeof buildAgent>['agent'],
): import('../src/store/channels.js').ChannelDirectory {
  return (
    agent['deps'] as {
      channels: import('../src/store/channels.js').ChannelDirectory;
    }
  ).channels;
}

async function fireBeat(
  agent: ReturnType<typeof buildAgent>['agent'],
): Promise<string> {
  await agent.fireHeartbeatForTest();
  const queue = agent['inbound'] as { content: string }[];
  assert.equal(queue.length, 1, 'beat enqueued');
  const content = queue[0].content;
  queue.length = 0;
  return content;
}

test('per-guild lastSendAt: a send stamps only its own guild', async () => {
  const { agent, cleanup } = buildAgent();
  try {
    const old = Date.now() - 1_000_000;
    lastSendAt(agent).set('alpha', old);
    lastSendAt(agent).set('beta', old);
    await agent.send('1001', 'hi alpha');
    assert.ok(lastSendAt(agent).get('alpha')! > old);
    assert.equal(lastSendAt(agent).get('beta'), old);
  } finally {
    agent.stop();
    cleanup();
  }
});

test('a send into a thread stamps the parent guild', async () => {
  const { agent, cleanup } = buildAgent();
  try {
    channelDirectory(agent).set('thread-9', 'my-thread', 'g1', '1001');
    const old = Date.now() - 1_000_000;
    lastSendAt(agent).set('alpha', old);
    await agent.send('thread-9', 'hi from the thread');
    assert.ok(lastSendAt(agent).get('alpha')! > old);
  } finally {
    agent.stop();
    cleanup();
  }
});

test('a send to an unresolvable channel stamps no guild', async () => {
  const { agent, cleanup } = buildAgent();
  try {
    const before = new Map(lastSendAt(agent));
    await agent.send('totally-unknown-channel', 'hello');
    assert.deepEqual(lastSendAt(agent), before);
  } finally {
    agent.stop();
    cleanup();
  }
});

test('per-guild silence cannot leak into heartbeat content', async () => {
  const { agent, cleanup } = buildAgent();
  try {
    const old = Date.now() - 365 * 24 * 60 * 60 * 1000;
    lastSendAt(agent).set('alpha', old);
    lastSendAt(agent).set('beta', old - 1);
    lastSendAt(agent).set('gamma', old - 2);
    agent['messagesSinceReflection'] = 10;
    assert.equal(await fireBeat(agent), '[heartbeat]');
  } finally {
    agent.stop();
    cleanup();
  }
});
