# Dark pending frontier inspection

The scoped-context store can now inspect the globally earliest admitted dark-ingress frontier using metadata only. It returns either an empty result, a typed activation/generation/projection blocker, or a bounded contiguous prefix from one world and renderer generation.

The inspector never skips an unrenderable front event, never substitutes another renderer generation, and does not expose the row beyond a boundary. It queries no event payload, rendered message bytes, or message hashes.

This is inert read-only substrate. No Agent, ingress, selector loop, branch assembler, provider, tool, effect, completion, compaction, cache, config, or activation path calls it; inspection does not claim or consume work.
