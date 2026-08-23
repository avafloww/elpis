import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTestAgent } from './helpers.js';

const NUDGE_MS = 12 * 60 * 60 * 1000;

function buildAgent(socialNudgeMs = NUDGE_MS) {
  const built = buildTestAgent({
    config: {
      heartbeat: {
        intervalMs: 0,
        maxIntervalMs: 4 * 60 * 60 * 1000,
        socialNudgeMs,
        reflectionMinMessages: 1,
      },
    },
    tmpPrefix: 'harness-hb-minimal-',
  });
  built.agent.primeForHeartbeatTest();
  return built;
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

test('heartbeat payload stays minimal past the social threshold', async () => {
  const { agent, cleanup } = buildAgent();
  try {
    (agent['lastSendAt'] as Map<string, number>).set(
      'stub',
      Date.now() - NUDGE_MS - 60_000,
    );
    agent['messagesSinceReflection'] = 10;
    assert.equal(await fireBeat(agent), '[heartbeat]');
  } finally {
    agent.stop();
    cleanup();
  }
});

test('repeated heartbeats carry the same irreducible signal', async () => {
  const { agent, cleanup } = buildAgent();
  try {
    assert.equal(await fireBeat(agent), '[heartbeat]');
    assert.equal(await fireBeat(agent), '[heartbeat]');
  } finally {
    agent.stop();
    cleanup();
  }
});

test('social-nudge configuration cannot alter heartbeat content', async () => {
  const { agent, cleanup } = buildAgent(0);
  try {
    (agent['lastSendAt'] as Map<string, number>).set(
      'stub',
      Date.now() - 365 * 24 * 60 * 60 * 1000,
    );
    assert.equal(await fireBeat(agent), '[heartbeat]');
  } finally {
    agent.stop();
    cleanup();
  }
});
