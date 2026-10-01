# Context and request assembly

Elpis keeps one live conversation history for the process. Inputs from multiple rooms are interleaved in arrival order, with provenance attached to each message.

## Why one history

The inhabitant should not become a set of disconnected room-local copies. A single history preserves causal continuity: an action taken in one room remains part of the same life, while server and channel boundaries still constrain what may be repeated elsewhere.

The harness enforces provenance and routing mechanics. Social privacy remains partly an agent-level practice expressed in the system prompt.

## Scoped-context migration

The replacement context architecture is introduced behind `context_graph.shadow_enabled`, which defaults to `false`. Shadow mode records stable world/event lineage beside the existing ordered loop and seals the newest pre-graph transcript as a byte-exact, content-addressed `legacy-mixed-unscoped` artifact. The sealed artifact is testimony, not automatically visible branch context or current authority.

Shadow mode does not change provider requests, compaction, send authority, cache behavior, or the one live monocontext history. It is validation infrastructure, not a privacy or world-isolation claim. A database marked `active` fails boot in a runtime that supports only shadow mode, so an older binary cannot silently resume graph-era state through the legacy loop.

Schema v30 adds the still-inactive root coordinator used by later branch execution. It binds one running branch to an exact continuation-head revision, keeps global predecessor order separate from same-world parent lineage, requires private and typed root-return capsules before yield, and records crash recovery without replay. Stored manifests can be reread as exact local-event and explicit-share projections; a provider-bound read can require every included share to remain active. On dark-mode boot, an interrupted coordinated branch becomes `crashed` and its prepared effects become `uncertain`; the continuation head does not advance. This does not activate graph requests or replace the legacy loop yet.

Schema v31 adds immutable dark request-projection plans and observations. With shadow mode enabled, Agent freezes one plan from the final request-message array before a call and attaches the existing provider content-plane observer through retries. Plans may contain only world/event lineage, counts, blocker tokens, and system-layer hashes and lengths. Observations contain only provider surface, hashes, lengths, eligibility/comparison result, and a bounded reason. The final provider content-plane byte stream is never stored in these rows.

Schema v32 adds immutable, explicitly contentful message projections for lineaged same-world text user events. Each record binds one source event, world, renderer generation, canonical `{role, content}` bytes, and content hash into its identity. Creation requires the complete lineage tuple to match an immutable inbound event, including its exact sequence. V2 shadow plans reference only projection IDs; plan and observation rows remain content-free. Foreign, unlineaged, assistant, tool, and multimodal messages are not projected. A pure graph-only materializer rejects missing, duplicate, reordered, wrong-world, or wrong-generation records without falling back to transcript history.

Schema v33 adds immutable, explicitly contentful system-layer projections. The prompt builder emits frozen typed fragments whose ordered concatenation is byte-for-byte identical to the legacy system message; Agent passes those exact fragments to the dark recorder beside the unchanged provider request. Each stored layer binds kind, visibility, optional world, renderer/policy generations, source hash, content hash, byte length, and content into a content-addressed identity. V3 shadow plans reference only layer IDs and carry explicit blockers for the legacy mixed contract, memory, focus, identity candidate, reasoning hint, unlineaged history, and unbound effect tools. A graph-only system materializer accepts only explicitly branch-visible global contract, integrated-self, and same-world policy layers, rejecting legacy, candidate, private-root, missing, duplicate, reordered, wrong-world, or wrong-generation records. Every current request remains ineligible, and these records cannot advance the coordinator, issue effects, alter compaction, or change the real provider call.

Schema v34 adds immutable dark local branch request views. A content-addressed view binds one currently active coordinated branch to its exact canonical manifest, total manifest-ordered local text-message projections, ordered branch-visible system-layer projections, and renderer/policy generations. Creation rejects explicit shares, stale coordinator or continuation-head lineage, incomplete or reordered messages, foreign worlds, unsupported system scopes, and any tool-bearing or runnable interpretation. A graph-only materializer rereads the stored source records and emits only provider-neutral system/user messages plus a candidate hash and byte count. The views are not wired into Agent or any provider, cannot issue effects or advance the coordinator, and do not change the legacy monocontext request.

