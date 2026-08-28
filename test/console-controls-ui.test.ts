import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { turnMessages } from '../src/console/client/components/secretary.js';
import { workerEntries } from '../src/console/client/components/workers.js';
import { clampLogRailHeight } from '../src/console/client/scroll.js';
import {
  appendSecretaryTurn,
  secretaryIdFromControl,
  secretaryPendingStatus,
  secretarySnapshotHasPending,
  upsertControlSession,
  workerDetailFromControl,
} from '../src/console/client/use-console.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (file: string): string =>
  fs.readFileSync(path.join(root, file), 'utf8');

test('console exports one five-view dashboard over a bounded transport', () => {
  const main = read('src/console/client/main.tsx');
  const hook = read('src/console/client/use-console.ts');
  const transport = read('src/console/client/transport.ts');
  const websocket = read('src/console/client/websocket-transport.ts');
  const standalone = read('src/console/client/standalone.tsx');
  const html = read('src/console/public/index.html');
  assert.match(main, /Thread.*Context.*Mind.*Workers.*Secretary/s);
  assert.match(main, /export function ConsoleDashboard/);
  assert.match(
    main,
    /export function ConsoleDashboard\(\{\s*state,\s*actions,\s*mediaResolver,\s*\}: ConsoleDashboardProps\)/,
  );
  assert.match(
    main,
    /<ConsoleMediaResolverContext\.Provider value=\{mediaResolver\}>/,
  );

  assert.match(standalone, /useConsole\(transport\)/);
  assert.doesNotMatch(hook, /WebSocket|location\.host|\/ws/);
  assert.match(hook, /transport\.subscribe/);
  assert.match(hook, /transport\.send/);
  assert.match(transport, /interface ConsoleTransport/);
  assert.match(websocket, /new WebSocket/);
  assert.match(websocket, /location\.host}\/ws/);
  assert.match(
    standalone,
    /<ConsoleDashboard state=\{state\} actions=\{actions\}/,
  );
  assert.match(hook, /t: 'control'/);
  assert.match(hook, /t: 'mind'/);
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

test('desktop log rail restores bounded persisted resize and fixed timestamps', () => {
  assert.equal(clampLogRailHeight(40, 800), 96);
  assert.equal(clampLogRailHeight(208, 800), 208);
  assert.equal(clampLogRailHeight(9999, 800), 560);
  const main = read('src/console/client/main.tsx');
  const styles = read('src/console/client/styles.css');
  assert.match(main, /LOG_RAIL_KEY = 'ep-logdock-h'/);
  assert.match(main, /role='separator'/);
  assert.match(main, /setPointerCapture/);
  assert.match(main, /ArrowUp/);
  assert.match(styles, /\.log-line time[\s\S]*white-space: nowrap/);
});

test('control projections preserve worker identity and select a started Secretary session', () => {
  assert.deepEqual(
    workerDetailFromControl({
      session: {
        id: 'wrk-1',
        slug: 'quiet-fox',
        worker: 'worker:quiet-fox',
        status: 'failed',
        mindId: 'elm-example',
      },
      messages: [
        {
          id: 7,
          direction: 'worker_to_dispatcher',
          sender: 'worker',
          body: 'done',
          createdAt: 8,
        },
      ],
      artifacts: [{ key: 'workspace.patch.gz' }],
    }),
    {
      id: 'wrk-1',
      slug: 'quiet-fox',
      worker: 'worker:quiet-fox',
      status: 'failed',
      mindId: 'elm-example',
      messages: [
        {
          id: 7,
          direction: 'worker_to_dispatcher',
          sender: 'worker',
          body: 'done',
          createdAt: 8,
        },
      ],
      artifacts: [{ key: 'workspace.patch.gz' }],
    },
  );
  assert.deepEqual(
    workerEntries(
      [
        {
          id: 7,
          direction: 'worker_to_dispatcher',
          sender: 'worker',
          body: 'done',
          createdAt: 8,
        },
      ],
      'worker:quiet-fox',
    ),
    [
      {
        id: 7,
        kind: 'message',
        role: 'assistant',
        channel: 'worker',
        content: 'done',
        author: 'worker:quiet-fox',
        ts: 8,
      },
    ],
  );
  assert.equal(
    secretaryIdFromControl({ id: 'sec-test-session' }),
    'sec-test-session',
  );
  assert.equal(secretaryIdFromControl({ status: 'failed' }), null);
});

test('successful control receipts upsert sessions and append Secretary turns immediately', () => {
  const snapshot = {
    available: true,
    sessions: [
      { id: 'sec-old', status: 'failed', turns: [{ id: 'turn-old' }] },
    ],
  };
  assert.deepEqual(
    upsertControlSession(snapshot, { id: 'sec-new', status: 'ready' }),
    {
      available: true,
      sessions: [
        { id: 'sec-new', status: 'ready' },
        { id: 'sec-old', status: 'failed', turns: [{ id: 'turn-old' }] },
      ],
    },
  );
  assert.deepEqual(
    upsertControlSession(snapshot, { id: 'sec-old', status: 'closed' }),
    {
      available: true,
      sessions: [
        { id: 'sec-old', status: 'closed', turns: [{ id: 'turn-old' }] },
      ],
    },
  );
  assert.deepEqual(
    appendSecretaryTurn(snapshot, {
      id: 'turn-new',
      sessionId: 'sec-old',
      status: 'queued',
    }).sessions[0].turns,
    [
      { id: 'turn-old' },
      { id: 'turn-new', sessionId: 'sec-old', status: 'queued' },
    ],
  );
  const source = read('src/console/client/use-console.ts');
  for (const op of ['start', 'send', 'followup', 'dismiss', 'enqueue', 'close'])
    assert.match(source, new RegExp(`frame\\.op === '${op}'`));
});

test('image viewer and worker mandate use real bounded content', () => {
  const thread = read('src/console/client/components/thread.tsx');
  const workers = read('src/console/client/components/workers.tsx');
  const styles = read('src/console/client/styles.css');
  assert.match(thread, /class='image-viewer'/);
  assert.match(thread, /event\.key === 'Escape'/);
  assert.match(thread, /class='memory-context-surface'/);
  assert.match(thread, /<Markdown value=\{memory\.markdown\}/);
  assert.match(styles, /\.image-viewer-layer[\s\S]*position: fixed/);
  assert.match(styles, /\.memory-context-body table/);
  assert.match(workers, /state\.mindItems\.find[\s\S]*\.body/);
  assert.doesNotMatch(workers, /Mandate text is not exposed/);
  assert.match(workers, /Fresh same-Mind follow-up/);
  assert.match(workers, /hidden model context is not resumed/);
  assert.match(workers, /actions\.control\('worker', 'followup'/);
});

test('Secretary pending state drives bounded refresh and honest activity labels', () => {
  const snapshot = {
    available: true,
    sessions: [
      { id: 'sec-queued', turns: [{ status: 'queued' }] },
      { id: 'sec-claimed', turns: [{ status: 'claimed' }] },
    ],
  };
  assert.equal(secretaryPendingStatus(snapshot.sessions[0]), 'queued');
  assert.equal(secretaryPendingStatus(snapshot.sessions[1]), 'claimed');
  assert.equal(secretarySnapshotHasPending(snapshot), true);
  assert.equal(
    secretarySnapshotHasPending({
      available: true,
      sessions: [{ turns: [{ status: 'completed' }] }],
    }),
    false,
  );
  const socket = read('src/console/client/use-console.ts');
  const view = read('src/console/client/components/secretary.tsx');
  assert.match(socket, /frame\.op !== 'snapshot'/);
  assert.match(
    socket,
    /frame\.lane === 'secretary'[\s\S]*frame\.op === 'snapshot'[\s\S]*secretary: controlSnapshot\(frame\.result\)/,
  );
  assert.match(socket, /state\.view !== 'secretary'/);
  assert.match(socket, /}, 750\)/);
  assert.match(view, /Waiting for Secretary/);
  assert.match(view, /Secretary is thinking/);
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

test('runtime command cards use only per-invocation receipts', () => {
  const thread = read('src/console/client/components/thread.tsx');
  assert.match(thread, /runtimeOperationReceipts\(result\)/);
  assert.match(thread, /hasRuntimeOperationLedger\(result\)/);
  assert.match(
    thread,
    /operation\.kind !== 'shell'[\s\S]*operation\.kind !== 'git'[\s\S]*operation\.kind !== 'file'/,
  );
  assert.match(thread, /<pre>\{receipt\.stdout\}<\/pre>/);
  assert.match(thread, /<pre>\{receipt\.stderr\}<\/pre>/);
  assert.match(thread, /<pre>\{receipt\.error\}<\/pre>/);
  assert.match(thread, /runtime-operation-omitted/);
  assert.doesNotMatch(
    thread,
    /RuntimeOperationCard[\s\S]{0,400}result\.content/,
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
