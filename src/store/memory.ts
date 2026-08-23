// memory.ts — dead simple, file-backed Markdown for the agent's long-term notes.
//
// MEMORY.md is injected into the system prompt on every agent turn (see
// prompt.ts), so the agent always reasons against fresh memory. It is NOT
// hot-reloaded — the agent loop caches it and only re-reads it on a context
// clear / compaction boundary (see agent.ts). SOUL.md, by contrast, IS
// hot-reloaded every turn.

import * as fs from 'node:fs';

export interface Memory {
  read(): string;
  append(text: string): { ok: true };
  overwrite(text: string): { ok: true };
}

export interface MemoryHooks {
  read?: () => string;
  changed?: (path: string) => void;
}

/** Append a dated bullet (`- [YYYY-MM-DD] text`) to a file, creating it if
 * missing. Strips trailing newlines from existing content first so bullets
 * stack cleanly. Shared by memory.append, ponder, ponder.close, and
 * memory.person so the stamp format + newline handling can't diverge across
 * MEMORY.md, ponder/, and people/. */
export function appendDatedBullet(
  file: string,
  text: string,
  stamp = new Date().toISOString().slice(0, 10),
): void {
  let existing = '';
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  const updated = existing.replace(/\n*$/, '') + `\n- [${stamp}] ${text}\n`;
  fs.writeFileSync(file, updated);
}

export function createMemory(path: string, hooks: MemoryHooks = {}): Memory {
  return {
    read(): string {
      if (hooks.read) return hooks.read();
      try {
        return fs.readFileSync(path, 'utf8');
      } catch {
        return ''; // missing file = empty memory
      }
    },
    append(text: string): { ok: true } {
      // Route through the shared dated-bullet writer so MEMORY.md, ponder/, and
      // people/ all stamp the same `- [YYYY-MM-DD] text` format.
      appendDatedBullet(path, text.trim());
      hooks.changed?.(path);
      return { ok: true };
    },
    overwrite(text: string): { ok: true } {
      fs.writeFileSync(path, text);
      hooks.changed?.(path);
      return { ok: true };
    },
  };
}

/** Ensure a file exists with the given default content. Call once at startup.
 * Used for both SOUL.md and MEMORY.md. */
export function ensureFile(path: string, defaultContent: string): void {
  try {
    fs.accessSync(path);
  } catch {
    fs.writeFileSync(path, defaultContent);
  }
}
