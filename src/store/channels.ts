// channels.ts — a small persistent id→name(→guild, →parent) directory so channel
// names survive a restart. Backed by elpis.db (the `channels` table). On first boot with an
// empty table it imports a legacy DATA_DIRECTORY/channels.json once, after which
// the DB is authoritative (the JSON file is left on disk, no longer written).
//
// Without it, restart-recovered contexts are primed with the placeholder name
// 'recovered' (agent.ts), which surfaces as `#recovered` labels and makes
// channel('some-name') resolution miss until that room receives a fresh message.
//
// Each entry also carries a `guild_id` (nullable — see docs/persistence.md's
// "guild_id NULL semantics"). A row written before the multi-server work has
// guild_id = NULL; it heals to a real guild the first time `set` is called
// with one, and a `set` call without a guild never nulls a healed row back
// out (COALESCE on the upsert). When the deployment has exactly one configured
// guild, every legacy NULL row is unambiguous and gets backfilled at startup.
//
// A THREAD's row also carries `parent_id` — the channel it inherits policy from
// (discord.ts's `resolvePolicyChannelId` computes it; `Agent.enqueue` records
// it). NULL for a normal channel. `Agent.send` reads it back via `parentOf`
// so a mute on the parent holds for every send into its threads; same COALESCE
// heal-never-downgrade rule as `guild_id`.

import * as fs from 'node:fs';
import { resolveDataLayout } from './data-layout.js';
import type { Database } from './db.js';

/** One row of the channel directory. */
export interface ChannelEntry {
  id: string;
  name: string;
  guildId: string | null;
  /** For a thread/forum post, the parent channel it inherits policy from;
   * null for a normal channel (and for a thread first seen before v6). */
  parentId: string | null;
}

export interface ChannelDirectory {
  /** The stored name for a channel id, or undefined if unknown. */
  get(id: string): string | undefined;
  /** The stored guild id for a channel id, or null if unknown/unrecorded. */
  guildOf(id: string): string | null;
  /** The stored parent channel id (threads only), or null. */
  parentOf(id: string): string | null;
  /** The full directory row for a channel id, or undefined if unknown. A single
   * prepared-statement read — for callers that need name+guild+parent for one
   * id and would otherwise scan the whole table via all. */
  entry(id: string): ChannelEntry | undefined;
  /** Record a real channel name. No-ops for placeholder/synthetic names
   * ('heartbeat', 'recovered', 'unknown', empty) and unchanged entries.
   * `guildId`/`parentId`, when provided, heal a NULL/differing stored value;
   * an absent one never downgrades an already-recorded one. */
  set(
    id: string,
    name: string,
    guildId?: string | null,
    parentId?: string | null,
  ): void;
  /** A snapshot of every known channel entry. */
  all(): ChannelEntry[];
}

/** Names that are synthetic/placeholder, never a real Discord channel name. */
const NON_REAL_NAMES = new Set([
  'heartbeat',
  'recovered',
  'unknown',
  '',
  'scheduler',
  'fleet',
  'harness',
]);

export function createChannelDirectory(
  db: Database,
  dataDir: string,
  guilds?: { id: string }[],
): ChannelDirectory {
  const getStmt = db.prepare(
    'SELECT name, guild_id, parent_id FROM channels WHERE id = ?',
  );
  const upsertStmt = db.prepare(
    'INSERT INTO channels (id, name, guild_id, parent_id, updated_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET name = excluded.name, ' +
      'guild_id = COALESCE(excluded.guild_id, channels.guild_id), ' +
      'parent_id = COALESCE(excluded.parent_id, channels.parent_id), updated_at = excluded.updated_at',
  );
  const allStmt = db.prepare(
    'SELECT id, name, guild_id, parent_id FROM channels',
  );

  // One-time legacy import: only when the table is empty.
  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number }
  ).n;
  if (count === 0) {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(resolveDataLayout(dataDir).legacyChannels, 'utf8'),
      );
      if (parsed && typeof parsed === 'object') {
        const now = new Date().toISOString();
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && !NON_REAL_NAMES.has(v))
            upsertStmt.run(k, v, null, null, now);
        }
      }
    } catch {
      // no legacy file / unreadable / malformed — start empty
    }
  }

  // A single configured guild makes every legacy NULL-guild row unambiguous:
  // there is nowhere else it could belong. Multiple guilds leave NULL rows to
  // heal individually as their channel gets a fresh `set` (see module header).
  if (guilds && guilds.length === 1) {
    db.prepare('UPDATE channels SET guild_id = ? WHERE guild_id IS NULL').run(
      guilds[0].id,
    );
  }

  type Row = {
    name: string;
    guild_id: string | null;
    parent_id: string | null;
  };
  return {
    get: (id) => (getStmt.get(id) as Row | undefined)?.name,
    guildOf: (id) => (getStmt.get(id) as Row | undefined)?.guild_id ?? null,
    parentOf: (id) => (getStmt.get(id) as Row | undefined)?.parent_id ?? null,
    entry: (id) => {
      const r = getStmt.get(id) as Row | undefined;
      return r
        ? { id, name: r.name, guildId: r.guild_id, parentId: r.parent_id }
        : undefined;
    },
    set: (id, name, guildId = null, parentId = null) => {
      // A synthetic name (e.g. 'scheduler') bails out before any write, which also
      // discards a `guildId` the caller may have passed alongside it. Deliberate
      // today: nothing that calls set with a synthetic name currently has a real
      // guild to offer. If a future caller stamps guild ids onto synthetic-name
      // enqueues, this guard will silently drop them — revisit then, don't just
      // relax it without checking who's newly affected.
      if (!id || typeof name !== 'string' || NON_REAL_NAMES.has(name)) return;
      const existing = getStmt.get(id) as Row | undefined;
      const healsGuild = guildId != null && guildId !== existing?.guild_id;
      const healsParent = parentId != null && parentId !== existing?.parent_id;
      if (existing?.name === name && !healsGuild && !healsParent) return;
      upsertStmt.run(id, name, guildId, parentId, new Date().toISOString());
    },
    all: () =>
      (allStmt.all() as (Row & { id: string })[]).map((r) => ({
        id: r.id,
        name: r.name,
        guildId: r.guild_id,
        parentId: r.parent_id,
      })),
  };
}
