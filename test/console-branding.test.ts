import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '../src/console/public');

function sha(file: string): string { return crypto.createHash('sha256').update(fs.readFileSync(path.join(publicDir, file))).digest('hex'); }

test('Console brand uses the supplied immutable light/dark SVG variants', () => {
  assert.equal(sha('elpis-logo-light.svg'), 'f6eb1d5aacdca72d58c456d1c61ab810772d7349dec2dee349898ec9c84f0c32');
  assert.equal(sha('elpis-logo-dark.svg'), '75b912107fe0e827d9bbc7dbabb50e32bdc8013ba51672e0e35efcf0a11a00f0');
  assert.equal(sha('elpis-icon-light.svg'), 'e0095125d542ede62a99c913630c0898457521b2428a0f1ba87ec8ddc3a2bb08');
  assert.equal(sha('elpis-icon-dark.svg'), 'ae116f3d33c0af06beac5b7b7b8cc6941d6204a52900f2a7c31518250cba696c');
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
});
