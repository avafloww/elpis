// mutes.ts — the killswitch's persistent state: one row per muted/deafened
// channel in agent.db's channel_mutes table (v5). The store is deliberately
// dumb — transition RULES (who may set/clear what) live in Agent.moderateChannel,
// the single implementation shared by slash commands, the console moderate op,
// and the sandbox's self-mute. See docs/persistence.md and the.

import type { Database } from './db.js';

export type MuteType = 'mute' | 'deafen';
export type MuteActor = 'self' | 'operator';

export interface MuteRow {
  channelId: string;
  type: MuteType;
  setBy: MuteActor;
  reason: string | null;
  createdAt: string;
}

export interface MuteStore {
  get(channelId: string): MuteRow | null;
  set(channelId: string, type: MuteType, setBy: MuteActor, reason?: string | null): void;
  /** Remove the row (release). Returns true if one existed. */
  clear(channelId: string): boolean;
  all(): MuteRow[];
}

export function createMuteStore(db: Database): MuteStore {
  const getStmt = db.prepare('SELECT channel_id, type, set_by, reason, created_at FROM channel_mutes WHERE channel_id = ?');
  const upsertStmt = db.prepare(
    'INSERT INTO channel_mutes (channel_id, type, set_by, reason, created_at) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(channel_id) DO UPDATE SET type = excluded.type, set_by = excluded.set_by, reason = excluded.reason, created_at = excluded.created_at',
  );
  const delStmt = db.prepare('DELETE FROM channel_mutes WHERE channel_id = ?');
  const allStmt = db.prepare('SELECT channel_id, type, set_by, reason, created_at FROM channel_mutes ORDER BY created_at');
  const toRow = (r: Record<string, unknown>): MuteRow => ({
    channelId: r.channel_id as string,
    type: r.type as MuteType,
    setBy: r.set_by as MuteActor,
    reason: (r.reason as string | null) ?? null,
    createdAt: r.created_at as string,
  });
  return {
    get: (id) => {
      const r = getStmt.get(id) as Record<string, unknown> | undefined;
      return r ? toRow(r) : null;
    },
    set: (id, type, setBy, reason = null) => {
      upsertStmt.run(id, type, setBy, reason, new Date().toISOString());
    },
    clear: (id) => delStmt.run(id).changes > 0,
    all: () => (allStmt.all() as Record<string, unknown>[]).map(toRow),
  };
}
