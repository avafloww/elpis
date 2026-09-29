import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createViewManifest } from '../src/context-graph.js';
import { materializeWorldConversation } from '../src/context/view.js';
import { openDatabase } from '../src/store/db.js';
import {
  ContextGraphStore,
  LegacyImportConflictError,
  StaleContinuationHeadError,
  branchId,
  capsuleId,
  effectId,
  eventId,
  hashContextBytes,
  legacyImportReceiptId,
  manifestId,
  shareGrantId,
  shadowProjectionPlanId,
  shadowRequestObservationId,
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
        message: { role: 'user', content: `<incoming>${event.text}</incoming>` },
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
      value.database.prepare('DELETE FROM context_event_message_projections').run(),
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
