import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import { ConsoleHub, type HubSources } from '../src/console/hub.js';
import { createConsoleServer } from '../src/console/server.js';
import { initialState, reducer } from '../src/console/client/use-console.js';
import { makeConfig } from './helpers.js';
import type { ConsoleState } from '../src/console/client/types.js';

const session = (id: string, status = 'running') => ({
  id,
  slug: id,
  worker: `worker:${id}`,
  status,
  mindId: 'elm-1234abcd',
});

test('background changes reach connected websocket observers incrementally without a request or reload', async (t) => {
  const waitFor = (check: () => void) => t.waitFor(check, { timeout: 4000 });
  const hub = new ConsoleHub();
  let workers = [session('quiet-fox'), session('calm-owl')];
  let messages: unknown[] = [];
  let artifacts: unknown[] = [];
  let turns: unknown[] = [];
  let context = 'before';
  let reads = 0;
  hub.attach({
    usage: () => ({ current: 1 }),
    rooms: () => [],
    participants: () => 0,
    meta: () => ({ agentName: 'Aster', startedAt: 1, uptimeMs: Date.now() }),
    archived: () => [],
    subUsage: () => null,
    context: () => ({
      model: 'example',
      tools: [],
      messages: [{ role: 'user', content: context }],
    }),
    worker: {
      list: async () => {
        reads++;
        return workers;
      },
      status: async (ref: string) => ({
        session: workers.find((w) => w.worker === ref),
        messages,
        artifacts,
      }),
    },
    secretary: {
      broker: { list: () => [{ id: 'sec-example', status: 'ready' }] },
      conversation: { list: () => turns },
    },
  } as unknown as HubSources);
  const server = createConsoleServer(
    makeConfig({ console: { enabled: true, host: '127.0.0.1', port: 0 } }),
    hub,
  );
  await server.start();
  t.after(() => server.stop());
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  t.after(() => ws.terminate());
  let state: ConsoleState = { ...initialState, view: 'context' };
  const frames: any[] = [];
  ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    frames.push(frame);
    state = reducer(state, { type: 'frame', frame });
  });
  await waitFor(() => assert.ok(frames.some((f) => f.t === 'snapshot')));
  state = reducer(state, { type: 'select-worker', ref: 'worker:quiet-fox' });
  ws.send(
    JSON.stringify({
      t: 'watch',
      workerRef: 'worker:quiet-fox',
      context: true,
    }),
  );
  await waitFor(() => assert.equal(state.workerDetail?.status, 'running'));
  const unchanged = state.workers.sessions[1];
  frames.length = 0;
  workers = [
    session('quiet-fox', 'completed'),
    workers[1],
    session('gentle-bear'),
  ];
  messages = [
    {
      id: 1,
      sessionId: 'quiet-fox',
      body: 'Finished work',
      direction: 'worker_to_dispatcher',
      token: 'synthetic-secret',
    },
  ];
  artifacts = [
    {
      id: 1,
      key: 'workspace.patch.gz',
      localPath: '/private/artifact',
      sha256: 'a'.repeat(64),
    },
  ];
  turns = [
    {
      id: 'turn-1',
      status: 'completed',
      request: { content: 'question' },
      response: { content: 'answer' },
    },
  ];
  context = 'after';
  await waitFor(() => {
    assert.equal(state.workerDetail?.status, 'completed');
    assert.equal((state.secretary.sessions[0]?.turns as unknown[])?.length, 1);
    assert.equal((state.context?.messages as any[])?.[0]?.content, 'after');
  });
  assert.equal(state.workers.sessions.length, 3);
  assert.equal(
    state.workers.sessions.find((s) => s.id === 'calm-owl'),
    unchanged,
    'unchanged records retain identity',
  );
  assert.equal(
    (state.workerDetail?.messages as any[])[0].body,
    'Finished work',
  );
  assert.equal(
    (state.workerDetail?.artifacts as any[])[0].key,
    'workspace.patch.gz',
  );
  assert.equal((state.context?.messages as any[])[0].content, 'after');
  assert.equal(
    frames.some((f) => f.t === 'snapshot'),
    false,
  );
  const patch = frames.find((f) => f.t === 'sync' && f.workers);
  assert.deepEqual(patch.workers.sessions.map((w: any) => w.id).sort(), [
    'gentle-bear',
    'quiet-fox',
  ]);
  assert.doesNotMatch(
    JSON.stringify(frames),
    /synthetic-secret|\/private\/artifact/,
  );
  frames.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 1700));
  assert.equal(
    frames.length,
    0,
    'idle state sends no repeated snapshots or uptime traffic',
  );
  workers = [workers[1]];
  await waitFor(() => assert.equal(state.workers.sessions.length, 1));
  assert.equal(state.workers.sessions[0].id, 'calm-owl');
  ws.close();
  await new Promise((resolve) => ws.once('close', resolve));
  const stoppedAt = reads;
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(reads, stoppedAt, 'no observer work continues without clients');
});

