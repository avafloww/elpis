// soul.ts — the agent's identity lives in the DATA DIRECTORY, never in the
// harness. SOUL.md may open with a YAML frontmatter envelope whose `name:`
// scalar is the agent's name; everything the harness renders a name into
// (extension signatures, moderation notes, worker dispatch guidance) derives it from
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

import { createHash } from 'node:crypto';
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
  const lines = inner
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    lines.length > 0 && lines.every((l) => /^[A-Za-z0-9_-]+[ \t]*:/.test(l))
  );
}

export const RESIDENT_REANCHOR_MAX_WORDS = 10;
export const RESIDENT_REANCHOR_MAX_BYTES = 120;
export const SOUL_PROMPT_SNAPSHOT_PARSER_GENERATION = 1;
export const SOUL_PROMPT_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

function residentReanchor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized) return null;
  if (normalized.split(' ').length > RESIDENT_REANCHOR_MAX_WORDS) return null;
  if (Buffer.byteLength(normalized, 'utf8') > RESIDENT_REANCHOR_MAX_BYTES)
    return null;
  return normalized;
}

export interface SoulParts {
  /** `name:` from the frontmatter, or null when absent. */
  name: string | null;
  /** Optional resident-authored request-tail orientation, tightly bounded. */
  reanchor: string | null;
  /** The prompt-facing body: raw text minus the envelope + the blank line(s)
   * right after it. Identical to the input when there is no envelope. */
  body: string;
}

export function parseSoul(raw: string): SoulParts {
  const m = raw.match(SOUL_ENVELOPE);
  if (!m || !looksLikeFrontmatter(m[1]))
    return { name: null, reanchor: null, body: raw };
  const body = raw.slice(m[0].length).replace(/^(\r?\n)+/, '');
  const frontmatter = parseFrontmatter(raw)?.frontmatter ?? {};
  const name = frontmatter['name'];
  return {
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    reanchor: residentReanchor(frontmatter['reanchor']),
    body,
  };
}

export interface PromptFacingSoulSnapshot {
  parserGeneration: number;
  sourceFileHash: string;
  sourceFileBytes: number;
  body: string;
  bodyHash: string;
  bodyBytes: number;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Read one strict prompt-facing SOUL snapshot for later resident authorization.
 * This derives source evidence only; it does not create or grant authority. */
export function readPromptFacingSoulSnapshot(
  soulPath: string,
): PromptFacingSoulSnapshot {
  const noFollow = fs.constants.O_NOFOLLOW;
  const nonBlock = fs.constants.O_NONBLOCK;
  if (typeof noFollow !== 'number' || typeof nonBlock !== 'number')
    throw new Error(
      'prompt-facing SOUL snapshot unavailable: strict file-open flags are unsupported',
    );
  let fd: number;
  try {
    fd = fs.openSync(soulPath, fs.constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    throw new Error(
      `prompt-facing SOUL snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile())
      throw new Error('prompt-facing SOUL snapshot must be a regular file');
    if (before.size > BigInt(SOUL_PROMPT_SNAPSHOT_MAX_BYTES))
      throw new Error('prompt-facing SOUL snapshot exceeds the byte limit');

    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(
        fd,
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (read === 0)
        throw new Error('prompt-facing SOUL snapshot changed while reading');
      offset += read;
    }
    const extra = Buffer.alloc(1);
    if (fs.readSync(fd, extra, 0, 1, offset) !== 0)
      throw new Error('prompt-facing SOUL snapshot changed while reading');

    const after = fs.fstatSync(fd, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('prompt-facing SOUL snapshot changed while reading');
    }

    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new Error('prompt-facing SOUL snapshot is not valid UTF-8');
    }
    const body = parseSoul(raw).body;
    if (!body.trim())
      throw new Error('prompt-facing SOUL snapshot body is empty');
    const bodyBuffer = Buffer.from(body, 'utf8');
    return Object.freeze({
      parserGeneration: SOUL_PROMPT_SNAPSHOT_PARSER_GENERATION,
      sourceFileHash: sha256(bytes),
      sourceFileBytes: bytes.length,
      body,
      bodyHash: sha256(bodyBuffer),
      bodyBytes: bodyBuffer.length,
    });
  } finally {
    fs.closeSync(fd);
  }
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
