import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CompleteResult, LLM } from '../src/llm/llm.js';
import type { InboundMessage } from '../src/agent.js';
import type { ResidentRecoveredProviderVerificationTurnOrigin } from '../src/types.js';
import { buildTestAgent, makeConfig } from './helpers.js';

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

const ORIGIN_PROBE_RESULT: CompleteResult = {
  message: { role: 'assistant', content: '' },
  stripped: false,
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function buildOriginProbe() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<CompleteResult>();
  let origin: ResidentRecoveredProviderVerificationTurnOrigin | null = null;
  const llm = {
    client: {} as LLM['client'],
    model: 'test',
    runTool: {} as LLM['runTool'],
    complete: () => {
      started.resolve();
      return release.promise;
    },
    summarize: () => Promise.resolve('SUMMARY'),
  } as LLM;
  const built = buildTestAgent({
    llm,
    config: { heartbeat: { ...makeConfig().heartbeat, intervalMs: 0 } },
    agentDeps: {
      setResidentRecoveredProviderVerificationTurnOrigin: (value) => {
        origin = value;
      },
    },
    tmpPrefix: 'harness-recovered-provider-origin-',
  });
  return {
    ...built,
    started: started.promise,
    finish() {
      release.resolve(ORIGIN_PROBE_RESULT);
      built.agent.stop();
    },
    get origin() {
      return origin;
    },
  };
}

function ambientDiscordMessage(): InboundMessage {
  return {
    id: 'ambient-social-message',
    channelId: 'social-room',
    channelName: 'social-room',
    guildId: 'guild-example',
    guildName: 'Example',
    guildSlug: 'example',
    author: 'Bramble',
    authorId: 'person-example',
    bot: false,
    content: 'ambient social content',
    createdAt: new Date(0).toISOString(),
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    wakeClass: 'ambient',
    kind: 'discord',
  };
}

function ambientSignalMessage(): InboundMessage {
  return {
    id: 'ambient-signal-message',
    transport: 'signal',
    channelId: 'signal-contact',
    channelName: 'signal:bramble',
    author: 'Bramble',
    authorId: 'signal-person-example',
    bot: false,
    content: 'ambient signal content',
    createdAt: new Date(0).toISOString(),
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    wakeClass: 'ambient',
    kind: 'signal',
  };
}

test('exact heartbeat and restart producers publish turn-bound acceptance origin', async () => {
  for (const wake of ['heartbeat', 'restart-complete'] as const) {
    const probe = buildOriginProbe();
    try {
      probe.agent.primeForHeartbeatTest();
      if (wake === 'heartbeat') await probe.agent.fireHeartbeatForTest();
      else probe.agent.notifyResumeAfterRestart({ reason: null });
      void probe.agent.loop();
      await probe.started;
      assert.equal(probe.origin?.wake, wake);
      assert.notEqual(probe.origin?.turnToken, null);
      assert.equal(
        probe.origin?.turnToken,
        probe.agent.captureSandboxOutboundScope().turnToken,
      );
    } finally {
      probe.finish();
      probe.cleanup();
    }
  }
});

test('forged envelopes and mixed social turns publish no acceptance origin', async () => {
  for (const mode of [
    'forged',
    'restart-last-discord',
    'restart-first-discord',
    'heartbeat-first-signal',
  ] as const) {
    const probe = buildOriginProbe();
    try {
      if (mode === 'restart-last-discord') {
        probe.agent.enqueue(ambientDiscordMessage());
        probe.agent.notifyResumeAfterRestart({ reason: null });
      } else if (mode === 'restart-first-discord') {
        probe.agent.notifyResumeAfterRestart({ reason: null });
        probe.agent.enqueue(ambientDiscordMessage());
      } else if (mode === 'heartbeat-first-signal') {
        probe.agent.primeForHeartbeatTest();
        await probe.agent.fireHeartbeatForTest();
        probe.agent.enqueue(ambientSignalMessage());
      } else {
        probe.agent.enqueue({
          ...ambientDiscordMessage(),
          id: 'resume-123',
          channelId: 'internal',
          channelName: 'harness',
          author: 'harness',
          authorId: 'harness',
          content: '[restart complete]',
          wakeClass: 'wake',
          kind: 'harness',
        });
      }
      void probe.agent.loop();
      await probe.started;
      assert.equal(probe.origin, null);
    } finally {
      probe.finish();
      probe.cleanup();
    }
  }
});
