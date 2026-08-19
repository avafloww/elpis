import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '../src/console/public');

function sha(file: string): string { return crypto.createHash('sha256').update(fs.readFileSync(path.join(publicDir, file))).digest('hex'); }

function pngMetadata(file: string): { width: number; height: number; colorType: number } {
  const png = fs.readFileSync(path.join(publicDir, file));
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] };
}

test('Console brand uses the supplied immutable light/dark SVG variants', () => {
  assert.equal(sha('elpis-logo-light.svg'), 'f6eb1d5aacdca72d58c456d1c61ab810772d7349dec2dee349898ec9c84f0c32');
  assert.equal(sha('elpis-logo-dark.svg'), '75b912107fe0e827d9bbc7dbabb50e32bdc8013ba51672e0e35efcf0a11a00f0');
  assert.equal(sha('elpis-icon-light.svg'), 'e0095125d542ede62a99c913630c0898457521b2428a0f1ba87ec8ddc3a2bb08');
  assert.equal(sha('elpis-icon-dark.svg'), 'ae116f3d33c0af06beac5b7b7b8cc6941d6204a52900f2a7c31518250cba696c');
});

test('Console PWA metadata uses opaque authored icons without a private-data service worker', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(publicDir, 'elpis-branding.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));

  assert.deepEqual(manifest, {
    id: './',
    name: 'Elpis Harness Console',
    short_name: 'Elpis',
    description: 'Private operator console for one persistent Elpis agent.',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#141320',
    theme_color: '#141320',
    icons: [
      { src: './elpis-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: './elpis-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: './elpis-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    categories: ['utilities', 'developer'],
    prefer_related_applications: false,
  });
  assert.deepEqual(pngMetadata('apple-touch-icon.png'), { width: 180, height: 180, colorType: 2 });
  assert.deepEqual(pngMetadata('elpis-icon-192.png'), { width: 192, height: 192, colorType: 2 });
  assert.deepEqual(pngMetadata('elpis-icon-512.png'), { width: 512, height: 512, colorType: 2 });
  assert.deepEqual(pngMetadata('elpis-icon-maskable-512.png'), { width: 512, height: 512, colorType: 2 });
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /data-elpis-theme-color content="#e7ece4"/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  assert.match(html, /apple-mobile-web-app-title" content="Elpis"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\.\/apple-touch-icon\.png"/);
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.match(js, /nextThemeColor = theme === 'dark' \? '#141320' : '#e7ece4'/);
  assert.match(js, /themeColor\.content = nextThemeColor/);
  assert.match(css, /height: calc\(52px \+ env\(safe-area-inset-top\)\)/);
  assert.match(css, /padding-bottom: env\(safe-area-inset-bottom\)/);
  assert.doesNotMatch(html + js, /serviceWorker/);
  assert.equal(fs.existsSync(path.join(publicDir, 'service-worker.js')), false);
});

test('Console brand is accessible and follows the manual data-theme toggle', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
  const js = fs.readFileSync(path.join(publicDir, 'elpis-branding.js'), 'utf8');
  assert.match(html, /data-elpis-favicon[\s\S]*elpis-icon-light\.svg/);
  assert.match(html, /class="ep-brand" role="img" aria-label="Elpis harness console"/);
  assert.match(html, /ep-brand-logo-light[\s\S]*ep-brand-logo-dark/);
  assert.doesNotMatch(html, /ep-brand-sub/, 'visible harness-console subtitle stays removed');
  assert.match(html, /src="\.\/elpis-branding\.js" defer/);
  assert.match(css, /data-theme="dark"\] \.ep-brand-logo-light \{ display: none; \}/);
  assert.match(css, /data-theme="dark"\] \.ep-brand-logo-dark \{ display: block; \}/);
  assert.match(css, /\.ep-brand-logo[\s\S]*height: 42px/);
  assert.match(css, /\.ep-topbar[^\n]*padding: 0 22px 0 12px/, 'logo keeps the reduced left inset without changing the right');
  assert.match(css, /\.ep-flower-gold \{ color: var\(--gold\); \}/);
  assert.match(js, /MutationObserver[\s\S]*attributeFilter: \['data-theme'\]/);
  assert.match(js, /syncBranding/);
});
