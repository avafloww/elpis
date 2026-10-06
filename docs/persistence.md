# Persistence and custody

Elpis stores a continuing agent's identity, memory, work, and conversation locally. Treat the data directory as private personal data, not ordinary application cache.

## Data directory

The root is the inhabitant's corpus and workspace. Harness-owned runtime state lives under `elpis-data/`:

```text
DATA_DIRECTORY/
├── SOUL.md
├── MEMORY.md
├── NOW.md
├── people/
├── ponder/
├── notes/
├── projects/                 # inhabitant-authored work may use any root path
└── elpis-data/
    ├── .gitignore            # owned and repaired by Elpis
    ├── config/               # inhabitant-authored harness configuration
    │   └── extensions/
    ├── elpis.db
    ├── sessions/
    ├── bg/
    ├── motor/
    ├── browser/
    ├── computer/
    ├── ssh-sockets/
    ├── memory-backups/
    ├── policy-denials/
    ├── context-graph/
    │   └── legacy/            # sealed content-addressed pre-graph transcripts
    └── layout-migration.json
```

Unknown root files and directories are never classified or moved heuristically. The exact runtime set grows as capabilities are used.

`elpis-data/.gitignore` is harness-owned and repaired to an exact boundary at boot. Immediate runtime children are ignored, while `.gitignore` and all of `config/` remain committable. A parent repository must not ignore `/elpis-data/` wholesale, because Git would then never consult the nested file. Runtime data remains private even when ignored; Git ignore is not an access-control mechanism.

## One-shot legacy migration

Before opening SQLite, transcripts, extensions, subprocess registries, or browser state, Elpis migrates known legacy paths from the data-directory root into `elpis-data/`. The legacy SQLite source is `DATA_DIRECTORY/agent.db`; the canonical destination is `DATA_DIRECTORY/elpis-data/elpis.db`.

Migration is conflict-first: if both an old and new known path exist, startup fails before moving anything. Elpis never merges two stores or guesses which is authoritative. Unknown root paths remain untouched.

Before moving SQLite, Elpis runs `PRAGMA quick_check`, checkpoints and truncates WAL, and collapses the legacy database to `journal_mode=DELETE`. A busy WAL or another open SQLite user blocks migration rather than risking a torn database. Surviving browser processes that still reference process-coupled legacy paths also block migration with a stop-and-restart error.

Moves are same-filesystem atomic renames recorded in `elpis-data/layout-migration.json`. The journal makes a partially completed migration resumable after a crash. Absolute paths retained in background-job and motor-trace records are rewritten to the new roots. A completed stable boot does not churn the journal.

## Identity and memory files

- `SOUL.md` holds self-authored identity and YAML frontmatter. `name:` is the runtime agent name.
- `MEMORY.md` holds durable general memory.
- `people/*.md` holds person-specific memory with optional external IDs.
- `NOW.md` records current focus.
- `ponder/` holds unresolved thinking without turning it into a commitment.
- `elpis-data/config/extensions/` contains trusted flat extension files and package directories; these execute with service-user authority and belong in encrypted backups.
- `elpis-data/config/wordlists/{adverbs,adjectives,nouns}.txt` contains hot-reloaded persistent-sandbox naming pools. Missing files seed from bundled defaults; invalid authored files are preserved and bypassed with a warning.

Existing inhabitant files are never replaced by boot defaults.

### Automatic memory consolidation

`memory.consolidation_threshold_tokens` defaults to 32,000 estimated tokens; `memory.consolidation_target_tokens` defaults to 24,000. The effective limits are clamped to half the model's usable context window. Set the threshold to `0` to disable consolidation.

At boot, before `MEMORY.md` can enter the main system prompt, Elpis checks it and each `people/*.md` file. Later writes are detected through memory-store hooks and filesystem watchers. Consolidation uses the configured model in an isolated/tool-free lane where available, preserves person-file frontmatter byte-for-byte, serializes concurrent edits, and writes atomically only after the result is non-empty, smaller, below threshold, and free of excluded prompt/resource contamination. The output gate rejects copied SOUL prose or frontmatter, consolidation instructions, person-memory envelopes, AGENTS.md/SKILL.md bodies, harness notices, and introduced runtime-snapshot fields. An exact runtime field already present in the source chunk may survive as a durable historical fact.

