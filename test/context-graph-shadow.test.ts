import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';

import type { InboundMessage } from '../src/agent.js';
import {
  ContextGraphShadowRecorder,
  buildShadowProjectionPlan,
} from '../src/context/shadow.js';
import {
  ContextGraphStore,
  hashContextBytes,
} from '../src/store/context-graph.js';
import { openDatabase } from '../src/store/db.js';
import { buildTestAgent, EMPTY_WAKE, makeStubLLM } from './helpers.js';

function fixture(): {
  directory: string;
  database: DatabaseSync;
  recorder: ContextGraphShadowRecorder;
} {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-context-shadow-'),
  );
  const database = openDatabase(directory);
  return {
    directory,
    database,
    recorder: new ContextGraphShadowRecorder(new ContextGraphStore(database)),
  };
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'message-1',
    channelId: 'channel-a',
    channelName: 'room-a',
    guildId: 'guild-a',
    guildSlug: 'example',
    author: 'Bramble',
    authorId: 'person-a',
    content: 'world A canary',
    createdAt: '2026-01-02T03:04:05.000Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    kind: 'discord',
    ...overrides,
  };
}

test('shadow ingress routes before recording and is idempotent by source identity', () => {
  const value = fixture();
  try {
    const message = inbound();
    const first = value.recorder.recordInbound(message);
    const repeated = value.recorder.recordInbound(message);
    assert.equal(repeated.sequence, first.sequence);
    assert.equal(first.worldId, 'world:discord:guild:guild-a');
    assert.equal(first.kind, 'inbound:discord');
    assert.deepEqual(JSON.parse(first.payloadJson), {
      schemaVersion: 1,
      id: 'message-1',
      source: null,
      transport: null,
      kind: 'discord',
      channelId: 'channel-a',
      channelName: 'room-a',
      guildId: 'guild-a',
      guildSlug: 'example',
      policyChannelId: null,
      originWorldId: null,
      author: 'Bramble',
      authorId: 'person-a',
      bot: false,
      content: 'world A canary',
      createdAt: '2026-01-02T03:04:05.000Z',
      replyTo: null,
      forwarded: null,
      mentions: [],
      attachments: [],
      wakeClass: 'wake',
      sendScope: null,
      sends: null,
    });
    const count = value.database
      .prepare('SELECT count(*) AS count FROM context_world_events')
      .get() as { count: number };
    assert.equal(count.count, 1);
    assert.throws(
      () => value.recorder.recordInbound({ ...message, content: 'changed' }),
      /context event identity conflict/,
    );
  } finally {
    value.database.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test('shadow ingress keeps malformed source timestamps idempotent', () => {
  const { database, recorder } = fixture();
  try {
    const message = inbound({ createdAt: 'not-a-timestamp' });
    const first = recorder.recordInbound(message);
    const repeated = recorder.recordInbound(message);
    assert.equal(first.occurredAt, 0);
    assert.deepEqual(repeated, first);
  } finally {
    database.close();
  }
});

test('Agent.enqueue attaches the durable graph identity before FIFO drain', () => {
  const built = buildTestAgent({
    agentDeps: ({ db }) => ({
      contextGraphShadow: new ContextGraphShadowRecorder(
        new ContextGraphStore(db),
      ),
    }),
  });
  try {
    const message = inbound();
    built.agent.enqueue(message);
    assert.deepEqual(message.contextGraphLineage, {
      worldId: 'world:discord:guild:guild-a',
      eventId: message.contextGraphLineage?.eventId,
      sequence: 1,
    });
    assert.match(
      message.contextGraphLineage?.eventId ?? '',
      /^event:ingress:[0-9a-f]{64}$/,
    );
  } finally {
    built.scheduler.stop();
    built.db.close();
    built.cleanup();
  }
});

test('shadow projection plans retain lineage and blockers without request content', () => {
  const privateSystem = 'PRIVATE_SYSTEM_CANARY';
  const localContent = 'LOCAL_CONTENT_CANARY';
  const foreignContent = 'FOREIGN_CONTENT_CANARY';
  const plan = buildShadowProjectionPlan({
    wakeLineage: {
      worldId: 'world:discord:guild:guild-a' as any,
      eventId: 'event:ingress:wake' as any,
      sequence: 3,
    },
    messages: [
      { role: 'system', content: privateSystem },
      {
        role: 'user',
        content: localContent,
        worldId: 'world:discord:guild:guild-a' as any,
        eventId: 'event:ingress:local' as any,
      },
      { role: 'assistant', content: 'UNLINEAGED_CONTENT_CANARY' },
      {
        role: 'user',
        content: foreignContent,
        worldId: 'world:discord:guild:guild-b' as any,
        eventId: 'event:ingress:foreign' as any,
      },
    ],
  });
  assert.deepEqual(plan.localEventIds, ['event:ingress:local']);
  assert.deepEqual(plan.foreignWorlds, [
    { worldId: 'world:discord:guild:guild-b', messageCount: 1 },
  ]);
  assert.deepEqual(plan.unlineagedRoles, {
    system: 0,
    user: 0,
    assistant: 1,
    tool: 0,
  });
  assert.deepEqual(plan.blockers, [
    'legacy_mixed_system',
    'unlineaged_history',
    'multiple_worlds',
  ]);
  assert.equal(
    plan.systemLayers[0]?.byteLength,
    Buffer.byteLength(privateSystem),
  );
  assert.match(plan.systemLayers[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(plan);
  for (const forbidden of [
    privateSystem,
    localContent,
    foreignContent,
    'UNLINEAGED_CONTENT_CANARY',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('shadow plans flag duplicate lineage without duplicating event identities', () => {
  const message = {
    role: 'user' as const,
    content: 'duplicate fixture',
    worldId: 'world:discord:guild:guild-a' as any,
    eventId: 'event:ingress:duplicate' as any,
  };
  const plan = buildShadowProjectionPlan({
    wakeLineage: {
      worldId: message.worldId,
      eventId: message.eventId,
      sequence: 1,
    },
    messages: [message, { ...message }],
  });
  assert.deepEqual(plan.localEventIds, [message.eventId]);
  assert.deepEqual(plan.blockers, ['duplicate_event']);
});

test('shadow recorder persists only plan metadata and final projection hashes', () => {
  const value = fixture();
  try {
    const message = inbound();
    const wake = value.recorder.recordInbound(message);
    const systemCanary = 'SYSTEM_CONTENT_MUST_NOT_PERSIST';
    const userCanary = 'USER_CONTENT_MUST_NOT_PERSIST';
    const projectionCanary = 'PROJECTION_BYTES_MUST_NOT_PERSIST';
    const projectionBytes = JSON.stringify({ messages: [projectionCanary] });
    const observer = value.recorder.prepareRequestObservation({
      wakeLineage: {
        worldId: wake.worldId,
        eventId: wake.eventId,
        sequence: wake.sequence,
      },
      messages: [
        { role: 'system', content: systemCanary },
        {
          role: 'user',
          content: userCanary,
          worldId: wake.worldId,
          eventId: wake.eventId,
          sequence: wake.sequence,
        },
      ],
    });
    assert.equal(typeof observer, 'function');
    observer?.({
      surface: 'openai-chat',
      bytes: projectionBytes,
      byteLength: Buffer.byteLength(projectionBytes),
      sha256: hashContextBytes(projectionBytes),
    });

    const plan = value.database
      .prepare(
        'SELECT plan_json, plan_hash FROM context_shadow_projection_plans',
      )
      .get() as { plan_json: string; plan_hash: string };
    const observation = value.database
      .prepare(
        `SELECT surface, actual_hash, actual_bytes, result, reason,
                expected_hash, expected_bytes
         FROM context_shadow_request_observations`,
      )
      .get() as Record<string, unknown>;
    assert.equal(plan.plan_hash, hashContextBytes(plan.plan_json));
    assert.deepEqual(
      { ...observation },
      {
        surface: 'openai-chat',
        actual_hash: hashContextBytes(projectionBytes),
        actual_bytes: Buffer.byteLength(projectionBytes),
        result: 'ineligible',
        reason: 'legacy_mixed_system',
        expected_hash: null,
        expected_bytes: null,
      },
    );
    const persisted = JSON.stringify({ plan, observation });
    for (const forbidden of [
      systemCanary,
      userCanary,
      projectionCanary,
      projectionBytes,
    ]) {
      assert.equal(persisted.includes(forbidden), false);
    }
  } finally {
    value.database.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test('Agent installs one shadow observer for the frozen request projection', async () => {
  let prepared: any;
  let llmMessages: unknown;
  let observationCalls = 0;
  const { promise: idle, resolve: onIdle } = Promise.withResolvers<void>();
  const llm = makeStubLLM({
    complete: async (messages, options) => {
      llmMessages = messages;
      assert.equal(typeof options?.observeContentProjection, 'function');
      options?.observeContentProjection?.({
        surface: 'openai-chat',
        bytes: '{"messages":[]}',
        byteLength: 15,
        sha256: 'a'.repeat(64),
      });
      return EMPTY_WAKE;
    },
  });
  const built = buildTestAgent({
    llm,
    agentDeps: {
      onIdle,
      contextGraphShadow: {
        recordInbound(message) {
          return {
            worldId: 'world:discord:guild:guild-a' as any,
            eventId: 'event:ingress:test' as any,
            sequence: 1,
          };
        },
        prepareRequestObservation(input: unknown) {
          assert.equal(
            prepared,
            undefined,
            'the plan is frozen once per outer request',
          );
          prepared = input;
          return () => {
            observationCalls++;
          };
        },
      } as any,
    },
  });
  try {
    void built.agent.loop();
    built.agent.enqueue(inbound());
    await idle;
    assert.equal(prepared.messages, llmMessages);
    assert.deepEqual(prepared.wakeLineage, {
      worldId: 'world:discord:guild:guild-a',
      eventId: 'event:ingress:test',
      sequence: 1,
    });
    assert.equal(observationCalls, 1);
  } finally {
    built.agent.stop();
    built.scheduler.stop();
    built.db.close();
    built.cleanup();
  }
});

test('shadow request planning failure does not block the provider call', async () => {
  let providerCalls = 0;
  const { promise: idle, resolve: onIdle } = Promise.withResolvers<void>();
  const built = buildTestAgent({
    llm: makeStubLLM({
      complete: async (_messages, options) => {
        providerCalls++;
        assert.equal(options?.observeContentProjection, undefined);
        return EMPTY_WAKE;
      },
    }),
    agentDeps: {
      onIdle,
      contextGraphShadow: {
        recordInbound() {
          return {
            worldId: 'world:discord:guild:guild-a' as any,
            eventId: 'event:ingress:test' as any,
            sequence: 1,
          };
        },
        prepareRequestObservation() {
          throw new Error('synthetic shadow failure');
        },
      } as any,
    },
  });
  try {
    void built.agent.loop();
    built.agent.enqueue(inbound());
    await idle;
    assert.equal(providerCalls, 1);
  } finally {
    built.agent.stop();
    built.scheduler.stop();
    built.db.close();
    built.cleanup();
  }
});

test('shadow ingress keeps Signal contacts separate and honors trusted origin worlds', () => {
  const value = fixture();
  try {
    const signal = value.recorder.recordInbound(
      inbound({
        id: 'signal-1',
        channelId: 'signal:bramble',
        channelName: 'bramble',
        guildId: undefined,
        guildSlug: undefined,
        kind: 'signal',
        transport: 'signal',
      }),
    );
    assert.equal(signal.worldId, 'world:signal:signal%3Abramble');

    const synthetic = value.recorder.recordInbound(
      inbound({
        id: 'job-1',
        channelId: '__internal__',
        channelName: 'harness',
        guildId: undefined,
        guildSlug: undefined,
        kind: 'harness',
        originWorldId: 'world:discord:guild:guild-a',
      }),
    );
    assert.equal(synthetic.worldId, 'world:discord:guild:guild-a');
  } finally {
    value.database.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});
