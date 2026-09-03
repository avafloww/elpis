# Bundled skills

Each direct child directory may contain one `SKILL.md` with `name` and `description` YAML frontmatter. `npm run build` copies this directory into `dist/skills/`; the resident discovers that installed copy at boot.

Inhabitant-authored skills belong in `elpis-data/skills/`, not here. Elpis deliberately does not discover `.agents/skills` or walk ancestor directories for skills.