test('selection changes discard stale details and reconnect releases interrupted backfill', () => {
  let state = reducer(initialState, {
    type: 'select-worker',
    ref: 'worker:quiet-fox',
  });
  state = reducer(state, {
    type: 'frame',
    frame: {
      t: 'controlResult',
      lane: 'worker',
      op: 'status',
      ok: true,
      result: { session: session('quiet-fox'), messages: [], artifacts: [] },
    },
  });
  state = reducer(state, { type: 'select-worker', ref: 'worker:calm-owl' });
  assert.equal(state.workerDetail, null);
  state = reducer(state, {
    type: 'frame',
    frame: {
      t: 'controlResult',
      lane: 'worker',
      op: 'status',
      ok: true,
      result: { session: session('quiet-fox'), messages: [], artifacts: [] },
    },
  });
  assert.equal(
    state.workerDetail,
    null,
    'late status cannot repaint another worker',
  );
  state = reducer(state, { type: 'history-loading', value: true });
  state = reducer(state, { type: 'connection', value: 'reconnecting' });
  assert.equal(state.loadingHistory, false);
});

test('stream lifecycle preserves active output across unrelated messages and obsolete stream endings', () => {
  let state = reducer(initialState, {
    type: 'frame',
    frame: { t: 'streamStart', streamId: 2 },
  });
  state = reducer(state, {
    type: 'frame',
    frame: { t: 'delta', streamId: 2, kind: 'content', text: 'working' },
  });
  state = reducer(state, {
    type: 'frame',
    frame: {
      t: 'message',
      msg: { id: 1, role: 'user', kind: 'user', content: 'hello' },
    },
  });
  assert.equal(state.live?.content, 'working');
  state = reducer(state, {
    type: 'frame',
    frame: { t: 'streamEnd', streamId: 1 },
  });
  assert.equal(state.live?.content, 'working');
  state = reducer(state, {
    type: 'frame',
    frame: {
      t: 'message',
      msg: { id: 2, role: 'assistant', kind: 'assistant', content: 'working' },
    },
  });
  assert.equal(state.live, null);
});

test('reconnect snapshots preserve loaded history within a process and reset restarted identities', () => {
  const messages = [1, 2, 3].map((id) => ({
    id,
    kind: 'user',
    role: 'user',
    channel: 'internal',
    content: String(id),
  }));
  let state = {
    ...initialState,
    meta: { startedAt: 10 },
    messages,
    hasMore: false,
  };
  state = reducer(state, {
    type: 'frame',
    frame: {
      t: 'snapshot',
      meta: { startedAt: 10 },
      messages: [messages[2]],
      hasMore: true,
    },
  });
  assert.deepEqual(
    state.messages.map((entry) => entry.id),
    [1, 2, 3],
  );
  assert.equal(state.hasMore, false);
  state = reducer(state, {
    type: 'frame',
    frame: {
      t: 'snapshot',
      meta: { startedAt: 20 },
      messages: [{ ...messages[0], content: 'new process' }],
    },
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].content, 'new process');
});

test('detaching a viewer fences pending control responses and async sync reads', async (t) => {
  const hub = new ConsoleHub();
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let reading = false;
  const worker = session('quiet-fox');
  const sources = {
    usage: () => ({}),
    rooms: () => [],
    participants: () => 0,
    meta: () => ({}),
    archived: () => [],
    subUsage: () => null,
    worker: {
      list: async () => [worker],
      status: async () => {
        reading = true;
        return pending;
      },
    },
  } as unknown as HubSources;
  hub.attach(sources);
  const frames: any[] = [];
  const client = {
    closed: false,
    send: (data: string) => frames.push(JSON.parse(data)),
  };
  t.after(() => hub.removeClient(client));
  await hub.addClient(client);
  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'watch', workerRef: worker.worker }),
  );
  await t.waitFor(() => assert.equal(reading, true), { timeout: 4000 });
  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'control',
      lane: 'worker',
      op: 'status',
      ref: worker.worker,
      reqId: 1,
    }),
  );
  hub.removeClient(client);
  await hub.addClient(client);
  frames.length = 0;
  release({
    session: { ...worker, status: 'failed' },
    messages: [],
    artifacts: [],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    frames.length,
    0,
    'no response from the previous attachment reaches a reattached viewer',
  );
});
