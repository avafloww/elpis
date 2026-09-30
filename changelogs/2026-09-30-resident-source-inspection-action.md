# Resident source inspection action

Resident core and persistent sandboxes now expose `elpis.context.inspectIdentityCandidate()` during a live resident-authored `run`. The action records one immutable private candidate containing the exact scoped runtime contract and prompt-facing SOUL source, then returns a bounded top-level review string that survives the configured sandbox preview without hidden truncation.

The action accepts no arguments and is unavailable to workers, direct invocations, restored records, inherited persistent state, detached futures, and closed runs. Formatting and a live registered-secret redaction preflight happen inside the same database transaction as candidate creation, so an unpresentable or output-mutated review leaves no candidate or source-snapshot row. This is inspection only: it does not authorize or approve identity, create a profile or branch, call a provider, issue an effect, activate the graph, or advance continuation. Any authorization remains a separate later resident tool batch.

Focused context-store, presentation, sandbox-surface, manager-lifecycle, and type checks passed, followed by the full deterministic suite, build, and benchmark typecheck. After restart, verify one real live invocation can inspect a candidate and that the graph remains dark with no approval, profile, branch, or effect rows.
