# Add one-attempt Codex standalone mode

Isolated standalone Codex completions may now explicitly disable the transport's automatic credential refresh and 401 replay. Existing standalone callers retain the prior retry behavior unless they opt into `retryUnauthorized: false`.

This is a prerequisite for context-graph provider invocations whose durable admission permits exactly one network attempt. It does not activate graph execution or change the main resident lane. The full build and focused Codex transport/client tests passed.
