# Exclude error notices from feedback controls

Harness and provider notices routed through the configured Discord error channel no longer receive the optional 👍 and 👎 control reactions. Ordinary resident-authored messages still receive controls when the guild or channel enables `feedback_reactions`, even when their text resembles an error.

The Agent now passes an internal error-notice purpose beside the existing send authorization. That purpose is not part of `OutboundSendOptions` or the sandbox API, so the behavior is based on delivery provenance rather than message-text inspection. Human reaction capture and retraction remain active independently of whether controls were displayed.

Validation exercises the real Agent `sendError` path through the Discord adapter alongside an identical ordinary send, plus the existing outbound-authority, moderation, feedback, and build checks.
