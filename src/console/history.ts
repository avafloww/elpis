// console/history.ts — lazy, on-disk backfill for the console's infinite
// scroll-back BELOW the live mirror.
//
// The hub's mirror covers everything this process has appended (seeded from the
// transcript that primed the agent at boot). To scroll further back — into the
// conversation history that existed BEFORE this process started (older rotated
// `main/*.jsonl` files, e.g. pre-compaction or pre-restart) — the client pages
// into this reader.
//
// The set of "archived" files is FROZEN at construction: every main transcript
// file that existed at boot EXCEPT the newest (the newest seeded the mirror, so
// serving it here would duplicate). Files created later (compaction rotations
// during this run) are never treated as archived — their content is already in
// the mirror. Contents are parsed lazily and cached.
//
// IDS: archived entries use NEGATIVE ids so they always sort before the mirror's
// non-negative ids. With T archived messages in chronological order, pool index
// i maps to id = i - T (newest archived = -1, oldest = -T). The client pages
// backward by passing the oldest negative id it holds as `beforeId`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { MAIN_TRANSCRIPT_ID, parseTranscriptFile } from '../store/sessions.js';
import type { ChatMessage } from '../llm/llm.js';
import { serializeMessage, type StreamEntry } from './hub.js';

export interface ArchivedReader {
  /** Return up to `limit` archived entries with ids in [beforeId - limit,
   * beforeId). `beforeId` is 0 for the first (newest) archived page, or the
   * oldest negative id the client already holds. */
  read(beforeId: number, limit: number): StreamEntry[];
}

/** List all main transcript files sorted chronologically (by mtime, tie-broken
 * by name — same order the store writes them). */
function listMainFilesChrono(sessionsRoot: string): string[] {
  const dir = path.join(sessionsRoot, 'discord', MAIN_TRANSCRIPT_ID);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const withMtime = names.map((f) => {
    const full = path.join(dir, f);
    let mtime = 0;
    try {
      mtime = fs.statSync(full).mtimeMs;
    } catch {
      /* skip */
    }
    return { full, name: f, mtime };
  });
  withMtime.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
  return withMtime.map((x) => x.full);
}

export function createArchivedReader(sessionsRoot: string): ArchivedReader {
  // Freeze the archived file set at boot: all-but-newest.
  const frozen = listMainFilesChrono(sessionsRoot);
  const files = frozen.slice(0, Math.max(0, frozen.length - 1));

  // Build the flat chronological pool lazily (concatenation of all archived
  // files), then cache it. The frozen file set never changes and the pool is
  // built exactly once, so there's no second reader to justify a separate
  // per-file cache alongside it.
  let pool: ChatMessage[] | null = null;
  const getPool = (): ChatMessage[] => {
    if (pool) return pool;
    pool = [];
    for (const f of files) pool.push(...parseTranscriptFile(f));
    return pool;
  };

  return {
    read(beforeId: number, limit: number): StreamEntry[] {
      const p = getPool();
      const T = p.length;
      if (T === 0) return [];
      // beforeId <= 0. First page: beforeId 0 → the newest archived slice.
      const end = beforeId >= 0 ? T : beforeId + T; // pool index (exclusive)
      const hi = Math.min(T, Math.max(0, end));
      const lo = Math.max(0, hi - limit);
      const out: StreamEntry[] = [];
      const thinkCallIds = new Set<string>();
      for (let i = 0; i < hi; i++) {
        const message = p[i];
        for (const call of message.tool_calls ?? []) {
          if (call.function.name === 'think') thinkCallIds.add(call.id);
        }
        const entry = serializeMessage(message, i - T, null);
        if (
          message.role === 'tool' &&
          message.tool_call_id &&
          thinkCallIds.delete(message.tool_call_id)
        ) {
          entry.kind = 'think-result';
        }
        if (i >= lo) out.push(entry);
      }
      return out;
    },
  };
}
