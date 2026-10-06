import { createHash } from 'node:crypto';

import type { InboundMessage } from '../agent.js';
import { worldIdForInbound, type WorldId } from '../context-graph.js';
import { eventId, type EventId } from '../store/context-graph.js';

export interface SocialInboundGraphEncoding {
  readonly eventId: EventId;
  readonly worldId: WorldId;
  readonly kind: `inbound:${NonNullable<InboundMessage['kind']>}`;
  readonly payload: {
    readonly schemaVersion: 1;
    readonly id: string;
    readonly source: InboundMessage['source'] | null;
    readonly transport: InboundMessage['transport'] | null;
    readonly kind: NonNullable<InboundMessage['kind']>;
    readonly channelId: string;
    readonly channelName: string;
    readonly guildId: string | null;
    readonly guildSlug: string | null;
    readonly policyChannelId: string | null;
    readonly originWorldId: WorldId | null;
    readonly author: string;
    readonly authorId: string;
    readonly bot: boolean;
    readonly content: string;
    readonly createdAt: string;
    readonly replyTo: InboundMessage['replyTo'];
    readonly forwarded: InboundMessage['forwarded'];
    readonly mentions: readonly string[];
    readonly attachments: readonly InboundMessage['attachments'][number][];
    readonly wakeClass: NonNullable<InboundMessage['wakeClass']>;
    readonly sendScope: InboundMessage['sendScope'] | null;
    readonly sends: InboundMessage['sends'] | null;
  };
  readonly occurredAt: number;
}

/** Pure, canonical graph identity and payload encoding for social ingress. */
export function encodeSocialInboundGraph(
  message: InboundMessage,
): SocialInboundGraphEncoding {
  const kind = message.kind ?? 'discord';
  const worldId = worldIdForInbound({
    channelId: message.channelId,
    guildId: message.guildId,
    kind,
    originWorldId: message.originWorldId,
  });
  const payload = {
    schemaVersion: 1 as const,
    id: message.id,
    source: message.source ?? null,
    transport: message.transport ?? null,
    kind,
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
    mentions: message.mentions.map((mention) => mention),
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    wakeClass: message.wakeClass ?? 'wake',
    sendScope: message.sendScope ?? null,
    sends: message.sends ?? null,
  };
  const occurredAt = Date.parse(message.createdAt);
  const identity = createHash('sha256')
    .update(worldId)
    .update('\u0000')
    .update(kind)
    .update('\u0000')
    .update(message.id)
    .digest('hex');
  return {
    eventId: eventId(`event:ingress:${identity}`),
    worldId,
    kind: `inbound:${kind}`,
    payload,
    occurredAt: Number.isSafeInteger(occurredAt) ? occurredAt : 0,
  };
}
