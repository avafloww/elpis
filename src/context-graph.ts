import { createHash, randomUUID } from 'node:crypto';

import type { ChatMessage } from './llm/llm.js';
import { CONSOLE_CHANNEL_ID, INTERNAL_CHANNEL_ID } from './types.js';

export type WorldId = `world:${string}`;
export type BranchId = `branch:${string}`;
export type EventId = `event:${string}`;

export const INTERNAL_WORLD_ID: WorldId = 'world:internal';
export const CONSOLE_WORLD_ID: WorldId = 'world:console';
export const LEGACY_WORLD_ID: WorldId = 'world:legacy-unscoped';

export interface WorldRoutableInbound {
  channelId: string;
  guildId?: string | null;
  kind?:
    | 'discord'
    | 'signal'
    | 'scheduler'
    | 'heartbeat'
    | 'harness'
    | 'worker'
    | 'watch';
  worldId?: WorldId;
  originWorldId?: WorldId;
}

export interface ScopedContextMessage extends ChatMessage {
  worldId?: WorldId;
  branchId?: BranchId;
  eventId?: EventId;
  sequence?: number;
  sharedFromWorldId?: WorldId;
}

export interface ViewManifest {
  branchId: BranchId;
  worldId: WorldId;
  parentBranchId: BranchId | null;
  authorityEpoch: number;
  eventIds: EventId[];
  sharedEventIds: EventId[];
  policyGeneration: number;
  hash: string;
}

export interface LegacyOpaqueCapsule {
  kind: 'legacy-opaque';
  id: string;
  sha256: string;
  messageCount: number;
  content: string;
}

