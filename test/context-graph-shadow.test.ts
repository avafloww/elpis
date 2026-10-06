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
import { freezeSystemLayer } from '../src/llm/prompt.js';
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

test('active graph ingress keeps Discord and Signal out of the legacy FIFO', () => {
  const accepted: InboundMessage[] = [];
  const muteRows = new Map<string, any>();
  let runWakeRecoveryCalls = 0;
  let providerCalls = 0;
  const built = buildTestAgent({
    llm: makeStubLLM({
      complete: async () => {
        providerCalls++;
        return EMPTY_WAKE;
      },
    }),
    agentDeps: {
      scheduler: {
        create: () => {
          throw new Error('active Agent cannot create legacy run wakes');
        },
        list: () => {
          runWakeRecoveryCalls++;
          return [];
        },
        update: () => {
          throw new Error('active Agent cannot update legacy run wakes');
        },
        markDone: () => {
          throw new Error('active Agent cannot complete legacy run wakes');
        },
        getById: () => null,
      },
      mutes: {
        get: (channelId) => muteRows.get(channelId) ?? null,
        set: (channelId, type, setBy, reason = null) =>
          muteRows.set(channelId, {
            channelId,
            type,
            setBy,
            reason,
            createdAt: '2026-01-02T03:04:05.000Z',
          }),
        clear: (channelId) => muteRows.delete(channelId),
        all: () => [...muteRows.values()],
      },
      contextGraphActive: {
        recordInbound(message) {
          accepted.push(message);
        },
      },
    },
  });
  try {
    assert.equal(runWakeRecoveryCalls, 0);
    void built.agent.loop();
    const before = built.agent.contextSnapshot().messages;
    const discord = inbound();
    const signal = inbound({
      id: 'signal-1',
      channelId: 'signal:bramble',
      channelName: 'bramble',
      guildId: undefined,
      guildSlug: undefined,
      kind: 'signal',
      transport: 'signal',
    });
    let internalDropped = false;
    const internal = inbound({
      id: 'internal-1',
      channelId: '__internal__',
      channelName: 'harness',
      kind: 'harness',
      onDropped: () => {
        internalDropped = true;
      },
    });
    built.agent.enqueue(discord);
    built.agent.enqueue(signal);
    assert.throws(
      () => built.agent.enqueue(internal),
      /active context graph does not accept harness ingress/,
    );
    assert.deepEqual(accepted, [discord, signal]);
    assert.equal(internalDropped, true);
    const consoleMessage = inbound({
      id: 'console-1',
      channelId: 'console',
      channelName: 'console',
      kind: 'discord',
    });
    assert.throws(
      () => built.agent.enqueue(consoleMessage),
      /active context graph does not accept discord ingress/,
    );
    assert.deepEqual(accepted, [discord, signal]);
    const muted = built.agent.moderateChannel(
      '100',
      'deafen',
      'operator',
      'active transport stop',
    );
    assert.equal(muted.ok, true);
    assert.equal(muteRows.get('100')?.type, 'deafen');
    assert.deepEqual(built.agent.contextSnapshot().messages, before);
    assert.equal(providerCalls, 0);
  } finally {
    built.agent.stop();
    built.scheduler.stop();
    built.db.close();
    built.cleanup();
  }
});

