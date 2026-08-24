import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  editDiffPreview,
  operationDisplayTarget,
  operationMindId,
  operationReceiptUseful,
} from '../src/console/client/components/thread.js';
import {
  formatRunSource,
  resultSummary,
  splitRunResult,
  wakePresentation,
} from '../src/console/client/run.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

test('typed run card prettifies display source without changing execution bytes', async () => {
  const source = fs.readFileSync(
    path.join(root, 'src/console/client/components/thread.tsx'),
    'utf8',
  );
  assert.match(source, /<FormattedCode call=\{call\} \/>/);
  assert.doesNotMatch(source, /runAttribution|run-attribution/);
  const raw = "const x={a:1,b:[2,3]};await elpis.read('x')";
  const formatted = await formatRunSource({ code: raw });
  assert.equal(raw, "const x={a:1,b:[2,3]};await elpis.read('x')");
  assert.match(formatted, /const x = \{ a: 1, b: \[2, 3\] \};/);
  assert.match(formatted, /await elpis\.read\('x'\)/);
  const heredoc = await formatRunSource({
    code: 'const value = <<<TEXT\nhello\nTEXT',
    display: {
      code: 'const value = "__ELPIS_HEREDOC_0__"',
      heredocs: [
        {
          token: '__ELPIS_HEREDOC_0__',
          source: '<<<TEXT\nhello\nTEXT',
        },
      ],
    },
  });
  assert.match(heredoc, /const value = <<<TEXT\nhello\nTEXT/);
});

test('operation card targets hide host prefixes while retaining useful paths', () => {
  assert.equal(
    operationDisplayTarget('/opt/elpis-harness/dist/console/public/app.js'),
    'dist/console/public/app.js',
  );
  assert.equal(
    operationDisplayTarget('/var/lib/elpis/private/receipt.json'),
    '…/elpis/private/receipt.json',
  );
  assert.equal(
    operationDisplayTarget('src/console/hub.ts'),
    'src/console/hub.ts',
  );
});

test('operation receipts optimize for human navigation instead of data volume', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/console/client/components/thread.tsx'),
    'utf8',
  );
  const styles = fs.readFileSync(
    path.join(root, 'src/console/client/styles.css'),
    'utf8',
  );
  assert.equal(
    operationMindId({
      kind: 'mind',
      target: 'elm-example',
      targetLiteral: true,
    }),
    'elm-example',
  );
  assert.equal(
    operationMindId({ kind: 'mind', target: 'id', targetLiteral: false }),
    null,
  );
  assert.equal(
    operationReceiptUseful({
      kind: 'file',
      target: 'path',
      targetLiteral: false,
    }),
    false,
  );
  assert.equal(
    operationReceiptUseful({
      kind: 'file',
      target: 'src/a.ts',
      targetLiteral: true,
    }),
    true,
  );
  assert.match(source, /if \(!mindId\) return null/);
  assert.match(source, /item\?\.title \|\| mindId/);
  assert.match(source, /onOpenMind\(mindId\)/);
  assert.match(
    source,
    /actions\.selectMind\(id\)[\s\S]*actions\.setView\('mind'\)/,
  );
  assert.match(styles, /\.operation-compact/);
  assert.match(styles, /min-height: 38px/);
  assert.doesNotMatch(source, /resultSummary\(result\.content, 260\)/);
  assert.doesNotMatch(styles, /operation-mind-body|operation-desktop-body/);
});

test('rich edit cards produce a bounded line diff with stable line numbers', () => {
  assert.deepEqual(editDiffPreview('a\nb\nc', 'a\nB\nC\nc'), [
    { kind: 'same', number: 1, text: 'a' },
    { kind: 'remove', number: 2, text: 'b' },
    { kind: 'add', number: 2, text: 'B' },
    { kind: 'add', number: 3, text: 'C' },
    { kind: 'same', number: 4, text: 'c' },
  ]);
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
