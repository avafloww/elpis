// Subprocess acceptance against freshly built server + browser assets:
// npm run build && node test/console-sync.acceptance.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { ConsoleHub } from '../dist/console/hub.js';
import { createConsoleServer } from '../dist/console/server.js';
import { MindService } from '../dist/store/mind.js';
import { runMigrations } from '../dist/store/db.js';
import { noopLogger } from '../dist/lib/log.js';

const db = new DatabaseSync(':memory:');
runMigrations(db);
const hub = new ConsoleHub();
const mind = new MindService({
  db,
  scheduler: {},
  logger: noopLogger,
  onChanged: () => hub.mindChanged(),
});
const item = mind.create({
  title: 'Review fixtures',
  body: 'Original mandate',
});
let workers = [
  {
    id: 'wrk-example',
    worker: 'worker:quiet-fox',
    slug: 'quiet-fox',
    mindId: item.id,
    status: 'running',
  },
];
let messages = [];
let artifacts = [];
let turns = [];
let projection = 'Original context';
let rooms = [];
let agentName = 'Aster';
const workerStatus = (ref) => ({
  session: workers.find((worker) => worker.worker === ref),
  messages,
  artifacts,
});
hub.attach({
  usage: () => ({
    current: 100,
    window: 1000,
    trigger: 800,
    triggerRatio: 0.8,
    ratio: 0.1,
    prompt: 90,
    completion: 10,
    cache: {},
  }),
  rooms: () => rooms,
  participants: () => 1,
  archived: () => [],
  subUsage: () => null,
  meta: () => ({
    agentName,
    model: 'example/model',
    startedAt: 1,
    uptimeMs: Date.now(),
  }),
  context: () => ({
    model: 'example/model',
    tools: [],
    messages: [{ role: 'user', content: projection }],
  }),
  mind,
  worker: {
    list: async () => workers,
    status: async (ref) => workerStatus(ref),
  },
  secretary: {
    broker: { list: () => [{ id: 'sec-example', status: 'ready' }] },
    conversation: { list: () => turns },
  },
});
const server = createConsoleServer(
  {
    console: { enabled: true, host: '127.0.0.1', port: 0 },
    paths: { dataDirectory: '/tmp/elpis-console-acceptance' },
    logger: noopLogger,
  },
  hub,
);
await server.start();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(8000);
  const errors = [];
  const frames = [];
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations++;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) =>
      frames.push(JSON.parse(String(payload))),
    ),
  );
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    window.fixtureSockets = [];
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args);
        window.fixtureSockets.push(this);
      }
    };
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  const nav = (name) =>
    page.locator('.view-nav button').filter({ hasText: name }).click();
  const visible = (selector, value) =>
    page.locator(selector).filter({ hasText: value }).first().waitFor();
  await nav('Workers');
  await page.locator('.worker-row').filter({ hasText: 'quiet-fox' }).click();
  const steering = page.getByPlaceholder('Send bounded steering…');
  await steering.fill('Keep this draft');
  await steering.evaluate((node) => {
    window.fixtureSteering = node;
  });
  messages = [
    {
      id: 1,
      sessionId: 'wrk-example',
      body: 'Mailbox progress',
      direction: 'worker_to_dispatcher',
    },
  ];
  artifacts = [{ id: 1, key: 'workspace.patch.gz', sha256: 'a'.repeat(64) }];
  await visible('.worker-detail', 'Mailbox progress');
  await visible('.artifact-card', 'workspace.patch.gz');
  assert.equal(await steering.inputValue(), 'Keep this draft');
  assert.equal(
    await steering.evaluate((node) => node === window.fixtureSteering),
    true,
  );
  workers = [{ ...workers[0], status: 'idle' }];
  await visible('.worker-detail-head .status-word', 'idle');
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  messages = [
    ...messages,
    {
      id: 2,
      sessionId: 'wrk-example',
      body: 'Progress while disconnected',
      direction: 'worker_to_dispatcher',
    },
  ];
  await visible('.worker-detail', 'Progress while disconnected');
  assert.equal(await steering.inputValue(), 'Keep this draft');
  workers = [{ ...workers[0], status: 'completed' }];
  await visible('.worker-detail-head .status-word', 'completed');

  await nav('Mind');
  await page.locator('.mind-row').filter({ hasText: item.title }).click();
  mind.update(item.id, {
    title: 'Updated review',
    body: 'Changed from the runtime',
  });
  mind.addComment(item.id, 'External comment', 'worker:quiet-fox');
  await visible('.mind-detail', 'Changed from the runtime');
  await visible('.mind-comments', 'External comment');

  await nav('Secretary');
  turns = [
    {
      id: 'turn-1',
      status: 'queued',
      request: { content: 'Inspect the proposal' },
      response: null,
    },
  ];
  await visible('.activity-copy', 'Waiting for Secretary');
  turns = [
    {
      ...turns[0],
      status: 'completed',
      response: { role: 'assistant', content: 'Secretary finished review' },
    },
  ];
  await visible('.secretary-thread', 'Secretary finished review');

  await nav('Context');
  await visible('.context-view', 'Original context');
  projection = 'Context changed without a message';
  await visible('.context-view', projection);
  await page.evaluate(() => window.fixtureSockets.at(-1).close());
  projection = 'Context after reconnect';
  await visible('.context-view', projection);

  await nav('Thread');
  const composer = page.getByPlaceholder('Write a message…');
  await composer.fill('Unsent thread draft');
  hub.streamStart();
  hub.streamDelta('content', 'Streaming progress');
  await visible('.thread-scroll', 'Streaming progress');
  hub.messageAppended({
    role: 'user',
    content: 'An interleaved input',
    channel: 'internal',
  });
  await visible('.thread-scroll', 'Streaming progress');
  hub.streamEnd();
  hub.messageAppended({
    role: 'assistant',
    content: 'Committed response',
    channel: 'internal',
  });
  await visible('.thread-scroll', 'Committed response');
  assert.equal(await composer.inputValue(), 'Unsent thread draft');
  hub.logLine('info', 'Live console log');
  await page.locator('.log-rail > header button').click();
  await visible('.log-line', 'Live console log');
  rooms = [
    {
      id: 'example-room',
      name: 'Example room',
      count: 1,
      presence: 1,
      group: 'discord',
      guildSlug: 'example',
    },
  ];
  await visible('.room-section', 'Example room');
  assert.equal(
    navigations,
    1,
    'live updates and reconnects never reload the page',
  );
  assert.ok(frames.some((frame) => frame.t === 'sync' && frame.workers));
  assert.deepEqual(errors, []);
  console.log(
    'Browser acceptance passed: workers, drafts, Mind, Secretary, Context, Thread, logs, rooms and reconnects.',
  );
} finally {
  await browser.close();
  server.stop();
  db.close();
}