test('active graph ingress failure cannot fall through to shadow or legacy input', () => {
  let shadowCalls = 0;
  const built = buildTestAgent({
    agentDeps: {
      contextGraphActive: {
        recordInbound() {
          throw new Error('durable active ingress failed');
        },
      },
      contextGraphShadow: {
        recordInbound() {
          shadowCalls++;
          throw new Error('shadow must not run');
        },
        prepareRequestObservation() {
          return undefined;
        },
      },
    },
  });
  try {
    const before = built.agent.contextSnapshot().messages;
    assert.throws(
      () => built.agent.enqueue(inbound()),
      /durable active ingress failed/,
    );
    assert.equal(shadowCalls, 0);
    assert.deepEqual(built.agent.contextSnapshot().messages, before);
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
  assert.equal(plan.schemaVersion, 3);
  assert.deepEqual(plan.localEventIds, ['event:ingress:local']);
  assert.deepEqual(plan.localMessageProjectionIds, []);
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
    'unlineaged_history',
    'multiple_worlds',
    'unrendered_event',
    'system_layer_unavailable',
    'unbound_effect_tools',
  ]);
  assert.deepEqual(plan.systemLayerProjectionIds, []);
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
  assert.deepEqual(plan.blockers, [
    'duplicate_event',
    'unrendered_event',
    'system_layer_unavailable',
    'unbound_effect_tools',
  ]);
});

test('shadow recorder keeps content in world-bound projections, not plans or observations', () => {
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
      systemLayers: [
        freezeSystemLayer({
          kind: 'runtime_contract',
          visibility: 'legacy_mixed',
          sourceKind: 'synthetic_contract',
          sourceText: 'synthetic contract source',
          content: systemCanary,
        }),
      ],
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
    const rendered = value.database
      .prepare(
        `SELECT projection_id, source_event_id, world_id,
                renderer_generation, message_json, message_hash
         FROM context_event_message_projections`,
      )
      .get() as Record<string, unknown>;
    const systemLayer = value.database
      .prepare(
        `SELECT layer_id, layer_kind, visibility, source_kind,
                content_text, content_hash, content_bytes
         FROM context_system_layer_projections`,
      )
      .get() as Record<string, unknown>;
    const parsedPlan = JSON.parse(plan.plan_json) as {
      schemaVersion: number;
      localMessageProjectionIds: string[];
      systemLayerProjectionIds: string[];
    };
    assert.equal(plan.plan_hash, hashContextBytes(plan.plan_json));
    assert.equal(parsedPlan.schemaVersion, 3);
    assert.deepEqual(parsedPlan.localMessageProjectionIds, [
      rendered.projection_id,
    ]);
    assert.deepEqual(parsedPlan.systemLayerProjectionIds, [
      systemLayer.layer_id,
    ]);
    assert.deepEqual(
      {
        layer_kind: systemLayer.layer_kind,
        visibility: systemLayer.visibility,
        source_kind: systemLayer.source_kind,
        content_text: systemLayer.content_text,
        content_hash: systemLayer.content_hash,
        content_bytes: systemLayer.content_bytes,
      },
      {
        layer_kind: 'runtime_contract',
        visibility: 'legacy_mixed',
        source_kind: 'synthetic_contract',
        content_text: systemCanary,
        content_hash: hashContextBytes(systemCanary),
        content_bytes: Buffer.byteLength(systemCanary),
      },
    );
    assert.equal(
      rendered.message_json,
      JSON.stringify({ role: 'user', content: userCanary }),
    );
    assert.equal(
      rendered.message_hash,
      hashContextBytes(String(rendered.message_json)),
    );
    assert.deepEqual(
      { ...observation },
      {
        surface: 'openai-chat',
        actual_hash: hashContextBytes(projectionBytes),
        actual_bytes: Buffer.byteLength(projectionBytes),
        result: 'ineligible',
        reason: 'legacy_monocontext_contract',
        expected_hash: null,
        expected_bytes: null,
      },
    );
    const metadataOnly = JSON.stringify({ plan, observation });
    for (const forbidden of [
      systemCanary,
      userCanary,
      projectionCanary,
      projectionBytes,
    ]) {
      assert.equal(metadataOnly.includes(forbidden), false);
    }
    assert.equal(JSON.stringify(rendered).includes(systemCanary), false);
    assert.equal(JSON.stringify(rendered).includes(projectionCanary), false);
    assert.equal(String(systemLayer.content_text), systemCanary);
  } finally {
    value.database.close();
    fs.rmSync(value.directory, { recursive: true, force: true });
  }
});