The dark local branch assembler rehearses the complete reservation boundary without making the request runnable. Given only an expected dark activation epoch, continuation-head revision, target world, fresh branch ID, exact message projection IDs, and deterministic time, it resolves the current per-world system-profile head under the same lock and derives the exact approved system layers, event lineage, renderer and policy generations, same-world parent, and a fresh authority epoch from durable records. One immediate transaction reserves the coordinator, writes the running branch, immutable start receipt, canonical share-free manifest and local request view, builds the bounded provider-neutral candidate, then creates the profile-binding receipt; pending assembly inserts its attempt receipt only after the binding exists. Missing profile state fails before any branch write, and validation, insertion, serialization, hashing, size, binding, or attempt failure rolls back the reservation and every new row. The candidate is capped at 8 MiB. The reusable graph-only materializer uses the same candidate builder for historical rereads. No Agent, provider, tool, effect, cache, compaction, queue, or activation path consumes it. Crash recovery marks the rehearsal branch crashed, leaves the head unchanged, and keeps the historical bound request view readable.

Schema v35 adds an inert dark-ingress admission substrate. Migration creates an immutable queue-generation watermark at the first event sequence that did not exist before v35, so older graph events cannot silently become pending work. The store can atomically append one new immutable inbound event and a content-free admission bound to its exact world, source sequence, dark activation epoch, queue generation, wake class, renderer generation, and timestamp. Exact retries return the existing record; conflicting retries, retroactive admission of an existing event, stale activation, non-inbound sources, or late admission failure reject without leaving a new event behind. No runtime ingress, queue selector, Agent loop, branch assembler, provider, effect, or completion path calls this API yet.

The store can also inspect the globally earliest admitted frontier without mutating it. Inspection reads only admission and projection identity metadata, requires the exact dark activation epoch and queue generation, and returns at most one contiguous same-world, same-renderer prefix. A missing exact projection blocks the frontier rather than allowing later work to pass; world, renderer, generation, and caller limits are explicit stop reasons. It never reads or returns event payloads, rendered message bytes, or hashes, and it does not claim, consume, reserve, assemble, call a provider, or issue an effect. No runtime path calls the inspector yet.

Schema v36 adds content-free pending-branch attempt and abandonment receipts. The store/root atomic assembly API begins one immediate transaction, recomputes the globally earliest exact projection frontier, selects its maximal bounded same-world/same-renderer prefix, builds the complete non-runnable candidate through the existing in-transaction assembler, and inserts the attempt receipt last. The caller supplies no world, event, message projection, selected count/range, renderer, parent, authority, manifest, or request-view identity. Empty or blocked frontiers write nothing; candidate, view, or receipt failure rolls back the branch and coordinator reservation. Database guards reject skipped admissions, projection substitution, stale root lineage, overlapping live attempts, effects, capsules, and yielded attempt branches. Coordinated recovery atomically writes abandonment before crash and release, leaves the head and admissions unchanged, and permits a fresh branch to retry the same earliest prefix. There is still no Agent/runtime caller, provider dispatch, consumption state, effect authority, config/activation change, or continuation advance.

Schema v37 adds an inert immutable approval receipt boundary for typed system-layer projections. An approval binds one exact layer and source hash to one of four semantic roles and matching provenance bases: newly authored scoped runtime contract, exact identity snapshot, accepted integrated-self delta, or routing-derived world policy. Database guards reject legacy-mixed, identity-candidate, private-root, wrong-kind, wrong-scope, wrong-world, and source-hash-substituted layers; receipts cannot be updated or deleted. A typed store API now derives basis kind and source hash from the exact stored layer and requested role, computes a content-addressed receipt identity, accepts only an exact replay, and validates the full identity again on read. The caller still supplies the bounded basis reference and therefore must already hold the authority it claims; this API records structure and does not manufacture that standing. Schema v38 additionally requires each role's exact immutable source-kind token at both the database and typed-read boundaries, and refuses migration if an existing receipt contradicts that source lineage.

