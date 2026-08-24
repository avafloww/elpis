import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  custodyWatchFrames,
  watchCustodyRoot,
  WATCH_FRAME_MAX_BYTES,
  WATCH_FRAME_MAX_COUNT,
} from '../src/console/watch-custody.js';
import { frameUrlFromLocalPath } from '../src/console/hub.js';
import { resolveFramePath } from '../src/console/server.js';

const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function tempRoots(): {
  data: string;
  privateDir: string;
  cleanup: () => void;
} {
  const base = fs.mkdtempSync('/tmp/elpis-watch-custody-');
  const data = path.join(base, 'home');
  const privateDir = path.join(base, 'private-acceptance');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  return {
    data,
    privateDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('explicit private watch image is copied into routeable bounded custody', (t) => {
  const roots = tempRoots();
  t.after(roots.cleanup);
  const source = path.join(roots.privateDir, 'acceptance frame.png');
  fs.writeFileSync(source, PIXEL);

  const [frame] = custodyWatchFrames([source], roots.data);
  assert.ok(frame);
  assert.equal(frame.contentType, 'image/png');
  assert.equal(frame.name, 'acceptance_frame.png');
  assert.equal(frame.size, PIXEL.length);
  assert.notEqual(frame.localPath, source);
  assert.equal(path.dirname(frame.localPath), watchCustodyRoot(roots.data));
  assert.equal(fs.statSync(frame.localPath).mode & 0o777, 0o600);

  // Custody owns bytes independently of a short-lived acceptance artifact.
  fs.unlinkSync(source);
  assert.deepEqual(fs.readFileSync(frame.localPath), PIXEL);
  const url = frameUrlFromLocalPath(frame.localPath);
  assert.match(url ?? '', /^\/frames\/watch\/[0-9a-f-]+\.png$/);
  assert.equal(resolveFramePath(url!, roots.data), frame.localPath);
});

test('watch custody rejects symlinks, fake/unsupported images, and oversized files', (t) => {
  const roots = tempRoots();
  t.after(roots.cleanup);
  const image = path.join(roots.privateDir, 'real.png');
  const symlink = path.join(roots.privateDir, 'alias.png');
  const fake = path.join(roots.privateDir, 'fake.png');
  const unsupported = path.join(roots.privateDir, 'real.txt');
  const oversized = path.join(roots.privateDir, 'oversized.png');
  fs.writeFileSync(image, PIXEL);
  fs.symlinkSync(image, symlink);
  fs.writeFileSync(fake, '<script>not an image</script>');
  fs.writeFileSync(unsupported, PIXEL);
  fs.closeSync(fs.openSync(oversized, 'w'));
  fs.truncateSync(oversized, WATCH_FRAME_MAX_BYTES + 1);

  assert.deepEqual(
    custodyWatchFrames([symlink, fake, unsupported, oversized], roots.data),
    [],
  );
});

test('one watch custody handoff has a hard frame-count bound', (t) => {
  const roots = tempRoots();
  t.after(roots.cleanup);
  const paths = Array.from(
    { length: WATCH_FRAME_MAX_COUNT + 3 },
    (_, index) => {
      const file = path.join(roots.privateDir, `frame-${index}.png`);
      fs.writeFileSync(file, PIXEL);
      return file;
    },
  );
  assert.equal(
    custodyWatchFrames(paths, roots.data).length,
    WATCH_FRAME_MAX_COUNT,
  );
});

test('watch frame URL rejects traversal outside custody', () => {
  assert.equal(
    resolveFramePath('/frames/watch/../SOUL.png', '/tmp/elpis-home'),
    null,
  );
  assert.equal(
    resolveFramePath('/frames/watch/frame.svg', '/tmp/elpis-home'),
    null,
  );
  assert.equal(
    resolveFramePath('/frames/watch/guess.png', '/tmp/elpis-home'),
    null,
  );
  assert.equal(
    frameUrlFromLocalPath('/tmp/elpis-data/watch-frames/guess.png'),
    null,
  );
});
