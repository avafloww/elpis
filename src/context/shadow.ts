import { createHash } from 'node:crypto';

import type { InboundMessage } from '../agent.js';
import { worldIdForInbound, type WorldId } from '../context-graph.js';
import {
  ContextGraphStore,
  eventId,
  type WorldEventRecord,
} from '../store/context-graph.js';

export class ContextGraphShadowRecorder {
  constructor(private readonly store: ContextGraphStore) {}

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
