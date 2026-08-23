import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runAttribution, splitRunResult } from '../src/console/client/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test('typed run card preserves source exactly without a browser formatter runtime', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/console/client/components/thread.tsx'),
    'utf8',
  );
  const packageSource = fs.readFileSync(
    path.join(root, 'package.json'),
    'utf8',
  );
  assert.match(source, /<pre>\{call\.code\}<\/pre>/);
  assert.doesNotMatch(
    source + packageSource,
    /formatSource|ElpisRunCode|prettierPlugins|run-code\.js|prettier\.umd|prism\.js/,
  );
});

test('typed run result parser separates value and console without rewriting either', () => {
  assert.deepEqual(
    splitRunResult(
      '[run ok — value saved to _]\nconst  x={a:1}\n--- console ---\nraw  `text`  ${literal}',
    ),
    {
      ok: true,
      value: 'const  x={a:1}',
      console: 'raw  `text`  ${literal}',
    },
  );
});

test('typed run result parser preserves failed output and attribution', () => {
  assert.deepEqual(splitRunResult('[run FAILED]\nboom'), {
    ok: false,
    value: 'boom',
    console: '',
  });
  assert.equal(
    runAttribution({
      execution: {
        alias: 'elm-example',
        lifecycle: 'ready',
        mindId: 'elm-example',
        runId: 'elm-example:g2:r4',
      },
      detached: true,
      bgId: 'job-1',
    }),
    'elm-example · ready · Mind #elm-example · elm-example:g2:r4 · detached job-1',
  );
});
