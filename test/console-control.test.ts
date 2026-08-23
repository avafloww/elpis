import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConsoleHub,
  type ConsoleSecretaryControl,
  type ConsoleWorkerControl,
  type HubClient,
  type HubSources,
} from '../src/console/hub.js';

function client(): HubClient & { frames: any[] } {
  const frames: any[] = [];
  return {
    closed: false,
    frames,
    send(data) {
      frames.push(JSON.parse(data));
    },
  };
}

function sources(overrides: Partial<HubSources> = {}): HubSources {
  return {
    usage: () => ({
      current: 0,
      window: 1,
      trigger: 1,
      triggerRatio: 1,
      ratio: 0,
      prompt: 0,
      completion: 0,
      cache: {
        supported: false,
        lastCached: 0,
        lastNew: 0,
        lastRatio: 0,
        totalCached: 0,
        totalNew: 0,
        totalRatio: 0,
        bustCount: 0,
        bustTokens: 0,
        turns: 0,
      },
    }),
    rooms: () => [],
    participants: () => 0,
    meta: () => ({
      gitHash: 'x',
      treeClean: true,
      uptimeMs: 0,
      model: 'x',
      botTag: 'x',
    }),
    archived: () => [],
    subUsage: () => null,
    ...overrides,
  };
}

