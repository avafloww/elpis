# Clarify mention-notification suppression guidance

The resident prompt now says to omit the `mentions` option on ordinary sends with no literal user mention. `mentions: false` is reserved for text that actually contains a literal user mention which should remain clickable but intentionally must not notify even an opted-in person.

The Discord notification API and defaults are unchanged: omitted or true still uses exact guild-and-user preferences and never forces a notification without opt-in. This is an agent-visible guidance correction only, with no configuration or migration effect.

Prompt review, the shared TypeScript build, and the complete release gates pass.
