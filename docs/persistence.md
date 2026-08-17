# Persistence and custody

Elpis stores a continuing agent's identity, memory, work, and conversation locally. Treat the data directory as private personal data, not ordinary application cache.

## Data directory

A typical layout is:

```text
DATA_DIRECTORY/
├── SOUL.md
├── MEMORY.md
├── NOW.md
├── agent.db
├── people/
├── ponder/
├── notes/
├── sessions/
├── browser/
├── computer/
├── extensions/
├── motor/
├── private/
└── bg/
```

The exact set grows as capabilities are used.

## Identity and memory files

- `SOUL.md` holds self-authored identity and YAML frontmatter. `name:` is the runtime agent name.
- `MEMORY.md` holds durable general memory.
- `people/*.md` holds person-specific memory with optional external IDs.
- `NOW.md` records current focus.
- `ponder/` holds unresolved thinking without turning it into a commitment.
- `extensions/*.ext.ts` contains trusted local harness plugins; these execute with service-user authority and belong in encrypted backups.

Existing files are never replaced by boot defaults.

## SQLite

`agent.db` uses Node's SQLite binding in WAL mode. Current tables cover:

- channel directory and moderation state;
- feedback and message localization;
- scheduled tasks;
- OAuth credentials;
- fleet sessions and worktrees;
- token-density estimates;
- Mind items, dependencies, tags, comments, events, and reminders.

Migrations are idempotent and run at boot. Foreign-key enforcement is enabled.

## Transcripts

`sessions/` contains JSONL streams. Each record is appended as history is committed. Transcripts preserve visible content, tool calls/results, channel provenance, send receipts, usage, and provider working-state envelopes where available.

Transcript directories are hardened to mode `0700` and files to `0600`, including pre-existing paths adopted at startup.

Compaction does not erase source messages from transcripts. Restarts restore the newest main stream.

## Opaque reasoning custody

Encrypted reasoning and signed thinking blocks are security-sensitive, model-specific working state. They are not confidential storage and should never contain secrets intentionally.

At restoration, opaque state is retained only when its recorded provider/model/surface/endpoint identity matches the configured replay identity. Motor traces additionally require a local private source sidecar. Mismatches strip opaque fields while preserving readable content and actions.

## Credentials

OAuth credentials are stored in `agent.db`. `config.yaml` may contain Discord, API, search, and social credentials. Keep both mode-restricted and out of Git.

Policy-denial bundles under `private/` can contain exact request and response bytes. They are mode `0600`, retention-bounded, and must be handled like transcripts.

## Backup

Back up the entire data directory with encryption. A backup is not trusted until an isolated restore drill verifies:

- SQLite integrity;
- transcript readability;
- identity and memory files;
- file permissions;
- absence of accidental publication.

Do not delete Git-held or local transcript history merely because a backup command succeeded; verify the restore first.

## Portability

Readable files and transcripts can move between hosts. Opaque provider reasoning may be discarded on provider or model changes. The continuing agent's durable identity is not defined by opaque wire state.
