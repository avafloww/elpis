# Dark system-profile request-view bindings

Schema 40 adds an immutable companion receipt that can bind one existing dark local request view to the exact current per-world system-profile head. The receipt seals the view and manifest edges, rejects retroactive binding after an attempt, effect, or capsule, and keeps historical profile-head lineage readable after later head advances.

The binding remains inert: no assembler creates it automatically, no provider or runtime path consumes it, it grants no effect authority, and migration creates no rows. A graph-only helper can materialize the validated binding together with the unchanged non-runnable request candidate.

Focused context-graph, migration, and database tests cover canonical identity, exact replay, `INSERT OR REPLACE`, immutability, edge sealing, retroactive-effect rejection, historical reread, downgrade fixtures, and migration idempotence. Resume by making dark assemblers derive their system layers from the selected profile and create this receipt atomically; do not bootstrap production profiles from legacy prompt layers.
