# Provider content-plane observation seam

Elpis provider adapters now offer an optional process-local observer for the final model-visible content plane immediately before network dispatch. OpenAI Chat reports translated messages, Responses and Codex report transformed input items, and Anthropic reports finalized system and message blocks after its request fingerprint is applied.

The observer receives canonical bytes plus a SHA-256, byte length, and provider-surface label. Observer failures are ignored, the real request is sent once and unchanged, and no content is persisted or logged by this seam. This is dark validation infrastructure for future scoped-context comparison; it does not activate the context graph, alter cache identity, bind effects, or change current conversation behavior.
