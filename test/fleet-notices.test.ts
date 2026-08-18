// Unit tests for Agent.notifyFleet: a fleet runner's notice enters
// the one history via the scheduler/bg-settle idiom — INTERNAL_CHANNEL_ID
// provenance, channelName 'fleet', author 'fleet'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLM } from '../src/llm/llm.js';
import { buildTestAgent, EMPTY_WAKE } from './helpers.js';

test('notifyFleet: enqueues a [fleet ...] notice with fleet provenance', () => {
  const { agent } = buildTestAgent({ tmpPrefix: 'harness-fleet-notices-' });

  assert.equal(agent.inboundQueueLengthForTest, 0);
  agent.notifyFleet('[fleet brisk-otter finished turn] done');
  assert.equal(agent.inboundQueueLengthForTest, 1, 'a fleet notice was queued');
  agent.stop();
});

test('notifyFleet: the notice drains into the one history with fleet provenance', async () => {
  const llm = {
    complete: () => Promise.resolve(EMPTY_WAKE),
    summarize: () => Promise.resolve('SUMMARY'),
  } as unknown as LLM;
  const { agent } = buildTestAgent({
    llm,
    config: { heartbeat: { intervalMs: 0, maxIntervalMs: 0, reflectionMinMessages: 99, socialNudgeMs: 12 * 60 * 60 * 1000 } },
    tmpPrefix: 'harness-fleet-notices-drain-',
  });

  agent.notifyFleet('[fleet brisk-otter finished turn] done');
  void agent.loop();
 // Allow the loop's microtask chain to drain the queued notice.
  await new Promise((r) => setTimeout(r, 20));

  const users = agent.messagesForTest.filter((m) => m.role === 'user');
  assert.ok(
    users.some((m) => m.content.includes('channel="fleet"') && m.content.includes('author="fleet"')
      && m.content.includes('[fleet brisk-otter finished turn] done')),
    'the notice is in history with fleet provenance and intact content',
  );
  agent.stop();
});
