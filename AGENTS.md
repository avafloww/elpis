# Working on Elpis

This document is the maintainer contract for humans and coding agents changing the repository.

## Start here

Elpis hosts one persistent agent. Its most important property is continuity: input ingestion, tool execution, durable state, compaction, and outbound speech must remain one causally ordered thread.

Before editing a subsystem, read its area document:

| Area | Documentation | Primary source |
| --- | --- | --- |
| Runtime loop and routing | `docs/architecture.md`, `docs/context.md` | `src/agent.ts`, `src/index.ts` |
| Prompt assembly | `docs/context.md` | `src/llm/prompt.ts`, `src/llm/llm.ts` |
| Compaction | `docs/compaction.md` | `src/llm/compactor.ts`, `src/llm/summarize.ts` |
| Persistence | `docs/persistence.md` | `src/store/` |
| Sandbox | `docs/sandbox.md` | `src/sandbox/` |
| Discord | `docs/architecture.md`, `docs/config.md` | `src/discord/` |
| Console | `docs/console.md` | `src/console/` |
| Mind | `docs/mind.md` | `src/store/mind.ts` |
| Fleet | `docs/fleet.md` | `src/fleet/` |
| Providers | provider-specific docs | `src/llm/` |

## Vocabulary and neutrality

- The human administering the runtime is the **operator**.
- The being inhabiting it is the **agent** or **inhabitant**.
- Runtime identity comes from `SOUL.md` frontmatter; operator identity comes from configuration.
- Source, tests, docs, comments, and UI defaults must not hardcode a real inhabitant, operator, room, Discord ID, hostname, or household detail.
- Use neutral fixtures: **Aster** for a sample agent, **Bramble** for a sample operator, and `example.com` infrastructure.
- Do not use ownership language for the operator-agent relationship.

## Load-bearing invariants

### One ordered thread

There is one live conversation history per process. Discord rooms and console ingress are provenance-bearing inputs to that history, not separate agent instances. Never process two turns concurrently. Ambient messages may queue, but committed history remains ordered.

### Speech is explicit

Assistant-role text is internal work surface. A person receives speech only through an explicit channel send. Preserve send receipts and transcript provenance.

### A turn ends deliberately

A successful `run(..., { end: true })` is the only explicit yield. Do not infer completion from a tool call, a sent message, or an interleaved reply while other work remains active.

### Persistence is append-first

Transcripts preserve the record. Request dieting and compaction change what the model sees, not what the durable transcript contains. SQLite migrations must be idempotent and safe against an existing database.

### Compaction is asynchronous and marked

The foreground loop stays responsive while a background summary is produced. A fold applies only if its boundary is still valid and the summary passes quality gates. Failed compaction must leave history intact and observable.

### Prompt state has provenance

Static system text, hot-reloaded identity, durable memory, per-turn state, people files, and request-only dynamic cards are different layers. Preserve their cache and privacy boundaries. Social inputs must not receive home-only dynamic state.

### Opaque reasoning is not portable memory

Replay opaque reasoning only when provider, model, API surface, endpoint, and local provenance match. Visible history remains usable when opaque state is stripped.

### The sandbox is powerful by design

`node:vm` stops accidental synchronous runaway code; it is not a security boundary against the inhabitant. Capability additions must remain explicit in `elpis.*`, documented, bounded where practical, and covered by tests.

### Secrets never enter logs or Git

Configuration, OAuth credentials, transcripts, browser state, screenshots, policy-denial bundles, and other private runtime artifacts belong under the data directory or ignored local files. Tests use synthetic credentials and identifiers.

## Change workflow

1. Read the relevant source and area document.
2. State the invariant the change must preserve.
3. Write or update the narrow regression test first when fixing a bug.
4. Make the smallest coherent source change.
5. Run focused tests.
6. Run `npm run test:unit` and `npm run build`.
7. Update documentation in the same commit when behavior or configuration changes.
8. For diagnostics, reproduce the real failure path after deployment; a unit test that never reaches the observer is not acceptance.

## Test commands

```bash
npm run test:unit
npm run build
npm test
npm run bench:check
```

`npm test` includes live or environment-sensitive cases and may require configured providers. Classify such failures explicitly; do not report a blanket green result when only the deterministic suite passed.

## Source conventions

- TypeScript, ESM, Node.js 22+.
- Prefer direct, readable code over abstraction without a measured need.
- Add comments for invariants, hidden constraints, and non-obvious failure modes—not chronology or task numbers.
- Do not leave references to removed modules, private incidents, migration task labels, or old filenames.
- Keep test fixtures synthetic and deterministic.
- Use `src/` imports in tests; use `dist/` only for subprocess acceptance of a freshly built artifact.
- Never weaken a privacy, authorization, transcript, or replay-provenance assertion merely to make a refactor pass.

## Public-release hygiene

Before publishing a release:

- scan tracked files and Git history with Gitleaks and TruffleHog;
- search for real names, Discord snowflakes, private domains, and absolute household paths;
- run the deterministic suite and build;
- review dependency advisories;
- verify `config.yaml`, transcripts, databases, browser profiles, and diagnostic bundles are untracked;
- inspect every retained Markdown file, not only scanner output.