Before replacement, the original is copied mode-restricted into `elpis-data/memory-backups/`; five versions per source file are retained. Keep this directory private and out of Git. If the provider fails or the file changes during consolidation, the original remains untouched. An oversized `MEMORY.md` then enters cognition only as a bounded head/tail emergency view naming the full on-disk path; omitted middle text is explicitly marked as unknown, never absence.

The consolidation prompt treats the data directory as the inhabitant's private room, asks for compact first-person internal/grug notes rather than a third-person profile, and forbids adding a current date because normal memory writes are timestamped by the harness.

## SQLite

`elpis-data/elpis.db` uses Node's SQLite binding in WAL mode. Current tables cover:

- channel directory, moderation state, and guild-scoped Discord person notification preferences;
- feedback and message localization;
- scheduled tasks;
- OAuth credentials;
- native worker sessions, mailbox messages, terminal-notice acknowledgements, and runtime-cleanup receipts (with published `fleet_*` rows retained as inert migration history);
- token-density estimates;
- Mind items, dependencies, tags, comments, events, and reminders;
- immutable local sandbox executor identity, permanent Mind↔sandbox registrations, alias tombstones, and lifecycle/run counters;
- scoped-context world events, branches, canonical view manifests, capsules, explicit share grants, effect receipts, continuation advances, sealed legacy-import receipts, one-way activation state, immutable hash-only dark request-projection plans/observations, immutable world-bound rendered text-message projections, immutable typed system-layer projections and their immutable approval receipts, immutable content-addressed per-world system profiles and append-only profile-head advances, immutable profile-to-request-view binding receipts, immutable dark local branch request views with ordered projection edges, content-free dark-ingress generation/admission records, immutable content-free dark pending-branch attempt/abandonment receipts, immutable migration-seeded scoped runtime-contract source artifacts, private immutable resident source-inspection snapshots/candidates and exact-source authorization/identity-derivation receipts, plus immutable resident current-world profile-binding receipts, inert exact-target dark isolated-provider binding receipts, immutable non-runnable isolated-provider invocation-admission policy snapshots, immutable active provider-execution attempt, response-evidence, and bounded visible-outcome receipts, plus one optional immutable exact-home Discord text activation scope, immutable home-text speech-attempt/result-capsule barriers, and immutable speech delivery dispositions plus deferred immutable finalization barriers that require each rejection, uncertainty, or observed return to reach its exact terminal state before commit. Dormant orchestration derives the active invocation from these records and resolves provider and speech evidence before generic recovery; it adds no new table or authority.

