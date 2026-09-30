import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createViewManifest } from '../src/context-graph.js';
import { assembleDarkLocalBranch } from '../src/context/root.js';
import { MAX_LOCAL_BRANCH_REQUEST_CANDIDATE_BYTES } from '../src/context/candidate.js';
import {
  materializeLocalBranchRequest,
  materializeSystemProjection,
  materializeWorldConversation,
} from '../src/context/view.js';
import { openDatabase } from '../src/store/db.js';
import {
  ContextGraphStore,
  LegacyImportConflictError,
  StaleContinuationHeadError,
  branchId,
  capsuleId,
  effectId,
  eventId,
  eventMessageProjectionId,
  hashContextBytes,
  legacyImportReceiptId,
  manifestId,
  shareGrantId,
  shadowProjectionPlanId,
  shadowRequestObservationId,
  systemLayerProjectionId,
  worldId,
} from '../src/store/context-graph.js';

function fixture(): {
  directory: string;
  database: DatabaseSync;
  store: ContextGraphStore;
} {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-context-graph-'),
  );
  const database = openDatabase(directory);
  return { directory, database, store: new ContextGraphStore(database) };
}

function closeFixture(value: {
  directory: string;
  database: DatabaseSync;
}): void {
  value.database.close();
  fs.rmSync(value.directory, { recursive: true, force: true });
}

test('world message projections materialize only exact ordered local text', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:a');
    const worldB = worldId('world:signal:b');
    const events = [
      { id: eventId('event:a-1'), world: worldA, text: 'A_ONE_CANARY' },
      { id: eventId('event:a-2'), world: worldA, text: 'A_TWO_CANARY' },
      { id: eventId('event:b-1'), world: worldB, text: 'B_ONLY_CANARY' },
    ];
    events.forEach((event, index) =>
      value.store.appendWorldEvent({
        eventId: event.id,
        worldId: event.world,
        kind: 'inbound:signal',
        payload: { text: event.text },
        occurredAt: index + 1,
        recordedAt: index + 1,
      }),
    );
    const projections = events.map((event, index) =>
      value.store.createEventMessageProjection({
        sourceEventId: event.id,
        sourceSequence: index + 1,
        worldId: event.world,
        rendererGeneration: 1,
        message: {
          role: 'user',
          content: `<incoming>${event.text}</incoming>`,
        },
        createdAt: index + 10,
      }),
    );
    assert.match(projections[0].projectionId, /^event-message:[0-9a-f]{64}$/);
    assert.equal(
      projections[0].messageHash,
      hashContextBytes(
        JSON.stringify({
          role: 'user',
          content: '<incoming>A_ONE_CANARY</incoming>',
        }),
      ),
    );
    assert.deepEqual(
      value.store.createEventMessageProjection({
        sourceEventId: events[0].id,
        sourceSequence: 1,
        worldId: worldA,
        rendererGeneration: 1,
        message: projections[0].message,
        createdAt: 99,
      }),
      projections[0],
    );
    assert.throws(
      () =>
        value.store.createEventMessageProjection({
          sourceEventId: events[0].id,
          sourceSequence: 1,
          worldId: worldA,
          rendererGeneration: 1,
          message: { role: 'user', content: 'changed rendering' },
          createdAt: 99,
        }),
      /projection identity conflict/,
    );
    assert.throws(
      () =>
        value.store.createEventMessageProjection({
          sourceEventId: events[0].id,
          sourceSequence: 2,
          worldId: worldA,
          rendererGeneration: 1,
          message: projections[0].message,
          createdAt: 99,
        }),
      /source lineage is invalid/,
    );
    const nonInbound = value.store.appendWorldEvent({
      eventId: eventId('event:derived'),
      worldId: worldA,
      kind: 'capsule',
      payload: { text: 'derived' },
      occurredAt: 4,
      recordedAt: 4,
    });
    assert.throws(
      () =>
        value.store.createEventMessageProjection({
          sourceEventId: nonInbound.eventId,
          sourceSequence: nonInbound.sequence,
          worldId: worldA,
          rendererGeneration: 1,
          message: { role: 'user', content: 'not authentic ingress' },
          createdAt: 99,
        }),
      /source lineage is invalid/,
    );

    const bMessages = materializeWorldConversation({
      store: value.store,
      worldId: worldB,
      rendererGeneration: 1,
      projectionIds: [projections[2].projectionId],
    });
    assert.deepEqual(bMessages, [
      {
        role: 'user',
        content: '<incoming>B_ONLY_CANARY</incoming>',
        worldId: worldB,
        eventId: events[2].id,
        sequence: 3,
      },
    ]);
    assert.equal(JSON.stringify(bMessages).includes('A_ONE_CANARY'), false);
    assert.throws(
      () =>
        materializeWorldConversation({
          store: value.store,
          worldId: worldB,
          rendererGeneration: 1,
          projectionIds: [projections[0].projectionId],
        }),
      /projection world mismatch/,
    );
    assert.throws(
      () =>
        materializeWorldConversation({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          projectionIds: [
            projections[1].projectionId,
            projections[0].projectionId,
          ],
        }),
      /projection order is invalid/,
    );
    const reorderedPlan = {
      schemaVersion: 2,
      worldId: worldA,
      wakeEventId: events[0].id,
      projectionGeneration: 2,
      policyGeneration: 1,
      rendererGeneration: 1,
      localEventIds: [events[1].id, events[0].id],
      localMessageProjectionIds: [
        projections[1].projectionId,
        projections[0].projectionId,
      ],
      sharedEventIds: [],
      foreignWorlds: [],
      unlineagedRoles: { system: 0, user: 0, assistant: 0, tool: 0 },
      systemLayers: [],
      blockers: [],
    };
    const reorderedHash = hashContextBytes(JSON.stringify(reorderedPlan));
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(`shadow-plan:${reorderedHash}`),
          worldId: worldA,
          wakeEventId: events[0].id,
          plan: reorderedPlan,
          createdAt: 99,
        }),
      /local event order is invalid/,
    );
    assert.throws(
      () =>
        materializeWorldConversation({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          projectionIds: [
            projections[0].projectionId,
            projections[0].projectionId,
          ],
        }),
      /duplicate projection/,
    );
    assert.throws(() =>
      value.database
        .prepare('UPDATE context_event_message_projections SET created_at = 0')
        .run(),
    );
    assert.throws(() =>
      value.database
        .prepare('DELETE FROM context_event_message_projections')
        .run(),
    );
  } finally {
    closeFixture(value);
  }
});

