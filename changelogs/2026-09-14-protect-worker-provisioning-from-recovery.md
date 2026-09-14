# Protect active worker provisioning from recovery

Worker refresh recovery no longer treats a Pod as missing while the same broker is still preparing that session's source archive or creating its Kubernetes resources. A process-local ownership marker covers the exact post-insert start attempt and is released in `finally` when the attempt settles.

The marker is deliberately not persisted. After a process restart, an abandoned `spawning` row with no Pod is still failed and cleaned by ordinary startup recovery. Existing capacity, dismissal, credential revocation, source-binding, and terminal-Pod behavior is unchanged; there is no configuration or database migration.

Deterministic tests trigger recovery from inside both source preparation and Pod provisioning before the fake runtime publishes a receipt. They also retain the existing missing-Pod recovery case. The complete worker test family, unit suite, TypeScript build, integration suite, benchmark build, formatting, dependency audit, and publication scans are required before release.
