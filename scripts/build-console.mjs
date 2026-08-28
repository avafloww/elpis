import { build } from 'esbuild';

await build({
  entryPoints: ['src/console/client/standalone.tsx'],
  outfile: 'dist/console/public/app.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      process.env.NODE_ENV ?? 'production',
    ),
  },
});
