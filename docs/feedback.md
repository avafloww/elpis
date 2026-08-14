# Feedback capture

Elpis can record 👍 and 👎 reactions on its own Discord messages as out-of-band feedback.

## Live capture

`src/discord/discord.ts` accepts configured reaction emoji only when the reacted-to message was authored by the bot. `src/store/feedback.ts` appends an immutable row to `agent.db`.

Feedback does not edit prompts, identity, memory, or conversation history. It is evidence for later review, not an automatic reward loop.

## Offline reconciliation

```bash
npm run feedback -- reconcile
npm run feedback -- review 20
```

The offline script logs into Discord, locates the bot's sent messages, matches them to transcript send receipts, and updates `message_index`. Review joins feedback with localized transcript context.

Matching runs newest-first, prefers exact chunk membership, and falls back to normalized whitespace matching. Ambiguous or missing localization remains explicit.

## Privacy

Review output can contain private conversation. Run it only on the host and never commit reports without deliberate redaction and consent.
