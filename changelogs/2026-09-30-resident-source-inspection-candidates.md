# Resident source-inspection candidate persistence

Schema v43 adds private immutable source snapshots and resident source-inspection candidate records for a future two-run identity authorization handshake. The store binds exact prompt-facing SOUL source/body bytes, parser generation, dark activation, the exact scoped runtime-contract artifact and migration receipt, and one trusted resident `run` batch/ordinal.

The prompt-facing snapshot reader now returns the exact decoded source from the same stable file-descriptor read. Store creation is atomic and exact-idempotent; changed sources for one recorded ordinal conflict, late candidate failure rolls back a new snapshot, and typed rereads rehash and reparse both stored BLOBs.

This is persistence substrate only. No sandbox API or runtime caller exists, migration creates no candidate rows, and candidates grant no approval, profile, branch, provider, tool, effect, activation, continuation, or identity authority.

The full deterministic unit suite, build, and bench typecheck pass. Focused SOUL, context-store, migration, database, and gateway-state tests cover source fidelity, run provenance, direct SQL guards, rollback, corruption detection, schema upgrades, and downgrade fixtures.
