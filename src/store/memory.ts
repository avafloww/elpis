// memory.ts — dead simple, file-backed Markdown for the agent's long-term notes.
//
// MEMORY.md is injected into the system prompt on every agent turn (see
// prompt.ts), so the agent always reasons against fresh memory. It is NOT
// hot-reloaded — the agent loop caches it and only re-reads it on a context
// clear / compaction boundary (see agent.ts). SOUL.md, by contrast, IS
// hot-reloaded every turn.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface Memory {
  read(): string;
  append(text: string): { ok: true };
  overwrite(text: string): { ok: true };
}

export interface MemoryHooks {
  read?: () => string;
  changed?: (path: string) => void;
}

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

export function writePrivateFileAtomic(file: string, content: string): void {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.writing-${process.pid}-${crypto.randomUUID()}`,
  );
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      PRIVATE_FILE_MODE,
    );
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      /* renamed or absent */
    }
  }
}

function hardenPrivateFile(file: string): void {
  try {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function hardenAuthoredMemoryFiles(
  dataDirectory: string,
  exactFiles: string[],
): void {
  for (const file of exactFiles) hardenPrivateFile(file);
  for (const relative of ['people', 'ponder']) {
    const root = path.join(dataDirectory, relative);
    const pending = [root];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      let entries: fs.Dirent[];
      try {
        fs.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile() && entry.name.endsWith('.md'))
          hardenPrivateFile(full);
      }
    }
  }
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const updated = existing.replace(/\n*$/, '') + `\n- [${stamp}] ${text}\n`;
  writePrivateFileAtomic(file, updated);
}

export function createMemory(path: string, hooks: MemoryHooks = {}): Memory {
  return {
    read(): string {
      if (hooks.read) return hooks.read();
      try {
        return fs.readFileSync(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return '';
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
      writePrivateFileAtomic(path, text);
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
    hardenPrivateFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    writePrivateFileAtomic(path, defaultContent);
  }
}
