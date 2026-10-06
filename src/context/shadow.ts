import { createHash, randomUUID } from 'node:crypto';

import type { InboundMessage } from '../agent.js';
import type {
  ChatMessage,
  ProviderContentProjectionObserver,
} from '../llm/llm.js';
import type { FrozenSystemLayer } from '../llm/prompt.js';
import {
  isEventId,
  isWorldId,
  worldIdForInbound,
  type EventId,
  type WorldId,
} from '../context-graph.js';
import {
  ContextGraphStore,
  shadowProjectionPlanId,
  shadowRequestObservationId,
  type EventMessageProjectionId,
  type SystemLayerProjectionId,
  type WorldEventRecord,
} from '../store/context-graph.js';
import { encodeSocialInboundGraph } from './social-inbound.js';

export type ShadowProjectionBlocker =
  | 'legacy_mixed_system'
  | 'unlineaged_history'
  | 'multiple_worlds'
  | 'unverified_share'
  | 'multimodal_unavailable'
  | 'duplicate_event'
  | 'unsupported_projected_role'
  | 'unrendered_event'
  | 'render_projection_mismatch'
  | 'legacy_monocontext_contract'
  | 'legacy_mixed_memory'
  | 'legacy_mixed_focus'
  | 'identity_candidate_unapproved'
  | 'runtime_hint_unscoped'
  | 'system_layer_unavailable'
  | 'system_layer_mismatch'
  | 'unbound_effect_tools';

export interface ShadowProjectionPlanV1 {
  readonly schemaVersion: 1;
  readonly worldId: WorldId;
  readonly wakeEventId: EventId;
  readonly projectionGeneration: 1;
  readonly policyGeneration: 1;
  readonly localEventIds: readonly EventId[];
  readonly sharedEventIds: readonly EventId[];
  readonly foreignWorlds: readonly {
    readonly worldId: WorldId;
    readonly messageCount: number;
  }[];
  readonly unlineagedRoles: Readonly<Record<ChatMessage['role'], number>>;
  readonly systemLayers: readonly {
    readonly ordinal: number;
    readonly sha256: string;
    readonly byteLength: number;
    readonly scope: 'legacy-mixed';
  }[];
  readonly blockers: readonly ShadowProjectionBlocker[];
}

export interface ShadowProjectionPlanV2 extends Omit<
  ShadowProjectionPlanV1,
  'schemaVersion' | 'projectionGeneration'
> {
  readonly schemaVersion: 2;
  readonly projectionGeneration: 2;
  readonly rendererGeneration: 1;
  readonly localMessageProjectionIds: readonly EventMessageProjectionId[];
}

export interface ShadowProjectionPlanV3 extends Omit<
  ShadowProjectionPlanV2,
  'schemaVersion' | 'projectionGeneration' | 'systemLayers'
> {
  readonly schemaVersion: 3;
  readonly projectionGeneration: 3;
  readonly systemRendererGeneration: 1;
  readonly systemLayerProjectionIds: readonly SystemLayerProjectionId[];
}

export type ShadowProjectionPlan =
  ShadowProjectionPlanV1 | ShadowProjectionPlanV2 | ShadowProjectionPlanV3;

const blockerOrder: readonly ShadowProjectionBlocker[] = [
  'legacy_mixed_system',
  'unlineaged_history',
  'multiple_worlds',
  'unverified_share',
  'multimodal_unavailable',
  'duplicate_event',
  'unsupported_projected_role',
  'unrendered_event',
  'render_projection_mismatch',
  'legacy_monocontext_contract',
  'legacy_mixed_memory',
  'legacy_mixed_focus',
  'identity_candidate_unapproved',
  'runtime_hint_unscoped',
  'system_layer_unavailable',
  'system_layer_mismatch',
  'unbound_effect_tools',
];

