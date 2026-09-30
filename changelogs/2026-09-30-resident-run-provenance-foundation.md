# Resident run provenance foundation

Elpis now contains an inert process-local authority primitive for distinguishing later resident assistant tool calls. It creates a fresh random batch identity, commits ordered tool names and exact raw-argument hashes with a domain-separated SHA-256 format, and can issue one single-use token per committed call ordinal.

Tokens and scope handles are backed by private WeakMaps rather than structural fields. Copies, cross-authority use, replay, and invalid handles fail closed. Accepted scopes expose a host-only active, detached, or closed lifecycle, and only active scopes resolve. A separate strict parser validates forensic batch metadata without recovering live authority from it.

Nothing instantiates or consumes this primitive in production yet. It adds no transcript field, Agent or sandbox-manager wiring, sandbox-visible API, database schema, provider request data, profile, effect, activation, or authorization action. Focused tests cover fresh identities, exact argument sensitivity, duplicate-ID rejection, commit ordering, single use, cross-authority and structural forgery rejection, lifecycle invalidation, strict forensic parsing, and a fixed canonical commitment vector.
