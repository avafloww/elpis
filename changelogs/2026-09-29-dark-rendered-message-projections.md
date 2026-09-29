# Dark rendered message projections

Schema v32 adds immutable, world-bound rendered text-user message records for the scoped-context migration. V2 shadow plans reference those content-addressed records while plan and provider-observation rows remain content-free. Foreign, unlineaged, assistant, tool, and multimodal messages are not projected.

A pure graph-only materializer now reconstructs ordered same-world user messages and rejects missing, duplicate, reordered, wrong-world, or wrong-generation records without consulting the legacy transcript. Current monocontext requests remain ineligible, shadow mode remains disabled by default, and this change cannot start or advance a branch, alter a provider request, issue an effect, or activate graph mode.

Validation covers same-world A/B exclusion, multimodal exclusion, immutable record identity, v1 plan compatibility, v2 lineage checks, migration upgrades and downgrades, the deterministic unit suite, build, and benchmark typecheck. After restart, verify schema 32 applied while graph activation remains dark and disabled shadow tables remain empty; graph-only system layers and active branch request assembly are still future work.