test('system layers materialize only explicit branch-visible scope', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:a');
    const worldB = worldId('world:signal:b');
    const create = (input: {
      kind:
        | 'runtime_contract'
        | 'identity'
        | 'world_policy'
        | 'private_frontier'
        | 'legacy_memory';
      visibility:
        | 'global_contract'
        | 'integrated_self'
        | 'integrated_self_candidate'
        | 'world'
        | 'private_root'
        | 'legacy_mixed';
      worldId: ReturnType<typeof worldId> | null;
      source: string;
      content: string;
      createdAt: number;
    }) =>
      value.store.createSystemLayerProjection({
        kind: input.kind,
        visibility: input.visibility,
        worldId: input.worldId,
        rendererGeneration: 1,
        policyGeneration: 1,
        sourceKind: 'synthetic_fixture',
        sourceHash: hashContextBytes(input.source),
        content: input.content,
        createdAt: input.createdAt,
      });
    const contract = create({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      worldId: null,
      source: 'contract-v1',
      content: 'CONTRACT_CANARY',
      createdAt: 1,
    });
    const identity = create({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      source: 'identity-v1',
      content: '\nIDENTITY_CANARY',
      createdAt: 2,
    });
    const worldPolicyA = create({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldA,
      source: 'policy-a',
      content: '\nWORLD_A_CANARY',
      createdAt: 3,
    });
    const worldPolicyB = create({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldB,
      source: 'policy-b',
      content: '\nWORLD_B_CANARY',
      createdAt: 4,
    });
    const candidate = create({
      kind: 'identity',
      visibility: 'integrated_self_candidate',
      worldId: null,
      source: 'candidate-v1',
      content: '\nCANDIDATE_CANARY',
      createdAt: 5,
    });
    const legacy = create({
      kind: 'legacy_memory',
      visibility: 'legacy_mixed',
      worldId: null,
      source: 'legacy-v1',
      content: '\nLEGACY_CANARY',
      createdAt: 6,
    });
    assert.match(contract.layerId, /^system-layer:[0-9a-f]{64}$/);
    assert.notEqual(worldPolicyA.layerId, worldPolicyB.layerId);
    assert.deepEqual(
      value.store.createSystemLayerProjection({
        kind: contract.kind,
        visibility: contract.visibility,
        worldId: contract.worldId,
        rendererGeneration: contract.rendererGeneration,
        policyGeneration: contract.policyGeneration,
        sourceKind: contract.sourceKind,
        sourceHash: contract.sourceHash,
        content: contract.content,
        createdAt: 99,
      }),
      contract,
    );
    const materialized = materializeSystemProjection({
      store: value.store,
      worldId: worldA,
      rendererGeneration: 1,
      policyGeneration: 1,
      layerIds: [contract.layerId, identity.layerId, worldPolicyA.layerId],
    });
    assert.deepEqual(materialized, {
      role: 'system',
      content: 'CONTRACT_CANARY\nIDENTITY_CANARY\nWORLD_A_CANARY',
    });
    assert.equal(materialized.content.includes('WORLD_B_CANARY'), false);
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldB,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [contract.layerId, identity.layerId, worldPolicyA.layerId],
        }),
      /world mismatch/,
    );
    for (const blocked of [candidate.layerId, legacy.layerId]) {
      assert.throws(
        () =>
          materializeSystemProjection({
            store: value.store,
            worldId: worldA,
            rendererGeneration: 1,
            policyGeneration: 1,
            layerIds: [contract.layerId, blocked],
          }),
        /not branch-visible/,
      );
    }
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [identity.layerId, contract.layerId],
        }),
      /order is invalid/,
    );
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [contract.layerId, identity.layerId, identity.layerId],
        }),
      /duplicate system layer/,
    );
    assert.throws(
      () =>
        materializeSystemProjection({
          store: value.store,
          worldId: worldA,
          rendererGeneration: 1,
          policyGeneration: 1,
          layerIds: [
            contract.layerId,
            systemLayerProjectionId(`system-layer:${'0'.repeat(64)}`),
          ],
        }),
      /is missing/,
    );
    const privateLayer = create({
      kind: 'private_frontier',
      visibility: 'private_root',
      worldId: null,
      source: 'private-root-v1',
      content: '\nPRIVATE_ROOT_CANARY',
      createdAt: 7,
    });
    const wake = value.store.appendWorldEvent({
      eventId: eventId('event:system-plan-wake'),
      worldId: worldA,
      kind: 'inbound:signal',
      payload: { text: 'wake' },
      occurredAt: 8,
      recordedAt: 8,
    });
    const planFor = (layerId: typeof contract.layerId, blockers: string[]) => ({
      schemaVersion: 3,
      worldId: worldA,
      wakeEventId: wake.eventId,
      projectionGeneration: 3,
      policyGeneration: 1,
      rendererGeneration: 1,
      systemRendererGeneration: 1,
      localEventIds: [wake.eventId],
      localMessageProjectionIds: [],
      sharedEventIds: [],
      foreignWorlds: [],
      unlineagedRoles: { system: 0, user: 0, assistant: 0, tool: 0 },
      systemLayerProjectionIds: [layerId],
      blockers,
    });
    const malformedPlan = {
      ...planFor(privateLayer.layerId, [
        'unrendered_event',
        'system_layer_unavailable',
        'unbound_effect_tools',
      ]),
      systemLayerProjectionIds: 'not-an-array',
    };
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(malformedPlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: malformedPlan,
          createdAt: 9,
        }),
      /system layer references are invalid/,
    );
    const privatePlan = planFor(privateLayer.layerId, [
      'unrendered_event',
      'unbound_effect_tools',
    ]);
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(privatePlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: privatePlan,
          createdAt: 9,
        }),
      /system layer scope is unsupported/,
    );
    const missingBlockerPlan = planFor(candidate.layerId, [
      'unrendered_event',
      'unbound_effect_tools',
    ]);
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(missingBlockerPlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: missingBlockerPlan,
          createdAt: 10,
        }),
      /system blocker lineage is invalid/,
    );
    const staleBlockerPlan = planFor(candidate.layerId, [
      'legacy_mixed_system',
      'identity_candidate_unapproved',
      'unrendered_event',
      'unbound_effect_tools',
    ]);
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(
            `shadow-plan:${hashContextBytes(JSON.stringify(staleBlockerPlan))}`,
          ),
          worldId: worldA,
          wakeEventId: wake.eventId,
          plan: staleBlockerPlan,
          createdAt: 11,
        }),
      /blockers are invalid/,
    );
    assert.throws(() =>
      value.database
        .prepare('UPDATE context_system_layer_projections SET created_at = 0')
        .run(),
    );
    assert.throws(() =>
      value.database
        .prepare('DELETE FROM context_system_layer_projections')
        .run(),
    );
    value.database.exec(
      'DROP TRIGGER context_system_layer_projections_no_update',
    );
    value.database
      .prepare(
        'UPDATE context_system_layer_projections SET content_text = ? WHERE layer_id = ?',
      )
      .run('CORRUPTED', contract.layerId);
    assert.throws(
      () => value.store.getSystemLayerProjection(contract.layerId),
      /stored system layer projection is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

function createBranch(
  store: ContextGraphStore,
  id: string,
  world: string,
  startedAt = 10,
): void {
  store.createBranch({
    branchId: branchId(id),
    worldId: worldId(world),
    authorityEpoch: 1,
    startedAt,
  });
}

function createLegacyCapsule(
  store: ContextGraphStore,
  id: string,
  branch: string,
  world: string,
): void {
  store.createCapsule({
    capsuleId: capsuleId(id),
    branchId: branchId(branch),
    worldId: worldId(world),
    kind: 'legacy_opaque',
    viewManifestHash: null,
    sourceRootHash: hashContextBytes('legacy-root'),
    policyGeneration: 0,
    content: { testimony: 'sealed legacy continuation' },
    createdAt: 12,
  });
}

test('shadow request observations are hash-only, immutable, and result-bound', () => {
  const value = fixture();
  try {
    const world = worldId('world:discord:guild:example');
    const wake = eventId('event:shadow-wake');
    value.store.appendWorldEvent({
      eventId: wake,
      worldId: world,
      kind: 'inbound',
      payload: { text: 'source testimony' },
      occurredAt: 10,
      recordedAt: 11,
    });
    const plan = {
      schemaVersion: 1,
      worldId: world,
      wakeEventId: wake,
      projectionGeneration: 1,
      policyGeneration: 1,
      localEventIds: [wake],
      sharedEventIds: [],
      foreignWorlds: [],
      unlineagedRoles: { system: 0, user: 0, assistant: 0, tool: 0 },
      systemLayers: [
        {
          ordinal: 0,
          sha256: hashContextBytes('system layer'),
          byteLength: 12,
          scope: 'legacy-mixed',
        },
      ],
      blockers: ['legacy_mixed_system'],
    };
    const missingLineagePlan = {
      ...plan,
      localEventIds: [wake, eventId('event:missing')],
    };
    const missingLineageHash = hashContextBytes(
      JSON.stringify(missingLineagePlan),
    );
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(`shadow-plan:${missingLineageHash}`),
          worldId: world,
          wakeEventId: wake,
          plan: missingLineagePlan,
          createdAt: 12,
        }),
      /local event is not in its world/,
    );
    const unsafePlan = { ...plan, content: 'forbidden raw request content' };
    const unsafeHash = hashContextBytes(JSON.stringify(unsafePlan));
    assert.throws(
      () =>
        value.store.createShadowProjectionPlan({
          planId: shadowProjectionPlanId(`shadow-plan:${unsafeHash}`),
          worldId: world,
          wakeEventId: wake,
          plan: unsafePlan,
          createdAt: 12,
        }),
      /unsupported field/,
    );
    const planHash = hashContextBytes(JSON.stringify(plan));
    const planId = shadowProjectionPlanId(`shadow-plan:${planHash}`);
    const created = value.store.createShadowProjectionPlan({
      planId,
      worldId: world,
      wakeEventId: wake,
      plan,
      createdAt: 12,
    });
    assert.deepEqual(
      value.store.createShadowProjectionPlan({
        planId,
        worldId: world,
        wakeEventId: wake,
        plan,
        createdAt: 99,
      }),
      created,
      'content-addressed plans are create-if-identical',
    );

    const actualHash = hashContextBytes('actual projection bytes');
    const observed = value.store.recordShadowRequestObservation({
      observationId: shadowRequestObservationId('shadow-observation:one'),
      planId,
      worldId: world,
      surface: 'openai-chat',
      actualHash,
      actualBytes: 23,
      result: 'ineligible',
      reason: 'legacy_mixed_system',
      expectedHash: null,
      expectedBytes: null,
      observedAt: 13,
    });
    assert.equal(observed.reason, 'legacy_mixed_system');
    assert.deepEqual(value.store.listShadowRequestObservations(planId), [
      observed,
    ]);
    assert.throws(
      () =>
        value.store.recordShadowRequestObservation({
          observationId: shadowRequestObservationId(
            'shadow-observation:false-equal',
          ),
          planId,
          worldId: world,
          surface: 'openai-chat',
          actualHash,
          actualBytes: 23,
          result: 'equal',
          reason: null,
          expectedHash: hashContextBytes('different projection'),
          expectedBytes: 23,
          observedAt: 14,
        }),
      /result does not match/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            "UPDATE context_shadow_request_observations SET reason='changed' WHERE observation_id=?",
          )
          .run(observed.observationId),
      /immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_shadow_projection_plans WHERE plan_id=?',
          )
          .run(planId),
      /immutable/,
    );
    const columns = (
      value.database
        .prepare(
          "SELECT name FROM pragma_table_info('context_shadow_request_observations') ORDER BY cid",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    assert.equal(columns.includes('bytes'), false);
    assert.equal(columns.includes('content'), false);
  } finally {
    closeFixture(value);
  }
});

test('context graph immutable records reject update and deletion', () => {
  const value = fixture();
  try {
    const event = value.store.appendWorldEvent({
      eventId: eventId('event:1'),
      worldId: worldId('world:discord:guild:example'),
      kind: 'inbound',
      payload: { text: 'neutral fixture' },
      occurredAt: 10,
      recordedAt: 11,
    });
    assert.equal(event.payloadHash, hashContextBytes(event.payloadJson));

    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_world_events SET payload_json = ? WHERE event_id = ?',
          )
          .run('{}', 'event:1'),
      /context world events are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare('DELETE FROM context_world_events WHERE event_id = ?')
          .run('event:1'),
      /context world events are immutable/,
    );
    assert.equal(
      value.store.getWorldEvent(eventId('event:1'))?.payloadJson,
      '{"text":"neutral fixture"}',
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_world_events(
              event_id, world_id, event_kind, payload_json, payload_hash,
              occurred_at, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'event:bad-json',
            'world:internal',
            'test',
            '{',
            'a'.repeat(64),
            12,
            12,
          ),
      /CHECK constraint failed/,
    );
  } finally {
    closeFixture(value);
  }
});

test('context graph enforces same-world lineage and view edges', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:contact-a');
    const worldB = worldId('world:signal:contact-b');
    createBranch(value.store, 'branch:a', worldA);
    value.store.appendWorldEvent({
      eventId: eventId('event:b'),
      worldId: worldB,
      kind: 'inbound',
      payload: { text: 'world B only' },
      occurredAt: 12,
      recordedAt: 13,
    });
    assert.throws(
      () =>
        value.store.createManifest({
          manifestId: manifestId('manifest:a'),
          branchId: branchId('branch:a'),
          worldId: worldA,
          manifest: createViewManifest({
            branchId: branchId('branch:a'),
            worldId: worldA,
            parentBranchId: null,
            authorityEpoch: 1,
            eventIds: [eventId('event:b')],
            sharedEventIds: [],
            policyGeneration: 1,
          }),
          projectionGeneration: 0,
          createdAt: 14,
        }),
      /FOREIGN KEY constraint failed/,
    );

    const count = value.database
      .prepare(
        "SELECT count(*) AS count FROM context_manifests WHERE manifest_id = 'manifest:a'",
      )
      .get() as { count: number };
    assert.equal(
      count.count,
      0,
      'failed edge rolls back its manifest atomically',
    );
    value.store.finishBranch(branchId('branch:a'), 'yielded', 15);
    assert.throws(
      () =>
        value.store.createBranch({
          branchId: branchId('branch:b-child'),
          worldId: worldB,
          parentBranchId: branchId('branch:a'),
          authorityEpoch: 1,
          startedAt: 16,
        }),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    closeFixture(value);
  }
});

