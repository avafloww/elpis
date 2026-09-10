# Materialize Gateway-managed catalogs during boot

Elpis now opens its resident database and materializes `llm.gateway_managed` from the enrolled, authority-bound Gateway catalog before module checks, compaction accounting, replay identity, role clients, tools, workers, or secretary consumers inspect model configuration. Direct provider configurations cross the same seam without Gateway activity.

Managed roles, routes, tool tiers, context metadata, and generation identity remain exact frozen catalog values. Materialization or pre-consumer validation failure closes the newly opened database instead of leaving a partial runtime alive. Gateway-managed subscription usage polling is disabled because no direct upstream credential exists.

This does not add the managed request adapter: generation still fails closed with `Gateway LLM adapter is unavailable`. Do not enable managed mode for a production resident yet.

Validation before publication must include the managed boot-order/cleanup regression, affected Gateway/config/compaction/tool/worker/secretary suites, deterministic unit tests, build, benchmark, formatting, and privacy/secret review.
