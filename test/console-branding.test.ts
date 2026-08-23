import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '../src/console/public');
const clientDir = path.join(here, '../src/console/client');
function sha(file: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(publicDir, file)))
    .digest('hex');
}
function pngMetadata(file: string): {
  width: number;
  height: number;
  colorType: number;
} {
  const png = fs.readFileSync(path.join(publicDir, file));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    colorType: png[25],
  };
}

test('Console brand keeps the supplied immutable SVG and authored PWA icons', () => {
  assert.equal(
    sha('elpis-logo-light.svg'),
    'f6eb1d5aacdca72d58c456d1c61ab810772d7349dec2dee349898ec9c84f0c32',
  );
  assert.equal(
    sha('elpis-logo-dark.svg'),
    '75b912107fe0e827d9bbc7dbabb50e32bdc8013ba51672e0e35efcf0a11a00f0',
  );
  assert.equal(
    sha('elpis-icon-light.svg'),
    'e0095125d542ede62a99c913630c0898457521b2428a0f1ba87ec8ddc3a2bb08',
  );
  assert.equal(
    sha('elpis-icon-dark.svg'),
    'ae116f3d33c0af06beac5b7b7b8cc6941d6204a52900f2a7c31518250cba696c',
  );
  assert.deepEqual(pngMetadata('apple-touch-icon.png'), {
    width: 180,
    height: 180,
    colorType: 2,
  });
  assert.deepEqual(pngMetadata('elpis-icon-192.png'), {
    width: 192,
    height: 192,
    colorType: 2,
  });
  assert.deepEqual(pngMetadata('elpis-icon-512.png'), {
    width: 512,
    height: 512,
    colorType: 2,
  });
  assert.deepEqual(pngMetadata('elpis-icon-maskable-512.png'), {
    width: 512,
    height: 512,
    colorType: 2,
  });
});

test('Preact shell uses fixed dark v2 PWA chrome and safe-area mobile layout without private caching', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(clientDir, 'styles.css'), 'utf8');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'),
  );
  assert.equal(manifest.background_color, '#141320');
  assert.equal(manifest.theme_color, '#141320');
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /name="theme-color" content="#141320"/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(
    html,
    /apple-mobile-web-app-status-bar-style"\s+content="black-translucent"/,
  );
  assert.match(html, /rel="apple-touch-icon"/);
  assert.match(html, /rel="manifest"/);
  assert.match(html, /elpis-icon-dark\.svg/);
  assert.match(css, /height:\s*100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /--bg-app:\s*#141320/);
  assert.doesNotMatch(html + css, /serviceWorker/);
  assert.equal(fs.existsSync(path.join(publicDir, 'service-worker.js')), false);
});
