# Per-send Discord mention suppression

Programmatic channel sends now accept an optional `mentions` boolean. `mentions: false` keeps literal user tags clickable while suppressing every user notification for that delivery, including users whose stored guild preference normally permits notification. Omitted or `mentions: true` preserves the existing preference-gated behavior and never widens notification authority.

The override is validated before send accounting, skips preference reads when suppression is requested, applies to every chunk, and is retained in send provenance and transcript recovery. There is no database migration or configuration change. Focused Discord, sandbox, and persistence tests cover rewritten and literal tags, multi-chunk delivery, malformed options, failure isolation, and non-widening behavior. After deployment, verify an explicit `mentions: false` send remains clickable without notifying an opted-in test user.
