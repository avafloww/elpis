# Resident skill roots move under config

Elpis now discovers inhabitant-authored skills from `elpis-data/config/skills` and motor skills from `elpis-data/config/motor-skills`. This places authored instruction packages under the existing Git-trackable config boundary; repository-bundled `dist/skills` and `dist/motor-skills` roots are unchanged.

On the first boot after upgrading, each old authored root is moved with a same-filesystem atomic rename before either catalog loads. If an old and new path both exist, startup fails before moving either root so no package is silently merged or shadowed. Package bytes and file modes are preserved by the rename.

Validation passed the focused data-layout/context-resource/motor-skill/runtime suite (36 tests), deterministic unit and provider-transport suites (90 provider tests), full `npm test`, build, benchmark compile, formatting, and diff hygiene. After deployment, verify the resident skill catalogs are unchanged and the old root paths no longer exist.
