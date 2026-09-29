import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContinuationHead,
  INTERNAL_WORLD_ID,
  createLegacyOpaqueCapsule,
  createViewManifest,
  materializeWorldView,
  partitionInitialContext,
  worldIdForInbound,
  type BranchId,
  type EventId,
  type ScopedContextMessage,
  type WorldId,
} from '../src/context-graph.js';

test('routes ingress to stable transport worlds before body use', () => {
  assert.equal(
    worldIdForInbound({ channelId: 'room-a', guildId: 'guild-a', kind: 'discord' }),
    'world:discord:guild:guild-a',
  );
  assert.equal(
    worldIdForInbound({ channelId: 'signal-private', kind: 'signal' }),
    'world:signal:signal-private',
  );
  assert.equal(
    worldIdForInbound({ channelId: 'internal', kind: 'scheduler' }),
    INTERNAL_WORLD_ID,
  );
  assert.equal(
    worldIdForInbound({
      channelId: 'internal',
      kind: 'worker',
      originWorldId: 'world:discord:guild:guild-a',
    }),
    'world:discord:guild:guild-a',
  );
});

test('view manifests hash exact ordered identities and reject duplicates', () => {
  const input = {
    branchId: 'branch:manifest' as BranchId,
    worldId: 'world:discord:guild:a' as WorldId,
    parentBranchId: null,
    authorityEpoch: 1,
    eventIds: ['event:a', 'event:b'] as EventId[],
    sharedEventIds: [] as EventId[],
    policyGeneration: 1,
  };
  const first = createViewManifest(input);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.equal(createViewManifest({ ...input }).hash, first.hash);
  assert.notEqual(
    createViewManifest({ ...input, eventIds: [...input.eventIds].reverse() }).hash,
    first.hash,
  );
  assert.throws(
    () =>
      createViewManifest({
        ...input,
        sharedEventIds: ['event:a'] as EventId[],
      }),
    /valid and unique/,
  );
});

test('materialized view excludes a supplied other-world canary without an exact share', () => {
  const worldA = 'world:discord:guild:a' as WorldId;
  const worldB = 'world:discord:guild:b' as WorldId;
  const eventA = 'event:a' as EventId;
  const eventB = 'event:b' as EventId;
  const messages: ScopedContextMessage[] = [
    { role: 'user', content: 'ASTER-CANARY', worldId: worldA, eventId: eventA },
    { role: 'user', content: 'allowed-b', worldId: worldB, eventId: eventB },
  ];
  const manifest = createViewManifest({
    branchId: 'branch:b' as BranchId,
    worldId: worldB,
    parentBranchId: null,
    authorityEpoch: 1,
    eventIds: [eventB],
    sharedEventIds: [],
    policyGeneration: 1,
  });
  const view = materializeWorldView(messages, manifest);
  assert.deepEqual(view.map((message) => message.content), ['allowed-b']);
  assert.ok(!JSON.stringify(view).includes('ASTER-CANARY'));
});

test('explicit shares require both manifest membership and source lineage', () => {
  const worldA = 'world:discord:guild:a' as WorldId;
  const worldB = 'world:discord:guild:b' as WorldId;
  const shared = 'event:shared' as EventId;
  const message: ScopedContextMessage = {
    role: 'user',
    content: 'exact portable claim',
    worldId: worldA,
    sharedFromWorldId: worldA,
    eventId: shared,
  };
  const manifest = createViewManifest({
    branchId: 'branch:b' as BranchId,
    worldId: worldB,
    parentBranchId: null,
    authorityEpoch: 1,
    eventIds: [],
    sharedEventIds: [shared],
    policyGeneration: 1,
  });
  assert.deepEqual(materializeWorldView([message], manifest), [message]);
  assert.throws(
    () =>
      materializeWorldView(
        [{ ...message, sharedFromWorldId: undefined }],
        manifest,
      ),
    /lacks source lineage/,
  );
});

test('legacy messages stay sealed instead of receiving invented world provenance', () => {
  const scoped: ScopedContextMessage = {
    role: 'user',
    content: 'new scoped record',
    worldId: 'world:internal',
    eventId: 'event:new',
    sequence: 8,
  };
  const legacy: ScopedContextMessage = {
    role: 'user',
    content: 'old mixed attractor',
  };
  const partitioned = partitionInitialContext([legacy, scoped]);
  assert.equal(legacy.sequence, undefined);
  assert.deepEqual(partitioned.worlds.get(INTERNAL_WORLD_ID), [scoped]);
  assert.deepEqual(partitioned.legacy, [{ ...legacy, sequence: 1 }]);
  const capsule = createLegacyOpaqueCapsule(partitioned.legacy);
  assert.equal(capsule?.messageCount, 1);
  assert.match(capsule?.content ?? '', /old mixed attractor/);
  assert.ok(!capsule?.content.includes('worldId'));
});

test('continuation head rejects concurrent and stale advancement', () => {
  const head = new ContinuationHead();
  const first = head.begin('world:internal');
  assert.throws(() => head.begin('world:internal'), /active branch/);
  assert.throws(
    () => head.finish('branch:stale' as BranchId),
    /stale branch/,
  );
  head.finish(first.branchId);
  const second = head.begin('world:console');
  assert.equal(second.parentBranchId, first.branchId);
  assert.equal(head.revoke(), 2);
  assert.equal(head.snapshot().authorityEpoch, 2);
});
