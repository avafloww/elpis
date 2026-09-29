# Context and request assembly

Elpis keeps one live conversation history for the process. Inputs from multiple rooms are interleaved in arrival order, with provenance attached to each message.

## Why one history

The inhabitant should not become a set of disconnected room-local copies. A single history preserves causal continuity: an action taken in one room remains part of the same life, while server and channel boundaries still constrain what may be repeated elsewhere.

The harness enforces provenance and routing mechanics. Social privacy remains partly an agent-level practice expressed in the system prompt.

## Scoped-context migration

The replacement context architecture is introduced behind `context_graph.shadow_enabled`, which defaults to `false`. Shadow mode records stable world/event lineage beside the existing ordered loop and seals the newest pre-graph transcript as a byte-exact, content-addressed `legacy-mixed-unscoped` artifact. The sealed artifact is testimony, not automatically visible branch context or current authority.

Shadow mode does not change provider requests, compaction, send authority, cache behavior, or the one live monocontext history. It is validation infrastructure, not a privacy or world-isolation claim. A database marked `active` fails boot in a runtime that supports only shadow mode, so an older binary cannot silently resume graph-era state through the legacy loop.

Schema v30 adds the still-inactive root coordinator used by later branch execution. It binds one running branch to an exact continuation-head revision, keeps global predecessor order separate from same-world parent lineage, requires private and typed root-return capsules before yield, and records crash recovery without replay. Stored manifests can be reread as exact local-event and explicit-share projections; a provider-bound read can require every included share to remain active. On dark-mode boot, an interrupted coordinated branch becomes `crashed` and its prepared effects become `uncertain`; the continuation head does not advance. This does not activate graph requests or replace the legacy loop yet.

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

External person messages are serialized into `<incoming-message>` envelopes. Envelopes carry channel, author, and transport provenance without asking the model to infer it from prose. Discord attachments are represented by metadata, inlined when small and textual, or passed as multimodal parts when supported. Signal v1 admits configured direct-contact text only and adds `transport="signal"`; unsupported event kinds are rejected before Agent history.

Console messages carry console provenance. Scheduler, heartbeat, watch, and harness notices are marked synthetic. Worker progress crosses the durable mailbox rather than resident conversation ingress.

Finalized Discord voice transcriptions carry `source="voice"` in the inbound envelope and enter this same queue in audio commit order. Partials and raw audio remain transient. Explicit sends to the joined voice channel preserve readable text alongside a bounded playback receipt. Voice does not start an independent resident loop; see [Discord voice](voice.md).

## Explicit resident speech

Ordinary text may use an exact leading header, followed by a newline and the message body:

```text
[send to=example/lounge replyTo=123]
Hello.
```

Discord targets are guild-qualified and may use optional `replyTo`. Configured Signal contacts use `signal:<alias>`, never a raw ACI; speech headers remain text-only and have no reply metadata. The whole body is outward speech, not a mixture of speech and private commentary. Programmatic Signal channel sends may add bounded local file attachments.

Only fresh, complete, unstripped resident assistant output is eligible. The resident commits the assistant message before routing through the existing channel resolver and send checks. It appends the delivery outcome after all tool results; a failed send does not strand the tool batch. A header does not yield: the final successful wake-bearing `run` still controls that transition.

Restored history, inbound text, and tool results are never replayed as sends. A context clear invalidates the old epoch: a late outcome leaves only a bounded private completion diagnostic, not a receipt in the newly cleared conversation. Failed or interrupted delivery can be partial; the mechanism does not promise crash-safe exactly-once delivery or automatically retry.

## Direct-channel action acknowledgements

When the message that owns a turn's wake comes from a sendable Discord `direct`-tier channel or a configured send-enabled Signal contact, Elpis appends a request-only `<direct-channel-action-acknowledgement>` card immediately before the current inbound batch. If the resident decides to act because the person asked, the card requires the first assistant response to be a brief speech-header acknowledgement before the first tool call. It does not force action or speech for an ordinary answer, refusal, silence, or a request the resident declines to perform.

For Discord, the card derives the tier from resolved channel policy, including a thread's configured parent, and includes the Discord reply ID when valid. For Signal, it derives permission from the boot-frozen contact policy, targets only `signal:<alias>`, and never includes reply metadata. Send-denied channels receive no impossible instruction. The frozen first request retains the card across transport retries; post-tool continuations and later outer turns omit it. Social and quiet rooms, ambient context, console input, and autonomous or harness wakes never receive it.

## Request projection

The durable transcript is the record; the provider request is a projection of it.

Before each call, `prepareForApi()` may:

- remove old provider reasoning fields outside the current open chain;
- omit request-only cards from tool continuations;
- strip opaque reasoning whose replay provenance is not trusted;
- translate messages into the selected provider's wire format.

Request projection must never mutate the in-memory history or transcript.

Provider adapters also expose a process-local, fail-open observation seam for the final model-visible content plane. Chat observes translated `messages`; Responses and Codex observe the transformed `input`; Anthropic observes the finalized `system` and `messages` after its request fingerprint is applied. The observer receives canonical bytes, their SHA-256, byte length, and an exact surface label immediately before transport dispatch. It omits transport fields and tool declarations, never issues a second provider request, and cannot block or mutate the real request if it fails. No observer is installed by default, and the seam does not itself persist or log content. It exists so dark scoped-context validation can compare exact local projections without giving shadow state continuation or effect authority.

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