test('capsule edges enforce causal DAG order at the database seam', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:capsules', 'world:legacy-unscoped');
    createLegacyCapsule(
      value.store,
      'capsule:parent',
      'branch:capsules',
      'world:legacy-unscoped',
    );
    value.store.createCapsule({
      capsuleId: capsuleId('capsule:child'),
      branchId: branchId('branch:capsules'),
      worldId: worldId('world:legacy-unscoped'),
      kind: 'legacy_opaque',
      viewManifestHash: null,
      sourceRootHash: hashContextBytes('legacy-root-child'),
      policyGeneration: 0,
      content: { testimony: 'child' },
      parentCapsuleIds: [capsuleId('capsule:parent')],
      createdAt: 13,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_capsule_edges(
              child_capsule_id, parent_capsule_id, world_id, ordinal
            ) VALUES (?, ?, ?, ?)`,
          )
          .run('capsule:parent', 'capsule:child', 'world:legacy-unscoped', 0),
      /parent must predate child/,
    );
  } finally {
    closeFixture(value);
  }
});

test('manifests bind canonical hashes and exact active share events', () => {
  const value = fixture();
  try {
    const sourceWorld = worldId('world:discord:guild:source');
    const destinationWorld = worldId('world:signal:destination');
    createBranch(value.store, 'branch:source', sourceWorld);
    value.store.appendWorldEvent({
      eventId: eventId('event:source'),
      worldId: sourceWorld,
      kind: 'inbound',
      payload: { text: 'source-only text' },
      occurredAt: 10,
      recordedAt: 10,
    });
    const sourceView = createViewManifest({
      branchId: branchId('branch:source'),
      worldId: sourceWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [eventId('event:source')],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    for (const [id, changed] of [
      [
        'manifest:wrong-authority',
        createViewManifest({ ...sourceView, authorityEpoch: 2 }),
      ],
      [
        'manifest:wrong-parent',
        createViewManifest({
          ...sourceView,
          parentBranchId: branchId('branch:unrelated'),
        }),
      ],
    ] as const) {
      assert.throws(
        () =>
          value.store.createManifest({
            manifestId: manifestId(id),
            branchId: branchId('branch:source'),
            worldId: sourceWorld,
            manifest: changed,
            projectionGeneration: 1,
            createdAt: 11,
          }),
        /lineage does not match/,
      );
    }
    const sourceManifest = value.store.createManifest({
      manifestId: manifestId('manifest:source'),
      branchId: branchId('branch:source'),
      worldId: sourceWorld,
      manifest: sourceView,
      projectionGeneration: 1,
      createdAt: 11,
    });
    assert.equal(JSON.parse(sourceManifest.json).hash, sourceView.hash);
    assert.match(sourceManifest.cacheNamespace, /^context:[0-9a-f]{64}$/);
    assert.throws(
      () =>
        value.store.createCapsule({
          capsuleId: capsuleId('capsule:wrong-policy'),
          branchId: branchId('branch:source'),
          worldId: sourceWorld,
          kind: 'private',
          viewManifestHash: sourceView.hash,
          sourceRootHash: hashContextBytes('source-root'),
          policyGeneration: 2,
          content: { text: 'must not persist' },
          createdAt: 12,
        }),
      /policy does not match/,
    );
    value.store.createCapsule({
      capsuleId: capsuleId('capsule:source'),
      branchId: branchId('branch:source'),
      worldId: sourceWorld,
      kind: 'private',
      viewManifestHash: sourceView.hash,
      sourceRootHash: hashContextBytes('source-root'),
      policyGeneration: 1,
      content: { text: 'explicitly shareable sentence' },
      createdAt: 12,
    });
    value.store.createShareGrant({
      grantId: shareGrantId('share:one'),
      sharedEventId: eventId('event:share:one'),
      sourceCapsuleId: capsuleId('capsule:source'),
      sourceWorldId: sourceWorld,
      destinationWorldId: destinationWorld,
      canonicalText: 'explicitly shared sentence',
      authorityEpoch: 1,
      createdAt: 13,
    });

    value.store.finishBranch(branchId('branch:source'), 'yielded', 14);
    createBranch(value.store, 'branch:destination', destinationWorld, 15);
    const destinationView = createViewManifest({
      branchId: branchId('branch:destination'),
      worldId: destinationWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [eventId('event:share:one')],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:destination'),
      branchId: branchId('branch:destination'),
      worldId: destinationWorld,
      manifest: destinationView,
      projectionGeneration: 1,
      shareGrantIds: [shareGrantId('share:one')],
      createdAt: 15,
    });
    const shareEdge = value.database
      .prepare(
        `SELECT grant_id, shared_event_id, destination_world_id
         FROM context_manifest_shares WHERE manifest_id = ?`,
      )
      .get('manifest:destination') as {
      grant_id: string;
      shared_event_id: string;
      destination_world_id: string;
    };
    assert.deepEqual(
      { ...shareEdge },
      {
        grant_id: 'share:one',
        shared_event_id: 'event:share:one',
        destination_world_id: destinationWorld,
      },
    );
    const sourceProjection = value.store.getManifestProjection(
      manifestId('manifest:source'),
      { requireActiveShares: true },
    );
    assert.equal(sourceProjection?.localEvents[0]?.eventId, 'event:source');
    assert.deepEqual(
      JSON.parse(sourceProjection?.localEvents[0]?.payloadJson ?? '{}'),
      { text: 'source-only text' },
    );
    const destinationProjection = value.store.getManifestProjection(
      manifestId('manifest:destination'),
      { requireActiveShares: true },
    );
    assert.deepEqual(destinationProjection?.localEvents, []);
    assert.deepEqual(destinationProjection?.shares[0], {
      grantId: shareGrantId('share:one'),
      eventId: eventId('event:share:one'),
      sourceCapsuleId: capsuleId('capsule:source'),
      sourceWorldId: sourceWorld,
      destinationWorldId: destinationWorld,
      canonicalText: 'explicitly shared sentence',
      contentHash: hashContextBytes('explicitly shared sentence'),
      status: 'active',
      authorityEpoch: 1,
    });

    value.store.finishBranch(branchId('branch:destination'), 'yielded', 16);
    createBranch(value.store, 'branch:tampered', destinationWorld, 17);
    assert.throws(
      () =>
        value.store.createManifest({
          manifestId: manifestId('manifest:tampered'),
          branchId: branchId('branch:tampered'),
          worldId: destinationWorld,
          manifest: {
            ...destinationView,
            branchId: branchId('branch:tampered'),
            hash: '0'.repeat(64),
          },
          projectionGeneration: 1,
          shareGrantIds: [shareGrantId('share:one')],
          createdAt: 17,
        }),
      /hash does not match/,
    );

    value.store.finishBranch(branchId('branch:tampered'), 'crashed', 18);
    value.store.revokeShareGrant(shareGrantId('share:one'), 19);
    assert.equal(
      value.store.getManifestProjection(manifestId('manifest:destination'))
        ?.shares[0]?.status,
      'revoked',
    );
    assert.throws(
      () =>
        value.store.getManifestProjection(manifestId('manifest:destination'), {
          requireActiveShares: true,
        }),
      /revoked share/,
    );
    createBranch(value.store, 'branch:revoked', destinationWorld, 20);
    const revokedView = createViewManifest({
      ...destinationView,
      branchId: branchId('branch:revoked'),
    });
    assert.throws(
      () =>
        value.store.createManifest({
          manifestId: manifestId('manifest:revoked'),
          branchId: branchId('branch:revoked'),
          worldId: destinationWorld,
          manifest: revokedView,
          projectionGeneration: 1,
          shareGrantIds: [shareGrantId('share:one')],
          createdAt: 20,
        }),
      /revoked context share/,
    );
  } finally {
    closeFixture(value);
  }
});

test('continuation head compare-and-swap rejects a stale revision', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:1', 'world:console');
    value.store.finishBranch(branchId('branch:1'), 'yielded', 12);
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_continuation_head
             SET branch_id = 'branch:1', world_id = 'world:console',
               revision = 1, updated_at = 12 WHERE singleton = 1`,
          )
          .run(),
      /lacks an advance receipt/,
    );

    const first = value.store.advanceContinuationHead({
      expectedRevision: 0,
      branchId: branchId('branch:1'),
      updatedAt: 12,
    });
    assert.deepEqual(first, {
      branchId: branchId('branch:1'),
      worldId: worldId('world:console'),
      revision: 1,
      updatedAt: 12,
    });

    createBranch(value.store, 'branch:2', 'world:console', 13);
    assert.throws(
      () =>
        value.store.advanceContinuationHead({
          expectedRevision: 0,
          branchId: branchId('branch:2'),
          updatedAt: 13,
        }),
      StaleContinuationHeadError,
    );
    assert.equal(value.store.getContinuationHead().branchId, 'branch:1');
    assert.equal(value.store.getContinuationHead().revision, 1);
  } finally {
    closeFixture(value);
  }
});

test('continuation advances are immutable and preserve cross-world order', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:a', 'world:discord:guild:a');
    value.store.finishBranch(branchId('branch:a'), 'yielded', 20);
    value.store.advanceContinuationHead({
      expectedRevision: 0,
      branchId: branchId('branch:a'),
      updatedAt: 21,
    });

    createBranch(value.store, 'branch:b', 'world:signal:contact-b', 22);
    assert.throws(
      () =>
        value.store.advanceContinuationHead({
          expectedRevision: 1,
          branchId: branchId('branch:b'),
          updatedAt: 23,
        }),
      /has not yielded/,
    );
    value.store.finishBranch(branchId('branch:b'), 'yielded', 24);
    value.store.advanceContinuationHead({
      expectedRevision: 1,
      branchId: branchId('branch:b'),
      updatedAt: 25,
    });

    const rows = value.database
      .prepare(
        `SELECT revision, predecessor_branch_id, predecessor_world_id,
          branch_id, world_id FROM context_continuation_advances ORDER BY revision`,
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(rows, [
      {
        revision: 1,
        predecessor_branch_id: null,
        predecessor_world_id: null,
        branch_id: 'branch:a',
        world_id: 'world:discord:guild:a',
      },
      {
        revision: 2,
        predecessor_branch_id: 'branch:a',
        predecessor_world_id: 'world:discord:guild:a',
        branch_id: 'branch:b',
        world_id: 'world:signal:contact-b',
      },
    ]);
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_continuation_advances WHERE revision = 1',
          )
          .run(),
      /immutable/,
    );
  } finally {
    closeFixture(value);
  }
});

test('restart recovery converts prepared effects to uncertain without retry', () => {
  const value = fixture();
  try {
    const world = worldId('world:discord:guild:example');
    createBranch(value.store, 'branch:effect', world);
    value.store.prepareEffect({
      effectId: effectId('effect:1'),
      branchId: branchId('branch:effect'),
      worldId: world,
      destinationWorldId: world,
      kind: 'send',
      authorityEpoch: 1,
      payload: { destination: 'channel-example', text: 'hello' },
      idempotencyKey: 'send-attempt-1',
      preparedAt: 20,
    });

    assert.throws(
      () => value.store.finishBranch(branchId('branch:effect'), 'crashed', 29),
      /prepared effect/,
    );
    const recovered = value.store.recoverPreparedEffects(30);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.status, 'uncertain');
    assert.equal(recovered[0]?.resolvedAt, 30);
    assert.deepEqual(value.store.recoverPreparedEffects(31), []);
    assert.throws(
      () =>
        value.store.resolveEffect(effectId('effect:1'), 'observed', 32, {
          remoteId: 'not-issued-by-test',
        }),
      /effect is not prepared/,
    );
    value.store.finishBranch(branchId('branch:effect'), 'crashed', 33);
    assert.throws(
      () =>
        value.store.prepareEffect({
          effectId: effectId('effect:2'),
          branchId: branchId('branch:effect'),
          worldId: world,
          destinationWorldId: world,
          kind: 'send',
          authorityEpoch: 1,
          payload: { text: 'must not issue from a closed branch' },
          preparedAt: 34,
        }),
      /branch is not running/,
    );
  } finally {
    closeFixture(value);
  }
});