Schema migrations run at boot after the filesystem-layout migration. Schema v29 adds the inactive scoped-context graph substrate; its activation row defaults to `dark`, and the current runtime refuses an `active` row rather than reopening it through monocontext recovery. Schema v30 adds a singleton root coordinator, immutable branch-start and crash-recovery receipts, and a database-enforced single-running-branch invariant. It refuses an ambiguous pre-v30 running branch rather than guessing whether that work may resume. Coordinated completion atomically commits a world-private capsule, typed root receipt, yielded branch, continuation advance, and coordinator release; restart recovery instead marks unresolved prepared effects uncertain and leaves the head unchanged. Schema v31 adds immutable content-addressed shadow projection plans and append-only request observations. Their strict schema rejects raw content and stores only lineage, hashes, lengths, counts, surfaces, blocker/result tokens, and timestamps; they have no continuation or effect authority. Schema v32 adds immutable rendered text-user message records bound to their source event and world. Schema v33 adds immutable typed system-layer records bound to exact source and content hashes, scope, optional world, and renderer/policy generations; V3 plans hold only their IDs and fail closed on missing, reordered, unsupported-scope, or blocker-inconsistent lineage. Schema v34 adds immutable content-addressed local branch request views whose ordered edges must exactly cover a share-free manifest and accepted branch-visible system projection. Their insert guard binds the active root coordinator and continuation head; graph-only rereads revalidate every source row. These dark records are explicitly non-runnable, have no tools, and are not connected to provider dispatch or effect authority. Message and system projection tables are deliberately contentful private state. Local request views store only ordered references and metadata but materialize from those contentful rows; plan and observation rows remain content-free. The dark assembler adds no schema: it composes the existing branch, start, coordinator, manifest, and request-view writes inside one immediate transaction. It derives authority and projection metadata from locked durable state rather than accepting them from the caller; a late request-view or bounded candidate-construction failure therefore cannot strand a running branch or coordinator reservation. Recovery uses the existing crash receipt path, does not synthesize capsules, and does not advance the continuation head. Historical request views remain immutable and readable after recovery. Schema v35 adds immutable dark-ingress generation and admission rows. Its generation-1 watermark is `MAX(context_world_events.sequence) + 1` at migration time, making pre-v35 events permanently ineligible for admission. A single immediate transaction must create a new inbound world event and its content-free admission together; exact retries are idempotent, while an existing unadmitted event is never promoted retroactively. These records have no selector, claim, consumption, branch, provider, effect, or live-ingress authority. A read-only dark-frontier inspector adds no schema: it queries only admission identity/scheduling fields and exact projection identity metadata, then returns a bounded contiguous same-world and same-renderer prefix or a typed blocker. It does not read payload/message bytes or hashes and has no runtime caller, mutation, claim, consumption, branch, provider, or effect authority. Schema v36 adds immutable pending-branch attempt and abandonment receipts. Their guards bind a running coordinator-owned branch and exact non-runnable request view to the globally earliest maximal same-world/same-renderer admitted prefix, forbid skipped or overlapping live claims, effects, capsules, and yielded transitions, and require abandonment before crash. Request-view message edges remain the ordered item lineage; no duplicate item or mutable consumed table exists. A store/root API now performs selection, full bounded candidate construction, branch/start/manifest/view writes, and attempt insertion inside one immediate transaction; derived queue and lineage fields are never accepted from the caller. Empty or blocked frontiers make no writes, and a late attempt rejection rolls the entire reservation back. Existing coordinated recovery writes abandonment before crashing and releasing an attempt branch, leaves admissions and the continuation head unchanged, and therefore makes the same earliest events retryable. No Agent/runtime caller, provider execution, consumption state, effect authority, or activation path uses this API. Schema v37 adds an empty-by-default immutable system-layer approval table. Its insert guard binds an exact stored layer and source hash to a matching semantic role and provenance basis while rejecting legacy, candidate, private-root, wrong-scope, and wrong-world projections. A typed store API derives the basis kind and source hash from the exact layer and role, computes a content-addressed receipt ID, validates stored identity on reread, accepts exact replay, and rejects changed timestamp or same-generation lineage conflicts. The bounded basis reference remains caller-authored testimony rather than independently authenticated standing. Schema v38 binds every approval role to an exact immutable layer source-kind token; migration fails rather than retaining a contradictory existing receipt, and new inserts plus typed rereads enforce the same mapping. Schema v39 adds immutable content-addressed system profiles plus append-only per-world, per-activation-epoch profile advances. A profile requires approved contract and identity roles, permits optional approved integrated-self and exact-world policy roles, and revalidates layer→approval→profile chronology, role, layer scope, world, renderer generation, policy generation, canonical JSON, hash, and identity on reread. The current head is derived from the latest advance rather than duplicated in a mutable row; compare-and-swap insertion enforces an unbroken predecessor chain and monotonic timestamps. Both profile creation and advancement remain dark-only. The dark assembler is their only consumer: it derives the exact current profile under its existing immediate transaction. No runtime Agent, provider, continuation, activation, or effect path reads them. Schema v40 adds immutable content-addressed companion receipts that bind one existing local request view to the exact current per-world profile-head revision. Insert guards require exact ordered approved layers, matching generations and hashes, active root lineage, complete share-free request edges, no prior attempt/effect/capsule, and monotonic profile→head→view→binding chronology; the receipt then seals request and manifest edges. Typed rereads validate the full historical profile-head prefix through the bound revision, while a graph-only paired materializer returns the binding plus the unchanged non-runnable candidate. Migration creates no rows. Both dark assemblers create the receipt inside the same immediate transaction as the non-runnable request view, before returning a candidate or inserting a pending-attempt receipt; no runtime Agent, provider, effect, activation, or continuation path consumes it. Schema v41 refuses existing unbound pending attempts, requires every new pending-attempt receipt to have an exact request-view/world/activation binding at the database seam, and makes typed rereads reject missing binding provenance. Schema v42 seeds an immutable content-addressed scoped runtime-contract artifact whose migration checksum follows its exact identity; the typed store reader rejects drift. The artifact is newly authored, tool-free source evidence only and grants no layer approval, profile selection, provider dispatch, effect authority, activation, or runtime behavior. Schema v43 adds private immutable SOUL source snapshots and resident source-inspection candidates. The store atomically binds exact source/body BLOBs, parser generation, the v42 contract artifact and migration receipt, dark activation epoch, and trusted live resident run provenance; exact retries are idempotent, changed same-ordinal sources conflict, and strict rereads rehash and reparse stored bytes. A live-resident-only inspection capability is the sole runtime writer and remains candidate-only. Schema v44 adds immutable one-per-candidate exact-source authorization receipts. Authorization requires a different live assistant batch, a fresh strict SOUL read matching the stored candidate byte-for-byte, the unchanged dark epoch and exact contract lineage, and an unchanged bounded receipt presentation after secret-redaction preflight. It creates no system-layer approval, profile, branch, provider request, effect authority, activation, or continuation change. Schema v45 adds immutable authorized resident identity-system derivation receipts. A later distinct live resident batch freshly verifies the exact authorized SOUL source, derives exactly two worldless projections (the authored scoped contract and authorized SOUL body) and their typed approvals in one transaction, refuses preexisting unreceipted target rows, and records an append-only authority revision. Presentation or secret-redaction failure rolls back every new row. It creates no world, profile/head, branch, request view, provider request, effect authority, activation, or continuation change. Schema v46 adds immutable resident current-world profile-binding receipts. The live resident binder receives the exact captured wake-defining social ingress lineage from the manager rather than caller arguments, and atomically creates one contract-and-identity-only profile, revision-one world head, and receipt only while dark; it creates no runnable request, effect, activation, or continuation authority. Schema v47 adds immutable dark isolated-provider binding receipts. The live resident action receives the same exact captured ingress lineage, rematerializes the pending request/profile/candidate, and binds it to the boot-resolved credential-free main provider target plus a deterministic isolated cache namespace. Database guards and typed rereads require dark mode, one exact pending attempt, no historical tool messages, and fixed non-runnable/no-network/no-tools execution flags. It performs no provider dispatch, issuance, result, capsule, effect, activation, configuration, or continuation action. Schema v48 adds an immutable monotonic insertion-order ledger for those bindings so the resident-owned post-restart verifier can select exactly the newest receipt without trusting wall-clock order; ambiguous multi-row upgrades fail closed. Schema v49 adds one immutable dormant invocation-admission policy snapshot per binding. It rematerializes the exact request/profile/candidate/target/cache lineage and fixes one attempt, no retries, no fallback, no tools, and no network/effect/capsule/continuation authority; it remains non-runnable testimony and deliberately leaves call, idle, and output limits unspecified. Schema v50 adds an active one-shot execution authority and evidence ledger without weakening the v49 admission. The attempt snapshots exact positive call-timeout, stream-idle-timeout, and visible-output byte limits before dispatch. Only active epoch `dark_epoch + 1`, the exact running coordinator branch, the expected world, and a direct non-Gateway Codex Responses target may create an attempt. A synchronous pre-network callback prepares exactly one same-world provider effect; a positive HTTP response receives separate immutable evidence; bounded visible success/error outcomes resolve that effect as observed, failed, or uncertain. Pre-dispatch rejection creates no effect, any uncertainty is never replayed, and restart recovery may crash the active execution branch without fabricating a dark-abandonment receipt or advancing continuation. Durable response evidence remains issued across restart and configuration drift, while outcome chronology cannot precede that evidence. The executor is not yet connected to Agent activation, speech, capsules, or continuation return. Schema v51 adds an empty-by-default immutable home-text activation scope that can be authored only in dark mode before any provider attempt. It binds the next activation epoch to one exact Discord guild world, guild, channel, and at most 1900 UTF-8 output bytes; fresh provider attempts must match that world and epochs, and every request-view message must be direct, unforwarded, attachment-free Discord text from the exact scoped guild and channel while staying within its output cap, while historical schema-v50 attempts remain readable. Schema v52 adds the same full ordered-request guard as a new migration so existing schema-v51 databases are hardened without changing the published v51 checksum. The scope itself performs no activation, provider call, speech, capsule, or continuation effect. Schema v53 makes an issued successful provider outcome atomically create one immutable home-text speech-attempt barrier and one exact world-private result capsule. The barrier derives the terminal Discord route from the request view, binds the exact scope, result bytes, capsule, future speech effect, root receipt, and deterministic nonce, permits no cross-world share, and turns exact replay into a read rather than another send opportunity. Registered deterministic SQLite functions let the insert guard independently verify canonical JSON, hashes, IDs, and nonce rather than trusting a typed caller. It still performs no Discord transport, speech-effect issuance, continuation return, activation, or Agent wiring. Core schema through v13 remains an explicit idempotent compatibility baseline; schema v14 adds `elpis_migrations`, an append-only ledger keyed by `(component, name)` with checksum and application timestamp. New core and extension migrations are strictly sorted named histories. SQL migration checksums are derived from exact SQL bytes; code migrations require an authored SHA-256 checksum. Each unapplied migration and its receipt commit in one `BEGIN IMMEDIATE` transaction, while checksum drift, removed history, or non-prefix insertion fails closed.

