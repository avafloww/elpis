// Unit tests for src/lib/image.ts (magic-byte image sniffing) and the
// discord.ts ingest-side content-type reconciliation it feeds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { sniffImageMediaType, sniffFileMediaType } from '../src/lib/image.js';
import { resolveAttachmentContentType } from '../src/discord/discord.js';

test('sniffImageMediaType: recognizes the four vision formats by magic bytes', () => {
  assert.equal(
    sniffImageMediaType(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
    'image/png',
  );
  assert.equal(
    sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    'image/jpeg',
  );
  assert.equal(sniffImageMediaType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(sniffImageMediaType(Buffer.from('GIF87a')), 'image/gif');
  assert.equal(
    sniffImageMediaType(
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([1, 2, 3, 4]),
        Buffer.from('WEBP'),
      ]),
    ),
    'image/webp',
  );
});

test('sniffImageMediaType: unrecognized or truncated bytes return null', () => {
  assert.equal(
    sniffImageMediaType(Buffer.from('plain text, not an image')),
    null,
  );
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), null);
  assert.equal(sniffImageMediaType(Buffer.from([0x89, 0x50])), null);
  // RIFF container that is NOT webp (e.g. a .wav) must not claim image/webp
  assert.equal(
    sniffImageMediaType(
      Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([1, 2, 3, 4]),
        Buffer.from('WAVE'),
      ]),
    ),
    null,
  );
});

test('sniffFileMediaType: reads only the head of a real file; missing file is null', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-sniff-'));
  try {
    const png = path.join(dir, 'mislabeled.webp');
    fs.writeFileSync(
      png,
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(64),
      ]),
    );
    assert.equal(await sniffFileMediaType(png), 'image/png');
    assert.equal(
      await sniffFileMediaType(path.join(dir, 'does-not-exist.png')),
      null,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveAttachmentContentType: corrects only within images', () => {
  // the incident shape: declared webp, PNG bytes
  assert.equal(
    resolveAttachmentContentType('image/webp', 'image/png'),
    'image/png',
  );
  // agreement passes through
  assert.equal(
    resolveAttachmentContentType('image/png', 'image/png'),
    'image/png',
  );
  // unrecognized bytes keep the declared type
  assert.equal(resolveAttachmentContentType('image/webp', null), 'image/webp');
  // non-image declared types are never touched (inline-text policy unchanged)
  assert.equal(
    resolveAttachmentContentType('text/plain', 'image/png'),
    'text/plain',
  );
  assert.equal(resolveAttachmentContentType(null, 'image/png'), null);
});
