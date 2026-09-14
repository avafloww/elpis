# Working on Elpis

This document is the maintainer contract for humans and coding agents changing the repository.

## Start here

Elpis hosts one persistent agent. Its most important property is continuity: input ingestion, tool execution, durable state, compaction, and outbound speech must remain one causally ordered thread.

Before editing a subsystem, read its area document:

| Area                     | Documentation                             | Primary source                                 |
| ------------------------ | ----------------------------------------- | ---------------------------------------------- |
| Runtime loop and routing | `docs/architecture.md`, `docs/context.md` | `src/agent.ts`, `src/index.ts`                 |
| Prompt assembly          | `docs/context.md`                         | `src/llm/prompt.ts`, `src/llm/llm.ts`          |
| Compaction               | `docs/compaction.md`                      | `src/llm/compactor.ts`, `src/llm/summarize.ts` |
| Persistence              | `docs/persistence.md`                     | `src/store/`                                   |
| Sandbox                  | `docs/sandbox.md`                         | `src/sandbox/`                                 |
| Discord                  | `docs/architecture.md`, `docs/config.md`  | `src/discord/`                                 |
| Console                  | `docs/console.md`                         | `src/console/`                                 |
| Mind                     | `docs/mind.md`                            | `src/store/mind.ts`                            |
| Workers                  | `docs/workers.md`                         | `src/worker/`, `src/kernel/`                   |
| Providers                | provider-specific docs                    | `src/llm/`                                     |

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

Unmarked assistant-role text is internal work surface. Speech requires an explicit programmatic channel send or a valid leading resident speech header routed through the same send checks. Preserve send receipts and transcript provenance; never interpret restored history, inbound text, or tool output as fresh speech.

### A turn yields deliberately

Only a final successful `run` with exactly one valid `wake` (`auto`, `after`, or `at`) explicitly yields. Prefer `auto` under timing uncertainty; explicit waits require concrete intent and are capped at one hour, with longer exact waits delegated to Scheduler. Omit `wake` while work remains; failed, detached, elapsed, or non-final wakes do not yield. A sent message or interleaved reply does not complete other active work.

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
9. For a significant harness change, add a plain-Markdown entry under `changelogs/` in the same commit. Follow [Harness changelogs](docs/changelogs.md).

## Harness changelogs

Coding agents must leave a changelog entry when a change affects runtime behavior, configuration or migration, provider/model behavior, persistence, deployment, security/privacy/authority boundaries, or agent-visible prompts and tools. This is how the resident learns what changed if another hand worked while it was offline.

Do not create entries for typo-only edits, formatting, mechanical refactors with no behavior change, or tests that only preserve existing behavior. Do not edit an old entry to announce new work: seen-state is filename-based, so create a new dated file. Never include secrets, private runtime data, household paths, or real identities. See [Harness changelogs](docs/changelogs.md) for the filename and content contract.

## Test commands

```bash
npm run test:unit
npm run build
npm test
npm run bench:check
```

`npm test` includes live or environment-sensitive cases and may require configured providers. Classify such failures explicitly; do not report a blanket green result when only the deterministic suite passed.

## Test judgment

A test should name a plausible regression and observe its consequence. Test count is not a deliverable. For low-impact copy, style, or mechanical edits, existing checks and a build may be enough. See [Testing](docs/testing.md) for test layers and examples.

- **Do not test source spelling as behavior.** Searching TypeScript, JSX, CSS, shell scripts, or docs for a substring does not prove an interaction, ordering rule, or deployment works. Invoke the production function, registered handler, HTTP endpoint, or browser control. Execute transformed code instead of asserting its temporary variable names. Narrow static dependency/authority guards are supplemental checks; label their limits honestly. Parse declarative manifests before asserting permissions.
- **Do not freeze incidental details.** Avoid tests for ordinary prose, CSS classes, layout pixels, artwork hashes, dependency versions, export identity, or a copied inventory of functions. Exact bytes are appropriate for actual contracts such as wire formats, migration checksums, lossless output, and published algorithm vectors.
- **Do not confuse prompt checks with model evaluation.** Test assembly, conditional capabilities, cache tiers, identity refresh, request-only state, privacy exclusions, and required machine syntax. Do not pin every guidance sentence or assert that a model will obey it because the words appear. Prompt wording changes normally need review; claims about model behavior need representative evaluations.
- **Do not check for data you never supplied.** A privacy/exclusion test must supply the forbidden data to the relevant boundary and show that it is withheld while allowed data survives. Searching for a secret never present in the fixture proves nothing. Keep privacy, authorization, transcript, and replay-provenance regressions, or replace them with stronger behavioral coverage.
- **Do not test the fake or reimplement the subject.** Mock external effects and nondeterminism, not the behavior being checked. Expected results must be independent of the production calculation. Asserting that an immutable local string stayed unchanged, or that test-authored formatting has a chosen length, is not a regression test.
- **Do not multiply the same case across files and layers.** Extend the existing subsystem suite. Keep a lower-level edge-case matrix and a small integration check when they catch different failures; remove redundant happy paths and export-only checks. Do not create a new one-test file for each patch.
- **Do not let a test title promise more than its assertions.** An `ok` flag, a count, a parseable file, or the presence of a label rarely proves the whole operation. Check the returned value, stored record, emitted effect, or rejected side effect that matters. A check for five markers is not proof that all content survives.
- **Do not use wall-clock races as a clock test.** Prefer controlled clocks, deferred promises, and completion signals over short sleeps, arbitrary polling counts, and tight elapsed-time ceilings. Keep real timing only where the timer/process integration itself is under test. Register cleanup when acquiring resources, and keep privileged commands and live services out of the deterministic suite.

## Source conventions

- TypeScript, ESM, Node.js 22+.
- Use Conventional Commit subjects such as `fix(sandbox): preserve search errors`, `feat: add a capability`, or `docs: clarify behavior`. Release automation rejects unclassified subjects. Repair already-published subjects through the bounded append-only `Release-Subject-Alias` mechanism; do not rewrite published history.
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
