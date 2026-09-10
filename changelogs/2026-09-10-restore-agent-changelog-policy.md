# Restore the agent-facing harness changelog policy

Repository coding agents are again explicitly required to add a dated changelog entry for significant harness changes. `AGENTS.md` now names the requirement and `docs/changelogs.md` defines when an entry is needed, its filename and body format, privacy rules, and the boot-time delivery model.

This repairs a process gap: the boot reader and tests still existed, but no agent-facing repository instruction told outside coding agents to create entries, and the live checkout had no `changelogs/` directory.

Validation: Markdown formatting and `git diff --check`. No runtime code or changelog delivery semantics changed.
