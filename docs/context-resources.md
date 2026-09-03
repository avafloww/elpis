# Context resources

Elpis can load two kinds of local instructions into the resident model's current context window: named skills and nearest-scope `AGENTS.md` files. These are best-effort guidance mechanisms, not security boundaries; a full-capability resident can still use raw filesystem, shell, or privileged surfaces.

## Skills

A skill is a directory containing `SKILL.md` with YAML frontmatter:

```markdown
---
name: release-check
description: Verify a release candidate before publication
---

Full instructions go here.
```

Elpis discovers `.agents/skills/*/SKILL.md` at boot. It checks the data directory and harness root first, then walks their ancestor directories outward, and finally checks `$HOME/.agents/skills`. A nearer earlier root wins when names collide. Names use letters, digits, `.`, `_`, or `-`; descriptions are shown in the system-prompt catalog. The boot catalog is capped at 128 skills and each displayed description at 512 characters.

The resident model loads full bodies with the top-level `skill` tool:

```json
{ "names": ["release-check"] }
```

A skill load must be the only tool call in that model response. Elpis rejects a mixed `skill`/`run`/`think` batch without executing any call, returns the full selected bodies as the tool result, and permits action only on a later model response. Worker and secretary tool lanes do not receive the resident skill tool.

One call may select at most 8 skills. Each `SKILL.md` is limited to 64 KiB and one call to 192 KiB total. The catalog is boot-frozen, while selected bodies are read and versioned at load time. Restart restoration accepts transcript descriptors only when the current file still has the same content hash.

## `AGENTS.md`

Before the first supported `elpis.read`, `elpis.edit`, `elpis.grep`, or `elpis.git` access under a directory, Elpis walks upward from the target and finds the nearest `AGENTS.md`. File symlinks check both the lexical parent and the physical target parent, one unseen scope per retry. The run fails with the complete file, up to 64 KiB, so the resident sees each local contract before retrying the operation.

Catching that interruption inside JavaScript does not approve it. The same file continues interrupting supported access until an uncaught result has been appended to model-visible history. Different nested scopes interrupt independently. Recursive grep preflights nested instruction files, bounded to 4,096 directories and 128 `AGENTS.md` files; Git add preflights the exact tracked or unignored paths selected by its pathspec. Raw `fs`, `elpis.sh`, `elpis.sudo`, and other indirect filesystem surfaces are deliberate bypasses and must not be described as covered. Preflight and the later target operation are separate filesystem steps, so concurrent symlink retargeting can outrun the physical-scope check; this is context guidance, not a security boundary.

## Lifetime and privacy

Loaded resources apply to one context window. Their bounded descriptors are stored beside tool results so a process restart can reconstruct the window without silently re-reading changed files. A whole-context clear drops the state immediately. Successful compaction removes resource-bearing tool results that existed when the fold began from both the summary input and retained tail, then extends the existing single compaction notice with a reminder to reload only resources still relevant. Resources loaded after that fold began survive into the next request. A failed or stale fold changes nothing.

Full skill and `AGENTS.md` bodies enter provider context and private transcripts. Do not put credentials or material unsuitable for that provider in these files.
