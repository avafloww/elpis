const DISCORD_ID_PATTERN = /^[0-9]{1,20}$/;
const DISCORD_ALLOWED_USER_LIMIT = 100;

export function isDiscordId(value: unknown): value is string {
  return typeof value === 'string' && DISCORD_ID_PATTERN.test(value);
}

export function validateDiscordId(
  value: unknown,
  label: string,
): asserts value is string {
  if (!isDiscordId(value)) {
    throw new Error(
      `${label} must be a nonempty decimal Discord ID string (at most 20 digits)`,
    );
  }
}

/** Reply metadata never changes the explicit destination or authorizes a send. */
export function validateReplyTo(
  replyTo: unknown,
): asserts replyTo is string | undefined {
  if (replyTo !== undefined) validateDiscordId(replyTo, 'replyTo');
}

/** Exact user-mention markup present in one already-chunked Discord message. */
export function discordMentionUserIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/<@!?([0-9]{1,20})>/g)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === DISCORD_ALLOWED_USER_LIMIT) break;
  }
  return ids;
}

/** Every payload disables implicit parsing; only validated explicit users may notify. */
export function discordMessageOptions(
  replyTo: string | undefined,
  chunkIndex: number,
  allowedUserIds: readonly unknown[] = [],
) {
  validateReplyTo(replyTo);
  const users: string[] = [];
  const seen = new Set<string>();
  for (const value of allowedUserIds) {
    if (!isDiscordId(value) || seen.has(value)) continue;
    seen.add(value);
    users.push(value);
    if (users.length === DISCORD_ALLOWED_USER_LIMIT) break;
  }
  return {
    ...(replyTo !== undefined && chunkIndex === 0
      ? {
          reply: { messageReference: replyTo, failIfNotExists: true },
        }
      : {}),
    allowedMentions: { parse: [], users, repliedUser: false },
  };
}

/** Compatibility name for callers that need no explicit user notifications. */
export function discordReplyOptions(
  replyTo: string | undefined,
  chunkIndex: number,
) {
  return discordMessageOptions(replyTo, chunkIndex);
}