test('shadow rendering never projects foreign or multimodal message content', () => {
  const value = fixture();
  try {
    const a = value.recorder.recordInbound(
      inbound({
        id: 'message-a',
        guildId: 'guild-a',
        content: 'A_SOURCE_CANARY',
      }),
    );
    const b = value.recorder.recordInbound(
      inbound({
        id: 'message-b',
        guildId: 'guild-b',
        content: 'B_SOURCE_CANARY',
      }),
    );
    const multimodal = value.recorder.recordInbound(
      inbound({
        id: 'message-b-image',
        guildId: 'guild-b',
        content: 'B_IMAGE_SOURCE_CANARY',
      }),
    );
    const partial = value.recorder.recordInbound(
      inbound({
        id: 'message-b-partial',
        guildId: 'guild-b',
        content: 'B_PARTIAL_SOURCE_CANARY',
      }),
    );
    value.recorder.prepareRequestObservation({
      wakeLineage: {
        worldId: multimodal.worldId,
        eventId: multimodal.eventId,
        sequence: multimodal.sequence,
      },
      messages: [
        {
          role: 'user',
          content: 'A_RENDERED_CANARY',
          worldId: a.worldId,
          eventId: a.eventId,
          sequence: a.sequence,
        },
        {
          role: 'user',
          content: 'B_RENDERED_CANARY',
          worldId: b.worldId,
          eventId: b.eventId,
          sequence: b.sequence,
        },
        {
          role: 'user',
          content: 'B_MULTIMODAL_RENDERED_CANARY',
          contentParts: [{ type: 'text', text: 'visible multimodal part' }],
          worldId: multimodal.worldId,
          eventId: multimodal.eventId,
          sequence: multimodal.sequence,
        },
        {
          role: 'user',
          content: 'B_PARTIAL_LINEAGE_RENDERED_CANARY',
          worldId: partial.worldId,
          eventId: partial.eventId,
        },
      ],
    });

    const rows = value.database
      .prepare(
        `SELECT projection_id, world_id, message_json
         FROM context_event_message_projections ORDER BY projection_id`,
      )
      .all() as Array<{
      projection_id: string;
      world_id: string;
      message_json: string;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].world_id, b.worldId);
    assert.equal(
      rows[0].message_json,
      JSON.stringify({ role: 'user', content: 'B_RENDERED_CANARY' }),
    );
    assert.equal(JSON.stringify(rows).includes('A_RENDERED_CANARY'), false);
    assert.equal(
      JSON.stringify(rows).includes('B_MULTIMODAL_RENDERED_CANARY'),
      false,
    );
    assert.equal(
      JSON.stringify(rows).includes('B_PARTIAL_LINEAGE_RENDERED_CANARY'),
      false,
    );

    const storedPlan = value.database
      .prepare('SELECT plan_json FROM context_shadow_projection_plans')
      .get() as { plan_json: string };
    const plan = JSON.parse(storedPlan.plan_json) as {
      localEventIds: string[];
      localMessageProjectionIds: string[];
      blockers: string[];
    };
    assert.deepEqual(plan.localEventIds, [
      b.eventId,
      multimodal.eventId,
      partial.eventId,
    ]);
    assert.deepEqual(plan.localMessageProjectionIds, [rows[0].projection_id]);
    assert.deepEqual(plan.blockers, [
      'multiple_worlds',
      'multimodal_unavailable',
      'unrendered_event',
      'render_projection_mismatch',
      'system_layer_unavailable',
      'system_layer_mismatch',
      'unbound_effect_tools',
    ]);
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
    assert.ok(Object.isFrozen(prepared.systemLayers));
    assert.equal(
      prepared.systemLayers
        .map((layer: { content: string }) => layer.content)
        .join(''),
      prepared.messages[0].content,
    );
    for (const layer of prepared.systemLayers) {
      assert.equal(layer.contentHash, hashContextBytes(layer.content));
      assert.equal(layer.byteLength, Buffer.byteLength(layer.content));
    }
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
