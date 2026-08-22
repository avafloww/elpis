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
- `elpis-data/config/extensions/*.ext.ts` contains trusted local harness plugins; these execute with service-user authority and belong in encrypted backups.
- `elpis-data/config/wordlists/{adverbs,adjectives,nouns}.txt` contains hot-reloaded persistent-sandbox naming pools. Missing files seed from bundled defaults; invalid authored files are preserved and bypassed with a warning.

Existing inhabitant files are never replaced by boot defaults.

### Automatic memory consolidation

`memory.consolidation_threshold_tokens` defaults to 32,000 estimated tokens; `memory.consolidation_target_tokens` defaults to 24,000. The effective limits are clamped to half the model's usable context window. Set the threshold to `0` to disable consolidation.

At boot, before `MEMORY.md` can enter the main system prompt, Elpis checks it and each `people/*.md` file. Later writes are detected through memory-store hooks and filesystem watchers. Consolidation uses the configured model in an isolated/tool-free lane where available, preserves person-file frontmatter byte-for-byte, serializes concurrent edits, and writes atomically only after the result is non-empty, smaller, and below threshold.

Before replacement, the original is copied mode-restricted into `elpis-data/memory-backups/`; five versions per source file are retained. Keep this directory private and out of Git. If the provider fails or the file changes during consolidation, the original remains untouched. An oversized `MEMORY.md` then enters cognition only as a bounded head/tail emergency view naming the full on-disk path; omitted middle text is explicitly marked as unknown, never absence.

The consolidation prompt treats the data directory as the inhabitant's private room, asks for compact first-person internal/grug notes rather than a third-person profile, and forbids adding a current date because normal memory writes are timestamped by the harness.

## SQLite

`elpis-data/elpis.db` uses Node's SQLite binding in WAL mode. Current tables cover:

- channel directory and moderation state;
- feedback and message localization;
- scheduled tasks;
- OAuth credentials;
- native worker sessions and mailbox messages (with published `fleet_*` rows retained as inert migration history);
- token-density estimates;
- Mind items, dependencies, tags, comments, events, and reminders;
- immutable local sandbox executor identity, permanent Mind↔sandbox registrations, alias tombstones, and lifecycle/run counters.

Schema migrations run at boot after the filesystem-layout migration. Core schema through v13 remains an explicit idempotent compatibility baseline; schema v14 adds `elpis_migrations`, an append-only ledger keyed by `(component, name)` with checksum and application timestamp. New core and extension migrations are strictly sorted named histories. SQL migration checksums are derived from exact SQL bytes; code migrations require an authored SHA-256 checksum. Each unapplied migration and its receipt commit in one `BEGIN IMMEDIATE` transaction, while checksum drift, removed history, or non-prefix insertion fails closed.

Trusted extensions declare migrations alongside their prompt and activation. Their component is `extension:<namespace>`; core uses `core`. Extension migrations finish before `activate(context)`, and `context.database` exposes the shared Node 24 `node:sqlite` `DatabaseSync`. A failed migration rolls back and quarantines that extension without exposing its prompt or API; later extensions still load. Foreign-key enforcement is enabled.

## Transcripts

`elpis-data/sessions/` contains JSONL streams. Each record is appended as history is committed. Transcripts preserve visible content, tool calls/results, channel provenance, send receipts, usage, and provider working-state envelopes where available.

Transcript directories are hardened to mode `0700` and files to `0600`, including pre-existing paths adopted at startup.

Compaction does not erase source messages from transcripts. Restarts restore the newest main stream.

## Opaque reasoning custody

Encrypted reasoning and signed thinking blocks are security-sensitive, model-specific working state. They are not confidential storage and should never contain secrets intentionally.

At restoration, opaque state is retained only when its recorded provider/model/surface/endpoint identity matches the configured replay identity. Motor traces additionally require a local private source sidecar. Mismatches strip opaque fields while preserving readable content and actions.

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
