# Policy-denial flight recorder

The Codex transport can preserve an exact private request/response specimen when a provider policy denial occurs. This exists for diagnosis, not automatic retry or evasion.

## Capture condition

A bundle is sealed only when the stream contains both denial wording and an error-shaped envelope such as `event: error` or `response.failed`. Ordinary generated text that discusses policy is not a denial. Recognized
provider wording includes both “flagged … usage policy” and “flagged for
possible cybersecurity risk.” These denials are terminal even without an HTTP
error status; the runtime must not treat them as transient transport failures
and automatically retry them. The denied input stays in history, and the error
notice identifies a provider policy denial instead of suggesting history
corruption or a conversation clear.

Bundles are written under:

```text
DATA_DIRECTORY/elpis-data/policy-denials/<timestamp-uuid>/
```

Directories are mode `0700`; files are mode `0600`. A manifest records hashes, transport metadata, capture completeness, and trigger type. Secret headers are excluded.

## Contents and risk

A bundle may contain exact request bytes, raw SSE bytes, prompts, messages, images, tool schemas, and opaque provider state. Treat it like a private transcript. Retention is bounded, but backup and deletion policy remain the operator's responsibility.

## Replay

Replay is explicit and potentially expensive:

```bash
npm run replay-policy-denial -- \
  "$DATA_DIRECTORY/elpis-data/policy-denials/<bundle>" \
  --yes
```

The CLI verifies the source hash, uses fresh local authentication, sends the recorded bytes, and writes a separate immutable result. It never mutates the source specimen.

A successful replay does not prove the original was harmless; a failed reproduction does not prove it was deterministic. Do not repeatedly replay large or sensitive bundles casually.
