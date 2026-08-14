// emotes.ts — the custom emote/sticker registry: first-use-per-context-window
// image attachment, so the agent can SEE a custom emote/sticker instead of
// guessing its meaning from `<:name:id>` markup or (for stickers) nothing at
// all. Custom emotes carry social cues that are often ambiguous or outright
// misleading by name alone; the image disambiguates.
//
// Contract:
// - `collect(input)` is called once per inbound Discord message at the single
// ingest point (discord.ts MessageCreate). It parses custom-emote markup out
// of the message content (`<:name:id>` / `<a:name:id>` — animated) plus the
// message's sticker metadata, and for each one NOT yet seen in the current
// context window returns ordinary InboundMessageAttachment entries pointing
// at downloaded image files. Those entries then ride the existing pipeline
// untouched: envelope `attachment#N:` metadata lines + base64 image_url
// content parts (agent.ts buildImageContentParts) + the console's
// /attachments/ route (the cache lives under ATTACHMENT_DIR).
// - "Seen" is an in-memory set scoped to the CONTEXT WINDOW, not the process:
// the Agent calls `resetSeen` at clearContext and at compaction-apply
// (the two boundaries past which a previously attached image is no longer
// visible to the model). A restart resets it implicitly — correct, because
// contentParts are not restored from the transcript on boot either.
// - Downloaded files are a plain disk cache keyed by emote/sticker id
// (ATTACHMENT_DIR/emotes/<id>/ + a small attach.json manifest), reused across
// seen-resets within a boot; /tmp clears it on reboot.
// - Animated emotes/stickers get `keyframes` evenly spaced PNG frames (first
// and last inclusive) extracted via ffmpeg, so the model can comprehend the
// motion, not just frame 1. ffmpeg missing or failing degrades to attaching
// the original file as a single static image (its first frame renders).
// Lottie stickers (vector JSON, no rasterizer here) degrade to a name-only
// metadata entry — the agent at least sees WHICH sticker was sent.
// - Attachment names carry the emote/sticker name AND id
// (`emote-blobwave-123456789-frame2of4.png`) so the model can correlate the
// image with the literal `<a:blobwave:123456789>` markup in the message text
// (custom-emote markup deliberately passes through resolveMentions raw).
// - Every failure path is a warn + skip, and collect races a ~3s soft
// deadline — emote enrichment must never drop the message or stall ingest
// (a long await in the MessageCreate handler lets a later message from
// another room enqueue first and steal the wake). A failed OR timed-out
// emote is NOT marked seen, so the next use retries/attaches; a timeout's
// download keeps running in the background to prime the cache.

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { ATTACHMENT_DIR } from '../types.js';
import type { InboundMessageAttachment } from '../lib/envelope.js';
import type { Logger } from '../lib/log.js';

/** Discord custom-emote markup: `<:name:id>` (static) / `<a:name:id>` (animated).
 * Emote names are [A-Za-z0-9_]{2,32} per Discord, so the capture is filesystem-safe
 * as-is. Exported for tests. */
export const EMOTE_MARKUP_RE = /<(a?):(\w{2,64}):(\d{6,32})>/g;

export interface EmoteRef {
  kind: 'emote';
  id: string;
  name: string;
  animated: boolean;
}

/** Sticker format, mapped from discord.js's StickerFormatType enum at the call
 * site (1=png, 2=apng, 3=lottie, 4=gif) so this module never imports discord.js. */
export type StickerFormat = 'png' | 'apng' | 'lottie' | 'gif';

export interface StickerRef {
  kind: 'sticker';
  id: string;
  name: string;
  format: StickerFormat;
}

export type EmoteOrStickerRef = EmoteRef | StickerRef;

/** Structural input — discord.ts maps the discord.js Message onto this shape so
 * the module stays dependency-free and unit-testable. */
export interface EmoteCollectInput {
  content: string;
  stickers?: { id: string; name: string; format: number }[];
}

/** Parse the unique custom emotes out of a message body, in first-use order.
 * Pure; exported for tests. */
export function parseCustomEmotes(content: string): EmoteRef[] {
  const out: EmoteRef[] = [];
  const seen = new Set<string>();
  for (const m of content.matchAll(EMOTE_MARKUP_RE)) {
    const [, a, name, id] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ kind: 'emote', id, name, animated: a === 'a' });
  }
  return out;
}

/** Map discord.js StickerFormatType numbers onto our format union. Unknown
 * numbers → null (skip: a future format is better ignored than mis-fetched).
 * Pure; exported for tests. */
export function stickerFormatOf(format: number): StickerFormat | null {
  switch (format) {
    case 1: return 'png';
    case 2: return 'apng';
    case 3: return 'lottie';
    case 4: return 'gif';
    default: return null;
  }
}

