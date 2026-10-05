# Isolated provider execution ledger

Schema v50 adds the dormant-to-active authority seam for one isolated direct Codex Responses call. An exact schema-v49 admission remains non-runnable; only a new active one-shot attempt can prepare the provider effect, record positive response evidence, and commit a bounded visible success or error.

The executor snapshots and enforces exact positive call-timeout, stream-idle-timeout, and visible-output byte limits while disabling unauthorized-response replay, tools, historical tool messages, and fallback. Provable pre-dispatch rejection creates no effect, while missing response evidence is issuance-uncertain and never retried. A durably received HTTP response remains issued evidence across restart and configuration drift, and response-to-outcome chronology fails closed. Restart recovery freezes effects and can crash an active execution branch without inventing a dark-abandonment receipt or advancing continuation.

This slice is intentionally not wired into Agent routing, graph activation, speech, capsules, or continuation return. Deterministic migration, store, executor, transport, and restart-recovery tests cover the new boundary; the remaining result-to-capsule and same-world delivery path must land before activation or deployment.