async function control(
  hub: ConsoleHub,
  c: ReturnType<typeof client>,
  frame: Record<string, unknown>,
): Promise<any> {
  const before = c.frames.length;
  hub.handleClientMessage(c, JSON.stringify({ t: 'control', ...frame }));
  for (let i = 0; i < 20 && c.frames.length === before; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(c.frames.length, before + 1);
  return c.frames.at(-1);
}

const workerSession = {
  id: 'wrk-12345678',
  slug: 'quiet-fox',
  worker: 'worker:quiet-fox',
  status: 'running',
  modelRef: 'configured/model',
  mindId: 'elm-1234abcd',
  runtime: 'kubernetes',
  podName: 'provider-detail',
  podUid: 'provider-uid',
  workspaceRef: '/tmp/private-workspace',
  sourceRevision: 'abc',
  sourceSha256: 'a'.repeat(64),
  sourceBytes: 12,
  createdAt: 1,
  updatedAt: 2,
  lastError: null,
  token: 'raw-worker-credential',
  controlTokenDigest: 'digest',
};
const secretaryId = 'sec-1234567890123456789012';
const secretarySession = {
  id: secretaryId,
  hintMindId: 'elm-1234abcd',
  status: 'ready',
  modelRef: 'configured/secretary',
  runtime: 'kubernetes',
  podName: 'secretary-pod',
  podUid: 'uid',
  createdAt: 1,
  updatedAt: 2,
  lastError: null,
  token: 'raw-secretary-token',
  controlTokenDigest: 'digest',
};

function worker(
  overrides: Partial<ConsoleWorkerControl> = {},
): ConsoleWorkerControl {
  return {
    async list() {
      return [workerSession] as any;
    },
    async status() {
      return { session: workerSession, messages: [], artifacts: [] } as any;
    },
    async start() {
      return workerSession as any;
    },
    async send() {
      return { id: 1 } as any;
    },
    async dismiss() {
      return workerSession as any;
    },
    ...overrides,
  };
}
function secretary(
  overrides: { broker?: any; conversation?: any } = {},
): ConsoleSecretaryControl {
  return {
    broker: {
      list: () => [secretarySession] as any,
      start: async () => secretarySession as any,
      close: async () => ({ ...secretarySession, status: 'closed' }) as any,
      ...overrides.broker,
    },
    conversation: {
      list: () =>
        [
          {
            id: 'stn-1234567890123456789012',
            sessionId: secretaryId,
            sequence: 1,
            status: 'completed',
            request: { role: 'user', content: 'hello' },
            response: { role: 'assistant', content: 'hi' },
            createdAt: 1,
            updatedAt: 2,
            claimedAt: 1,
            completedAt: 2,
            lastError: null,
            token: 'turn-secret',
          },
        ] as any,
      enqueue: (_id: string, request: any) =>
        ({
          id: 'stn-1234567890123456789012',
          sessionId: secretaryId,
          sequence: 2,
          status: 'queued',
          request,
          response: null,
          createdAt: 3,
          updatedAt: 3,
          claimedAt: null,
          completedAt: null,
          lastError: null,
        }) as any,
      ...overrides.conversation,
    },
  } as ConsoleSecretaryControl;
}

test('console control snapshot reports honest unavailable lanes', async () => {
  const hub = new ConsoleHub();
  hub.attach(sources());
  const c = client();
  await hub.addClient(c);
  const snapshot = c.frames[0];
  assert.deepEqual(snapshot.workers, { available: false, sessions: [] });
  assert.deepEqual(snapshot.secretary, { available: false, sessions: [] });
  assert.deepEqual(
    await control(hub, c, { lane: 'worker', op: 'snapshot', reqId: 1 }),
    {
      t: 'controlResult',
      lane: 'worker',
      op: 'snapshot',
      reqId: 1,
      ok: true,
      result: { available: false, sessions: [] },
    },
  );
  const denied = await control(hub, c, {
    lane: 'secretary',
    op: 'close',
    reqId: 2,
    sessionId: secretaryId,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error, /unavailable/);
});

test('snapshots include durable turns while stripping tokens, credentials, and artifact paths', async () => {
  const w = worker({
    status: async () =>
      ({
        session: workerSession,
        messages: [
          {
            id: 8,
            sessionId: workerSession.id,
            direction: 'worker_to_dispatcher',
            kind: 'message',
            messageKey: 'k',
            sender: 'worker',
            body: 'done',
            createdAt: 4,
            acknowledgedAt: null,
            token: 'mail-secret',
          },
        ],
        artifacts: [
          {
            id: 9,
            sessionId: workerSession.id,
            key: 'workspace.patch.gz',
            kind: 'unified_patch_gzip',
            sourceSha256: 'a'.repeat(64),
            sha256: 'b'.repeat(64),
            sizeBytes: 5,
            createdAt: 6,
            relativePath: 'artifacts/private',
            localPath: '/tmp/private',
          },
        ],
      }) as any,
  });
  const hub = new ConsoleHub();
  hub.attach(sources({ worker: w, secretary: secretary() }));
  const c = client();
  await hub.addClient(c);
  assert.equal(c.frames[0].workers.available, true);
  assert.equal(c.frames[0].secretary.sessions[0].turns.length, 1);
  assert.doesNotMatch(
    JSON.stringify(c.frames[0]),
    /raw-worker|raw-secretary|turn-secret|controlToken|private-workspace|secretary-pod/,
  );
  const status = await control(hub, c, {
    lane: 'worker',
    op: 'status',
    reqId: 3,
    ref: 'worker:quiet-fox',
  });
  assert.equal(status.ok, true);
  assert.equal(status.result.messages[0].body, 'done');
  assert.equal(status.result.artifacts[0].key, 'workspace.patch.gz');
  assert.doesNotMatch(JSON.stringify(status), /relativePath|localPath|private/);
});

test('control snapshots retain active sessions while bounding history and body previews', async () => {
  const workerSessions = Array.from({ length: 15 }, (_, i) => ({
    ...workerSession,
    id: `wrk-${String(i).padStart(8, '0')}`,
    slug: `worker-${i}`,
    worker: `worker:worker-${i}`,
    status: i === 14 ? 'running' : 'finished',
    createdAt: 100 - i,
  }));
  const secretarySessions = Array.from({ length: 15 }, (_, i) => ({
    ...secretarySession,
    id: `sec-${String(i).padStart(22, '0')}`,
    status: i === 14 ? 'ready' : 'closed',
    createdAt: 100 - i,
  }));
  const long = '😀'.repeat(3000);
  const w = worker({
    list: async () => workerSessions as any,
    status: async () =>
      ({
        session: workerSessions[14],
        messages: Array.from({ length: 25 }, (_, i) => ({ id: i, body: long })),
        artifacts: Array.from({ length: 25 }, (_, i) => ({
          id: i,
          key: `a-${i}`,
        })),
      }) as any,
  });
  const sec = secretary({
    broker: { list: () => secretarySessions as any },
    conversation: {
      list: (sessionId: string) =>
        Array.from({ length: 6 }, (_, i) => ({
          id: `stn-${String(i).padStart(22, '0')}`,
          sessionId,
          sequence: i + 1,
          status: 'completed',
          request: { role: 'user', content: long },
          response: { role: 'assistant', content: long },
        })) as any,
    },
  });
  const hub = new ConsoleHub();
  hub.attach(sources({ worker: w, secretary: sec }));
  const c = client();
  await hub.addClient(c);
  const snapshot = c.frames[0];
  assert.equal(snapshot.workers.sessions.length, 10);
  assert.ok(
    snapshot.workers.sessions.some(
      (session: any) => session.id === workerSessions[14].id,
    ),
  );
  assert.equal(snapshot.secretary.sessions.length, 10);
  const active = snapshot.secretary.sessions.find(
    (session: any) => session.id === secretarySessions[14].id,
  );
  assert.ok(active);
  assert.equal(active.turns.length, 4);
  assert.equal(active.turns[0].sequence, 3);
  assert.match(active.turns[0].request.content, /truncated for console/);
  assert.ok(Buffer.byteLength(active.turns[0].request.content, 'utf8') < 8300);
  const status = await control(hub, c, {
    lane: 'worker',
    op: 'status',
    reqId: 9,
    ref: workerSessions[14].id,
  });
  assert.equal(status.result.messages.length, 20);
  assert.equal(status.result.artifacts.length, 20);
  assert.match(status.result.messages[0].body, /truncated for console/);
  assert.ok(Buffer.byteLength(status.result.messages[0].body, 'utf8') < 8300);
});

test('control operations validate bounded identities/content and delegate exact runtime calls', async () => {
  const calls: any[] = [];
  const w = worker({
    start: async (...args: any[]) => {
      calls.push(['worker.start', ...args]);
      return workerSession as any;
    },
    send: async (...args: any[]) => {
      calls.push(['worker.send', ...args]);
      return { id: 4, sessionId: workerSession.id, body: args[1] } as any;
    },
    dismiss: async (...args: any[]) => {
      calls.push(['worker.dismiss', ...args]);
      return workerSession as any;
    },
  });
  const sec = secretary({
    broker: {
      start: async (...args: any[]) => {
        calls.push(['secretary.start', ...args]);
        return secretarySession;
      },
      close: async (...args: any[]) => {
        calls.push(['secretary.close', ...args]);
        return secretarySession;
      },
    },
    conversation: {
      enqueue: (...args: any[]) => {
        calls.push(['secretary.enqueue', ...args]);
        return {
          id: 'stn-1234567890123456789012',
          sessionId: secretaryId,
          request: args[1],
        };
      },
    },
  });
  const hub = new ConsoleHub();
  hub.attach(sources({ worker: w, secretary: sec }));
  const c = client();
  await hub.addClient(c);
  calls.length = 0;
  await control(hub, c, {
    lane: 'worker',
    op: 'start',
    reqId: 10,
    mindId: 'elm-1234abcd',
    modelRef: 'configured/model',
  });
  await control(hub, c, {
    lane: 'worker',
    op: 'send',
    reqId: 11,
    ref: 'worker:quiet-fox',
    content: 'bounded hello',
  });
  await control(hub, c, {
    lane: 'worker',
    op: 'dismiss',
    reqId: 12,
    ref: 'wrk-12345678',
  });
  await control(hub, c, {
    lane: 'secretary',
    op: 'start',
    reqId: 13,
    hintMindId: 'elm-1234abcd',
  });
  await control(hub, c, {
    lane: 'secretary',
    op: 'enqueue',
    reqId: 14,
    sessionId: secretaryId,
    content: 'question',
  });
  await control(hub, c, {
    lane: 'secretary',
    op: 'close',
    reqId: 15,
    sessionId: secretaryId,
  });
  assert.deepEqual(calls, [
    ['worker.start', 'elm-1234abcd', { modelRef: 'configured/model' }],
    ['worker.send', 'worker:quiet-fox', 'bounded hello'],
    ['worker.dismiss', 'wrk-12345678'],
    ['secretary.start', 'elm-1234abcd'],
    ['secretary.enqueue', secretaryId, { role: 'user', content: 'question' }],
    ['secretary.close', secretaryId],
  ]);
  const before = calls.length;
  for (const frame of [
    { lane: 'worker', op: 'start', reqId: 20, mindId: 'elm-123' },
    {
      lane: 'worker',
      op: 'send',
      reqId: 21,
      ref: 'x'.repeat(200),
      content: 'x',
    },
    {
      lane: 'worker',
      op: 'send',
      reqId: 22,
      ref: 'wrk-12345678',
      content: '😀'.repeat(9000),
    },
    { lane: 'secretary', op: 'start', reqId: 23, hintMindId: 'elm-123' },
    {
      lane: 'secretary',
      op: 'enqueue',
      reqId: 24,
      sessionId: 'sec-short',
      content: 'x',
    },
  ])
    assert.equal((await control(hub, c, frame)).ok, false);
  assert.equal(calls.length, before);
});

test('async control rejection and unknown operations always receive bounded correlated errors', async () => {
  const hub = new ConsoleHub();
  hub.attach(
    sources({
      worker: worker({
        status: async () => {
          throw new Error('boom-' + 'x'.repeat(2000));
        },
      }),
    }),
  );
  const c = client();
  await hub.addClient(c);
  const failed = await control(hub, c, {
    lane: 'worker',
    op: 'status',
    reqId: 77,
    ref: 'wrk-12345678',
  });
  assert.equal(failed.t, 'controlResult');
  assert.equal(failed.lane, 'worker');
  assert.equal(failed.op, 'status');
  assert.equal(failed.reqId, 77);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.length, 1000);
  assert.match(failed.error, /^boom-/);
  const unknown = await control(hub, c, {
    lane: 'worker',
    op: 'kubectl',
    reqId: 78,
  });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /unknown worker operation/);
  const malformed = await control(hub, c, {
    lane: 'worker',
    op: 'status',
    reqId: 'bad',
    ref: 'wrk-12345678',
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reqId, 0);
});