test('root coordinator serializes branches against one continuation head', () => {
  const value = fixture();
  try {
    const first = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:coordinated-a1'),
      worldId: worldId('world:signal:a'),
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 10,
    });
    assert.deepEqual(first.start, {
      branchId: branchId('branch:coordinated-a1'),
      worldId: worldId('world:signal:a'),
      baseRevision: 0,
      predecessorBranchId: null,
      predecessorWorldId: null,
      startedAt: 10,
    });
    assert.equal(first.state.activeBranchId, 'branch:coordinated-a1');
    assert.throws(
      () => value.store.finishBranch(first.branch.branchId, 'yielded', 11),
      /return capsules are incomplete/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            `UPDATE context_root_coordinator
             SET base_revision = 99, updated_at = 11 WHERE singleton = 1`,
          )
          .run(),
      /invalid context root coordinator transition/,
    );
    assert.throws(
      () =>
        value.store.beginCoordinatedBranch({
          branchId: branchId('branch:overlap'),
          worldId: worldId('world:signal:b'),
          expectedRevision: 0,
          authorityEpoch: 1,
          startedAt: 11,
        }),
      /already active/,
    );

    const firstView = createViewManifest({
      branchId: first.branch.branchId,
      worldId: first.branch.worldId,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:coordinated-a1'),
      branchId: first.branch.branchId,
      worldId: first.branch.worldId,
      manifest: firstView,
      projectionGeneration: 1,
      createdAt: 11,
    });
    value.store.completeCoordinatedBranch({
      branchId: first.branch.branchId,
      viewManifestHash: firstView.hash,
      privateCapsuleId: capsuleId('capsule:coordinated-a1-private'),
      rootReceiptCapsuleId: capsuleId('capsule:coordinated-a1-root'),
      sourceRootHash: hashContextBytes('coordinated-a1-root'),
      privateContent: { summary: 'first local branch' },
      outcome: 'completed',
      commitments: [],
      blockers: [],
      artifactRefs: [],
      endedAt: 12,
    });
    assert.deepEqual(value.store.getRootCoordinatorState(), {
      activeBranchId: null,
      activeWorldId: null,
      baseRevision: 1,
      predecessorBranchId: branchId('branch:coordinated-a1'),
      predecessorWorldId: worldId('world:signal:a'),
      updatedAt: 12,
    });
    assert.throws(
      () =>
        value.store.beginCoordinatedBranch({
          branchId: branchId('branch:stale'),
          worldId: worldId('world:signal:b'),
          expectedRevision: 0,
          authorityEpoch: 1,
          startedAt: 13,
        }),
      StaleContinuationHeadError,
    );
    assert.equal(value.store.getBranch(branchId('branch:stale')), null);

    const otherWorld = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:coordinated-b'),
      worldId: worldId('world:signal:b'),
      expectedRevision: 1,
      authorityEpoch: 1,
      startedAt: 14,
    });
    assert.equal(otherWorld.branch.parentBranchId, null);
    value.store.recoverCoordinatedBranch(15);

    const sameWorld = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:coordinated-a2'),
      worldId: worldId('world:signal:a'),
      expectedRevision: 1,
      authorityEpoch: 1,
      startedAt: 16,
    });
    assert.equal(sameWorld.branch.parentBranchId, 'branch:coordinated-a1');
  } finally {
    closeFixture(value);
  }
});

test('coordinated return commits both capsules and head advance atomically', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:return');
    value.store.appendWorldEvent({
      eventId: eventId('event:return'),
      worldId: world,
      kind: 'inbound',
      payload: { text: 'return me' },
      occurredAt: 9,
      recordedAt: 9,
    });
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:return'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 2,
      startedAt: 10,
    });
    const view = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: world,
      parentBranchId: null,
      authorityEpoch: 2,
      eventIds: [eventId('event:return')],
      sharedEventIds: [],
      policyGeneration: 3,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:return'),
      branchId: opened.branch.branchId,
      worldId: world,
      manifest: view,
      projectionGeneration: 4,
      createdAt: 11,
    });
    value.store.prepareEffect({
      effectId: effectId('effect:return'),
      branchId: opened.branch.branchId,
      worldId: world,
      destinationWorldId: world,
      kind: 'send',
      authorityEpoch: 2,
      payload: { text: 'attempted' },
      preparedAt: 12,
    });
    const complete = (
      parentCapsuleIds?: readonly ReturnType<typeof capsuleId>[],
    ) =>
      value.store.completeCoordinatedBranch({
        branchId: opened.branch.branchId,
        viewManifestHash: view.hash,
        privateCapsuleId: capsuleId('capsule:return-private'),
        rootReceiptCapsuleId: capsuleId('capsule:return-root'),
        sourceRootHash: hashContextBytes('branch trace root'),
        privateContent: { summary: 'world-local outcome' },
        privateParentCapsuleIds: parentCapsuleIds,
        outcome: 'completed',
        commitments: ['follow up locally'],
        blockers: [],
        artifactRefs: ['artifact:one'],
        endedAt: 16,
      });

    assert.throws(() => complete(), /prepared effect/);
    assert.equal(value.store.getContinuationHead().revision, 0);
    value.store.resolveEffect(effectId('effect:return'), 'failed', 13, {
      accepted: false,
    });
    assert.throws(
      () => complete([capsuleId('capsule:missing-parent')]),
      /FOREIGN KEY constraint failed/,
    );
    const capsuleCount = value.database
      .prepare('SELECT count(*) AS n FROM context_capsules')
      .get() as { n: number };
    assert.equal(capsuleCount.n, 0);
    assert.equal(
      value.store.getBranch(opened.branch.branchId)?.status,
      'running',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);

    const returned = complete();
    assert.equal(returned.branch.status, 'yielded');
    assert.equal(returned.head.revision, 1);
    assert.equal(returned.head.branchId, opened.branch.branchId);
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    const rootReceipt = JSON.parse(returned.rootReceipt.contentJson);
    assert.equal(rootReceipt.privateCapsuleId, 'capsule:return-private');
    assert.deepEqual(rootReceipt.effects, [
      {
        effectId: 'effect:return',
        destinationWorldId: world,
        kind: 'send',
        authorityEpoch: 2,
        payloadHash: hashContextBytes(JSON.stringify({ text: 'attempted' })),
        status: 'failed',
        preparedAt: 12,
        resolvedAt: 13,
      },
    ]);
    const committedCapsules = value.database
      .prepare(
        `SELECT capsule_kind FROM context_capsules
         WHERE branch_id = ? ORDER BY sequence`,
      )
      .all(opened.branch.branchId) as { capsule_kind: string }[];
    assert.deepEqual(
      committedCapsules.map((row) => row.capsule_kind),
      ['private', 'root_receipt'],
    );
  } finally {
    closeFixture(value);
  }
});

test('root coordinator crash recovery makes prepared effects uncertain without advancing', () => {
  const value = fixture();
  try {
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:recover-active'),
      worldId: worldId('world:signal:recovery'),
      expectedRevision: 0,
      authorityEpoch: 4,
      startedAt: 10,
    });
    value.store.prepareEffect({
      effectId: effectId('effect:recover-active'),
      branchId: opened.branch.branchId,
      worldId: opened.branch.worldId,
      destinationWorldId: opened.branch.worldId,
      kind: 'send',
      authorityEpoch: 4,
      payload: { text: 'issued state is unknown after restart' },
      preparedAt: 11,
    });

    const recovered = value.store.recoverCoordinatedBranch(20);
    assert.deepEqual(recovered, {
      ...opened.start,
      uncertainEffects: 1,
      recoveredAt: 20,
    });
    assert.equal(
      value.store.getBranch(opened.branch.branchId)?.status,
      'crashed',
    );
    assert.equal(
      value.store.getEffect(effectId('effect:recover-active'))?.status,
      'uncertain',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.recoverCoordinatedBranch(21), null);

    const retry = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:recover-retry'),
      worldId: opened.branch.worldId,
      expectedRevision: 0,
      authorityEpoch: 5,
      startedAt: 22,
    });
    assert.equal(retry.start.baseRevision, 0);
  } finally {
    closeFixture(value);
  }
});

test('legacy import receipts are idempotent and reject changed testimony', () => {
  const value = fixture();
  try {
    createBranch(value.store, 'branch:migration', 'world:legacy-unscoped');
    createLegacyCapsule(
      value.store,
      'capsule:legacy',
      'branch:migration',
      'world:legacy-unscoped',
    );

    const sourceHash = hashContextBytes('exact old mixed summary bytes');
    const first = value.store.recordLegacyImport({
      receiptId: legacyImportReceiptId('legacy-import:1'),
      sourceRef: 'transcript:main:summary-7',
      sourceHash,
      sourceSize: 29,
      artifactRef: `legacy:${sourceHash}`,
      importGeneration: 1,
      capsuleId: capsuleId('capsule:legacy'),
      importedAt: 20,
    });
    const repeated = value.store.recordLegacyImport({
      receiptId: legacyImportReceiptId('legacy-import:retry'),
      sourceRef: 'transcript:main:summary-7',
      sourceHash,
      sourceSize: 29,
      artifactRef: `legacy:${sourceHash}`,
      importGeneration: 1,
      capsuleId: capsuleId('capsule:legacy'),
      importedAt: 99,
    });
    assert.deepEqual(repeated, first);

    const row = value.database
      .prepare('SELECT count(*) AS count FROM context_legacy_import_receipts')
      .get() as { count: number };
    assert.equal(row.count, 1);
    assert.throws(
      () =>
        value.store.recordLegacyImport({
          receiptId: legacyImportReceiptId('legacy-import:2'),
          sourceRef: 'transcript:main:summary-7',
          sourceHash: hashContextBytes(
            'different bytes must not gain old provenance',
          ),
          sourceSize: 45,
          artifactRef: 'legacy:different',
          importGeneration: 1,
          capsuleId: capsuleId('capsule:legacy'),
          importedAt: 100,
        }),
      LegacyImportConflictError,
    );
  } finally {
    closeFixture(value);
  }
});

