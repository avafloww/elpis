// sessions.ts — transcript persistence for crash-safe recovery.
//
// (monocontext): ONE interleaved JSONL stream for the whole mind, keyed by a
// reserved 'main' id under DATA_DIRECTORY/elpis-data/sessions/discord/main/TIMESTAMP-SEQ.jsonl.
// Each persisted message carries an optional `channel` provenance stamp (the
// Discord channel id, or 'internal'/'harness'); replay ignores it. Every push is
// persisted — no exception (heartbeat traffic included).
//
// ROTATION RULE: a single transcript file accumulates messages across many
// turns. A new file (new TIMESTAMP) is started ONLY on:
// 1. manual context clear (/clear, /new) — writes an empty sentinel so a
// restart right after a clear honors the wipe (does not resurrect the
// pre-clear file).
// 2. compaction boundary (the history was structurally rewritten)
// Otherwise we append to the existing transcript — restart-resume continues the
// same file.
//
// RESTART: loadMostRecentMain loads the NEWEST .jsonl under discord/main/ and
// primes the one history from it; if that newest file is empty (the /clear
// sentinel) it returns null → fresh start (do NOT fall through to an older file,
// or a clear-then-restart would resurrect the wiped mind — review N1).

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  ChatMessage,
  ReasoningItemParam,
  AnthropicThinkingBlock,
} from '../llm/llm.js';
import {
  isTrustedOpaqueReplay,
  parseGenerationProvenance,
  type ReplayIdentity,
} from '../llm/provenance.js';
import { parseRunMessageMetadata } from '../sandbox/metadata.js';
import type { ContextResourceDescriptor } from '../context-resources.js';

/** Reserved transcript id for the single monocontext stream. */
export const MAIN_TRANSCRIPT_ID = 'main';

/** A persistent transcript writer. One active file per channel; rotation
 * creates a new file (new timestamp) and switches the writer to it. */
export interface TranscriptStore {
  /** Append a message to the active transcript for a channel. Creates the
   * file + dir on first write for this channel. No-op if channelId is falsy
   * (no channel bound yet — e.g. a restarted context before any inbound). */
  append(channelId: string, msg: ChatMessage): void;
  /** Start a fresh transcript file for a channel (rotation). Used on context
   * clear and compaction boundary. Subsequent appends go to the new file. When
   * `sentinel` is true an empty file is written immediately so a restart right
   * after the rotation (no appends since) does NOT boot from the pre-rotation
   * file — the whole-mind wipe promised by /clear is honored (review N1). */
  rotate(channelId: string, sentinel?: boolean): void;
  /** Force any pending writes for the active channel to disk. The default
   * store writes synchronously (appendFileSync) so each append is already
   * durable — this is an explicit sync seam for graceful shutdown / /restart
   * so callers don't reach into fs directly. No-op if no channel is bound. */
  flush(channelId: string): void;
  /** Continue APPENDING to an existing transcript file (restart-resume). Without
   * this, the first append of a fresh process mints a NEW timestamped file, so
   * the loaded history's file is frozen and the session's new messages land in a
   * separate file — on the next restart boot primes from that partial file and
   * silently loses the earlier context. Called at boot with the path that primed
   * the history so the module honors its documented "restart-resume continues the
   * same file" contract. No-op for a falsy path. */
  adopt(channelId: string, filePath: string): void;
}

function hardenTranscriptTree(sessionsRoot: string): void {
  fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(sessionsRoot, 0o700);
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        fs.chmodSync(target, 0o700);
        walk(target);
      } else if (entry.isFile()) {
        fs.chmodSync(target, 0o600);
      }
    }
  };
  walk(sessionsRoot);
}

export interface LoadedTranscript {
  /** The channel id the transcript belongs to. */
  channelId: string;
  /** Messages parsed from the JSONL file, in order. Malformed lines skipped. */
  messages: ChatMessage[];
  /** Absolute path to the loaded file (the new active transcript for append). */
  path: string;
}

export interface TranscriptStoreOptions {
  writeSentinel?: (temporaryPath: string, finalPath: string) => void;
}

