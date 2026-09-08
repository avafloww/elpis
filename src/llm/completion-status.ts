/** Transient provider terminal metadata, not speech or turn authorization. */
export type CompletionStatus = 'complete' | 'incomplete' | 'unknown';

export function chatCompletionStatus(reason: unknown): CompletionStatus {
  if (
    reason === 'stop' ||
    reason === 'tool_calls' ||
    reason === 'function_call'
  )
    return 'complete';
  if (reason === 'length' || reason === 'content_filter') return 'incomplete';
  return 'unknown';
}

export function anthropicCompletionStatus(reason: unknown): CompletionStatus {
  if (
    reason === 'end_turn' ||
    reason === 'stop_sequence' ||
    reason === 'tool_use'
  )
    return 'complete';
  if (
    reason === 'max_tokens' ||
    reason === 'model_context_window_exceeded' ||
    reason === 'pause_turn'
  )
    return 'incomplete';
  return 'unknown';
}

/** Event type is terminal metadata too (Codex can omit response.status).
 * Explicit incomplete evidence wins; an unrecognized supplied status is not
 * upgraded by a completed envelope. */
export function responsesCompletionStatus(
  response: { status?: unknown; incomplete_details?: unknown },
  eventType?: unknown,
): CompletionStatus {
  if (
    response.status === 'incomplete' ||
    eventType === 'response.incomplete' ||
    response.incomplete_details != null
  )
    return 'incomplete';
  if (response.status === 'completed') return 'complete';
  if (response.status == null && eventType === 'response.completed')
    return 'complete';
  return 'unknown';
}
