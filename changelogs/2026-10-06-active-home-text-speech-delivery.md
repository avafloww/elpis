# Complete dormant active-home speech delivery

- Added parallel active-only speech receipts and deferred finalization barriers for exact rejection, uncertain issuance, and observed Discord delivery.
- Observed delivery now atomically commits the root receipt, branch yield, continuation advance, and coordinator release; failure reconciliation never retries a possible send.
- Added authority-derived active orchestration that sends only a provider success created during the same call. A preexisting speech barrier is reconciled without delayed delivery.
- Kept Agent routing, deployment, and graph activation disconnected.
