// console/media.ts — bounded transport-neutral reads for console media routes.
//
// Both the loopback HTTP server and remote transports consume this reader so
// route custody and byte limits cannot drift between transports.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDataLayout } from '../store/data-layout.js';
import { ATTACHMENT_DIR } from '../types.js';
import { watchCustodyRoot } from './watch-custody.js';

export const CONSOLE_MEDIA_MAX_BYTES = 25 * 1024 * 1024;
export const CONSOLE_MEDIA_ROUTE_MAX_BYTES = 2 * 1024;

const MEDIA_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
});

const FRAME_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
const WATCH_CAPABILITY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpe?g|gif|webp)$/i;

export interface ConsoleMedia {
  /** Exact bytes served locally or handed to another transport. */
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export type ConsoleMediaFailure = 'invalid_route' | 'not_found' | 'too_large';

export type ConsoleMediaReadResult =
  | ({ readonly ok: true } & ConsoleMedia)
  | { readonly ok: false; readonly reason: ConsoleMediaFailure };

export interface ConsoleMediaReader {
  read(route: string): Promise<ConsoleMediaReadResult>;
}

export interface ConsoleMediaReaderOptions {
  readonly dataDirectory: string;
  /** Defaults to the immutable inbound attachment cache. */
  readonly attachmentDirectory?: string;
  /** Optional image exposed as the resident identity avatar. */
  readonly avatarPath?: string | null;
}

type ResolvedMedia = {
  readonly file: string;
  readonly root: string | null;
  readonly mediaType: string;
};

function under(root: string, candidate: string): boolean {
  return candidate.startsWith(root + path.sep);
}

/** Decode and validate an origin-relative media route exactly once. */
function safeRoute(route: string): string | null {
  if (
    typeof route !== 'string' ||
    Buffer.byteLength(route, 'utf8') > CONSOLE_MEDIA_ROUTE_MAX_BYTES ||
    route.includes('?') ||
    route.includes('#') ||
    route.includes('\\')
  )
    return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    return null;
  }
  if (/^[^/]/.test(decoded) || /[\u0000-\u001f\u007f\\?#]/.test(decoded))
    return null;
  const parts = decoded.split('/').slice(1);
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    return null;
  return decoded;
}

function resolveMedia(
  route: string,
  options: Required<
    Pick<ConsoleMediaReaderOptions, 'dataDirectory' | 'attachmentDirectory'>
  > &
    Pick<ConsoleMediaReaderOptions, 'avatarPath'>,
): ResolvedMedia | null {
  const decoded = safeRoute(route);
  if (!decoded) return null;

  if (decoded === '/identity/avatar') {
    if (!options.avatarPath) return null;
    const ext = path.extname(options.avatarPath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return null;
    return {
      file: path.resolve(options.avatarPath),
      root: null,
      mediaType: MEDIA_TYPES[ext],
    };
  }

  const attachmentPrefix = '/attachments/';
  if (decoded.startsWith(attachmentPrefix)) {
    const root = path.resolve(options.attachmentDirectory);
    const file = path.resolve(root, decoded.slice(attachmentPrefix.length));
    if (!under(root, file)) return null;
    const ext = path.extname(file).toLowerCase();
    return {
      file,
      root,
      mediaType: MEDIA_TYPES[ext] ?? 'application/octet-stream',
    };
  }

  const match = decoded.match(
    /^\/frames\/(watch|computer|browser|motor)\/(.+)$/,
  );
  if (!match) return null;
  const layout = resolveDataLayout(options.dataDirectory);
  const roots = {
    watch: watchCustodyRoot(options.dataDirectory),
    computer: path.join(layout.computer, 'screenshots'),
    browser: path.join(layout.browser, 'screenshots'),
    motor: path.join(layout.motor, 'episodes'),
  } as const;
  const kind = match[1] as keyof typeof roots;
  const relative = match[2] ?? '';
  // Watch custody intentionally grants only one flat, unguessable capability.
  if (kind === 'watch' && !WATCH_CAPABILITY.test(relative)) return null;
  const root = path.resolve(roots[kind]);
  const file = path.resolve(root, relative);
  if (!under(root, file) || !FRAME_EXTENSION.test(file)) return null;
  const ext = path.extname(file).toLowerCase();
  return { file, root, mediaType: MEDIA_TYPES[ext] };
}

/** Read no more than the stat-authorized size, detecting concurrent growth. */
async function readBounded(file: string): Promise<Buffer | 'too_large' | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      file,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > CONSOLE_MEDIA_MAX_BYTES) return 'too_large';
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: grew } = await handle.read(extra, 0, 1, offset);
    if (grew !== 0) return 'too_large';
    return offset === bytes.length ? bytes : bytes.subarray(0, offset);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function createConsoleMediaReader(
  options: ConsoleMediaReaderOptions,
): ConsoleMediaReader {
  const normalized = {
    dataDirectory: path.resolve(options.dataDirectory),
    attachmentDirectory: path.resolve(
      options.attachmentDirectory ?? ATTACHMENT_DIR,
    ),
    avatarPath: options.avatarPath ?? null,
  };

  return {
    async read(route: string): Promise<ConsoleMediaReadResult> {
      let resolved = resolveMedia(route, normalized);
      if (!resolved) return { ok: false, reason: 'invalid_route' };
      // Frame and attachment roots are custody boundaries. Canonicalization
      // prevents a symlink inside either tree from turning media reads into an
      // arbitrary-file primitive. A direct avatar path is explicitly selected.
      if (resolved.root) {
        try {
          const [realRoot, realFile] = await Promise.all([
            fs.promises.realpath(resolved.root),
            fs.promises.realpath(resolved.file),
          ]);
          if (!under(realRoot, realFile))
            return { ok: false, reason: 'not_found' };
          resolved = { ...resolved, file: realFile };
        } catch {
          return { ok: false, reason: 'not_found' };
        }
      }
      const bytes = await readBounded(resolved.file);
      if (bytes === 'too_large') return { ok: false, reason: 'too_large' };
      if (!bytes) return { ok: false, reason: 'not_found' };
      return {
        ok: true,
        bytes,
        mediaType: resolved.mediaType,
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    },
  };
}

/** Pure path helpers retained for callers that need route diagnostics. */
export function resolveAttachmentPath(reqPath: string): string | null {
  const prefix = '/attachments/';
  if (!reqPath.startsWith(prefix)) return null;
  const decoded = safeRoute(reqPath);
  if (!decoded?.startsWith(prefix)) return null;
  const root = path.resolve(ATTACHMENT_DIR);
  const file = path.resolve(root, decoded.slice(prefix.length));
  return under(root, file) ? file : null;
}

export function resolveFramePath(
  reqPath: string,
  dataDirectory: string,
): string | null {
  return (
    resolveMedia(reqPath, {
      dataDirectory,
      attachmentDirectory: ATTACHMENT_DIR,
      avatarPath: null,
    })?.file ?? null
  );
}
