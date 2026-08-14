// soul.ts — the agent's identity lives in the DATA DIRECTORY, never in the
// harness. SOUL.md may open with a YAML frontmatter envelope whose `name:`
// scalar is the agent's name; everything the harness renders a name into
// (native notes, moderation notes, fleet dispatch guidance) derives it from
// here. The harness source itself never hardcodes an agent name.
//
// parseSoul splits the file into { name, body } BYTE-PRESERVINGLY: the body
// is the raw text with only the envelope (and the blank lines that separate it
// from the content) removed, never trimmed — the body is injected verbatim
// into the system prompt, so adding a frontmatter block to an existing SOUL.md
// must leave the injected bytes identical (prefix-cache stability, and "no
// implications for the current agent"). This is why the body split does not
// reuse parseFrontmatter, whose body is trimmed; the envelope MAP still
// comes from parseFrontmatter so scalar handling (quotes) stays one
// convention.

import * as fs from 'node:fs';
import { parseFrontmatter } from '../lib/frontmatter.js';

/** Fallback when SOUL.md is missing, has no frontmatter, or no `name:`. */
export const DEFAULT_AGENT_NAME = 'Agent';

/** The frontmatter envelope, anchored at byte 0. Mirrors parseFrontmatter's
 * shape (a closing `---` line must be newline-terminated); tolerates CRLF. */
const SOUL_ENVELOPE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/;

/** SOUL.md is agent-edited prose, so a leading `---` might be a decorative
 * ruler, not frontmatter — and swallowing prose as a false envelope would
 * silently corrupt the injected soul. Only a block whose every non-empty line
 * is `key: value`-shaped counts as an envelope. */
function looksLikeFrontmatter(inner: string): boolean {
  const lines = inner.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => /^[A-Za-z0-9_-]+[ \t]*:/.test(l));
}

export interface SoulParts {
  /** `name:` from the frontmatter, or null when absent. */
  name: string | null;
  /** The prompt-facing body: raw text minus the envelope + the blank line(s)
 * right after it. Identical to the input when there is no envelope. */
  body: string;
}

export function parseSoul(raw: string): SoulParts {
  const m = raw.match(SOUL_ENVELOPE);
  if (!m || !looksLikeFrontmatter(m[1])) return { name: null, body: raw };
  const body = raw.slice(m[0].length).replace(/^(\r?\n)+/, '');
  const name = parseFrontmatter(raw)?.frontmatter['name'];
  return { name: typeof name === 'string' && name.trim() ? name.trim() : null, body };
}

/** Read the agent's name off SOUL.md's frontmatter; DEFAULT_AGENT_NAME when
 * the file is missing or carries no name. Cheap enough to call at use sites
 * (a rename in SOUL.md takes effect without a restart). */
export function readAgentName(soulPath: string): string {
  let raw = '';
  try {
    raw = fs.readFileSync(soulPath, 'utf8');
  } catch {
    return DEFAULT_AGENT_NAME;
  }
  return parseSoul(raw).name ?? DEFAULT_AGENT_NAME;
}
