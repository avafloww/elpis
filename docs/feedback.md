# Feedback capture

Elpis can record 👍 and 👎 reactions on its own Discord messages as out-of-band feedback.

## Live capture

`src/discord/discord.ts` accepts 👍 and 👎 only when the reacted-to message was authored by the bot. Adding one appends a row to `elpis-data/elpis.db`. Removing it deletes every stored row for that exact Discord message, reactor, and emoji, without touching another person's reaction or the opposite emoji. Add and remove events for one exact key execute in gateway arrival order, so a quick untap cannot leave a late stale add.

Capture and retraction remain active whether or not bot-authored feedback controls are displayed. Harness and provider error-channel notices do not receive bot-authored controls, but a person's later 👍/👎 reaction on any bot-authored message remains eligible for the same capture rules. Feedback does not edit prompts, identity, memory, or conversation history. It is evidence for later review, not an automatic reward loop.

## Offline reconciliation

```bash
npm run feedback -- reconcile
npm run feedback -- review 20
```

The offline script logs into Discord, locates the bot's sent messages, matches them to transcript send receipts, and updates `message_index`. Review joins feedback with localized transcript context.

Matching runs newest-first, prefers exact chunk membership, and falls back to normalized whitespace matching. Ambiguous or missing localization remains explicit.

## Privacy

Review output can contain private conversation. Run it only on the host and never commit reports without deliberate redaction and consent.
