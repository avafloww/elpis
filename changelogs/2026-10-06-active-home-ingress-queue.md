# Durable active home ingress queue

Schema v55 adds a dormant store boundary for social ingress after scoped-context activation. Discord and Signal inputs can be appended to the ordered world-event log in one transaction; only exact direct non-bot home Discord text also receives a renderer-1 projection and immutable active-home admission. Other routes remain queued as world events and cannot fall through to legacy context.

Exact retries are idempotent, conflicting or retroactive home admission fails closed, and any late projection or admission failure rolls back the event append. The API is not wired into Agent or boot routing and grants no branch, provider, speech, effect, capsule, or continuation authority.

Validation covers exact-home admission, cross-world queuing, replay conflicts, rollback, immutability, schema migration, and dependent downgrade fixtures. Fresh active-mode request assembly remains the next prerequisite before cutover.
