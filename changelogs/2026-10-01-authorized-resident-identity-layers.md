# Authorized resident identity layers

Schema 45 adds one immutable derivation receipt that can consume an exact resident identity-source authorization from a later live run batch. The transaction freshly verifies the prompt-facing SOUL, creates only the worldless scoped-contract and identity projections plus their typed approvals, and refuses preexisting target rows without a matching derivation receipt.

The new `elpis.context.deriveAuthorizedIdentityLayers(authorizationId)` capability is available only to an active resident run. Exact same-call retries are idempotent, presentation and secret-redaction failures roll the whole transaction back, and the receipt remains explicitly unprofiled and inactive: no world, profile, branch, request view, provider request, effect authority, activation, or continuation state is created.
