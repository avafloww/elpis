import { createHash, randomUUID } from 'node:crypto';

import type { InboundMessage } from '../agent.js';
import type {
  ChatMessage,
  ProviderContentProjectionObserver,
} from '../llm/llm.js';
import {
  isEventId,
  isWorldId,
  worldIdForInbound,
  type EventId,
  type WorldId,
} from '../context-graph.js';
import {
  ContextGraphStore,
  eventId,
  shadowProjectionPlanId,
  shadowRequestObservationId,
  type EventMessageProjectionId,
  type WorldEventRecord,
} from '../store/context-graph.js';

export type ShadowProjectionBlocker =
  | 'legacy_mixed_system'
  | 'unlineaged_history'
  | 'multiple_worlds'
  | 'unverified_share'
  | 'multimodal_unavailable'
  | 'duplicate_event'
  | 'unsupported_projected_role'
  | 'unrendered_event'
  | 'render_projection_mismatch';

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

export interface ShadowProjectionPlanV2
  extends Omit<
    ShadowProjectionPlanV1,
    'schemaVersion' | 'projectionGeneration'
  > {
  readonly schemaVersion: 2;
  readonly projectionGeneration: 2;
  readonly rendererGeneration: 1;
  readonly localMessageProjectionIds: readonly EventMessageProjectionId[];
}

export type ShadowProjectionPlan =
  | ShadowProjectionPlanV1
  | ShadowProjectionPlanV2;

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
];

export function buildShadowProjectionPlan(input: {
  messages: readonly ChatMessage[];
  wakeLineage: NonNullable<InboundMessage['contextGraphLineage']>;
  localProjections?: ReadonlyMap<EventId, EventMessageProjectionId>;
  projectionMismatches?: ReadonlySet<EventId>;
}): ShadowProjectionPlanV2 {
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
  const systemLayers: Array<{
    ordinal: number;
    sha256: string;
    byteLength: number;
    scope: 'legacy-mixed';
  }> = [];

  input.messages.forEach((message, ordinal) => {
    if (message.role === 'system') {
      const bytes = Buffer.from(message.content);
      systemLayers.push({
        ordinal,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        byteLength: bytes.byteLength,
        scope: 'legacy-mixed',
      });
      blockers.add('legacy_mixed_system');
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

  return {
    schemaVersion: 2,
    worldId: input.wakeLineage.worldId,
    wakeEventId: input.wakeLineage.eventId,
    projectionGeneration: 2,
    policyGeneration: 1,
    rendererGeneration: 1,
    localEventIds,
    localMessageProjectionIds,
    sharedEventIds,
    foreignWorlds: [...foreignCounts]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([worldId, messageCount]) => ({ worldId, messageCount })),
    unlineagedRoles,
    systemLayers,
    blockers: blockerOrder.filter((blocker) => blockers.has(blocker)),
  };
}

export class ContextGraphShadowRecorder {
  constructor(private readonly store: ContextGraphStore) {}

  prepareRequestObservation(input: {
    messages: readonly ChatMessage[];
    wakeLineage: InboundMessage['contextGraphLineage'] | null;
  }): ProviderContentProjectionObserver | undefined {
    if (!input.wakeLineage) return undefined;
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
      try {
        const projection = this.store.createEventMessageProjection({
          sourceEventId: message.eventId,
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
    const worldId = worldIdForInbound({
      channelId: message.channelId,
      guildId: message.guildId,
      kind: message.kind,
      originWorldId: message.originWorldId,
    });
    const payload = {
      schemaVersion: 1,
      id: message.id,
      source: message.source ?? null,
      transport: message.transport ?? null,
      kind: message.kind ?? 'discord',
      channelId: message.channelId,
      channelName: message.channelName,
      guildId: message.guildId ?? null,
      guildSlug: message.guildSlug ?? null,
      policyChannelId: message.policyChannelId ?? null,
      originWorldId: message.originWorldId ?? null,
      author: message.author,
      authorId: message.authorId,
      bot: message.bot ?? false,
      content: message.content,
      createdAt: message.createdAt,
      replyTo: message.replyTo,
      forwarded: message.forwarded,
      mentions: [...message.mentions],
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
      wakeClass: message.wakeClass ?? 'wake',
      sendScope: message.sendScope ?? null,
      sends: message.sends ?? null,
    };
    const occurredAt = Date.parse(message.createdAt);
    const identity = createHash('sha256')
      .update(worldId)
      .update('\u0000')
      .update(message.kind ?? 'discord')
      .update('\u0000')
      .update(message.id)
      .digest('hex');
    return this.store.appendWorldEvent({
      eventId: eventId(`event:ingress:${identity}`),
      worldId,
      kind: `inbound:${message.kind ?? 'discord'}`,
      payload,
      occurredAt: Number.isSafeInteger(occurredAt) ? occurredAt : 0,
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