function isBoundedId(value: unknown, prefix: string): value is string {
  return (
    typeof value === 'string' &&
    value.startsWith(prefix) &&
    value.length > prefix.length &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isWorldId(value: unknown): value is WorldId {
  return isBoundedId(value, 'world:');
}

export function isBranchId(value: unknown): value is BranchId {
  return isBoundedId(value, 'branch:');
}

export function isEventId(value: unknown): value is EventId {
  return isBoundedId(value, 'event:');
}

function boundedSegment(value: string): string {
  if (!value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('invalid world routing segment');
  }
  return encodeURIComponent(value);
}

export function worldIdForInbound(input: WorldRoutableInbound): WorldId {
  if (input.worldId !== undefined) {
    if (!isWorldId(input.worldId)) throw new Error('invalid explicit WorldId');
    return input.worldId;
  }
  if (input.originWorldId !== undefined) {
    if (!isWorldId(input.originWorldId)) {
      throw new Error('invalid origin WorldId');
    }
    return input.originWorldId;
  }
  if (input.kind === 'signal') {
    return `world:signal:${boundedSegment(input.channelId)}`;
  }
  if (input.channelId === CONSOLE_CHANNEL_ID) return CONSOLE_WORLD_ID;
  if (
    input.kind === 'scheduler' ||
    input.channelId === INTERNAL_CHANNEL_ID ||
    input.kind === 'heartbeat' ||
    input.kind === 'harness' ||
    input.kind === 'worker'
  ) {
    return INTERNAL_WORLD_ID;
  }
  if (input.guildId) {
    return `world:discord:guild:${boundedSegment(input.guildId)}`;
  }
  return `world:discord:channel:${boundedSegment(input.channelId)}`;
}

export function createEventId(): EventId {
  return `event:${randomUUID()}`;
}

export function createBranchId(): BranchId {
  return `branch:${randomUUID()}`;
}

export function canonicalViewManifestBytes(
  input: Omit<ViewManifest, 'hash'>,
): string {
  return JSON.stringify({
    schemaVersion: 1,
    branchId: input.branchId,
    worldId: input.worldId,
    parentBranchId: input.parentBranchId,
    authorityEpoch: input.authorityEpoch,
    eventIds: [...input.eventIds],
    sharedEventIds: [...input.sharedEventIds],
    policyGeneration: input.policyGeneration,
  });
}

export function createViewManifest(input: Omit<ViewManifest, 'hash'>): ViewManifest {
  if (!isBranchId(input.branchId) || !isWorldId(input.worldId)) {
    throw new Error('view manifest has invalid branch or world identity');
  }
  if (input.parentBranchId !== null && !isBranchId(input.parentBranchId)) {
    throw new Error('view manifest has invalid parent branch identity');
  }
  if (!Number.isSafeInteger(input.authorityEpoch) || input.authorityEpoch < 1) {
    throw new Error('view manifest authority epoch must be positive');
  }
  if (!Number.isSafeInteger(input.policyGeneration) || input.policyGeneration < 1) {
    throw new Error('view manifest policy generation must be positive');
  }
  const eventIds = [...input.eventIds];
  const sharedEventIds = [...input.sharedEventIds];
  const all = [...eventIds, ...sharedEventIds];
  if (all.some((id) => !isEventId(id)) || new Set(all).size !== all.length) {
    throw new Error('view manifest event identities must be valid and unique');
  }
  const canonical = { ...input, eventIds, sharedEventIds };
  const hash = createHash('sha256')
    .update(canonicalViewManifestBytes(canonical))
    .digest('hex');
  return { ...canonical, hash };
}

export function materializeWorldView(
  messages: readonly ScopedContextMessage[],
  manifest: ViewManifest,
): ScopedContextMessage[] {
  const byId = new Map<EventId, ScopedContextMessage>();
  for (const message of messages) {
    if (!message.eventId) continue;
    if (byId.has(message.eventId)) {
      throw new Error(`duplicate context event ${message.eventId}`);
    }
    byId.set(message.eventId, message);
  }
  const local = new Set(manifest.eventIds);
  return [...manifest.eventIds, ...manifest.sharedEventIds].map((eventId) => {
    const message = byId.get(eventId);
    if (!message) throw new Error(`missing context event ${eventId}`);
    if (local.has(eventId)) {
      if (message.worldId !== manifest.worldId) {
        throw new Error(`local event ${eventId} belongs to another world`);
      }
      return message;
    }
    if (
      message.worldId === manifest.worldId ||
      message.sharedFromWorldId !== message.worldId
    ) {
      throw new Error(`shared event ${eventId} lacks source lineage`);
    }
    return message;
  });
}

export function partitionInitialContext(messages: readonly ChatMessage[]): {
  worlds: Map<WorldId, ScopedContextMessage[]>;
  legacy: ScopedContextMessage[];
  nextSequence: number;
} {
  const worlds = new Map<WorldId, ScopedContextMessage[]>();
  const legacy: ScopedContextMessage[] = [];
  let nextSequence = 1;
  for (const source of messages) {
    const message = { ...source } as ScopedContextMessage;
    const sequence =
      Number.isSafeInteger(message.sequence) && (message.sequence ?? 0) > 0
        ? message.sequence!
        : nextSequence;
    nextSequence = Math.max(nextSequence, sequence + 1);
    message.sequence = sequence;
    if (!isWorldId(message.worldId)) {
      legacy.push(message);
      continue;
    }
    const branch = worlds.get(message.worldId) ?? [];
    branch.push(message);
    worlds.set(message.worldId, branch);
  }
  return { worlds, legacy, nextSequence };
}

export function createLegacyOpaqueCapsule(
  messages: readonly ScopedContextMessage[],
): LegacyOpaqueCapsule | null {
  if (messages.length === 0) return null;
  const body = messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.channel ? { channel: message.channel } : {}),
  }));
  const content = JSON.stringify(body);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return {
    kind: 'legacy-opaque',
    id: `legacy:${sha256}`,
    sha256,
    messageCount: messages.length,
    content,
  };
}

export class ContinuationHead {
  private active: { branchId: BranchId; worldId: WorldId } | null = null;
  private parentBranchId: BranchId | null = null;
  private authorityEpoch = 1;

  begin(worldId: WorldId): {
    branchId: BranchId;
    worldId: WorldId;
    parentBranchId: BranchId | null;
    authorityEpoch: number;
  } {
    if (this.active) throw new Error('continuation head already has an active branch');
    const branchId = createBranchId();
    this.active = { branchId, worldId };
    return {
      branchId,
      worldId,
      parentBranchId: this.parentBranchId,
      authorityEpoch: this.authorityEpoch,
    };
  }

  finish(branchId: BranchId): void {
    if (!this.active || this.active.branchId !== branchId) {
      throw new Error('cannot advance continuation head from a stale branch');
    }
    this.parentBranchId = branchId;
    this.active = null;
  }

  revoke(): number {
    this.authorityEpoch += 1;
    return this.authorityEpoch;
  }

  snapshot(): Readonly<{
    active: { branchId: BranchId; worldId: WorldId } | null;
    parentBranchId: BranchId | null;
    authorityEpoch: number;
  }> {
    return Object.freeze({
      active: this.active ? { ...this.active } : null,
      parentBranchId: this.parentBranchId,
      authorityEpoch: this.authorityEpoch,
    });
  }
}