Trusted extensions declare migrations alongside their prompt and activation. Their component is `extension:<namespace>`; core uses `core`. Extension migrations finish before `activate(context)`, and `context.database` exposes the shared Node 24 `node:sqlite` `DatabaseSync`. A failed migration rolls back and quarantines that extension without exposing its prompt or API; later extensions still load. Foreign-key enforcement is enabled.

## Transcripts

`elpis-data/sessions/` contains JSONL streams. Each record is appended as history is committed. Transcripts preserve visible content, tool calls/results, channel provenance, send receipts, usage, and provider working-state envelopes where available.

Voice send receipts retain bounded playback status, final transcript, and
played duration. Restoration rebuilds only those public fields and discards
malformed or oversized voice metadata while preserving the text-send record.

Transcript directories are hardened to mode `0700` and files to `0600`, including pre-existing paths adopted at startup.

Compaction does not erase source messages from transcripts. Restarts restore the newest main stream.

## Opaque reasoning custody

Encrypted reasoning and signed thinking blocks are security-sensitive, model-specific working state. They are not confidential storage and should never contain secrets intentionally.

At restoration, opaque state is retained only when its recorded provider/model/surface/endpoint and tool-contract identity matches the configured replay identity. When Gateway attribution is present, its atomic tuple of canonical HTTPS authority, exact model ref, and immutable target generation must also match; missing or malformed tuples cannot authorize managed opaque replay. A target-generation or tool-contract change strips opaque state, while catalog revision, credential refresh, request ID, and harness commit are not replay identity. Actual upstream provider type, model, and API surface remain attribution fields even when the endpoint is the Gateway request endpoint. Motor traces additionally require a local private source sidecar. Mismatches strip opaque fields while preserving readable content and actions.

