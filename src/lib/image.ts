// Magic-byte image-type sniffing, shared by Discord ingest (correcting an
// attachment's declared content type before the envelope renders it) and
// buildImageContentParts in agent.ts (labeling the base64 payload). The
// declared `content_type` on a Discord attachment is uploader-side metadata
// and is sometimes wrong — a Bluesky image reshared on Discord
// arrived stamped `image/webp` with PNG bytes, and Anthropic validates the
// payload against the label, so every request 400'd for as long as the
// message stayed in context. The bytes are the truth; the label is a claim.

import * as fs from 'node:fs';

/** Sniff an image buffer's real media type from its magic bytes. Recognizes
 * the vision formats (PNG/JPEG/GIF/WEBP); null = unrecognized (callers fall
 * back to the declared type). Pure; exported for tests. */
export function sniffImageMediaType(buf: Buffer): string | null {
  if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  )
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'image/jpeg';
  if (buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'GIF8')
    return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

/** Sniff a file on disk by reading only its first 12 bytes (enough for every
 * signature above — never loads the whole image). Returns null on any read
 * failure; sniffing is advisory, never load-bearing. */
export async function sniffFileMediaType(
  localPath: string,
): Promise<string | null> {
  try {
    const fh = await fs.promises.open(localPath, 'r');
    try {
      const buf = Buffer.alloc(12);
      const { bytesRead } = await fh.read(buf, 0, 12, 0);
      return sniffImageMediaType(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
