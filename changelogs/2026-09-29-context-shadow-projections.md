# Hash-only dark request projection records

When `context_graph.shadow_enabled` is active, the legacy Agent loop now freezes a lineage-only projection plan for each provider request and records the final provider-visible content plane as a hash, byte length, and surface immediately before dispatch. The recorder persists no request bytes or message content, and its strict plan schema rejects unknown/content-bearing fields.

Schema v31 adds immutable content-addressed plans and append-only observations. Current legacy-mixed requests are deliberately recorded as ineligible; the shadow path does not create branches, advance the continuation head, change caching, issue another provider request, or affect sends. Planning and observation failures remain non-semantic and cannot block the real call.

Focused graph, Agent, migration, Gateway-resident, and secretary migration suites pass. After deployment, verify the service upgrades to schema 31 while graph activation remains `dark`; shadow tables should remain empty when shadow mode is disabled.
