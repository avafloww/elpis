import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  resultSummary,
  splitRunResult,
  wakePresentation,
} from '../src/console/client/run.js';

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
  assert.match(source, /<HighlightedCode value=\{call\.code\} \/>/);
  assert.doesNotMatch(source, /runAttribution|run-attribution/);
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

test('typed run card summarizes results and isolates wake presentation', () => {
  assert.deepEqual(splitRunResult('[run FAILED]\nboom'), {
    ok: false,
    value: 'boom',
    console: '',
  });
  assert.equal(
    resultSummary('[run ok]\nObject{2 keys: task, result}'),
    'Object{2 keys: task, result}',
  );
  const wake = wakePresentation(
    {
      execution: {
        alias: 'elm-example',
        lifecycle: 'ready',
        mindId: 'elm-example',
        runId: 'elm-example:g2:r4',
      },
      wake: {
        state: 'armed',
        kind: 'after',
        targetAt: 3_600_000,
        taskId: 7,
        advice: { reason: 'quiet-exploration' },
      },
    },
    0,
  );
  assert.ok(wake);
  assert.match(wake.when, /^Wake scheduled · /);
  assert.equal(wake.reason, 'quiet exploration');
  assert.equal(wake.raw, 'task #7 · after · armed');
  assert.doesNotMatch(JSON.stringify(wake), /elm-example|lifecycle|runId/);
});
