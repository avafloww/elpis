import { copyFile } from 'node:fs/promises';
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['client/main.tsx'],
  outdir: 'dist/public/assets',
  entryNames: 'app',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'info',
});

const sharedAssets = [
  'elpis-logo-dark.svg',
  'elpis-icon-dark.svg',
  'apple-touch-icon.png',
  'elpis-icon-192.png',
  'elpis-icon-512.png',
  'elpis-icon-maskable-512.png',
];

await Promise.all(
  sharedAssets.map((name) =>
    copyFile(
      new URL(`../../src/console/public/${name}`, import.meta.url),
      new URL(`dist/public/${name}`, import.meta.url),
    ),
  ),
);
