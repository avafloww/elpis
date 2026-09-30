# Dark system profiles and append-only selection

Schema v39 adds an inactive persistence layer for composing one world's approved system context before any branch can use it. Content-addressed profiles require exact approved runtime-contract and identity layers, may include approved integrated-self and same-world policy layers, and bind all selections to one activation epoch and renderer/policy generation pair.

Per-world selection is an append-only compare-and-swap advance chain; there is no mutable head row that can diverge from its history. Database guards and typed rereads reject stale activation, cross-world policy substitution, generation mismatch, approvals that predate their source layer, backdated profile composition or selection, changed canonical identity, replacement writes, and broken predecessor order.

The migration creates no profiles or approvals. Agent, branch assembly, request views, providers, tools, effects, activation, compaction, and continuation behavior are unchanged. After deployment, verify schema 39, empty profile/advance tables, dark activation, and a healthy service.
