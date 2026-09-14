# Direct channels acknowledge accepted work before tools

When the Discord message that owns a turn's wake comes from a sendable `direct`-tier channel, the first provider request now receives a request-only instruction with the exact speech-header target and reply ID. If the resident decides to perform requested tool-backed work, the instruction requires a brief outward acknowledgement before the first tool call. It does not force action, speech, or a completion claim.

The instruction uses the resolved channel policy, including thread-parent inheritance, but targets the actual channel or thread. Send-denied and muted channels, social or quiet rooms, ambient context, console input, synthetic wakes, later outer turns, and post-tool continuations do not receive it. Context clearing drops the turn latch. There is no configuration, transcript, database, or migration change.

Focused tests cover direct threads, social and send-denied exclusions, post-tool omission, and a mid-request context clear. The full unit and integration suites, TypeScript build, benchmark build, Prettier check, and diff check pass. After deployment, the next accepted action in a direct room should show a short speech-header acknowledgement before its first tool runs.
