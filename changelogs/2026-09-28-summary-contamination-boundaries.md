# Keep injected context out of durable summaries

Conversation compaction now excludes harness-injected person-memory messages and loaded AGENTS.md/SKILL.md resource bodies from the summary-model input by their provenance fields. Ordinary conversation remains eligible, the source history and transcript are unchanged by projection, person-memory inside the verbatim tail remains, and the existing resource-tail reload placeholder behavior is unchanged.

Automatic `MEMORY.md` and `people/*.md` consolidation now treats the source file as authoritative and fails closed if a candidate copies identity-anchor prose/frontmatter, consolidation instructions, person-memory or resource envelopes, harness notices, or runtime-snapshot fields not present in the source chunk. A rejected candidate leaves the original file untouched and creates no backup; source-backed historical runtime facts may still survive. No configuration migration is required.

Validation: supplied-marker compactor and memory-consolidator regressions, the deterministic unit suite, and a production build. After restart, verify normal boot and leave any cleanup of existing private memory to a separate reviewed operation with its predecessor preserved.