## Credentials and diagnostic captures

OAuth credentials are stored in `elpis-data/elpis.db`. `config.yaml` may contain Discord, API, search, and social credentials. Keep both mode-restricted and out of Git.

Policy-denial bundles under `elpis-data/policy-denials/` can contain exact request and response bytes. They are mode `0600`, retention-bounded, and must be handled like transcripts.

## Backup

Back up the entire data directory with encryption. A backup is not trusted until an isolated restore drill verifies:

- SQLite integrity;
- transcript readability;
- identity and memory files;
- inhabitant-authored `elpis-data/config/`;
- file permissions;
- absence of accidental publication.

Do not delete Git-held or local transcript history merely because a backup command succeeded; verify the restore first.

## Portability

Readable files and transcripts can move between hosts. Opaque provider reasoning may be discarded on provider or model changes. The continuing agent's durable identity is not defined by opaque wire state.

## Scheduler dispatch lifecycle

Each due row is reread immediately before dispatch: completion, removal,
rescheduling, and snoozing by earlier callbacks take precedence over a poll's
snapshot. Callback lifecycle changes are not overwritten after delivery.
Failed dispatches retain their row and persist a fixed 60-second retry floor in
`next_run_at` (never pulling an existing later schedule forward or reviving a
done row). Unrelated due tasks still progress in the same poll. After rearming,
poll throws the original failure, or an AggregateError for multiple failures;
errors remain observable without a zero-delay retry loop. Retries are at-least-once
if a callback performs side effects before throwing.