export function createTranscriptStore(
  sessionsRoot: string,
  options: TranscriptStoreOptions = {},
): TranscriptStore {
  hardenTranscriptTree(sessionsRoot);
  // channelId -> absolute path of the active transcript file
  const active = new Map<string, string>();
  const writeSentinel =
    options.writeSentinel ??
    ((temporaryPath: string, finalPath: string): void => {
      let fd: number | undefined;
      try {
        fd = fs.openSync(temporaryPath, 'wx', 0o600);
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      fs.renameSync(temporaryPath, finalPath);
    });

  // monotonic counter so two rotations within the same millisecond produce
  // distinct filenames (timestamp alone can collide on a fast machine)
  let seqCounter = 0;

  function dirFor(channelId: string): string {
    return path.join(sessionsRoot, 'discord', channelId);
  }

  function newFilePath(channelId: string): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const seq = String(seqCounter++).padStart(4, '0');
    const p = path.join(dirFor(channelId), `${ts}-${seq}.jsonl`);
    // Minting a path is the one place a NEW file may need a NEW dir — create it
    // here so append (called once per message, forever) doesn't pay this
    // syscall on every write.
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(p), 0o700);
    return p;
  }

  function ensureActive(channelId: string): string {
    let p = active.get(channelId);
    if (!p) {
      p = newFilePath(channelId);
      active.set(channelId, p);
    }
    return p;
  }

  return {
    append(channelId, msg) {
      if (!channelId) return;
      // ensureActive mints (and creates the dir for) a fresh path; an already-
      // active path had its dir created when it was minted/adopted.
      const p = ensureActive(channelId);
      const line = JSON.stringify(msg) + '\n';
      try {
        fs.appendFileSync(p, line, { encoding: 'utf8', mode: 0o600 });
      } catch (e) {
        // The dir existed when the path was minted but can vanish underneath a
        // long-lived store (external cleanup). Recreate once and retry rather
        // than dropping a transcript line.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
        fs.chmodSync(path.dirname(p), 0o700);
        fs.appendFileSync(p, line, { encoding: 'utf8', mode: 0o600 });
      }
    },
    rotate(channelId, sentinel) {
      if (!channelId) return;
      if (!sentinel) {
        active.delete(channelId);
        return;
      }
      // Keep the old active path until the empty newest file exists. Any
      // failure must propagate before /clear wipes memory, and a later append
      // must still continue the retained pre-clear transcript.
      const p = newFilePath(channelId);
      const temporary = `${p}.pending`;
      try {
        writeSentinel(temporary, p);
      } catch (error) {
        for (const candidate of [temporary, p]) {
          try {
            fs.unlinkSync(candidate);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
              // Keep the original publication failure as the useful cause.
            }
          }
        }
        throw error;
      }
      active.set(channelId, p);
    },
    adopt(channelId, filePath) {
      if (!channelId || !filePath) return;
      // Unlike newFilePath, an adopted path is caller-supplied (arbitrary) —
      // guarantee its dir exists too, same as every other path-minting site.
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      fs.chmodSync(path.dirname(filePath), 0o700);
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600);
      active.set(channelId, filePath);
    },
    flush(channelId) {
      // append/rotate use appendFileSync/mkdirSync — already durable per call.
      // This seam exists so /restart and graceful shutdown have an explicit
      // sync point without reaching into fs. fsync the active file's fd to be
      // thorough: open, fsync, close.
      if (!channelId) return;
      const p = active.get(channelId);
      if (!p) return;
      try {
        const fd = fs.openSync(p, 'r');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } catch {
        // file may not exist yet (no appends) or fsync unsupported — non-fatal
      }
    },
  };
}

/** The absolute path of the newest (by mtime, tie-broken by filename) .jsonl in
 * a single channel dir, or null if the dir has none. */
function newestJsonlInDir(dir: string): string | null {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const f of files) {
    let st: fs.Stats;
    try {
      st = fs.statSync(f);
    } catch {
      continue;
    }
    if (
      !best ||
      st.mtimeMs > best.mtime ||
      (st.mtimeMs === best.mtime && f > best.path)
    ) {
      best = { path: f, mtime: st.mtimeMs };
    }
  }
  return best ? best.path : null;
}

