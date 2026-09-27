# Add disabled-by-default Signal direct-text transport

Elpis can now supervise one configured `signal-cli` JSON-RPC child and route configured Signal contacts through the same ordered Agent history and outbound send seam as Discord.

The first increment is intentionally narrow: direct-contact text only, exact ACI allowlists, separate receive/send booleans that default off, an exact startup version gate, no linking or registration API, no group/reply/attachment support, no automatic replay or restart, and acceptance receipts that do not claim delivery or read. Unknown or unsupported inbound events are rejected before Agent history. Raw Signal identifiers are not accepted as resident-authored destinations; configured aliases use `signal:<alias>`.

Signal is disabled by default and an absent section starts no process. Signal E2EE terminates at the Elpis host; accepted text follows the configured resident model/provider path and does not create a local-only lane.

Focused transport, config, routing, prompt-header, and authority tests pass. The deterministic unit suite and build are required before deployment. After restart, verify the existing Discord-only service remains healthy with Signal disabled. Installing `signal-cli`, linking an account, enabling the section, and live send/receive acceptance remain separate explicitly authorized operations.