/** CDN download URL for a ref. GIF stickers are served from media.discordapp.net
 * (cdn.discordapp.com serves them only as static PNG); everything else lives on
 * the CDN host. The `size=96` on emotes keeps the per-image context cost small —
 * an emote is 32px in chat; 96px is plenty for comprehension. Pure; for tests. */
export function emoteCdnUrl(ref: EmoteOrStickerRef): string {
  if (ref.kind === 'emote') {
    const ext = ref.animated ? 'gif' : 'png';
    return `https://cdn.discordapp.com/emojis/${ref.id}.${ext}?size=96&quality=lossless`;
  }
  switch (ref.format) {
    case 'gif': return `https://media.discordapp.net/stickers/${ref.id}.gif`;
    case 'lottie': return `https://cdn.discordapp.com/stickers/${ref.id}.json`;
    default: return `https://cdn.discordapp.com/stickers/${ref.id}.png`;
  }
}

/** Whether a ref needs keyframe extraction (a real animation we can decode). */
export function isAnimated(ref: EmoteOrStickerRef): boolean {
  if (ref.kind === 'emote') return ref.animated;
  return ref.format === 'apng' || ref.format === 'gif';
}

/** The seen-set key — emotes and stickers share the id namespace on Discord's
 * side in theory but not by contract, so prefix by kind. Pure; for tests. */
export function refKey(ref: EmoteOrStickerRef): string {
  return `${ref.kind === 'emote' ? 'e' : 's'}:${ref.id}`;
}

/** Filesystem-safe display slug for a sticker/emote name (sticker names are
 * arbitrary user text; emote names are already word-safe). */
export function safeNameSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || 'unnamed';
}

/** Attachment display/file name for one attached image. `frame` is 1-based when
 * the ref is animated and split into `of` keyframes. Pure; exported for tests. */
export function attachmentName(ref: EmoteOrStickerRef, opts?: { frame?: number; of?: number; ext?: string }): string {
  const base = `${ref.kind}-${safeNameSlug(ref.name)}-${ref.id}`;
  const ext = opts?.ext ?? 'png';
  if (opts?.frame !== undefined && opts?.of !== undefined && opts.of > 1) {
    return `${base}-frame${opts.frame}of${opts.of}.${ext}`;
  }
  return `${base}.${ext}`;
}

/** Pick `k` evenly spaced indices out of `n` (first and last inclusive).
 * Pure; exported for tests. */
export function pickKeyframeIndices(n: number, k: number): number[] {
  if (n <= 0) return [];
  if (k <= 1 || n === 1) return [0];
  if (n <= k) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(Math.round((i * (n - 1)) / (k - 1)));
  return [...new Set(out)];
}

/** Build the ffmpeg argv for exploding an animation into per-frame PNGs.
 * `-f apng` is forced for APNG stickers — without it ffmpeg probes the file as
 * a plain PNG and decodes exactly one frame. Frames are downscaled to ≤160px
 * wide (stickers are 320px; emotes are already ≤96) to bound the base64 cost
 * of a keyframe batch. Pure; exported for tests. */
export function ffmpegExtractArgs(inputPath: string, outPattern: string, format: 'apng' | null): string[] {
  return [
    '-v', 'error', '-y',
    ...(format === 'apng' ? ['-f', 'apng'] : []),
    '-i', inputPath,
    '-vf', 'scale=w=min(iw\\,160):h=-2',
    '-fps_mode', 'passthrough',
    '-frames:v', '300',
    outPattern,
  ];
}

const DOWNLOAD_MAX_BYTES = 8 * 1024 * 1024; // an emote/sticker larger than this is not an emote
const MAX_NEW_PER_MESSAGE = 4;              // bound the image cost of an emote-spam message
const MAX_KEYFRAMES = 8;                    // clamp for discord.emote_keyframes (bounds images-per-ref)
const FFMPEG_TIMEOUT_MS = 15_000;
/** Soft deadline for collect(): ingest never waits longer than this for a
 * first-use download/extract — see the comment inside collect. */
const COLLECT_DEADLINE_MS = 3_000;

interface ManifestEntry { name: string; file: string; contentType: string; size: number }
interface Manifest { entries: ManifestEntry[] }

export interface EmoteRegistry {
  /** Detect + enrich: returns attachment entries for first-use emotes/stickers. */
  collect(input: EmoteCollectInput): Promise<InboundMessageAttachment[]>;
  /** Forget what has been attached — called at every context-window boundary
 * (clear, compaction-apply). Cached files on disk are kept and reused. */
  resetSeen(): void;
  /** Test/diagnostic accessor. */
  seenCountForTest(): number;
}

