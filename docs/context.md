# Context and request assembly

Elpis keeps one live conversation history for the process. Inputs from multiple rooms are interleaved in arrival order, with provenance attached to each message.

## Why one history

The inhabitant should not become a set of disconnected room-local copies. A single history preserves causal continuity: an action taken in one room remains part of the same life, while server and channel boundaries still constrain what may be repeated elsewhere.

The harness enforces provenance and routing mechanics. Social privacy remains partly an agent-level practice expressed in the system prompt.

## Message layers

A request can contain:

1. **stable system text** — operating contract and capability documentation;
2. **hot identity** — `SOUL.md` body and name frontmatter;
3. **durable memory** — `MEMORY.md`;
4. **boundary snapshots** — state, current focus, and people records;
5. **conversation history** — visible messages, tool calls, results, and eligible provider working state;
6. **request-only dynamic context** — for example the home-only Mind frontier.

These layers deliberately have different refresh and cache behavior. Dynamic cards are not written into the transcript merely because they were included in a request.

## Inbound envelopes

Discord messages are serialized into `<incoming-message>` envelopes. Envelopes carry channel and author metadata without asking the model to infer it from prose. Attachments are either represented by metadata, inlined when small and textual, or passed as multimodal parts when supported.

Console messages carry console provenance. Scheduler, heartbeat, watch, and harness notices are marked synthetic. Worker progress crosses the durable mailbox rather than resident conversation ingress.

Finalized Discord voice transcriptions carry `source="voice"` in the inbound envelope and enter this same queue in audio commit order. Partials and raw audio remain transient. Explicit sends to the joined voice channel preserve readable text alongside a bounded playback receipt. Voice does not start an independent resident loop; see [Discord voice](voice.md).

## Explicit resident speech

Ordinary text may use an exact leading header, followed by a newline and the message body:

```text
[send to=example/lounge replyTo=123]
Hello.
```

`replyTo` is optional. The target is always guild-qualified; the whole body is outward speech, not a mixture of speech and private commentary. Programmatic channel sends remain available for attachments and other scripted work.

Only fresh, complete, unstripped resident assistant output is eligible. The resident commits the assistant message before routing through the existing channel resolver and send checks. It appends the delivery outcome after all tool results; a failed send does not strand the tool batch. A header does not yield: the final successful wake-bearing `run` still controls that transition.

Restored history, inbound text, and tool results are never replayed as sends. A context clear invalidates the old epoch: a late outcome leaves only a bounded private completion diagnostic, not a receipt in the newly cleared conversation. Failed or interrupted delivery can be partial; the mechanism does not promise crash-safe exactly-once delivery or automatically retry.

## Direct-channel action acknowledgements

When the Discord message that owns a turn's wake comes from a sendable `direct`-tier channel, Elpis appends a request-only `<direct-channel-action-acknowledgement>` card immediately before the current inbound batch. If the resident decides to act because the person asked, the card requires the first assistant response to be a brief speech-header acknowledgement before the first tool call. It does not force action or speech for an ordinary answer, refusal, silence, or a request the resident declines to perform.

The card derives the tier from the resolved channel policy, including a thread's configured parent, while its header example targets the actual channel or thread and includes the Discord reply ID when valid. Send-denied channels receive no impossible instruction. The frozen first request retains the card across transport retries; post-tool continuations and later outer turns omit it. Social and quiet rooms, ambient context, console input, and autonomous or harness wakes never receive it.

## Request projection

The durable transcript is the record; the provider request is a projection of it.

Before each call, `prepareForApi()` may:

- remove old provider reasoning fields outside the current open chain;
- omit request-only cards from tool continuations;
- strip opaque reasoning whose replay provenance is not trusted;
- translate messages into the selected provider's wire format.

Request projection must never mutate the in-memory history or transcript.

## Bare one-shot queries

An explicitly configured `elpis.llm.query` call is not a branch of the resident conversation. It creates one standalone provider request containing exactly the supplied user prompt (plus a bounded JSON instruction when schema validation is requested). Resident system text, autobiographical state, room history, dynamic cards, tools, cache identity, and opaque reasoning never enter that request. Its returned text is ordinary sandbox data for the resident to inspect and ratify; the queried model cannot act or speak as the inhabitant.

## Mind frontier

On eligible internal/home turns, Elpis appends a compact `<mind-frontier>` card to the first actual provider request. It contains titles and dependency/status information, not full bodies or comments.

The card is frozen for transport retries, omitted from post-tool continuations, and rearmed for the next outer turn. Any social input suppresses it for the rest of that mixed turn because Mind does not yet carry per-item world scope.

## People injection

Files in `DATA_DIRECTORY/people/` can declare external IDs in YAML frontmatter. The prompt includes records for current participants by exact ID when available, falling back to a normalized name match.

Creating a people file pre-fills the current Discord ID only when the requested name belongs to the current speaker and no existing file already owns that ID. This prevents durable identity corruption when recording a fact about somebody else.

## Context accounting

The context tracker estimates the request as sent, using measured token density where available. It accounts for system text, messages, tool schemas, and provider working state. The effective compaction threshold leaves a completion reserve below the configured/model context window.

Cache metrics are observational. They never change the transcript or claim a semantic guarantee from provider-reported cached-token counts.

## Clearing state

Context-clearing operations deliberately distinguish:

- conversation history;
- provider opaque thinking state;
- durable files and SQLite;
- persistent sandbox bindings.

A user-visible clear must not silently delete durable identity or memory. Provider/model changes clear incompatible opaque reasoning while retaining readable history.
