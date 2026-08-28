import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CONSOLE_MEDIA_MAX_BYTES,
  createConsoleMediaReader,
} from '../src/console/media.js';
import { custodyWatchFrames } from '../src/console/watch-custody.js';

test('console media reader returns exact bytes, type, length, and digest', async (t) => {
  const root = fs.mkdtempSync('/tmp/elpis-media-reader-');
  const attachments = path.join(root, 'attachments');
  const avatar = path.join(root, 'avatar.webp');
  fs.mkdirSync(path.join(attachments, 'message-1'), { recursive: true });
  const bytes = Buffer.from('bounded media bytes');
  fs.writeFileSync(path.join(attachments, 'message-1', 'note.txt'), bytes);
  fs.writeFileSync(avatar, bytes);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const reader = createConsoleMediaReader({
    dataDirectory: root,
    attachmentDirectory: attachments,
    avatarPath: avatar,
  });
  const result = await reader.read('/attachments/message-1/note.txt');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.bytes, bytes);
  assert.equal(result.mediaType, 'text/plain; charset=utf-8');
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));

  const identity = await reader.read('/identity/avatar');
  assert.equal(identity.ok, true);
  if (identity.ok) {
    assert.equal(identity.mediaType, 'image/webp');
    assert.deepEqual(identity.bytes, bytes);
  }
});

test('console media reader rejects unsafe paths, symlink escape, and unsupported frames', async (t) => {
  const root = fs.mkdtempSync('/tmp/elpis-media-safety-');
  const attachments = path.join(root, 'attachments');
  fs.mkdirSync(path.join(attachments, 'message-1'), { recursive: true });
  fs.symlinkSync(
    '/etc/passwd',
    path.join(attachments, 'message-1', 'escape.txt'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reader = createConsoleMediaReader({
    dataDirectory: root,
    attachmentDirectory: attachments,
  });

  for (const route of [
    '/attachments/../etc/passwd',
    '/attachments/message-1/%2e%2e/secret',
    '/attachments/message-1/file.txt%3Fraw',
    '/frames/computer/trace.json',
    '/frames/unknown/frame.png',
    '/frames/watch/guess.png',
  ]) {
    const result = await reader.read(route);
    assert.deepEqual(result, { ok: false, reason: 'invalid_route' }, route);
  }
  assert.deepEqual(await reader.read('/attachments/message-1/escape.txt'), {
    ok: false,
    reason: 'not_found',
  });
});

test('console media reader enforces the shared media byte bound before reading', async (t) => {
  const root = fs.mkdtempSync('/tmp/elpis-media-size-');
  const attachments = path.join(root, 'attachments');
  const dir = path.join(attachments, 'message-1');
  fs.mkdirSync(dir, { recursive: true });
  const large = path.join(dir, 'large.bin');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, CONSOLE_MEDIA_MAX_BYTES + 1);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const reader = createConsoleMediaReader({
    dataDirectory: root,
    attachmentDirectory: attachments,
  });
  assert.deepEqual(await reader.read('/attachments/message-1/large.bin'), {
    ok: false,
    reason: 'too_large',
  });
});

test('watch media remains restricted to custodied UUID image capabilities', async (t) => {
  const root = fs.mkdtempSync('/tmp/elpis-media-watch-');
  const source = path.join(root, 'source.png');
  fs.writeFileSync(
    source,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    ),
  );
  const [custodied] = custodyWatchFrames([source], root);
  assert.ok(custodied);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const reader = createConsoleMediaReader({ dataDirectory: root });
  const result = await reader.read(
    `/frames/watch/${path.basename(custodied.localPath)}`,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.bytes, fs.readFileSync(source));
});
