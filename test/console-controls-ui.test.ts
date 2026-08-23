import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { turnMessages } from '../src/console/client/components/secretary.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (file: string): string =>
  fs.readFileSync(path.join(root, file), 'utf8');

test('console source is a Preact five-view shell with one WebSocket reducer', () => {
  const main = read('src/console/client/main.tsx');
  const socket = read('src/console/client/use-console.ts');
  const html = read('src/console/public/index.html');
  assert.match(main, /Thread.*Context.*Mind.*Workers.*Secretary/s);
  assert.match(main, /useConsole\(\)/);
  assert.match(socket, /new WebSocket/);
  assert.match(socket, /t: 'control'/);
  assert.match(socket, /t: 'mind'/);
  assert.match(html, /id="app"/);
  assert.match(html, /app\.css/);
  assert.match(html, /app\.js/);
  assert.doesNotMatch(html, /unfinished operations|worker-root|secretary-root/);
});

test('build uses exact Preact and esbuild seam while retired vanilla files stay absent', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies.preact, '10.29.8');
  assert.equal(pkg.devDependencies.esbuild, '0.28.2');
  assert.match(
    pkg.scripts['build:console'],
    /tsc -p tsconfig\.console\.json.*build-console/,
  );
  for (const file of [
    'app.js',
    'styles.css',
    'scroll-follow.js',
    'run-code.js',
    'elpis-branding.js',
  ])
    assert.equal(
      fs.existsSync(path.join(root, 'src/console/public', file)),
      false,
      file,
    );
});

test('secretary turn renderer preserves ordinary request and response wire records', () => {
  assert.deepEqual(
    turnMessages({
      status: 'completed',
      request: { role: 'user', content: 'question' },
      response: { role: 'assistant', content: 'answer' },
    }),
    [
      { role: 'user', content: 'question', status: 'completed' },
      { role: 'assistant', content: 'answer', status: 'completed' },
    ],
  );
});

test('operations display bounded receipts without raw credentials or local paths', () => {
  const source = [
    'main.tsx',
    'use-console.ts',
    'components/workers.tsx',
    'components/secretary.tsx',
  ]
    .map((file) => read(`src/console/client/${file}`))
    .join('\n');
  assert.match(source, /sha256/);
  assert.match(source, /artifact/);
  assert.match(source, /request-correlated|reqId|requestId/);
  assert.doesNotMatch(
    source,
    /rawToken|controlTokenDigest|secretKey|relativePath|localPath|podUid|podName/,
  );
  assert.match(
    read('docs/console-v2-adjustments.md'),
    /Secretary launch context is not authority scope/,
  );
});
