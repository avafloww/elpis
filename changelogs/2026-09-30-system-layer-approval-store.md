# Typed system-layer approval records

The context graph store can now write and reread system-layer approval receipts through a typed, content-addressed API. The API derives the allowed provenance basis and source hash from the exact stored layer and semantic role. Schema 38 additionally requires the role's exact immutable source-kind token at migration, insert, and typed-read boundaries. It accepts an exact replay, rejects changed timestamps and same-generation identity conflicts, and validates the complete receipt identity on every read.

Candidate, legacy-mixed, private-root, wrong-kind, wrong-scope, and wrong-world layers remain ineligible. The caller-authored basis reference is recorded testimony, not independently authenticated authority. No Agent or runtime path calls this API, and there is still no system profile, request-view binding, provider dispatch, tool/effect authority, activation change, or continuation-head change.