export function buildShadowProjectionPlan(input: {
  messages: readonly ChatMessage[];
  wakeLineage: NonNullable<InboundMessage['contextGraphLineage']>;
  localProjections?: ReadonlyMap<EventId, EventMessageProjectionId>;
  projectionMismatches?: ReadonlySet<EventId>;
  systemLayerProjectionIds?: readonly SystemLayerProjectionId[];
  systemLayerBlockers?: readonly ShadowProjectionBlocker[];
}): ShadowProjectionPlanV3 {
  if (
    !isWorldId(input.wakeLineage.worldId) ||
    !isEventId(input.wakeLineage.eventId)
  ) {
    throw new Error('shadow request wake lineage is invalid');
  }
  const blockers = new Set<ShadowProjectionBlocker>();
  const localEventIds: EventId[] = [];
  const localMessageProjectionIds: EventMessageProjectionId[] = [];
  const sharedEventIds: EventId[] = [];
  const seenEvents = new Set<EventId>();
  const foreignCounts = new Map<WorldId, number>();
  const unlineagedRoles: Record<ChatMessage['role'], number> = {
    system: 0,
    user: 0,
    assistant: 0,
    tool: 0,
  };
  let systemMessageCount = 0;

  input.messages.forEach((message) => {
    if (message.role === 'system') {
      systemMessageCount += 1;
      if (message.contentParts) blockers.add('multimodal_unavailable');
      return;
    }
    if (message.contentParts) blockers.add('multimodal_unavailable');
    if (!isWorldId(message.worldId) || !isEventId(message.eventId)) {
      unlineagedRoles[message.role] += 1;
      blockers.add('unlineaged_history');
      return;
    }
    if (seenEvents.has(message.eventId)) {
      blockers.add('duplicate_event');
      return;
    }
    seenEvents.add(message.eventId);
    if (message.worldId === input.wakeLineage.worldId) {
      localEventIds.push(message.eventId);
      if (message.role !== 'user') {
        blockers.add('unsupported_projected_role');
        blockers.add('unrendered_event');
        return;
      }
      if (message.contentParts) {
        blockers.add('multimodal_unavailable');
        blockers.add('unrendered_event');
        return;
      }
      if (input.projectionMismatches?.has(message.eventId)) {
        blockers.add('render_projection_mismatch');
        blockers.add('unrendered_event');
        return;
      }
      const projectionId = input.localProjections?.get(message.eventId);
      if (!projectionId) {
        blockers.add('unrendered_event');
        return;
      }
      localMessageProjectionIds.push(projectionId);
      return;
    }
    foreignCounts.set(
      message.worldId,
      (foreignCounts.get(message.worldId) ?? 0) + 1,
    );
    if (
      message.sharedFromWorldId === message.worldId &&
      typeof message.viewManifestHash === 'string'
    ) {
      sharedEventIds.push(message.eventId);
      blockers.add('unverified_share');
    } else {
      blockers.add('multiple_worlds');
    }
  });

  for (const blocker of input.systemLayerBlockers ?? []) blockers.add(blocker);
  if (
    systemMessageCount !== 1 ||
    !input.systemLayerProjectionIds ||
    input.systemLayerProjectionIds.length === 0
  ) {
    blockers.add('system_layer_unavailable');
  }
  blockers.add('unbound_effect_tools');

  return {
    schemaVersion: 3,
    worldId: input.wakeLineage.worldId,
    wakeEventId: input.wakeLineage.eventId,
    projectionGeneration: 3,
    policyGeneration: 1,
    rendererGeneration: 1,
    systemRendererGeneration: 1,
    localEventIds,
    localMessageProjectionIds,
    sharedEventIds,
    foreignWorlds: [...foreignCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([worldId, messageCount]) => ({ worldId, messageCount })),
    unlineagedRoles,
    systemLayerProjectionIds: [...(input.systemLayerProjectionIds ?? [])],
    blockers: blockerOrder.filter((blocker) => blockers.has(blocker)),
  };
}

export class ContextGraphShadowRecorder {
  constructor(private readonly store: ContextGraphStore) {}

