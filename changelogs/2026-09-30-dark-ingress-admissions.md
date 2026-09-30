# Dark ingress admission substrate

Schema 35 adds an inert, content-free admission ledger for future scoped-context ingress. Migration records a generation watermark after the last existing world event, so pre-migration records cannot be reclassified as pending work.

The new store operation creates one new inbound world event and its exact admission in a single immediate transaction. Exact retries are idempotent; conflicting retries, stale or active graph state, non-inbound lineage, retroactive admission, and late database rejection fail closed without leaving a partial event. Admission rows carry only identity and scheduling metadata, not message content.

Nothing calls this path at runtime yet. It does not select work, reserve branches, call providers, attach tools, issue effects, advance continuity, or alter the legacy Agent queue. After restart, verify schema 35 applied once while the graph remains dark and both admission tables are empty.
