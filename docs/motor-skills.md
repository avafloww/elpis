# Motor skills

Motor skills are resident-selected instruction packages for the visual motor cortex. They carry stable embodied technique such as controls, modal stop conditions, save rituals, and optional troubleshooting references. Dynamic episode state belongs in the scoped goal instead.

Elpis discovers motor-skill packages at boot from two owned roots:

- `elpis-data/motor-skills/<name>/SKILL.md` for private inhabitant-authored skills;
- bundled `dist/motor-skills/<name>/SKILL.md`, copied from repository `motor-skills/` during build.

The package directory and frontmatter `name` must match. Duplicate names across roots fail startup. Package resources are bounded regular UTF-8 text files; symlinks, special files, unsupported extensions, and traversal-shaped names are rejected.

The resident-facing `elpis.motor.start` documentation always includes the bounded name-and-description catalog, not full bodies. The resident selects up to four packages with `start(goal, { skills: [...] })`. Selection order is preserved and combined main bodies may not exceed 32 KiB. Motor skills supply instructions only; they cannot widen the separately validated motor authority envelope.

`elpis.motor.inspectSkill(name)` explicitly returns the main `SKILL.md` body, description, source kind, SHA-256 digest, package root, absolute main-file path, and auxiliary resource manifest to the resident. It does not load the skill into an episode.

At episode start, Elpis freezes every selected package into the private mode-0600 episode trace before any effect. Only each `SKILL.md` body enters the initial motor context; the package manifest stays resident-side. Skill authors cite any useful auxiliary file by its exact `skill:<name>/<relative-path>` handle inside that body. A selected main body explicitly tells the motor it is already loaded and must not be sourced or reread.

When a loaded skill or the visible problem makes an auxiliary reference relevant, Holo may call `read_skill_resource({ path: "skill:<selected-name>/<relative-path>" })`. This Holo-only observation tool appears only when selected packages contain resources. It cannot address unselected packages or arbitrary files, and it is bounded to eight reads and 32 KiB of serialized tool-result context per episode. `SKILL.md` itself is not a resource handle. Tool results enter ordinary motor history; cold recovery reconstructs the exact original package and resource-read counters even if source files changed or disappeared. Motor-skill packages must not contain credentials or other secrets: selected package bytes are deliberately copied into private episode traces.
