export interface ActiveHomeIngressClassifierInput {
  readonly eventKind: string;
  readonly eventWorldId: string;
  readonly payload: unknown;
  readonly scope: {
    readonly worldId: string;
    readonly guildId: string;
    readonly channelId: string;
  };
}

export function activeHomeIngressContent(
  input: ActiveHomeIngressClassifierInput,
): string | null {
  if (
    input.eventKind !== 'inbound:discord' ||
    input.eventWorldId !== input.scope.worldId ||
    input.payload === null ||
    typeof input.payload !== 'object' ||
    Array.isArray(input.payload)
  ) {
    return null;
  }
  const payload = input.payload as Record<string, unknown>;
  if (
    payload.schemaVersion !== 1 ||
    payload.kind !== 'discord' ||
    payload.source !== null ||
    payload.transport !== null ||
    payload.originWorldId !== null ||
    payload.forwarded !== null ||
    payload.guildId !== input.scope.guildId ||
    payload.channelId !== input.scope.channelId ||
    payload.bot !== false ||
    payload.wakeClass !== 'wake' ||
    !Array.isArray(payload.attachments) ||
    payload.attachments.length !== 0 ||
    typeof payload.content !== 'string' ||
    payload.content.length === 0 ||
    Buffer.byteLength(payload.content) > 8 * 1024 * 1024
  ) {
    return null;
  }
  return payload.content;
}

export function activeHomeIngressMessageJson(input: {
  readonly payloadJson: string;
  readonly eventKind: string;
  readonly eventWorldId: string;
  readonly scopeWorldId: string;
  readonly guildId: string;
  readonly channelId: string;
}): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(input.payloadJson);
  } catch {
    return null;
  }
  const content = activeHomeIngressContent({
    eventKind: input.eventKind,
    eventWorldId: input.eventWorldId,
    payload,
    scope: {
      worldId: input.scopeWorldId,
      guildId: input.guildId,
      channelId: input.channelId,
    },
  });
  return content === null ? null : JSON.stringify({ role: 'user', content });
}