test('local branch request views bind one coordinated world without lifecycle effects', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:a');
    const worldB = worldId('world:signal:b');
    const eventA = value.store.appendWorldEvent({
      eventId: eventId('event:request-a'),
      worldId: worldA,
      kind: 'inbound:signal',
      payload: { text: 'A_PRIVATE_CANARY' },
      occurredAt: 1,
      recordedAt: 1,
    });
    const eventB1 = value.store.appendWorldEvent({
      eventId: eventId('event:request-b1'),
      worldId: worldB,
      kind: 'inbound:signal',
      payload: { text: 'B_ONE_CANARY' },
      occurredAt: 2,
      recordedAt: 2,
    });
    const eventB2 = value.store.appendWorldEvent({
      eventId: eventId('event:request-b2'),
      worldId: worldB,
      kind: 'inbound:signal',
      payload: { text: 'B_TWO_CANARY' },
      occurredAt: 3,
      recordedAt: 3,
    });
    const projectionA = value.store.createEventMessageProjection({
      sourceEventId: eventA.eventId,
      sourceSequence: eventA.sequence,
      worldId: worldA,
      rendererGeneration: 1,
      message: {
        role: 'user',
        content: '<incoming>A_PRIVATE_CANARY</incoming>',
      },
      createdAt: 4,
    });
    const projectionB1 = value.store.createEventMessageProjection({
      sourceEventId: eventB1.eventId,
      sourceSequence: eventB1.sequence,
      worldId: worldB,
      rendererGeneration: 1,
      message: { role: 'user', content: '<incoming>B_ONE_CANARY</incoming>' },
      createdAt: 5,
    });
    const projectionB2 = value.store.createEventMessageProjection({
      sourceEventId: eventB2.eventId,
      sourceSequence: eventB2.sequence,
      worldId: worldB,
      rendererGeneration: 1,
      message: { role: 'user', content: '<incoming>B_TWO_CANARY</incoming>' },
      createdAt: 6,
    });
    const layer = (input: {
      kind: 'runtime_contract' | 'identity' | 'world_policy';
      visibility: 'global_contract' | 'integrated_self' | 'world';
      worldId: ReturnType<typeof worldId> | null;
      source: string;
      content: string;
      createdAt: number;
    }) =>
      value.store.createSystemLayerProjection({
        kind: input.kind,
        visibility: input.visibility,
        worldId: input.worldId,
        rendererGeneration: 1,
        policyGeneration: 1,
        sourceKind: 'synthetic_fixture',
        sourceHash: hashContextBytes(input.source),
        content: input.content,
        createdAt: input.createdAt,
      });
    const contract = layer({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      worldId: null,
      source: 'request-contract',
      content: 'CONTRACT_CANARY',
      createdAt: 7,
    });
    const identity = layer({
      kind: 'identity',
      visibility: 'integrated_self',
      worldId: null,
      source: 'request-identity',
      content: '\nIDENTITY_CANARY',
      createdAt: 8,
    });
    const policyA = layer({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldA,
      source: 'request-policy-a',
      content: '\nA_POLICY_CANARY',
      createdAt: 9,
    });
    const policyB = layer({
      kind: 'world_policy',
      visibility: 'world',
      worldId: worldB,
      source: 'request-policy-b',
      content: '\nB_POLICY_CANARY',
      createdAt: 10,
    });
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:request-b'),
      worldId: worldB,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 11,
    });
    const manifest = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: worldB,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [eventB1.eventId, eventB2.eventId],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:request-b'),
      branchId: opened.branch.branchId,
      worldId: worldB,
      manifest,
      projectionGeneration: 1,
      createdAt: 12,
    });
    const base = {
      branchId: opened.branch.branchId,
      worldId: worldB,
      manifestId: manifestId('manifest:request-b'),
      systemRendererGeneration: 1,
      systemLayerProjectionIds: [
        contract.layerId,
        identity.layerId,
        policyB.layerId,
      ],
      messageProjectionIds: [
        projectionB1.projectionId,
        projectionB2.projectionId,
      ],
      createdAt: 13,
    };
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          systemLayerProjectionIds: [
            contract.layerId,
            identity.layerId,
            policyA.layerId,
          ],
        }),
      /system layer is invalid/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          messageProjectionIds: [
            projectionB2.projectionId,
            projectionB1.projectionId,
          ],
        }),
      /message lineage is invalid/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          messageProjectionIds: [projectionB1.projectionId],
        }),
      /coverage is incomplete/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          ...base,
          messageProjectionIds: [
            projectionB1.projectionId,
            projectionA.projectionId,
          ],
        }),
      /message lineage is invalid/,
    );
    const lifecycleBefore = {
      branch: value.store.getBranch(opened.branch.branchId),
      coordinator: value.store.getRootCoordinatorState(),
      head: value.store.getContinuationHead(),
      activation: value.store.getActivationState(),
    };
    const created = value.store.createLocalBranchRequestView(base);
    assert.match(created.requestViewId, /^branch-request-view:[0-9a-f]{64}$/);
    assert.equal(created.view.executionMode, 'dark');
    assert.equal(created.view.scope, 'local-only');
    assert.equal(created.view.runnable, false);
    assert.equal(created.view.toolMode, 'none');
    assert.deepEqual(value.store.createLocalBranchRequestView(base), created);
    const materialized = materializeLocalBranchRequest({
      store: value.store,
      requestViewId: created.requestViewId,
    });
    assert.deepEqual(materialized.messages, [
      {
        role: 'system',
        content: 'CONTRACT_CANARY\nIDENTITY_CANARY\nB_POLICY_CANARY',
      },
      { role: 'user', content: '<incoming>B_ONE_CANARY</incoming>' },
      { role: 'user', content: '<incoming>B_TWO_CANARY</incoming>' },
    ]);
    assert.equal(
      materialized.candidateHash,
      hashContextBytes(materialized.candidateJson),
    );
    assert.equal(
      materialized.candidateBytes,
      Buffer.byteLength(materialized.candidateJson),
    );
    assert.equal(
      materialized.candidateJson.includes('A_PRIVATE_CANARY'),
      false,
    );
    assert.equal(materialized.candidateJson.includes('A_POLICY_CANARY'), false);
    assert.deepEqual(
      {
        branch: value.store.getBranch(opened.branch.branchId),
        coordinator: value.store.getRootCoordinatorState(),
        head: value.store.getContinuationHead(),
        activation: value.store.getActivationState(),
      },
      lifecycleBefore,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_local_branch_request_views SET created_at = 0 WHERE request_view_id = ?',
          )
          .run(created.requestViewId),
      /immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_local_branch_request_messages WHERE request_view_id = ?',
          )
          .run(created.requestViewId),
      /immutable/,
    );
    value.store.recoverCoordinatedBranch(14);
    assert.throws(
      () => value.store.createLocalBranchRequestView(base),
      /active coordinated branch/,
    );
    value.database.exec(
      'DROP TRIGGER context_local_branch_request_views_no_update',
    );
    value.database
      .prepare(
        'UPDATE context_local_branch_request_views SET view_hash = ? WHERE request_view_id = ?',
      )
      .run('0'.repeat(64), created.requestViewId);
    assert.throws(
      () => value.store.getLocalBranchRequestView(created.requestViewId),
      /stored local branch request view is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

test('local branch request views reject manifests with explicit shares', () => {
  const value = fixture();
  try {
    const sourceWorld = worldId('world:signal:source');
    const destinationWorld = worldId('world:signal:destination');
    createBranch(value.store, 'branch:share-source', sourceWorld, 1);
    const sourceManifest = createViewManifest({
      branchId: branchId('branch:share-source'),
      worldId: sourceWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:share-source'),
      branchId: branchId('branch:share-source'),
      worldId: sourceWorld,
      manifest: sourceManifest,
      projectionGeneration: 1,
      createdAt: 2,
    });
    value.store.createCapsule({
      capsuleId: capsuleId('capsule:share-source'),
      branchId: branchId('branch:share-source'),
      worldId: sourceWorld,
      kind: 'private',
      viewManifestHash: sourceManifest.hash,
      sourceRootHash: hashContextBytes('share-source-root'),
      policyGeneration: 1,
      content: { text: 'shareable fixture' },
      createdAt: 3,
    });
    value.store.createShareGrant({
      grantId: shareGrantId('share:request-view'),
      sharedEventId: eventId('event:request-view-share'),
      sourceCapsuleId: capsuleId('capsule:share-source'),
      sourceWorldId: sourceWorld,
      destinationWorldId: destinationWorld,
      canonicalText: 'explicit share fixture',
      authorityEpoch: 1,
      createdAt: 4,
    });
    value.store.finishBranch(branchId('branch:share-source'), 'yielded', 5);
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:share-destination'),
      worldId: destinationWorld,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 6,
    });
    const destinationManifest = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: destinationWorld,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [],
      sharedEventIds: [eventId('event:request-view-share')],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:share-destination'),
      branchId: opened.branch.branchId,
      worldId: destinationWorld,
      manifest: destinationManifest,
      projectionGeneration: 1,
      shareGrantIds: [shareGrantId('share:request-view')],
      createdAt: 7,
    });
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          branchId: opened.branch.branchId,
          worldId: destinationWorld,
          manifestId: manifestId('manifest:share-destination'),
          systemRendererGeneration: 1,
          systemLayerProjectionIds: [],
          messageProjectionIds: [],
          createdAt: 8,
        }),
      /manifest is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

test('local branch request views reject non-monotonic manifest event order', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:request-order');
    const first = value.store.appendWorldEvent({
      eventId: eventId('event:request-order-first'),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'first' },
      occurredAt: 1,
      recordedAt: 1,
    });
    const later = value.store.appendWorldEvent({
      eventId: eventId('event:request-order-later'),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'later' },
      occurredAt: 2,
      recordedAt: 2,
    });
    const firstProjection = value.store.createEventMessageProjection({
      sourceEventId: first.eventId,
      sourceSequence: first.sequence,
      worldId: world,
      rendererGeneration: 1,
      message: { role: 'user', content: 'first' },
      createdAt: 3,
    });
    const laterProjection = value.store.createEventMessageProjection({
      sourceEventId: later.eventId,
      sourceSequence: later.sequence,
      worldId: world,
      rendererGeneration: 1,
      message: { role: 'user', content: 'later' },
      createdAt: 4,
    });
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:request-order'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 5,
    });
    const manifest = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: world,
      parentBranchId: null,
      authorityEpoch: 1,
      eventIds: [later.eventId, first.eventId],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    value.store.createManifest({
      manifestId: manifestId('manifest:request-order'),
      branchId: opened.branch.branchId,
      worldId: world,
      manifest,
      projectionGeneration: 1,
      createdAt: 6,
    });
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          branchId: opened.branch.branchId,
          worldId: world,
          manifestId: manifestId('manifest:request-order'),
          systemRendererGeneration: 1,
          systemLayerProjectionIds: [],
          messageProjectionIds: [
            laterProjection.projectionId,
            firstProjection.projectionId,
          ],
          createdAt: 7,
        }),
      /manifest event order is invalid/,
    );
    const row = value.database
      .prepare(
        'SELECT count(*) AS count FROM context_local_branch_request_views',
      )
      .get() as { count: number };
    assert.equal(row.count, 0);
  } finally {
    closeFixture(value);
  }
});