/** Load the NEWEST transcript file for one id. Returns null when the dir has no
 * files OR the newest file is empty (the /clear sentinel — do NOT fall through
 * to an older file). */
export interface TranscriptParseOptions {
  /** Present only at a replay boundary. null means strip every opaque block. */
  opaqueReplayIdentity?: ReplayIdentity | null;
}

export function loadMostRecentForChannel(
  sessionsRoot: string,
  channelId: string,
  options?: TranscriptParseOptions,
): LoadedTranscript | null {
  const dir = path.join(sessionsRoot, 'discord', channelId);
  const p = newestJsonlInDir(dir);
  if (!p) return null;
  const messages = parseTranscriptFile(p, options);
  if (messages.length === 0) return null;
  return { channelId, messages, path: p };
}

/** Load the single most-recent monocontext transcript for restart recovery.
 * Returns null on first boot (no discord/main/ stream yet). */
export function loadMostRecentMain(
  sessionsRoot: string,
  options?: TranscriptParseOptions,
): LoadedTranscript | null {
  return loadMostRecentForChannel(sessionsRoot, MAIN_TRANSCRIPT_ID, options);
}

function parseContextResourceDescriptors(
  raw: unknown,
): ContextResourceDescriptor[] {
  if (!Array.isArray(raw)) return [];
  const out: ContextResourceDescriptor[] = [];
  for (const value of raw.slice(0, 32)) {
    if (typeof value !== 'object' || value === null) continue;
    const item = value as Record<string, unknown>;
    if (item.kind !== 'skill' && item.kind !== 'agents') continue;
    if (
      typeof item.key !== 'string' ||
      item.key.length === 0 ||
      item.key.length > 4096 ||
      typeof item.display !== 'string' ||
      item.display.length === 0 ||
      item.display.length > 4096 ||
      typeof item.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.version)
    ) {
      continue;
    }
    if (
      item.kind === 'skill' &&
      (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item.key) ||
        item.display !== item.key)
    ) {
      continue;
    }
    if (
      item.kind === 'agents' &&
      (!path.isAbsolute(item.key) ||
        path.basename(item.key) !== 'AGENTS.md' ||
        !path.isAbsolute(item.display) ||
        path.basename(item.display) !== 'AGENTS.md')
    ) {
      continue;
    }
    out.push({
      kind: item.kind,
      key: item.key,
      display: item.display,
      version: item.version,
    });
  }
  return out;
}

/** Parse a JSONL transcript file into ChatMessage[]. Skips malformed lines. */
export function parseTranscriptFile(
  filePath: string,
  options?: TranscriptParseOptions,
): ChatMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return [];
  }
  const out: ChatMessage[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const msg = parseChatMessage(parsed, options);
    if (msg) out.push(msg);
  }
  return out;
}

/** Validate a parsed JSON value is a ChatMessage-shaped object. Returns null
 * if not. We trust our own writes but defend against truncation/corruption. */
