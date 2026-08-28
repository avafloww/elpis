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

await copyFile(
  new URL('../../src/console/public/elpis-logo-dark.svg', import.meta.url),
  new URL('dist/public/elpis-logo-dark.svg', import.meta.url),
);