Schema v39 adds inert content-addressed system profiles and an append-only per-world profile head. A profile must contain one approved scoped runtime contract and identity snapshot, may include one approved integrated-self delta and same-world policy, and binds every selected approval to one activation epoch plus exact renderer and policy generations. Creation derives generations from the contract, requires every approval to follow its source layer and predate the profile, and revalidates every approval and layer; it cannot target the sealed legacy world. Head advancement is compare-and-swap over the latest immutable advance for that world and epoch, rejects profile or head chronology moving backward, and has no mutable head row to drift from history. Candidate profile creation and head selection do not make a request runnable or confer effect authority. Only the dark assembler reads the current selected profile head, and it does so inside the same transaction that creates the non-runnable bound request view. No Agent, provider, tool, effect, activation, or continuation path reads these profiles, and migration creates no profile or approval rows.

Schema v40 adds an inert immutable companion receipt that binds one existing dark local request view to the exact current system-profile head selected for that world and activation epoch. Creation requires an active coordinated branch with no attempt, effect, or capsule; exact contract → identity → optional integrated-self → optional world-policy layer order; matching renderer and policy generations; complete share-free request edges; and monotonic profile, head, view, and binding chronology. Binding seals the request view's system/message edges and manifest event/share edges. Historical rereads validate the complete profile-head prefix through the bound revision without requiring that revision to remain current, so later profile advances do not rewrite old testimony. A graph-only paired materializer returns the validated receipt plus the unchanged provider-neutral request candidate. The receipt is not runnable and is created atomically by the dark assemblers before they return a candidate or insert a pending-attempt receipt. It is not read by Agent, providers, tools, effects, activation, continuation, or live ingress; migration creates no rows.

Schema v41 makes that binding a durable prerequisite for every new dark pending-attempt receipt. Migration refuses an existing attempt whose request view, world, and activation epoch lack an exact binding instead of grandfathering ambiguous provenance. A database insert guard enforces the same tuple for future attempts, and typed rereads fail closed if persisted state is later corrupted. This adds no runtime caller, runnable request, provider dispatch, effect authority, activation, or continuation change.

Schema v42 seeds one immutable, content-addressed scoped runtime-contract artifact whose bytes are newly authored for graph branches rather than extracted from the legacy mixed prompt. The contract is world-scoped, explicit-share-only, and tool-free; it states that prompt text grants no send or effect authority and does not import legacy memory, focus, people records, dynamic cards, or host capabilities. Its migration checksum is bound to the exact artifact identity, and a typed reader rejects missing or changed bytes. The artifact is source evidence only: it creates no system-layer projection, approval, authorization, profile, world head, branch, provider request, effect authority, activation, or runtime caller.

A strict prompt-facing SOUL snapshot reader is a later authorization prerequisite, not an authorization action. It opens one non-symlink regular file descriptor, bounds and validates one stable UTF-8 source read, reuses `parseSoul()` to derive the exact unwrapped prompt body, and returns the exact decoded source plus separate source-file and body hashes and byte lengths and a parser generation. Missing, changing, oversized, invalid, or empty-body sources fail closed.

Schema v43 adds private persistence for resident source-inspection candidates. One atomic store operation binds the exact source-file and prompt-body bytes, parser generation, dark activation epoch, exact v42 contract artifact and migration receipt, and one trusted live resident `run` batch/ordinal record. Source snapshots and candidates are immutable and content-addressed; exact same-call retries are idempotent, changed sources for an already-recorded ordinal conflict, late candidate or presentation failure rolls back a new source snapshot, and typed rereads rehash, decode, and reparse both stored byte sequences. Migration creates no candidate rows. These records grant no system-layer approval, identity authorization, profile, branch, provider, tool, effect, activation, or continuation authority.

Schema v44 adds one immutable exact-source authorization receipt per inspected candidate. The resident must name the canonical candidate from a different live assistant batch; the writer freshly rereads the strict prompt-facing SOUL source, requires byte-for-byte agreement with the candidate snapshot, exact v42 contract and dark activation lineage, and records the authorizing batch/ordinal. Exact same-call retry returns the original receipt, while another call cannot reauthorize that candidate or reuse its ordinal for another source. Formatting and live secret-redaction preflight occur inside the insertion transaction. Historical receipts remain readable after later SOUL changes or graph activation. This authorizes source testimony only and creates no layer approval, profile, branch, provider request, effect authority, activation, or continuation change.