test('manifest rereads reject canonical authority drift from the branch', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:manifest-lineage');
    const opened = value.store.beginCoordinatedBranch({
      branchId: branchId('branch:manifest-lineage'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 1,
      startedAt: 1,
    });
    const malformed = createViewManifest({
      branchId: opened.branch.branchId,
      worldId: world,
      parentBranchId: null,
      authorityEpoch: 2,
      eventIds: [],
      sharedEventIds: [],
      policyGeneration: 1,
    });
    const projectionGeneration = 1;
    const cacheNamespace = `context:${hashContextBytes(
      `${world}\u0000${projectionGeneration}\u0000${malformed.hash}`,
    )}`;
    value.database
      .prepare(
        `INSERT INTO context_manifests(
           manifest_id, branch_id, world_id, manifest_hash, manifest_json,
           projection_generation, policy_generation, cache_namespace, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'manifest:authority-drift',
        opened.branch.branchId,
        world,
        malformed.hash,
        JSON.stringify(malformed),
        projectionGeneration,
        malformed.policyGeneration,
        cacheNamespace,
        2,
      );
    assert.throws(
      () =>
        value.store.getManifestProjection(
          manifestId('manifest:authority-drift'),
        ),
      /stored context manifest identity is invalid/,
    );
    assert.throws(
      () =>
        value.store.createLocalBranchRequestView({
          branchId: opened.branch.branchId,
          worldId: world,
          manifestId: manifestId('manifest:authority-drift'),
          systemRendererGeneration: 1,
          systemLayerProjectionIds: [],
          messageProjectionIds: [],
          createdAt: 3,
        }),
      /stored context manifest identity is invalid/,
    );
  } finally {
    closeFixture(value);
  }
});

function createDarkAssemblyInputs(
  value: ReturnType<typeof fixture>,
  world: ReturnType<typeof worldId>,
  prefix: string,
): {
  messageProjectionIds: ReturnType<typeof eventMessageProjectionId>[];
  systemLayerProjectionIds: ReturnType<typeof systemLayerProjectionId>[];
} {
  const events = ['one', 'two'].map((suffix, index) =>
    value.store.appendWorldEvent({
      eventId: eventId('event:' + prefix + '-' + suffix),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: prefix + '-' + suffix },
      occurredAt: index + 1,
      recordedAt: index + 1,
    }),
  );
  const projections = events.map((event, index) =>
    value.store.createEventMessageProjection({
      sourceEventId: event.eventId,
      sourceSequence: event.sequence,
      worldId: world,
      rendererGeneration: 7,
      message: {
        role: 'user',
        content:
          '<incoming>' +
          prefix.toUpperCase() +
          '_' +
          (index + 1) +
          '_CANARY</incoming>',
      },
      createdAt: index + 10,
    }),
  );
  const layer = (input: {
    kind: 'runtime_contract' | 'identity' | 'world_policy';
    visibility: 'global_contract' | 'integrated_self' | 'world';
    layerWorld: ReturnType<typeof worldId> | null;
    content: string;
    createdAt: number;
  }) =>
    value.store.createSystemLayerProjection({
      kind: input.kind,
      visibility: input.visibility,
      worldId: input.layerWorld,
      rendererGeneration: 4,
      policyGeneration: 3,
      sourceKind: 'synthetic_fixture',
      sourceHash: hashContextBytes(prefix + ':' + input.kind),
      content: input.content,
      createdAt: input.createdAt,
    });
  const layers = [
    layer({
      kind: 'runtime_contract',
      visibility: 'global_contract',
      layerWorld: null,
      content: 'DARK_CONTRACT',
      createdAt: 20,
    }),
    layer({
      kind: 'identity',
      visibility: 'integrated_self',
      layerWorld: null,
      content: '\nASTER_IDENTITY',
      createdAt: 21,
    }),
    layer({
      kind: 'world_policy',
      visibility: 'world',
      layerWorld: world,
      content: '\n' + prefix.toUpperCase() + '_POLICY_CANARY',
      createdAt: 22,
    }),
  ];
  return {
    messageProjectionIds: projections.map(
      (projection) => projection.projectionId,
    ),
    systemLayerProjectionIds: layers.map((layerRecord) => layerRecord.layerId),
  };
}

function tableCount(database: DatabaseSync, table: string): number {
  const row = database
    .prepare('SELECT count(*) AS count FROM ' + table)
    .get() as { count: number };
  return row.count;
}

test('dark local branch assembly atomically reserves only one world and remains non-runnable', () => {
  const value = fixture();
  try {
    const worldA = worldId('world:signal:assembly-a');
    const worldB = worldId('world:signal:assembly-b');
    const a = createDarkAssemblyInputs(value, worldA, 'assembly-a');
    const b = createDarkAssemblyInputs(value, worldB, 'assembly-b');
    const activationBefore = value.store.getActivationState();
    const headBefore = value.store.getContinuationHead();

    const assembled = assembleDarkLocalBranch({
      store: value.store,
      expectedActivationEpoch: activationBefore.epoch,
      expectedHeadRevision: headBefore.revision,
      worldId: worldB,
      branchId: branchId('branch:dark-assembly-b'),
      messageProjectionIds: b.messageProjectionIds,
      systemLayerProjectionIds: b.systemLayerProjectionIds,
      assembledAt: 30,
    });

    assert.equal(assembled.branch.worldId, worldB);
    assert.equal(assembled.branch.status, 'running');
    assert.equal(assembled.branch.authorityEpoch, 1);
    assert.equal(assembled.start.baseRevision, 0);
    assert.match(assembled.manifest.manifestId, /^manifest:[0-9a-f]{64}$/);
    assert.equal(assembled.manifest.projectionGeneration, 7);
    assert.equal(assembled.manifest.policyGeneration, 3);
    assert.deepEqual(JSON.parse(assembled.manifest.json).sharedEventIds, []);
    assert.equal(assembled.requestView.view.runnable, false);
    assert.equal(assembled.requestView.view.toolMode, 'none');
    assert.deepEqual(assembled.request.messages, [
      {
        role: 'system',
        content: 'DARK_CONTRACT\nASTER_IDENTITY\nASSEMBLY-B_POLICY_CANARY',
      },
      { role: 'user', content: '<incoming>ASSEMBLY-B_1_CANARY</incoming>' },
      { role: 'user', content: '<incoming>ASSEMBLY-B_2_CANARY</incoming>' },
    ]);
    assert.equal(
      assembled.request.candidateJson.includes('ASSEMBLY-A_1_CANARY'),
      false,
    );
    assert.equal(
      assembled.request.candidateJson.includes('ASSEMBLY-A_POLICY_CANARY'),
      false,
    );
    assert.equal(
      assembled.request.candidateHash,
      hashContextBytes(assembled.request.candidateJson),
    );
    assert.equal(a.messageProjectionIds.length, 2);

    assert.equal(tableCount(value.database, 'context_branches'), 1);
    assert.equal(tableCount(value.database, 'context_branch_starts'), 1);
    assert.equal(tableCount(value.database, 'context_manifests'), 1);
    assert.equal(
      tableCount(value.database, 'context_local_branch_request_views'),
      1,
    );
    assert.deepEqual(value.store.getRootCoordinatorState(), {
      activeBranchId: assembled.branch.branchId,
      activeWorldId: worldB,
      baseRevision: 0,
      predecessorBranchId: null,
      predecessorWorldId: null,
      updatedAt: 30,
    });
    assert.deepEqual(value.store.getContinuationHead(), headBefore);
    assert.deepEqual(value.store.getActivationState(), activationBefore);
    for (const table of [
      'context_capsules',
      'context_effects',
      'context_continuation_advances',
      'context_shadow_projection_plans',
      'context_shadow_request_observations',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }

    const recovered = value.store.recoverCoordinatedBranch(31);
    assert.equal(recovered?.uncertainEffects, 0);
    assert.equal(value.store.getContinuationHead().revision, 0);
    assert.equal(
      value.store.getBranch(assembled.branch.branchId)?.status,
      'crashed',
    );
    assert.deepEqual(
      materializeLocalBranchRequest({
        store: value.store,
        requestViewId: assembled.requestView.requestViewId,
      }),
      assembled.request,
    );
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rolls back a late request-view failure', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-rollback');
    const input = createDarkAssemblyInputs(value, world, 'assembly-rollback');
    value.database.exec(
      [
        'CREATE TEMP TRIGGER force_dark_assembly_late_failure',
        'BEFORE INSERT ON context_local_branch_request_views',
        'BEGIN',
        "SELECT RAISE(ABORT, 'forced late assembly failure');",
        'END;',
      ].join('\n'),
    );
    assert.throws(
      () =>
        assembleDarkLocalBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          worldId: world,
          branchId: branchId('branch:assembly-rollback'),
          ...input,
          assembledAt: 30,
        }),
      /forced late assembly failure/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_manifest_events',
      'context_local_branch_request_views',
      'context_local_branch_request_system_layers',
      'context_local_branch_request_messages',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rolls back candidate materialization failure', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-candidate-rollback');
    const input = createDarkAssemblyInputs(
      value,
      world,
      'assembly-candidate-rollback',
    );
    const content = 'x'.repeat(
      Math.floor(MAX_LOCAL_BRANCH_REQUEST_CANDIDATE_BYTES / 2) + 1,
    );
    const projections = ['one', 'two'].map((suffix, index) => {
      const event = value.store.appendWorldEvent({
        eventId: eventId('event:assembly-candidate-' + suffix),
        worldId: world,
        kind: 'inbound:signal',
        payload: { text: suffix },
        occurredAt: index + 40,
        recordedAt: index + 40,
      });
      return value.store.createEventMessageProjection({
        sourceEventId: event.eventId,
        sourceSequence: event.sequence,
        worldId: world,
        rendererGeneration: 7,
        message: { role: 'user', content },
        createdAt: index + 50,
      });
    });
    assert.throws(
      () =>
        assembleDarkLocalBranch({
          store: value.store,
          expectedActivationEpoch: 0,
          expectedHeadRevision: 0,
          worldId: world,
          branchId: branchId('branch:assembly-candidate-rollback'),
          messageProjectionIds: projections.map(
            (projection) => projection.projectionId,
          ),
          systemLayerProjectionIds: input.systemLayerProjectionIds,
          assembledAt: 60,
        }),
      /candidate exceeds byte limit/,
    );
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_manifest_events',
      'context_local_branch_request_views',
      'context_local_branch_request_system_layers',
      'context_local_branch_request_messages',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rejects stale root state and an active branch', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-stale');
    const input = createDarkAssemblyInputs(value, world, 'assembly-stale');
    const assemble = (
      overrides: Partial<Parameters<typeof assembleDarkLocalBranch>[0]>,
    ) =>
      assembleDarkLocalBranch({
        store: value.store,
        expectedActivationEpoch: 0,
        expectedHeadRevision: 0,
        worldId: world,
        branchId: branchId('branch:assembly-stale'),
        ...input,
        assembledAt: 30,
        ...overrides,
      });
    assert.throws(
      () => assemble({ expectedActivationEpoch: 1 }),
      /activation is not dark at epoch 1/,
    );
    assert.throws(
      () => assemble({ expectedHeadRevision: 1 }),
      StaleContinuationHeadError,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 0);

    value.store.beginCoordinatedBranch({
      branchId: branchId('branch:already-active'),
      worldId: world,
      expectedRevision: 0,
      authorityEpoch: 8,
      startedAt: 31,
    });
    assert.throws(
      () => assemble({ branchId: branchId('branch:blocked-by-active') }),
      /context branch already active/,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 1);
    assert.equal(
      value.store.getRootCoordinatorState().activeBranchId,
      branchId('branch:already-active'),
    );
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly derives same-world parent and fresh authority', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-parent');
    const input = createDarkAssemblyInputs(value, world, 'assembly-parent');
    const previousBranchId = branchId('branch:assembly-parent-history');
    value.store.createBranch({
      branchId: previousBranchId,
      worldId: world,
      authorityEpoch: 8,
      startedAt: 1,
    });
    value.store.finishBranch(previousBranchId, 'yielded', 2);
    value.store.advanceContinuationHead({
      expectedRevision: 0,
      branchId: previousBranchId,
      updatedAt: 3,
    });

    const assembled = assembleDarkLocalBranch({
      store: value.store,
      expectedActivationEpoch: 0,
      expectedHeadRevision: 1,
      worldId: world,
      branchId: branchId('branch:assembly-parent-current'),
      ...input,
      assembledAt: 30,
    });
    assert.equal(assembled.branch.parentBranchId, previousBranchId);
    assert.equal(assembled.branch.authorityEpoch, 9);
    assert.equal(assembled.start.predecessorBranchId, previousBranchId);
    assert.equal(assembled.start.predecessorWorldId, world);
    assert.equal(assembled.start.baseRevision, 1);
    assert.equal(value.store.getContinuationHead().revision, 1);
  } finally {
    closeFixture(value);
  }
});

test('dark local branch assembly rejects incomplete or substituted projection lineage', () => {
  const value = fixture();
  try {
    const world = worldId('world:signal:assembly-lineage');
    const foreignWorld = worldId('world:signal:assembly-foreign');
    const input = createDarkAssemblyInputs(value, world, 'assembly-lineage');
    const foreign = createDarkAssemblyInputs(
      value,
      foreignWorld,
      'assembly-foreign',
    );
    const extraEvent = value.store.appendWorldEvent({
      eventId: eventId('event:assembly-other-generation'),
      worldId: world,
      kind: 'inbound:signal',
      payload: { text: 'other generation' },
      occurredAt: 40,
      recordedAt: 40,
    });
    const wrongGeneration = value.store.createEventMessageProjection({
      sourceEventId: extraEvent.eventId,
      sourceSequence: extraEvent.sequence,
      worldId: world,
      rendererGeneration: 8,
      message: { role: 'user', content: 'OTHER_GENERATION_CANARY' },
      createdAt: 41,
    });
    const assemble = (
      messageProjectionIds: typeof input.messageProjectionIds,
    ) =>
      assembleDarkLocalBranch({
        store: value.store,
        expectedActivationEpoch: 0,
        expectedHeadRevision: 0,
        worldId: world,
        branchId: branchId('branch:assembly-invalid-lineage'),
        messageProjectionIds,
        systemLayerProjectionIds: input.systemLayerProjectionIds,
        assembledAt: 50,
      });

    assert.throws(
      () => assemble([]),
      /requires unique local message projections/,
    );
    assert.throws(
      () =>
        assemble([
          input.messageProjectionIds[0]!,
          input.messageProjectionIds[0]!,
        ]),
      /requires unique local message projections/,
    );
    assert.throws(
      () => assemble([eventMessageProjectionId('event-message:missing')]),
      /projection is missing/,
    );
    assert.throws(
      () => assemble([foreign.messageProjectionIds[0]!]),
      /message lineage is invalid/,
    );
    assert.throws(
      () => assemble([...input.messageProjectionIds].reverse()),
      /manifest event order is invalid/,
    );
    assert.throws(
      () =>
        assemble([
          input.messageProjectionIds[0]!,
          wrongGeneration.projectionId,
        ]),
      /renderer generation is inconsistent/,
    );
    const wrongSystemGeneration = value.store.createSystemLayerProjection({
      kind: 'world_policy',
      visibility: 'world',
      worldId: world,
      rendererGeneration: 5,
      policyGeneration: 3,
      sourceKind: 'synthetic_fixture',
      sourceHash: hashContextBytes('wrong-system-generation'),
      content: 'WRONG_SYSTEM_GENERATION_CANARY',
      createdAt: 42,
    });
    const assembleWithSystem = (
      systemLayerProjectionIds: typeof input.systemLayerProjectionIds,
    ) =>
      assembleDarkLocalBranch({
        store: value.store,
        expectedActivationEpoch: 0,
        expectedHeadRevision: 0,
        worldId: world,
        branchId: branchId('branch:assembly-invalid-system'),
        messageProjectionIds: input.messageProjectionIds,
        systemLayerProjectionIds,
        assembledAt: 50,
      });
    assert.throws(
      () =>
        assembleWithSystem([
          input.systemLayerProjectionIds[0]!,
          input.systemLayerProjectionIds[0]!,
        ]),
      /system layer references are invalid/,
    );
    assert.throws(
      () =>
        assembleWithSystem([systemLayerProjectionId('system-layer:missing')]),
      /system layer is missing/,
    );
    assert.throws(
      () =>
        assembleWithSystem([
          input.systemLayerProjectionIds[0]!,
          input.systemLayerProjectionIds[1]!,
          wrongSystemGeneration.layerId,
        ]),
      /system layer generations are inconsistent/,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 0);

    const firstProjection = value.store.getEventMessageProjection(
      input.messageProjectionIds[0]!,
    )!;
    value.database.exec('DROP TRIGGER context_world_events_no_update');
    value.database
      .prepare(
        'UPDATE context_world_events SET event_kind = ? WHERE event_id = ?',
      )
      .run('derived:capsule', firstProjection.sourceEventId);
    assert.throws(
      () => assemble(input.messageProjectionIds),
      /stored event message projection has invalid source/,
    );
    assert.equal(tableCount(value.database, 'context_branches'), 0);
  } finally {
    closeFixture(value);
  }
});

test('dark ingress admission atomically records only a new exact inbound event', () => {
  const value = fixture();
  try {
    const input = {
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      wakeClass: 'text_user_turn' as const,
      messageRendererGeneration: 7,
      event: {
        eventId: eventId('event:dark-ingress-exact'),
        worldId: worldId('world:signal:dark-ingress'),
        kind: 'inbound:signal',
        payload: { text: 'DARK_INGRESS_PRIVATE_CANARY' },
        occurredAt: 10,
        recordedAt: 11,
      },
      admittedAt: 12,
    };
    const receipt = value.store.admitDarkInboundEvent(input);
    assert.deepEqual(receipt.generation, {
      queueGeneration: 1,
      firstAdmissibleSequence: 1,
      activationEpoch: 0,
    });
    assert.equal(receipt.event.sequence, 1);
    assert.deepEqual(receipt.admission, {
      eventId: input.event.eventId,
      worldId: input.event.worldId,
      sourceSequence: 1,
      activationEpoch: 0,
      queueGeneration: 1,
      wakeClass: 'text_user_turn',
      messageRendererGeneration: 7,
      admittedAt: 12,
    });
    assert.deepEqual(value.store.admitDarkInboundEvent(input), receipt);

    const admissionRow = value.database
      .prepare('SELECT * FROM context_dark_ingress_admissions')
      .get() as Record<string, unknown>;
    assert.equal(
      JSON.stringify(admissionRow).includes('DARK_INGRESS_PRIVATE_CANARY'),
      false,
    );
    assert.equal(
      receipt.event.payloadJson.includes('DARK_INGRESS_PRIVATE_CANARY'),
      true,
    );
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          ...input,
          admittedAt: 13,
        }),
      /dark ingress admission conflict/,
    );
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          ...input,
          event: { ...input.event, payload: { text: 'changed' } },
        }),
      /dark ingress admission conflict/,
    );

    const unadmitted = value.store.appendWorldEvent({
      eventId: eventId('event:dark-ingress-unadmitted'),
      worldId: input.event.worldId,
      kind: 'inbound:signal',
      payload: { text: 'UNADMITTED_CANARY' },
      occurredAt: 20,
      recordedAt: 20,
    });
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          ...input,
          event: {
            eventId: unadmitted.eventId,
            worldId: unadmitted.worldId,
            kind: unadmitted.kind,
            payload: { text: 'UNADMITTED_CANARY' },
            occurredAt: unadmitted.occurredAt,
            recordedAt: unadmitted.recordedAt,
          },
          admittedAt: 20,
        }),
      /dark ingress admission conflict/,
    );
    assert.equal(tableCount(value.database, 'context_dark_ingress_admissions'), 1);
    for (const table of [
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_effects',
      'context_continuation_advances',
    ]) {
      assert.equal(tableCount(value.database, table), 0, table);
    }
  } finally {
    closeFixture(value);
  }
});

test('dark ingress admission rolls its event back after a late database rejection', () => {
  const value = fixture();
  try {
    value.database.exec(`
      CREATE TRIGGER test_dark_ingress_late_rejection
      BEFORE INSERT ON context_dark_ingress_admissions
      WHEN NEW.event_id = 'event:dark-ingress-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic late admission rejection');
      END;
    `);
    const rejectedId = eventId('event:dark-ingress-rollback');
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          expectedActivationEpoch: 0,
          queueGeneration: 1,
          wakeClass: 'text_user_turn',
          messageRendererGeneration: 1,
          event: {
            eventId: rejectedId,
            worldId: worldId('world:discord:rollback'),
            kind: 'inbound:discord',
            payload: { text: 'ROLLBACK_CANARY' },
            occurredAt: 30,
            recordedAt: 30,
          },
          admittedAt: 30,
        }),
      /synthetic late admission rejection/,
    );
    assert.equal(value.store.getWorldEvent(rejectedId), null);
    assert.equal(value.store.getDarkIngressAdmission(rejectedId), null);
    assert.equal(tableCount(value.database, 'context_world_events'), 0);
    assert.equal(tableCount(value.database, 'context_dark_ingress_admissions'), 0);
  } finally {
    closeFixture(value);
  }
});

test('dark ingress admission fails closed on stale state and immutable lineage', () => {
  const value = fixture();
  try {
    const staleId = eventId('event:dark-ingress-stale');
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          expectedActivationEpoch: 1,
          queueGeneration: 1,
          wakeClass: 'text_user_turn',
          messageRendererGeneration: 1,
          event: {
            eventId: staleId,
            worldId: worldId('world:signal:stale'),
            kind: 'inbound:signal',
            payload: { text: 'STALE_CANARY' },
            occurredAt: 40,
            recordedAt: 40,
          },
          admittedAt: 40,
        }),
      /context graph activation is not dark at epoch 1/,
    );
    assert.equal(value.store.getWorldEvent(staleId), null);

    const rejectedDerivedId = eventId('event:dark-ingress-api-derived');
    assert.throws(
      () =>
        value.store.admitDarkInboundEvent({
          expectedActivationEpoch: 0,
          queueGeneration: 1,
          wakeClass: 'text_user_turn',
          messageRendererGeneration: 1,
          event: {
            eventId: rejectedDerivedId,
            worldId: worldId('world:signal:api-derived'),
            kind: 'derived:capsule',
            payload: { text: 'API_DERIVED_CANARY' },
            occurredAt: 45,
            recordedAt: 45,
          },
          admittedAt: 45,
        }),
      /context dark ingress admission lineage is invalid/,
    );
    assert.equal(value.store.getWorldEvent(rejectedDerivedId), null);
    assert.equal(value.store.getDarkIngressAdmission(rejectedDerivedId), null);

    const derived = value.store.appendWorldEvent({
      eventId: eventId('event:dark-ingress-derived'),
      worldId: worldId('world:signal:derived'),
      kind: 'derived:capsule',
      payload: { text: 'DERIVED_CANARY' },
      occurredAt: 50,
      recordedAt: 50,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_dark_ingress_admissions(
               event_id, world_id, source_sequence, activation_epoch,
               queue_generation, wake_class, message_renderer_generation,
               admitted_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            derived.eventId,
            derived.worldId,
            derived.sequence,
            0,
            1,
            'text_user_turn',
            1,
            50,
          ),
      /context dark ingress admission lineage is invalid/,
    );

    const admitted = value.store.admitDarkInboundEvent({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      wakeClass: 'text_user_turn',
      messageRendererGeneration: 1,
      event: {
        eventId: eventId('event:dark-ingress-immutable'),
        worldId: worldId('world:signal:immutable'),
        kind: 'inbound:signal',
        payload: { text: 'IMMUTABLE_CANARY' },
        occurredAt: 60,
        recordedAt: 60,
      },
      admittedAt: 60,
    });
    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_dark_ingress_admissions SET admitted_at = ? WHERE event_id = ?',
          )
          .run(61, admitted.event.eventId),
      /context dark ingress admissions are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'DELETE FROM context_dark_ingress_admissions WHERE event_id = ?',
          )
          .run(admitted.event.eventId),
      /context dark ingress admissions are immutable/,
    );
    assert.throws(
      () =>
        value.database
          .prepare(
            'UPDATE context_dark_ingress_generations SET activation_epoch = 2 WHERE queue_generation = 1',
          )
          .run(),
      /context dark ingress generations are immutable/,
    );
  } finally {
    closeFixture(value);
  }
});

function admitPendingFixture(
  value: ReturnType<typeof fixture>,
  input: {
    id: string;
    world: string;
    rendererGeneration: number;
    queueGeneration?: number;
    content: string;
    time: number;
    project?: boolean;
    projectionRendererGeneration?: number;
  },
) {
  const receipt = value.store.admitDarkInboundEvent({
    expectedActivationEpoch: 0,
    queueGeneration: input.queueGeneration ?? 1,
    wakeClass: 'text_user_turn',
    messageRendererGeneration: input.rendererGeneration,
    event: {
      eventId: eventId(input.id),
      worldId: worldId(input.world),
      kind: 'inbound:signal',
      payload: { text: input.content },
      occurredAt: input.time,
      recordedAt: input.time,
    },
    admittedAt: input.time,
  });
  const projection =
    input.project === false
      ? null
      : value.store.createEventMessageProjection({
          sourceEventId: receipt.event.eventId,
          sourceSequence: receipt.event.sequence,
          worldId: receipt.event.worldId,
          rendererGeneration:
            input.projectionRendererGeneration ?? input.rendererGeneration,
          message: {
            role: 'user',
            content: `<incoming>${input.content}</incoming>`,
          },
          createdAt: input.time,
        });
  return { receipt, projection };
}

test('dark pending inspection is bounded, read-only, and activation-gated', () => {
  const value = fixture();
  try {
    const tables = [
      'context_world_events',
      'context_dark_ingress_admissions',
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_effects',
      'context_continuation_advances',
    ];
    const before = Object.fromEntries(
      tables.map((table) => [table, tableCount(value.database, table)]),
    );
    const activation = value.store.getActivationState();
    const coordinator = value.store.getRootCoordinatorState();
    const head = value.store.getContinuationHead();

    assert.deepEqual(
      value.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 1,
        maxEvents: 4,
      }),
      { status: 'empty' },
    );
    assert.deepEqual(
      value.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 1,
        queueGeneration: 1,
        maxEvents: 4,
      }),
      {
        status: 'blocked',
        reason: 'activation_mismatch',
        expectedActivationEpoch: 1,
        actualMode: 'dark',
        actualActivationEpoch: 0,
      },
    );
    assert.throws(
      () =>
        value.store.inspectNextDarkPendingBatch({
          expectedActivationEpoch: 0,
          queueGeneration: 0,
          maxEvents: 1,
        }),
      /queueGeneration must be positive/,
    );
    for (const maxEvents of [0, 1_025]) {
      assert.throws(
        () =>
          value.store.inspectNextDarkPendingBatch({
            expectedActivationEpoch: 0,
            queueGeneration: 1,
            maxEvents,
          }),
        /maxEvents must be between 1 and 1024/,
      );
    }
    assert.deepEqual(
      Object.fromEntries(
        tables.map((table) => [table, tableCount(value.database, table)]),
      ),
      before,
    );
    assert.deepEqual(value.store.getActivationState(), activation);
    assert.deepEqual(value.store.getRootCoordinatorState(), coordinator);
    assert.deepEqual(value.store.getContinuationHead(), head);
  } finally {
    closeFixture(value);
  }
});

test('dark pending inspection never skips an unrenderable frontier', () => {
  const value = fixture();
  try {
    const first = admitPendingFixture(value, {
      id: 'event:pending-frontier-a',
      world: 'world:signal:pending-a',
      rendererGeneration: 7,
      content: 'FRONTIER_A_PRIVATE_CANARY',
      time: 10,
      project: false,
    });
    admitPendingFixture(value, {
      id: 'event:pending-later-b',
      world: 'world:signal:pending-b',
      rendererGeneration: 7,
      content: 'LATER_B_PRIVATE_CANARY',
      time: 11,
    });
    const tables = [
      'context_world_events',
      'context_dark_ingress_admissions',
      'context_event_message_projections',
      'context_branches',
      'context_branch_starts',
      'context_manifests',
      'context_local_branch_request_views',
      'context_effects',
      'context_continuation_advances',
    ];
    const countsBefore = Object.fromEntries(
      tables.map((table) => [table, tableCount(value.database, table)]),
    );
    const activationBefore = value.store.getActivationState();
    const coordinatorBefore = value.store.getRootCoordinatorState();
    const headBefore = value.store.getContinuationHead();
    const blocked = value.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.deepEqual(blocked, {
      status: 'blocked',
      reason: 'projection_unavailable',
      eventId: first.receipt.event.eventId,
      worldId: first.receipt.event.worldId,
      sourceSequence: first.receipt.event.sequence,
      messageRendererGeneration: 7,
    });
    assert.equal(JSON.stringify(blocked).includes('FRONTIER_A_PRIVATE_CANARY'), false);
    assert.equal(JSON.stringify(blocked).includes('LATER_B_PRIVATE_CANARY'), false);
    assert.deepEqual(
      value.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 2,
        maxEvents: 8,
      }),
      {
        status: 'blocked',
        reason: 'generation_mismatch',
        eventId: first.receipt.event.eventId,
        worldId: first.receipt.event.worldId,
        sourceSequence: first.receipt.event.sequence,
        expectedActivationEpoch: 0,
        actualActivationEpoch: 0,
        expectedQueueGeneration: 2,
        actualQueueGeneration: 1,
      },
    );
    assert.deepEqual(
      Object.fromEntries(
        tables.map((table) => [table, tableCount(value.database, table)]),
      ),
      countsBefore,
    );
    assert.deepEqual(value.store.getActivationState(), activationBefore);
    assert.deepEqual(value.store.getRootCoordinatorState(), coordinatorBefore);
    assert.deepEqual(value.store.getContinuationHead(), headBefore);
  } finally {
    closeFixture(value);
  }

  const wrongRenderer = fixture();
  try {
    const first = admitPendingFixture(wrongRenderer, {
      id: 'event:pending-wrong-renderer',
      world: 'world:signal:pending-wrong-renderer',
      rendererGeneration: 4,
      projectionRendererGeneration: 5,
      content: 'WRONG_RENDERER_PRIVATE_CANARY',
      time: 20,
    });
    assert.deepEqual(
      wrongRenderer.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 1,
        maxEvents: 8,
      }),
      {
        status: 'blocked',
        reason: 'projection_unavailable',
        eventId: first.receipt.event.eventId,
        worldId: first.receipt.event.worldId,
        sourceSequence: first.receipt.event.sequence,
        messageRendererGeneration: 4,
      },
    );
  } finally {
    closeFixture(wrongRenderer);
  }
});

test('dark pending inspection returns only the contiguous same-world renderable prefix', () => {
  const crossWorld = fixture();
  try {
    const a1 = admitPendingFixture(crossWorld, {
      id: 'event:pending-a1',
      world: 'world:signal:pending-prefix-a',
      rendererGeneration: 3,
      content: 'PREFIX_A1_PRIVATE_CANARY',
      time: 30,
    });
    const a2 = admitPendingFixture(crossWorld, {
      id: 'event:pending-a2',
      world: 'world:signal:pending-prefix-a',
      rendererGeneration: 3,
      content: 'PREFIX_A2_PRIVATE_CANARY',
      time: 31,
    });
    const b1 = admitPendingFixture(crossWorld, {
      id: 'event:pending-b1',
      world: 'world:signal:pending-prefix-b',
      rendererGeneration: 3,
      content: 'PREFIX_B1_PRIVATE_CANARY',
      time: 32,
    });
    const a3 = admitPendingFixture(crossWorld, {
      id: 'event:pending-a3',
      world: 'world:signal:pending-prefix-a',
      rendererGeneration: 3,
      content: 'PREFIX_A3_PRIVATE_CANARY',
      time: 33,
    });
    const ready = crossWorld.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.deepEqual(ready, {
      status: 'ready',
      worldId: a1.receipt.event.worldId,
      messageRendererGeneration: 3,
      items: [
        {
          eventId: a1.receipt.event.eventId,
          sourceSequence: a1.receipt.event.sequence,
          projectionId: a1.projection!.projectionId,
        },
        {
          eventId: a2.receipt.event.eventId,
          sourceSequence: a2.receipt.event.sequence,
          projectionId: a2.projection!.projectionId,
        },
      ],
      stopReason: 'world_boundary',
    });
    assert.deepEqual(
      crossWorld.store.inspectNextDarkPendingBatch({
        expectedActivationEpoch: 0,
        queueGeneration: 1,
        maxEvents: 1,
      }),
      {
        status: 'ready',
        worldId: a1.receipt.event.worldId,
        messageRendererGeneration: 3,
        items: [
          {
            eventId: a1.receipt.event.eventId,
            sourceSequence: a1.receipt.event.sequence,
            projectionId: a1.projection!.projectionId,
          },
        ],
        stopReason: 'limit',
      },
    );
    const serialized = JSON.stringify(ready);
    for (const canary of [
      'PREFIX_A1_PRIVATE_CANARY',
      'PREFIX_A2_PRIVATE_CANARY',
      'PREFIX_B1_PRIVATE_CANARY',
      'PREFIX_A3_PRIVATE_CANARY',
    ]) {
      assert.equal(serialized.includes(canary), false);
    }
    assert.equal(serialized.includes(a1.receipt.event.eventId), true);
    assert.equal(serialized.includes(a2.projection!.projectionId), true);
    assert.equal(serialized.includes(b1.receipt.event.eventId), false);
    assert.equal(serialized.includes(b1.projection!.projectionId), false);
    assert.equal(serialized.includes(a3.receipt.event.eventId), false);
    assert.equal(serialized.includes(a3.projection!.projectionId), false);
  } finally {
    closeFixture(crossWorld);
  }

  const rendererBoundary = fixture();
  try {
    admitPendingFixture(rendererBoundary, {
      id: 'event:pending-renderer-1',
      world: 'world:signal:pending-renderer',
      rendererGeneration: 1,
      content: 'RENDERER_ONE_PRIVATE_CANARY',
      time: 40,
    });
    admitPendingFixture(rendererBoundary, {
      id: 'event:pending-renderer-2',
      world: 'world:signal:pending-renderer',
      rendererGeneration: 2,
      content: 'RENDERER_TWO_PRIVATE_CANARY',
      time: 41,
    });
    const ready = rendererBoundary.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.equal(ready.items.length, 1);
      assert.equal(ready.stopReason, 'renderer_boundary');
    }
  } finally {
    closeFixture(rendererBoundary);
  }

  const generationBoundary = fixture();
  try {
    const first = admitPendingFixture(generationBoundary, {
      id: 'event:pending-generation-1',
      world: 'world:signal:pending-generation',
      rendererGeneration: 2,
      content: 'GENERATION_ONE_PRIVATE_CANARY',
      time: 45,
    });
    generationBoundary.database
      .prepare(
        `INSERT INTO context_dark_ingress_generations(
           queue_generation, first_admissible_sequence, activation_epoch
         ) VALUES (?, ?, ?)`,
      )
      .run(2, 2, 0);
    const second = admitPendingFixture(generationBoundary, {
      id: 'event:pending-generation-2',
      world: 'world:signal:pending-generation',
      rendererGeneration: 2,
      queueGeneration: 2,
      content: 'GENERATION_TWO_PRIVATE_CANARY',
      time: 46,
    });
    const secondId = second.receipt.event.eventId;
    const ready = generationBoundary.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.deepEqual(ready, {
      status: 'ready',
      worldId: first.receipt.event.worldId,
      messageRendererGeneration: 2,
      items: [
        {
          eventId: first.receipt.event.eventId,
          sourceSequence: first.receipt.event.sequence,
          projectionId: first.projection!.projectionId,
        },
      ],
      stopReason: 'generation_boundary',
    });
    assert.equal(JSON.stringify(ready).includes(secondId), false);
  } finally {
    closeFixture(generationBoundary);
  }

  const unavailable = fixture();
  try {
    admitPendingFixture(unavailable, {
      id: 'event:pending-projected',
      world: 'world:signal:pending-unavailable',
      rendererGeneration: 6,
      content: 'PROJECTED_PRIVATE_CANARY',
      time: 50,
    });
    admitPendingFixture(unavailable, {
      id: 'event:pending-unprojected',
      world: 'world:signal:pending-unavailable',
      rendererGeneration: 6,
      content: 'UNPROJECTED_PRIVATE_CANARY',
      time: 51,
      project: false,
    });
    const ready = unavailable.store.inspectNextDarkPendingBatch({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      maxEvents: 8,
    });
    assert.equal(ready.status, 'ready');
    if (ready.status === 'ready') {
      assert.equal(ready.items.length, 1);
      assert.equal(ready.stopReason, 'projection_unavailable');
    }
  } finally {
    closeFixture(unavailable);
  }
});
