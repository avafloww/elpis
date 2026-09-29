import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { createViewManifest } from '../src/context-graph.js';
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

    assert.throws(
      () =>
        value.store.createBranch({
          branchId: branchId('branch:b-child'),
          worldId: worldB,
          parentBranchId: branchId('branch:a'),
          authorityEpoch: 1,
          startedAt: 11,
        }),
      /FOREIGN KEY constraint failed/,
    );

    createBranch(value.store, 'branch:b', worldB, 12);
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
          .run(
            'capsule:parent',
            'capsule:child',
            'world:legacy-unscoped',
            0,
          ),
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

    createBranch(value.store, 'branch:destination', destinationWorld, 14);
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
    assert.deepEqual({ ...shareEdge }, {
      grant_id: 'share:one',
      shared_event_id: 'event:share:one',
      destination_world_id: destinationWorld,
    });

    createBranch(value.store, 'branch:tampered', destinationWorld, 16);
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

    value.store.revokeShareGrant(shareGrantId('share:one'), 18);
    createBranch(value.store, 'branch:revoked', destinationWorld, 19);
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
    createBranch(value.store, 'branch:2', 'world:console', 11);
    value.store.finishBranch(branchId('branch:1'), 'yielded', 12);

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
          .prepare('DELETE FROM context_continuation_advances WHERE revision = 1')
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
          sourceHash: hashContextBytes('different bytes must not gain old provenance'),
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