function parseChatMessage(
  raw: unknown,
  options?: TranscriptParseOptions,
): ChatMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const role = obj.role;
  if (
    role !== 'system' &&
    role !== 'user' &&
    role !== 'assistant' &&
    role !== 'tool'
  ) {
    return null;
  }
  const content = obj.content;
  if (typeof content !== 'string') return null;
  const msg: ChatMessage = { role, content };
  if (
    typeof obj.reasoning_content === 'string' &&
    obj.reasoning_content.length > 0
  ) {
    msg.reasoning_content = obj.reasoning_content;
  }
  const provenance =
    role === 'assistant'
      ? parseGenerationProvenance(obj.provenance)
      : undefined;
  if (provenance) msg.provenance = provenance;
  const replayBoundary =
    options !== undefined && Object.hasOwn(options, 'opaqueReplayIdentity');
  const trustedOpaque =
    !replayBoundary ||
    isTrustedOpaqueReplay(provenance, options?.opaqueReplayIdentity ?? null);
  // Responses-API encrypted reasoning items: kept loosely-validated (each entry
  // an object with type 'reasoning') and otherwise verbatim — they are opaque
  // replay payloads, and over-validating here would silently break reasoning
  // continuity across a restart.
  if (trustedOpaque && Array.isArray(obj.reasoning_items)) {
    const items = obj.reasoning_items.filter(
      (r): r is ReasoningItemParam =>
        typeof r === 'object' &&
        r !== null &&
        (r as { type?: unknown }).type === 'reasoning',
    );
    if (items.length > 0) msg.reasoning_items = items;
  }
  // Anthropic thinking blocks (with signatures): loosely validated (an object
  // whose type is 'thinking' or 'redacted_thinking') and otherwise verbatim —
  // opaque, signature-validated replay payloads, so over-validating would break
  // thinking continuity across a restart.
  if (trustedOpaque && Array.isArray(obj.thinking_blocks)) {
    const blocks = obj.thinking_blocks.filter(
      (b): b is AnthropicThinkingBlock =>
        typeof b === 'object' &&
        b !== null &&
        ((b as { type?: unknown }).type === 'thinking' ||
          (b as { type?: unknown }).type === 'redacted_thinking'),
    );
    if (blocks.length > 0) msg.thinking_blocks = blocks;
  }
  if (Array.isArray(obj.tool_calls)) {
    const tool_calls: ChatMessage['tool_calls'] = [];
    for (const tc of obj.tool_calls) {
      if (typeof tc !== 'object' || tc === null) continue;
      const t = tc as Record<string, unknown>;
      const tcId = t.id;
      const tcType = t.type;
      const tcFn = t.function;
      if (typeof tcId !== 'string') continue;
      if (tcType !== 'function') continue;
      if (typeof tcFn !== 'object' || tcFn === null) continue;
      const fn = tcFn as Record<string, unknown>;
      const fnName = fn.name;
      const fnArgs = fn.arguments;
      if (typeof fnName !== 'string' || typeof fnArgs !== 'string') continue;
      tool_calls.push({
        id: tcId,
        type: 'function',
        function: { name: fnName, arguments: fnArgs },
      });
    }
    if (tool_calls.length > 0) msg.tool_calls = tool_calls;
  }
  const tcid = obj.tool_call_id;
  if (typeof tcid === 'string') msg.tool_call_id = tcid;
  // Harness-only person markers are bounded and user-role only. They drive
  // first-seen dedupe + compaction reconciliation after restart; malformed or
  // oversized transcript values are dropped rather than trusted.
  if (
    role === 'user' &&
    typeof obj.personContext === 'object' &&
    obj.personContext !== null
  ) {
    const p = obj.personContext as Record<string, unknown>;
    if (
      (p.kind === 'inbound' || p.kind === 'memory') &&
      typeof p.authorId === 'string' &&
      p.authorId.length > 0 &&
      p.authorId.length <= 256 &&
      typeof p.author === 'string' &&
      p.author.length > 0 &&
      p.author.length <= 256
    ) {
      msg.personContext = {
        kind: p.kind,
        authorId: p.authorId,
        author: p.author,
      };
    }
  }
  //: whitelist the provenance stamp and recorded sends, or they are dropped
  // silently on reload (review N6). parseChatMessage drops unlisted fields.
  if (typeof obj.channel === 'string') msg.channel = obj.channel;
  if (role === 'tool') {
    const run = parseRunMessageMetadata(obj.run);
    if (run) msg.run = run;
    const contextResources = parseContextResourceDescriptors(
      obj.contextResources,
    );
    if (contextResources.length > 0) msg.contextResources = contextResources;
  }
  if (Array.isArray(obj.sends)) {
    const sends: { channel: string; text: string }[] = [];
    for (const s of obj.sends) {
      if (typeof s !== 'object' || s === null) continue;
      const so = s as Record<string, unknown>;
      if (typeof so.channel === 'string' && typeof so.text === 'string') {
        sends.push({ channel: so.channel, text: so.text });
      }
    }
    if (sends.length > 0) msg.sends = sends;
  }
  return msg;
}
