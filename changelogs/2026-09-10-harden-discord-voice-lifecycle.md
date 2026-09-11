# Harden Discord voice lifecycle races

Discord voice now makes a retiring speech response inert to late audio and transcript callbacks, claims terminal failure policy before external notices, and coalesces indistinguishable session updates onto one acknowledged state barrier.

This prevents synchronous cancellation, playback, policy, or notice reentry from changing a retiring receipt, playing late media, overriding no-cancel failure semantics, or letting a duplicate `session.updated` acknowledgement satisfy a different update. A returned playback-finish promise is still observed if synchronous reentry already settled the speech.

There is no configuration or migration change. The public Realtime bridge remains disabled by default and live provider and Discord-call acceptance are still required before enabling voice.

Validation covered the focused realtime transport and voice session suites, the full deterministic unit suite, provider transport tests, TypeScript build, console build, benchmark compile, and Prettier checks.
