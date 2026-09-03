# Bundled motor skills

Each direct child directory is one portable motor-skill package. It contains a `SKILL.md` with matching `name` and a nonempty `description` in YAML frontmatter. Optional bounded UTF-8 text resources may live beside it or in subdirectories.

The build copies this directory into `dist/motor-skills/`, where the installed resident discovers it without requiring a source checkout. Inhabitant-authored motor skills belong in `elpis-data/motor-skills/`.

A resident explicitly selects packages through `elpis.motor.start(..., { skills: [...] })`. The motor receives each selected `SKILL.md` body immediately. It can read auxiliary files only through the bounded `read_skill_resource` tool and only by an exact `skill:<selected-name>/<relative-path>` handle; it has no arbitrary filesystem access.