  prepareRequestObservation(input: {
    messages: readonly ChatMessage[];
    systemLayers?: readonly FrozenSystemLayer[];
    wakeLineage: InboundMessage['contextGraphLineage'] | null;
  }): ProviderContentProjectionObserver | undefined {
    if (!input.wakeLineage) return undefined;
    const systemLayerProjectionIds: SystemLayerProjectionId[] = [];
    const systemLayerBlockers = new Set<ShadowProjectionBlocker>();
    const systemMessages = input.messages.filter(
      (message) => message.role === 'system',
    );
    const renderedLayers = input.systemLayers ?? [];
    const systemMatches =
      systemMessages.length === 1 &&
      renderedLayers.length > 0 &&
      renderedLayers.map((layer) => layer.content).join('') ===
        systemMessages[0].content;
    if (!systemMatches) {
      systemLayerBlockers.add('system_layer_mismatch');
    } else {
      try {
        for (const layer of renderedLayers) {
          if (
            createHash('sha256').update(layer.content).digest('hex') !==
              layer.contentHash ||
            Buffer.byteLength(layer.content) !== layer.byteLength ||
            !/^[0-9a-f]{64}$/.test(layer.sourceHash)
          ) {
            throw new Error('frozen system layer integrity mismatch');
          }
          const storedLayer = this.store.createSystemLayerProjection({
            kind: layer.kind,
            visibility: layer.visibility,
            worldId: null,
            rendererGeneration: 1,
            policyGeneration: 1,
            sourceKind: layer.sourceKind,
            sourceHash: layer.sourceHash,
            content: layer.content,
            createdAt: Date.now(),
          });
          if (
            storedLayer.contentHash !== layer.contentHash ||
            storedLayer.contentBytes !== layer.byteLength
          ) {
            throw new Error('stored system layer integrity mismatch');
          }
          systemLayerProjectionIds.push(storedLayer.layerId);
          switch (layer.kind) {
            case 'runtime_contract':
              systemLayerBlockers.add('legacy_monocontext_contract');
              break;
            case 'legacy_memory':
              systemLayerBlockers.add('legacy_mixed_memory');
              break;
            case 'legacy_focus':
              systemLayerBlockers.add('legacy_mixed_focus');
              break;
            case 'identity':
              systemLayerBlockers.add('identity_candidate_unapproved');
              break;
            case 'runtime_hint':
              systemLayerBlockers.add('runtime_hint_unscoped');
              break;
          }
        }
      } catch {
        systemLayerProjectionIds.length = 0;
        systemLayerBlockers.add('system_layer_mismatch');
      }
    }
    if (systemLayerProjectionIds.length === 0) {
      systemLayerBlockers.add('system_layer_unavailable');
    }
    const localProjections = new Map<EventId, EventMessageProjectionId>();
    const projectionMismatches = new Set<EventId>();
    for (const message of input.messages) {
      if (
        message.worldId !== input.wakeLineage.worldId ||
        !isEventId(message.eventId) ||
        message.role !== 'user' ||
        message.contentParts
      ) {
        continue;
      }
      const sourceSequence = message.sequence;
      if (
        typeof sourceSequence !== 'number' ||
        !Number.isSafeInteger(sourceSequence) ||
        sourceSequence < 1
      ) {
        projectionMismatches.add(message.eventId);
        continue;
      }
      try {
        const projection = this.store.createEventMessageProjection({
          sourceEventId: message.eventId,
          sourceSequence,
          worldId: input.wakeLineage.worldId,
          rendererGeneration: 1,
          message: { role: 'user', content: message.content },
          createdAt: Date.now(),
        });
        localProjections.set(message.eventId, projection.projectionId);
      } catch {
        projectionMismatches.add(message.eventId);
      }
    }
    const plan = buildShadowProjectionPlan({
      messages: input.messages,
      wakeLineage: input.wakeLineage,
      localProjections,
      projectionMismatches,
      systemLayerProjectionIds,
      systemLayerBlockers: [...systemLayerBlockers],
    });
    const planJson = JSON.stringify(plan);
    const planHash = createHash('sha256').update(planJson).digest('hex');
    const stored = this.store.createShadowProjectionPlan({
      planId: shadowProjectionPlanId(`shadow-plan:${planHash}`),
      worldId: plan.worldId,
      wakeEventId: plan.wakeEventId,
      plan,
      createdAt: Date.now(),
    });
    const planReason = plan.blockers[0] ?? 'projection_unavailable';
    return (projection) => {
      const actualBytes = Buffer.byteLength(projection.bytes);
      const actualHash = createHash('sha256')
        .update(projection.bytes)
        .digest('hex');
      const integrityOk =
        actualBytes === projection.byteLength &&
        actualHash === projection.sha256;
      this.store.recordShadowRequestObservation({
        observationId: shadowRequestObservationId(
          `shadow-observation:${randomUUID()}`,
        ),
        planId: stored.planId,
        worldId: stored.worldId,
        surface: projection.surface,
        actualHash,
        actualBytes,
        result: 'ineligible',
        reason: integrityOk ? planReason : 'projection_integrity',
        expectedHash: null,
        expectedBytes: null,
        observedAt: Date.now(),
      });
    };
  }

  recordInbound(message: InboundMessage): WorldEventRecord {
    const encoded = encodeSocialInboundGraph(message);
    return this.store.appendWorldEvent({
      ...encoded,
      recordedAt: Date.now(),
    });
  }
}

export function originWorldForChannel(
  channelId: string | null | undefined,
  guildId: string | null | undefined,
): WorldId | undefined {
  if (!channelId) return undefined;
  return worldIdForInbound({
    channelId,
    guildId,
    kind: channelId.startsWith('signal:') ? 'signal' : 'discord',
  });
}
