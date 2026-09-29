# Dark local branch request views

Schema 34 adds immutable, content-addressed local branch request views for the inactive scoped-context graph. Each view binds one active coordinated branch to a share-free manifest, total manifest-ordered local text projections, and ordered branch-visible system projections. The stored view is explicitly dark, local-only, non-runnable, and tool-free.

Creation now rejects stale coordinator or continuation-head lineage, missing or reordered messages, foreign worlds, explicit shares, unsupported system scope, and generation drift. A graph-only materializer rereads every stored source row and produces provider-neutral system/user messages with a candidate hash and byte count; it is not connected to Agent, providers, effects, compaction, cache behavior, or graph activation.

Deterministic unit tests, build, and bench type-check were run before deployment. After restart, verify schema 34 applied once while graph activation remains dark, shadow mode remains disabled, coordinator/head stay idle, and all new request-view tables remain empty.
