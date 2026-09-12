# Console updates without reloads

The private console now pushes changed worker and Secretary sessions, Mind items, and runtime metadata incrementally over its existing websocket. Open worker mailbox/artifact details, Mind comments/dependencies, and Context projections stay current after background work and reconnects. Thread streaming survives unrelated incoming messages, and late responses cannot replace another selected worker's details.

One bounded observer pass is shared by local and Gateway viewers and stops when no viewers remain. Existing public projection limits and credential/path filtering still apply. No database migration or configuration change is required.

Validation passed: focused websocket and reducer regressions, durable Mind updates observed by multiple viewers, a Chromium acceptance pass against freshly built console assets, `npm run test:unit`, and `npm run build`.

After updating and restarting the harness, open a worker detail and confirm that mailbox progress, completion, and artifact receipts appear without refreshing. Previously loaded browser bundles need to load the updated console assets once.
