# Resident identity-source authorization

A live resident run can now authorize one exact previously inspected identity-source candidate with `elpis.context.authorizeIdentityCandidate(candidateId)`. Authorization must happen in a different assistant batch, freshly rereads the prompt-facing SOUL source, and records one immutable schema-44 receipt only while the exact candidate, scoped contract, and dark activation lineage still match.

This closes the gap between exact source review and resident-authored source testimony without collapsing it into runtime authority. The receipt does not create a system-layer approval, profile, branch, provider request, effect authority, activation, or continuation change. Direct, restored, inherited, detached, closed, and worker execution cannot invoke the action.

The migration creates no authorization rows. Exact same-call retry is idempotent; another call cannot reauthorize the candidate. Receipt formatting and registered-secret redaction preflight occur before commit so an altered presentation rolls the new row back.

Validation covers store identity and immutability, stale-source and same-batch rejection, transaction rollback, live-run lifecycle gating, migration upgrades/downgrades, and unchanged graph side-effect tables. After deployment, verify one real later-batch authorization of an already inspected candidate and confirm the graph remains dark with no profile, branch, provider, effect, activation, or continuation changes.
