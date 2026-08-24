// Bounded custody for images explicitly handed to elpis.watch.
//
// Watch callers may point at arbitrary private files because the sandbox itself
// can read them. The console must not turn that path into a general filesystem
// route. Instead, accepted image bytes are copied into this dedicated, bounded
// root under an unguessable name. /frames/watch serves only this root.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveDataLayout } from '../store/data-layout.js';
import { sniffImageMediaType } from '../lib/image.js';

export const WATCH_FRAME_MAX_BYTES = 10 * 1024 * 1024;
export const WATCH_FRAME_MAX_COUNT = 16;
export const WATCH_CUSTODY_MAX_BYTES = 256 * 1024 * 1024;
export const WATCH_CUSTODY_MAX_FILES = 256;

const SOURCE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface CustodiedWatchFrame {
  name: string;
  contentType: string;
  localPath: string;
  size: number;
}

export function watchCustodyRoot(dataDirectory: string): string {
  return path.join(resolveDataLayout(dataDirectory).root, 'watch-frames');
}

function safeDisplayName(source: string, extension: string): string {
  const stem = path
    .basename(source, path.extname(source))
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 100);
  return `${stem || 'frame'}${extension}`;
}

function ensureCustodyRoot(dataDirectory: string): string | null {
  const root = watchCustodyRoot(dataDirectory);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    // Never follow a substituted custody-root symlink.
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    fs.chmodSync(root, 0o700);
    return root;
  } catch {
    return null;
  }
}

type ExistingFrame = { file: string; size: number; mtimeMs: number };

function existingFrames(root: string): ExistingFrame[] {
  const frames: ExistingFrame[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return frames;
  }
  for (const name of names) {
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file);
      // Symlinks and directories neither count as custody nor become deletion
      // traversal gadgets. The serving side independently realpath-confines.
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      frames.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      /* raced with cleanup */
    }
  }
  return frames.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

function makeRoom(root: string, incomingBytes: number): boolean {
  const frames = existingFrames(root);
  let total = frames.reduce((sum, frame) => sum + frame.size, 0);
  while (
    frames.length > 0 &&
    (frames.length >= WATCH_CUSTODY_MAX_FILES ||
      total + incomingBytes > WATCH_CUSTODY_MAX_BYTES)
  ) {
    const oldest = frames.shift()!;
    try {
      fs.unlinkSync(oldest.file);
      total -= oldest.size;
    } catch {
      // Conservatively keep accounting bytes when deletion raced or failed.
    }
  }
  return (
    frames.length < WATCH_CUSTODY_MAX_FILES &&
    total + incomingBytes <= WATCH_CUSTODY_MAX_BYTES
  );
}

function readAcceptedImage(source: string): {
  bytes: Buffer;
  contentType: string;
  extension: string;
} | null {
  if (!SOURCE_EXTENSIONS.has(path.extname(source).toLowerCase())) return null;
  let fd: number | null = null;
  try {
    const pathStat = fs.lstatSync(source);
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) return null;
    // O_NOFOLLOW makes an explicitly supplied symlink fail instead of silently
    // expanding console custody to its target. fstat/read through one fd avoids
    // a check-then-open path replacement race.
    fd = fs.openSync(
      source,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > WATCH_FRAME_MAX_BYTES
    )
      return null;
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.size !== before.size || bytes.length !== before.size) return null;
    const contentType = sniffImageMediaType(bytes);
    const extension = contentType ? MEDIA_EXTENSIONS[contentType] : undefined;
    if (!contentType || !extension) return null;
    return { bytes, contentType, extension };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed/unavailable */
      }
    }
  }
}

/** Copy at most WATCH_FRAME_MAX_COUNT validated images into bounded custody.
 * Invalid, oversized, symlinked, and unreadable inputs are skipped. */
export function custodyWatchFrames(
  paths: string[],
  dataDirectory: string,
): CustodiedWatchFrame[] {
  const root = ensureCustodyRoot(dataDirectory);
  if (!root) return [];
  const accepted: CustodiedWatchFrame[] = [];
  for (const source of paths.slice(0, WATCH_FRAME_MAX_COUNT)) {
    if (typeof source !== 'string') continue;
    const image = readAcceptedImage(source);
    if (!image || !makeRoom(root, image.bytes.length)) continue;
    const localPath = path.join(root, `${randomUUID()}${image.extension}`);
    let fd: number | null = null;
    try {
      fd = fs.openSync(
        localPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600,
      );
      fs.writeFileSync(fd, image.bytes);
      fs.closeSync(fd);
      fd = null;
      accepted.push({
        name: safeDisplayName(source, image.extension),
        contentType: image.contentType,
        localPath,
        size: image.bytes.length,
      });
    } catch {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
      try {
        fs.unlinkSync(localPath);
      } catch {
        /* no partial destination */
      }
    }
  }
  return accepted;
}
