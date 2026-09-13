import type { Database } from './db.js';
import { isDiscordId, validateDiscordId } from '../lib/outbound.js';

export interface DiscordPersonSetting {
  guildId: string;
  userId: string;
  notifyOnMention: boolean;
  updatedAt: string | null;
}

export interface DiscordPersonSettingsStore {
  get(guildId: string, userId: string): DiscordPersonSetting;
  set(
    guildId: string,
    userId: string,
    notifyOnMention: boolean,
  ): DiscordPersonSetting;
  allowsMentionNotification(guildId: string, userId: string): boolean;
}

type Row = {
  notify_on_mention: number;
  updated_at: string;
};

export function createDiscordPersonSettingsStore(
  db: Database,
): DiscordPersonSettingsStore {
  const getStmt = db.prepare(
    'SELECT notify_on_mention, updated_at FROM discord_person_settings WHERE guild_id = ? AND user_id = ?',
  );
  const setStmt = db.prepare(`
    INSERT INTO discord_person_settings
      (guild_id, user_id, notify_on_mention, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      notify_on_mention = excluded.notify_on_mention,
      updated_at = excluded.updated_at
  `);
  const allowedStmt = db.prepare(
    'SELECT notify_on_mention FROM discord_person_settings WHERE guild_id = ? AND user_id = ?',
  );

  const get = (guildId: string, userId: string): DiscordPersonSetting => {
    validateDiscordId(guildId, 'guildId');
    validateDiscordId(userId, 'userId');
    const row = getStmt.get(guildId, userId) as Row | undefined;
    return {
      guildId,
      userId,
      notifyOnMention: row?.notify_on_mention === 1,
      updatedAt: row?.updated_at ?? null,
    };
  };

  return {
    get,
    set: (guildId, userId, notifyOnMention) => {
      validateDiscordId(guildId, 'guildId');
      validateDiscordId(userId, 'userId');
      if (typeof notifyOnMention !== 'boolean') {
        throw new Error('notifyOnMention must be a boolean');
      }
      const updatedAt = new Date().toISOString();
      setStmt.run(guildId, userId, notifyOnMention ? 1 : 0, updatedAt);
      return { guildId, userId, notifyOnMention, updatedAt };
    },
    allowsMentionNotification: (guildId, userId) => {
      if (!isDiscordId(guildId) || !isDiscordId(userId)) return false;
      const row = allowedStmt.get(guildId, userId) as
        Pick<Row, 'notify_on_mention'> | undefined;
      return row?.notify_on_mention === 1;
    },
  };
}
