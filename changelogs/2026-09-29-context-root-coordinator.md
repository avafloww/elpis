# Scoped context root coordinator

Elpis now has a durable, still-inactive root coordinator for serialized scoped branches. A branch start is bound to the exact continuation-head revision and same-world parent, and a normal return atomically commits its world-private capsule, typed root receipt, yielded state, continuation advance, and coordinator release.

Schema v30 enforces one running branch, immutable start/recovery receipts, return capsules before coordinated yield, and fail-closed migration when an older database already contains an ambiguous running branch. Exact stored manifest projections verify local event order, explicit share lineage, content hashes, and optionally current share validity.

Dark-mode startup still refuses an `active` graph before recovery. Otherwise an interrupted coordinated branch is recorded as crashed, prepared effects become uncertain without replay, and the continuation head remains unchanged. Provider requests, compaction, sends, and the live monocontext loop are still unchanged; this is coordinator infrastructure, not graph activation or a privacy claim.

Deterministic tests cover stale and overlapping starts, cross-world ordering, same-world ancestry, return rollback, unresolved effects, recovery/retry, projection revocation, migration refusal, and database transition guards. After restart, verify schema 30, dark activation, no running graph branch, and a healthy service.
