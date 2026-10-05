# Add exact Codex dispatch lifecycle hooks

One-attempt standalone Codex calls can now attach synchronous lifecycle hooks immediately before the underlying network fetch and immediately after a real response exists. A failing pre-network hook prevents the request; the response hook never runs without positive response evidence.

The hooks are accepted only with unauthorized replay disabled. Ordinary standalone and resident lanes keep their existing behavior. Provider-transport and Codex client tests cover ordering, blocked pre-dispatch, one network attempt, and response evidence; the full build passes.
