// feedback.ts — out-of-band capture of 👍/👎 reactions on the agent's Discord
// messages. Writes one IMMUTABLE row per reaction-add into agent.db's `feedback`
// table. This NEVER touches the conversation transcript or the agent's history —
// the agent does not see feedback; it is data for offline human+LLM review (see
// docs/feedback.md and scripts/feedback.ts).

import type { Database } from './db.js';

export type Verdict = 'good' | 'bad';

export interface FeedbackEvent {
  verdict: Verdict;
  /** ISO timestamp of the reaction. */
  reactedAt: string;
  emoji: string;
  reactorId: string;
  reactorName: string | null;
  isOwner: boolean;
  discordMessageId: string;
  channelId: string;
  channelName: string | null;
  /** The reacted message's text — always stored so the signal survives even if
 * the message is never localized to a transcript. */
  messageContent: string;
}

export interface FeedbackStore {
  recordReaction(event: FeedbackEvent): void;
}

/** 👍 → 'good', 👎 → 'bad', anything else → null (not feedback). */
export function classifyEmoji(name: string | null): Verdict | null {
  if (name === '👍') return 'good';
  if (name === '👎') return 'bad';
  return null;
}

export function createFeedbackStore(db: Database): FeedbackStore {
  const ins = db.prepare(
    'INSERT INTO feedback ' +
    '(verdict, reacted_at, emoji, reactor_id, reactor_name, is_owner, discord_message_id, channel_id, channel_name, message_content) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  return {
    recordReaction(e) {
      ins.run(
        e.verdict, e.reactedAt, e.emoji, e.reactorId, e.reactorName,
        e.isOwner ? 1 : 0, e.discordMessageId, e.channelId, e.channelName, e.messageContent,
      );
    },
  };
}
