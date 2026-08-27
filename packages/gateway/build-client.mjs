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
