/** Reply metadata never changes the explicit destination or authorizes a send. */
export function validateReplyTo(
  replyTo: unknown,
): asserts replyTo is string | undefined {
  if (
    replyTo !== undefined &&
    (typeof replyTo !== 'string' || !/^[0-9]{1,20}$/.test(replyTo))
  ) {
    throw new Error(
      'replyTo must be a nonempty decimal Discord message-ID string (at most 20 digits)',
    );
  }
}

/** Discord resolves the reference in the send's channel; never fetch or fall back. */
export function discordReplyOptions(
  replyTo: string | undefined,
  chunkIndex: number,
) {
  validateReplyTo(replyTo);
  return replyTo !== undefined && chunkIndex === 0
    ? {
        reply: { messageReference: replyTo, failIfNotExists: true },
        allowedMentions: { repliedUser: false },
      }
    : {};
}
