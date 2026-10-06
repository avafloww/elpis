# Active home request assembly

Schema v56 adds the dormant persistence seam after active home ingress. The store now consumes only the oldest exact scoped home admission and atomically creates one active local branch, request view, source-profile binding, materialized candidate, and non-runnable provider invocation admission.

The admission carries no network, tool, effect, capsule, or continuation authority. Exact replay is idempotent, changed replay fails, and a late admission failure rolls back all newly opened branch artifacts. Every newly inserted active request view must acquire its matching admission before the transaction commits, including views on branches opened before activation; unrelated in-flight branches survive migration. Existing dark request assembly remains dark by explicit mode and profile epoch.

Focused context-store, database, and migration regression suites plus the build cover the new path. Agent routing, provider execution lineage, deployment, and graph activation remain intentionally disconnected.
