# Completion status metadata

`CompleteResult.completionStatus` is optional for injected clients and is explicitly
set by resident Chat Completions, Responses, and Anthropic adapters. An omitted
field means unknown, never complete. It is transient: not part of ChatMessage,
provenance, transcripts, or replay. It is not speech authorization, sanitizer
eligibility, or a claim that the agent's turn or task is finished.

## Exact mapping

| Surface                                     | Complete                                                                       | Incomplete                                                                              | Unknown                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Chat `finish_reason`                        | `stop`, `tool_calls`, deprecated `function_call`                               | `length`, `content_filter` (omitted content)                                            | missing/null or any other value                                                              |
| Anthropic `message_delta.delta.stop_reason` | `end_turn`, `stop_sequence`, `tool_use`                                        | `max_tokens`, `model_context_window_exceeded`, `pause_turn` (explicitly unfinished)     | missing/null, `refusal` (classifier intervention, not normal completion), or any other value |
| Responses response metadata                 | `status: completed`; or `response.completed` event when status is missing/null | `status: incomplete`, `response.incomplete` event, or any non-null `incomplete_details` | missing status without recognized terminal event, or any other status                        |

Responses incomplete evidence takes precedence over completed evidence. A supplied
unrecognized status is not upgraded by a completed event. Incomplete details are
explicit incomplete evidence irrespective of their reason (including
`max_output_tokens` and `content_filter`). Codex's usage-only terminal payloads
still have terminal event metadata. Mere stream exhaustion, text, tool calls,
usage, or Anthropic `message_stop` alone do not establish completeness. Chat and
Anthropic retain the last non-null terminal reason; usage-only chunks do not erase it.

## Scope and sources

Reviewed `docs/anthropic-oauth.md`, `docs/codex-oauth.md` and the locked SDK
ChatCompletion Choice / ChatCompletionChunk Choice, Anthropic Message stop_reason,
and Responses status/event declarations. Public API reference context:

- https://platform.openai.com/docs/api-reference/chat/object
- https://platform.openai.com/docs/api-reference/responses/object
- https://platform.openai.com/docs/api-reference/responses-streaming
- https://docs.anthropic.com/en/api/handling-stop-reasons

The supplied released-source archive has streaming-only resident CompleteResult
producers. Nonstreaming Chat and Responses calls return summary strings or
standalone results; there is no nonstreaming resident completion branch to modify.
The pure normalizers accept nonstreaming terminal metadata and are tested with
injected values, without adding a new execution branch. The existing Responses
assembly helper applies normalization to the response object plus terminal event.
Resident Codex delegates to streamResponsesComplete and returns its result intact;
the separate standalone Codex loop is unchanged.

No status changes content, sanitizer flags, tool calls, usage, provenance,
cancellation, failure classification, retry/denial behavior, or partial-output
handling. In particular, truncation remains returned output, not a new exception,
retry, repair, or model switch. Existing missing-terminal stream failures remain
failures. No header delivery or replay effects are implemented here.
