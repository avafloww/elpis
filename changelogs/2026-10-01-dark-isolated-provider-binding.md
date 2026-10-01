# Dark isolated-provider binding

Elpis can now record an immutable dark receipt that binds the exact current pending request candidate to the concrete configured main provider target and a dedicated cache namespace. The new resident action accepts no target arguments and remains unavailable outside a live routed resident run.

Schema v47 adds the append-only binding table and database guards. Every receipt is explicitly non-runnable, has no network or tool authority, and does not dispatch a request, record a result, change configuration, issue an effect, create a capsule, activate the graph, or advance continuation.

Validation covers migration idempotence, exact lineage rematerialization, replay, immutability, recovery survival, runtime authority, exact presentation, and secret-redaction rollback. After deployment, verify the schema migration and record one live dark binding before designing any provider executor.
