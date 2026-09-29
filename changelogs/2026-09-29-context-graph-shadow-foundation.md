# Scoped context graph shadow foundation

Elpis now includes an inactive durable substrate for world-scoped context: immutable world events, branches, canonical view manifests, capsules, explicit shares, effect receipts, an ordered continuation chain, and one-way activation state. `context_graph.shadow_enabled` defaults to `false`.

When shadow mode is explicitly enabled, ingress is routed to a stable world before its body is recorded, graph lineage follows the committed user message into the transcript, and the newest pre-graph transcript is sealed byte-exact as mixed/unscoped legacy testimony. Shadow mode does not alter provider requests, compaction, sends, or cache identity, and it is not an isolation claim.

Schema v29 is applied at boot. A runtime that only supports shadow mode refuses to start if the graph activation row is already `active`, preventing silent fallback to the old mixed loop. Deterministic tests cover routing, exact-byte legacy custody, canonical manifests, explicit shares, continuation ordering, crash/effect guards, migrations, and transcript lineage; the full unit suite and build were run before release.

After restart, verify the service is healthy and the configured default remains shadow-disabled. Active branch execution and provider projection remain later stages of the replacement.