Schema v45 consumes one such authorization only from a later distinct live resident batch while the graph remains dark. After another strict exact SOUL reread, one immediate transaction creates exactly two worldless system-layer projections—the authored scoped-runtime contract and the authorized SOUL body—their typed approvals, and one immutable derivation receipt with append-only authority revision. Preexisting target projections or approvals without that receipt fail closed, and presentation or live secret-redaction failure rolls the transaction back. The receipt is derivation evidence, not a profile: it creates no world, profile/head, branch, request view, provider request, effect authority, activation, or continuation change.

The composition root owns one process-local resident-run provenance authority. Before dispatching a live assistant tool batch, Agent creates a fresh random batch identity and a domain-separated commitment over ordered tool names and exact raw-argument hashes, stamps that record on the assistant message, appends the message to the transcript, and only then commits the process-local prepared batch. Append failure prevents both commit and tool execution. A provider batch outside the provenance bounds is durably appended without a batch record, every call in it receives a rejection result, and the long-lived loop continues without executing those calls. Restart restoration strictly recomputes valid assistant-only records from the stored tool calls; malformed, changed, wrong-role, or partial metadata is dropped. Provider translators omit the harness-only field, and restored records cannot mint tokens.

For each successfully parsed live `run` call, Agent issues the exact committed ordinal's single-use token and sends it only to `SandboxManager`. The manager accepts it before sandbox creation or code execution, rejects invalid, replayed, cross-authority, or non-`run` tokens without downgrading, and binds only the resulting opaque handle to that invocation's fresh `RunScope`. The handle becomes detached synchronously when the async deadline wins and closes on ordinary completion, failure, preparse, detached settlement, disposal, or restart; persistent VM reuse never carries a prior invocation's handle. No token, verifier, or handle is exposed through `elpis.*`, `SandboxDeps`, transcript restoration, or provider input. This proves live call provenance and lifecycle; it does not itself grant identity or effect authority.

A zero-argument resident sandbox action can consume that live scope only to inspect source candidates. The manager re-resolves the handle as active, the recorder reads one strict prompt-facing SOUL snapshot, and one transaction stores and rereads the schema-v43 candidate before formatting a bounded top-level review string. The string contains the exact scoped contract plus the complete SOUL body when it fits, otherwise UTF-8-safe exact head and tail bytes with the omitted interval named. Formatting, exact-preview validation, and a live registered-secret redaction preflight happen before commit, so a review the resident cannot receive unchanged leaves no new candidate row. Core and persistent resident sandboxes expose the action; worker, direct, restored, inherited, detached, and closed execution cannot use it. The action is candidate-only: it cannot authorize, approve, profile, branch, call a provider, issue an effect, activate the graph, or advance continuation.

The same active-scope machinery exposes a separate one-argument authorization action. It re-resolves the current live handle, accepts only an exact candidate ID, performs a fresh strict SOUL read, and commits the schema-v44 receipt only from a different assistant batch than inspection. The fixed receipt presentation and secret-redaction preflight remain inside the transaction. Direct, restored, inherited, detached, closed, and worker execution remain unable to invoke it. This action authorizes only the exact source candidate; later profile and runtime authority seams remain disconnected.

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

Provider adapters also expose a process-local, fail-open observation seam for the final model-visible content plane. Chat observes translated `messages`; Responses and Codex observe the transformed `input`; Anthropic observes the finalized `system` and `messages` after its request fingerprint is applied. The observer receives canonical bytes, their SHA-256, byte length, and an exact surface label immediately before transport dispatch. It omits transport fields and tool declarations, never issues a second provider request, and cannot block or mutate the real request if it fails. When shadow mode is disabled no observer is installed. When enabled, Agent installs the schema-v31–v33 dark recorder described above; the content-plane seam itself still does not log or persist bytes. Shadow observation remains fail-open and cannot give shadow state continuation or effect authority.

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
