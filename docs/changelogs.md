# Harness changelogs

Harness changelogs let the resident learn about significant repository changes made by an external coding agent or while the resident process was offline. On boot, unseen entries are delivered as a pointer-style `[harness updated]` notice. The resident chooses when to read the bodies.

## When an entry is required

Add an entry in the same commit when a change affects any of these:

- runtime behavior, lifecycle, routing, or deployment;
- configuration syntax, defaults, compatibility, or migrations;
- provider, model, prompt, tool, or capability behavior visible to the resident;
- persistence, transcript, compaction, or replay semantics;
- security, privacy, credentials, authority, or trust boundaries;
- an operational requirement the resident must verify after restart.

Skip entries for typo-only documentation edits, formatting, dependency metadata with no runtime effect, mechanical refactors with no behavior change, and tests that only preserve an existing contract. Prefer one entry per coherent change rather than one per commit when several commits form a single shipped change.

## File and body format

Create a plain Markdown file named:

```text
changelogs/YYYY-MM-DD-short-kebab-slug.md
```

The reader uses the filename for ordering and seen-state. There is no frontmatter or metadata parser. Do not rename or edit an already-seen entry to announce new behavior; create a new dated entry because seen-state is filename-based.

Keep the body short and operational. Include:

1. what changed in the resident's world;
2. why it changed or which failure it fixes;
3. compatibility, migration, configuration, or security consequences;
4. the validation performed;
5. anything the resident should verify or resume after boot.

A commit or pull-request reference is useful when known. Never include secrets, tokens, private runtime data, transcripts, household paths, private hostnames, or real identities. Use neutral fixtures and public repository-relative paths.

## Delivery behavior

The boot reader scans Markdown files in `changelogs/`, sorts unseen filenames, and emits a pointer rather than injecting every body into context. Entries are marked seen only after the notice reaches resident history. Failures therefore cause re-delivery instead of silent loss.