export function createEmoteRegistry(opts: {
  log: Logger;
  keyframes: number;
  /** Cache root override for tests; defaults to ATTACHMENT_DIR/emotes. */
  cacheDir?: string;
  /** fetch override for tests. */
  fetchFn?: typeof fetch;
  /** collect() soft-deadline override for tests; defaults to COLLECT_DEADLINE_MS. */
  collectDeadlineMs?: number;
}): EmoteRegistry {
  const { log } = opts;
  const keyframes = Math.min(MAX_KEYFRAMES, Math.max(1, Math.floor(opts.keyframes)));
  const deadlineMs = opts.collectDeadlineMs ?? COLLECT_DEADLINE_MS;
  const cacheRoot = opts.cacheDir ?? path.join(ATTACHMENT_DIR, 'emotes');
  const fetchFn = opts.fetchFn ?? fetch;
  const seen = new Set<string>();
 // Coalesce concurrent first-uses of the same emote (two rooms at once) onto
 // one download/extract; both messages then attach the same files.
  const inflight = new Map<string, Promise<ManifestEntry[] | null>>();

  function dirFor(ref: EmoteOrStickerRef): string {
    return path.join(cacheRoot, `${ref.kind}-${ref.id}`);
  }

  async function readManifest(dir: string): Promise<ManifestEntry[] | null> {
    try {
      const m = JSON.parse(await fs.promises.readFile(path.join(dir, 'attach.json'), 'utf8')) as Manifest;
      if (!Array.isArray(m.entries) || m.entries.length === 0) return null;
      for (const e of m.entries) await fs.promises.access(path.join(dir, e.file));
      return m.entries;
    } catch {
      return null;
    }
  }

  async function writeManifest(dir: string, entries: ManifestEntry[]): Promise<void> {
    await fs.promises.writeFile(path.join(dir, 'attach.json'), JSON.stringify({ entries } satisfies Manifest));
  }

  async function download(url: string, dest: string): Promise<number> {
    const res = await fetchFn(url, {
      headers: { 'User-Agent': 'elpis/0.1' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > DOWNLOAD_MAX_BYTES) throw new Error(`${buf.byteLength} bytes exceeds cap`);
    await fs.promises.writeFile(dest, buf);
    return buf.byteLength;
  }

  function runFfmpeg(args: string[]): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += String(d); });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, FFMPEG_TIMEOUT_MS);
 // ENOENT (ffmpeg not installed) → soft 127, same idiom as ssh.ts.
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, stderr: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr }); });
    });
  }

  /** Explode `origPath` into keyframes inside `dir`; returns manifest entries,
 * or null when extraction produced nothing usable (caller falls back to the
 * static original). */
  async function extractKeyframes(ref: EmoteOrStickerRef, dir: string, origPath: string): Promise<ManifestEntry[] | null> {
    const framesDir = path.join(dir, 'frames');
    await fs.promises.rm(framesDir, { recursive: true, force: true });
    await fs.promises.mkdir(framesDir, { recursive: true });
    const apng = ref.kind === 'sticker' && ref.format === 'apng' ? 'apng' as const : null;
    const { code, stderr } = await runFfmpeg(ffmpegExtractArgs(origPath, path.join(framesDir, 'f-%03d.png'), apng));
    const produced = (await fs.promises.readdir(framesDir)).filter((f) => f.startsWith('f-')).sort();
    if (code !== 0 || produced.length === 0) {
      log.warn(`emotes: ffmpeg extract failed for ${refKey(ref)} (code ${code}): ${stderr.slice(0, 200)}`);
      await fs.promises.rm(framesDir, { recursive: true, force: true });
      return null;
    }
    const picked = pickKeyframeIndices(produced.length, keyframes);
    const entries: ManifestEntry[] = [];
    for (let i = 0; i < picked.length; i++) {
      const name = attachmentName(ref, { frame: i + 1, of: picked.length });
      const dest = path.join(dir, name);
      await fs.promises.copyFile(path.join(framesDir, produced[picked[i]]), dest);
      const size = (await fs.promises.stat(dest)).size;
      entries.push({ name, file: name, contentType: 'image/png', size });
    }
    await fs.promises.rm(framesDir, { recursive: true, force: true });
    return entries;
  }

  /** Ensure the cache dir for `ref` holds attachable files; returns manifest
 * entries or null on failure (failure is NOT cached — next use retries). */
  async function ensureFiles(ref: EmoteOrStickerRef): Promise<ManifestEntry[] | null> {
    const dir = dirFor(ref);
    const cached = await readManifest(dir);
    if (cached) return cached;
    await fs.promises.mkdir(dir, { recursive: true });

 // Lottie: vector JSON, no rasterizer available — surface name/id only.
    if (ref.kind === 'sticker' && ref.format === 'lottie') {
      const entries: ManifestEntry[] = [{ name: attachmentName(ref, { ext: 'json' }), file: '', contentType: 'application/json', size: 0 }];
      await writeManifest(dir, entries);
      return entries;
    }

    const ext = ref.kind === 'emote' ? (ref.animated ? 'gif' : 'png')
      : ref.format === 'gif' ? 'gif' : 'png';
    const origPath = path.join(dir, `orig.${ext}`);
    let size: number;
    try {
      size = await download(emoteCdnUrl(ref), origPath);
    } catch (e) {
      log.warn(`emotes: download failed for ${refKey(ref)} (${ref.name}): ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }

 // Always extract for an animated input, even at keyframes=1: the single
 // frame is then a downscaled PNG rather than the raw (possibly multi-MB)
 // GIF/APNG — `1` genuinely means "one static frame", as documented.
    if (isAnimated(ref)) {
      const frames = await extractKeyframes(ref, dir, origPath);
      if (frames) {
        await writeManifest(dir, frames);
        return frames;
      }
 // fall through: attach the original as a single static image (frame 1 renders)
    }

    const name = attachmentName(ref, { ext });
    const dest = path.join(dir, name);
    await fs.promises.copyFile(origPath, dest);
    const entries: ManifestEntry[] = [{ name, file: name, contentType: ext === 'gif' ? 'image/gif' : 'image/png', size }];
    await writeManifest(dir, entries);
    return entries;
  }

  function toAttachments(ref: EmoteOrStickerRef, entries: ManifestEntry[]): InboundMessageAttachment[] {
    const dir = dirFor(ref);
    return entries.map((e) => ({
      url: emoteCdnUrl(ref),
      name: e.name,
      contentType: e.contentType,
      localPath: e.file ? path.join(dir, e.file) : null,
      size: e.size,
    }));
  }

  return {
    async collect(input: EmoteCollectInput): Promise<InboundMessageAttachment[]> {
      const refs: EmoteOrStickerRef[] = [
        ...parseCustomEmotes(input.content ?? ''),
        ...(input.stickers ?? []).flatMap((s): StickerRef[] => {
          const format = stickerFormatOf(s.format);
          return format ? [{ kind: 'sticker', id: s.id, name: s.name, format }] : [];
        }),
      ];
      const fresh = refs.filter((r) => !seen.has(refKey(r)));
      if (fresh.length === 0) return [];
      const capped = fresh.slice(0, MAX_NEW_PER_MESSAGE);
      if (capped.length < fresh.length) {
        log.warn(`emotes: ${fresh.length - capped.length} first-use emote(s) beyond the per-message cap of ${MAX_NEW_PER_MESSAGE} deferred to next use`);
      }
 // Refs resolve CONCURRENTLY (same reasoning as buildInboundAttachments'
 // parallel downloads), each racing a shared soft deadline: ingest must
 // never stall on a slow CDN or a wedged ffmpeg — MessageCreate handlers
 // interleave at every await, so a long block here would let a LATER
 // message from another room enqueue first and steal the wake (history
 // order + turn provenance skew). On timeout the message goes through
 // WITHOUT the image and the ref is NOT marked seen; the in-flight
 // download keeps running and primes the disk cache, so the emote's next
 // use attaches instantly.
      const deadlineAt = Date.now() + deadlineMs;
      const results = await Promise.all(capped.map(async (ref) => {
        const key = refKey(ref);
        let p = inflight.get(key);
        if (!p) {
 // Made never-rejecting HERE, at creation: the try/await below handles
 // the awaited copy, but the `.finally`-derived cleanup promise is
 // unobserved — a rejecting ensureFiles would escape it as a process
 // unhandledRejection (→ operator error channel) for a failure this
 // module promises to swallow.
          p = ensureFiles(ref).then(
            (r) => r,
            (e) => { log.warn(`emotes: ensure failed for ${key} (${ref.name}): ${e instanceof Error ? e.message : String(e)}`); return null; },
          );
          inflight.set(key, p);
          void p.finally(() => inflight.delete(key));
        }
        let timer: NodeJS.Timeout | undefined;
        const entries = await Promise.race([
          p,
          new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), Math.max(0, deadlineAt - Date.now())); }),
        ]);
        clearTimeout(timer);
        if (entries === 'timeout') {
          log.info(`emotes: ${key} (${ref.name}) not ready within ${deadlineMs}ms — cache priming continues, attaches on next use`);
          return [];
        }
        if (!entries) return []; // failed — not marked seen, next use retries
        seen.add(key);
        log.info(`emotes: attached first-use ${key} (${ref.name}) x${entries.length}`);
        return toAttachments(ref, entries);
      }));
      return results.flat();
    },
    resetSeen(): void {
      seen.clear();
    },
    seenCountForTest(): number {
      return seen.size;
    },
  };
}
