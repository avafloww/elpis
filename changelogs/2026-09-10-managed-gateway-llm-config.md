# Managed Gateway LLM configuration boundary

Elpis can now parse `llm.gateway_managed`, fetch one authenticated Gateway catalog through an internally bound resident client, and materialize a complete frozen model registry with exact full-ref, target-generation, route, tool-contract, and replay identity.

The boundary fails closed when resident or dashboard authority changes, when managed input contains accessors or unexpected fields, when selected roles are missing or non-executable, or when a resolved target is not from the exact authority-bound registry. Direct provider configuration is unchanged.

This does **not** enable managed provider execution yet. Current boot and `createLLM` continue to refuse managed configuration until the later boot-wiring and provider-adapter changes land.

Validation covered 64 materialization cases, 323 affected focused tests, 90 deterministic unit tests, a full TypeScript build, and an independent security review.
