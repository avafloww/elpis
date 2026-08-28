import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type {
  GatewayToResidentFrame,
  RequestId,
  ResidentConsoleOutputEffect,
  ResidentMediaResultEffect,
  ResidentOperationResultEffect,
  ViewerId,
} from '@elpis/gateway-protocol';
import {
  ConsoleHub,
  type HubClient,
  type HubSources,
} from '../src/console/hub.js';
import {
  CONSOLE_MEDIA_MAX_BYTES,
  createConsoleMediaReader,
  type ConsoleMediaReadResult,
} from '../src/console/media.js';
import {
  GatewayConsoleBridge,
  type GatewayConsoleHub,
} from '../src/gateway-console-bridge.js';
import type { GatewayLinkEffectSink } from '../src/gateway-link.js';

const viewerA = 'egv1.AAAAAAAAAAAAAAAAAAAAAA' as ViewerId;
const viewerB = 'egv1.BBBBBBBBBBBBBBBBBBBBBB' as ViewerId;
let nextRequest = 0;
const request = (): RequestId =>
  `egr1.${String(++nextRequest).padStart(22, 'A')}` as RequestId;

function frame(
  value:
    | {
        type: 'viewer.open' | 'viewer.close' | 'viewer.snapshot';
        requestId: RequestId;
        viewerId: ViewerId;
      }
    | { type: 'console.input'; viewerId: ViewerId; payload: string }
    | { type: 'media.get'; requestId: RequestId; route: string },
): GatewayToResidentFrame {
  return {
    version: 1,
    connectionId: 'egx1.AAAAAAAAAAAAAAAAAAAAAA',
    seq: 2,
    ...value,
  } as GatewayToResidentFrame;
}

const meta = Object.freeze({
  gitHash: 'abc1234',
  treeClean: true,
  version: '1.2.3',
  versionTag: 'v1.2.3',
  versionLabel: '1.2.3',
  versionUrl: 'https://example.com/releases/v1.2.3',
  revisionUrl: 'https://example.com/commit/abc1234',
  exactRelease: true,
  buildState: 'release' as const,
  startedAt: 1,
  uptimeMs: 2,
  model: 'test/model',
  agentName: 'Aster',
});

function sources(overrides: Partial<HubSources> = {}): HubSources {
  return {
    usage: () => ({
      current: 1,
      window: 100,
      trigger: 80,
      triggerRatio: 0.8,
      ratio: 0.01,
      prompt: 1,
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
    meta: () => meta,
    archived: () => [],
    subUsage: () => null,
    ...overrides,
  };
}

function recorder(): HubClient & { readonly raw: string[] } {
  const raw: string[] = [];
  return { closed: false, raw, send: (data) => void raw.push(data) };
}

function effectRecorder(
  hooks: Partial<{
    operation: (effect: ResidentOperationResultEffect) => boolean;
    output: (effect: ResidentConsoleOutputEffect) => boolean;
    media: (effect: ResidentMediaResultEffect) => boolean;
  }> = {},
) {
  const order: string[] = [];
  const operations: ResidentOperationResultEffect[] = [];
  const outputs: ResidentConsoleOutputEffect[] = [];
  const media: ResidentMediaResultEffect[] = [];
  const sink: GatewayLinkEffectSink = {
    operationResult(effect) {
      operations.push(effect);
      order.push('operation:' + effect.operation);
      return hooks.operation?.(effect) ?? true;
    },
    consoleOutput(effect) {
      outputs.push(effect);
      order.push('output:' + JSON.parse(effect.payload).t);
      return hooks.output?.(effect) ?? true;
    },
    mediaResult(effect) {
      media.push(effect);
      order.push('media');
      return hooks.media?.(effect) ?? true;
    },
  };
  return { sink, order, operations, outputs, media };
}

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test('composed bridge preserves local snapshot bytes and makes snapshots fresh barriers', async () => {
  const accepted: string[] = [];
  let holdMeta = false;
  let releaseMeta: (() => void) | undefined;
  const hub = new ConsoleHub([
    { role: 'user', channel: 'internal', content: 'already present' },
  ]);
  hub.attach(
    sources({
      meta: async () => {
        if (holdMeta)
          await new Promise<void>((resolve) => {
            releaseMeta = resolve;
          });
        return meta;
      },
      chat: ({ content }) => {
        accepted.push(content);
        return { ok: true, note: 'accepted' };
      },
    }),
  );

  // The remote path must forward the ConsoleHub's existing serialized payload
  // byte-for-byte; it must not maintain a second snapshot representation.
  const local = recorder();
  await hub.addClient(local);
  assert.equal(local.raw.length, 1);
  hub.removeClient(local);

  const bridge = new GatewayConsoleBridge({
    hub,
    media: { read: async () => ({ ok: false, reason: 'not_found' }) },
  });
  const ordinary = effectRecorder();
  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewerA }),
    ordinary.sink,
  );
  await settle();
  assert.equal(ordinary.outputs.length, 1);
  assert.equal(ordinary.outputs[0].payload, local.raw[0]);
  assert.deepEqual(ordinary.order.slice(0, 2), [
    'operation:viewer.open',
    'output:snapshot',
  ]);
  bridge.handleFrame(
    frame({ type: 'viewer.close', requestId: request(), viewerId: viewerA }),
    ordinary.sink,
  );

  // Re-entering from the open-result writer occurs before addClient. Possessing
  // the bridge client identity must not authorize input or receive a delta.
  let hostile!: ReturnType<typeof effectRecorder>;
  hostile = effectRecorder({
    operation(effect) {
      if (effect.operation === 'viewer.open' && effect.viewerId === viewerB) {
        bridge.handleFrame(
          frame({
            type: 'console.input',
            viewerId: viewerB,
            payload: JSON.stringify({
              t: 'chat',
              nonce: 'early-input-0001',
              content: 'must not enter',
            }),
          }),
          hostile.sink,
        );
        hub.messageAppended({
          role: 'user',
          channel: 'internal',
          content: 'committed during open',
        });
      }
      return true;
    },
  });
  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewerB }),
    hostile.sink,
  );
  await settle();
  assert.deepEqual(accepted, []);
  assert.deepEqual(hostile.order.slice(0, 2), [
    'operation:viewer.open',
    'output:snapshot',
  ]);
  const openingSnapshot = JSON.parse(hostile.outputs[0].payload);
  assert.equal(openingSnapshot.t, 'snapshot');
  assert.equal(
    openingSnapshot.messages.at(-1).content,
    'committed during open',
  );

  bridge.handleFrame(
    frame({
      type: 'console.input',
      viewerId: viewerA,
      payload: JSON.stringify({
        t: 'chat',
        nonce: 'stale-input-0001',
        content: 'stale viewer',
      }),
    }),
    hostile.sink,
  );
  bridge.handleFrame(
    frame({
      type: 'console.input',
      viewerId: viewerB,
      payload: JSON.stringify({
        t: 'chat',
        nonce: 'valid-input-0001',
        content: 'attached viewer',
      }),
    }),
    hostile.sink,
  );
  assert.deepEqual(accepted, ['attached viewer']);

  // An explicit refresh awaits live sources. Deltas may precede it, but the
  // correlated result is emitted only after a snapshot containing that state.
  holdMeta = true;
  const snapshotId = request();
  const barrierStart = hostile.order.length;
  bridge.handleFrame(
    frame({
      type: 'viewer.snapshot',
      requestId: snapshotId,
      viewerId: viewerB,
    }),
    hostile.sink,
  );
  await settle();
  assert.equal(typeof releaseMeta, 'function');
  hub.messageAppended({
    role: 'assistant',
    channel: 'internal',
    content: 'newest committed state',
  });
  releaseMeta?.();
  await settle();
  const barrierOrder = hostile.order.slice(barrierStart);
  assert.ok(barrierOrder.indexOf('output:message') >= 0);
  assert.ok(
    barrierOrder.indexOf('output:message') <
      barrierOrder.indexOf('output:snapshot'),
  );
  assert.deepEqual(barrierOrder.slice(-2), [
    'output:snapshot',
    'operation:viewer.snapshot',
  ]);
  assert.equal(hostile.operations.at(-1)?.requestId, snapshotId);
  const fresh = JSON.parse(hostile.outputs.at(-1)!.payload);
  assert.equal(fresh.t, 'snapshot');
  assert.equal(fresh.messages.at(-1).content, 'newest committed state');
});

test('disconnect, backpressure, reconnect, and stop leave no ghost clients', async () => {
  const accepted: string[] = [];
  let holdSnapshot = false;
  let releaseSnapshot: (() => void) | undefined;
  const hub = new ConsoleHub();
  hub.attach(
    sources({
      meta: async () => {
        if (holdSnapshot)
          await new Promise<void>((resolve) => {
            releaseSnapshot = resolve;
          });
        return meta;
      },
      chat: ({ content }) => {
        accepted.push(content);
        return { ok: true, note: 'accepted' };
      },
    }),
  );
  let finishMedia!: (value: ConsoleMediaReadResult) => void;
  const pendingMedia = new Promise<ConsoleMediaReadResult>((resolve) => {
    finishMedia = resolve;
  });
  const bridge = new GatewayConsoleBridge({
    hub,
    media: { read: () => pendingMedia },
  });

  const old = effectRecorder();
  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewerA }),
    old.sink,
  );
  await settle();
  holdSnapshot = true;
  const staleSnapshotId = request();
  bridge.handleFrame(
    frame({
      type: 'viewer.snapshot',
      requestId: staleSnapshotId,
      viewerId: viewerA,
    }),
    old.sink,
  );
  await settle();
  assert.equal(typeof releaseSnapshot, 'function');
  const oldOutputCount = old.outputs.length;
  const staleMediaId = request();
  bridge.handleFrame(
    frame({
      type: 'media.get',
      requestId: staleMediaId,
      route: '/attachments/message/image.png',
    }),
    old.sink,
  );
  bridge.disconnect();
  holdSnapshot = false;
  hub.messageAppended({
    role: 'assistant',
    channel: 'internal',
    content: 'after disconnect',
  });
  assert.equal(old.outputs.length, oldOutputCount);
  bridge.handleFrame(
    frame({
      type: 'console.input',
      viewerId: viewerA,
      payload: JSON.stringify({
        t: 'chat',
        nonce: 'detached-input-01',
        content: 'detached',
      }),
    }),
    old.sink,
  );
  assert.deepEqual(accepted, []);

  let writable = true;
  const current = effectRecorder({ output: () => writable });
  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewerA }),
    current.sink,
  );
  await settle();
  assert.equal(current.outputs.length, 1);
  releaseSnapshot?.();
  await settle();
  assert.equal(
    old.operations.some((effect) => effect.requestId === staleSnapshotId),
    false,
  );
  assert.equal(old.outputs.length, oldOutputCount);
  hub.messageAppended({
    role: 'assistant',
    channel: 'internal',
    content: 'only the reconnect',
  });
  assert.deepEqual(
    current.outputs.slice(1).map((effect) => JSON.parse(effect.payload).t),
    ['message', 'usage', 'rooms'],
  );
  assert.equal(old.outputs.length, oldOutputCount);

  // A false sink write is the link's backpressure/failure signal. The remote
  // HubClient closes and detaches synchronously, so it cannot retain authority.
  writable = false;
  hub.messageAppended({
    role: 'assistant',
    channel: 'internal',
    content: 'write fails',
  });
  const failedOutputCount = current.outputs.length;
  hub.messageAppended({
    role: 'assistant',
    channel: 'internal',
    content: 'must not reach failed sink',
  });
  assert.equal(current.outputs.length, failedOutputCount);
  bridge.handleFrame(
    frame({
      type: 'console.input',
      viewerId: viewerA,
      payload: JSON.stringify({
        t: 'chat',
        nonce: 'failed-input-001',
        content: 'failed sink',
      }),
    }),
    current.sink,
  );
  assert.deepEqual(accepted, []);

  const newest = effectRecorder();
  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewerA }),
    newest.sink,
  );
  await settle();
  assert.equal(newest.outputs.length, 1);
  bridge.stop();
  bridge.stop();
  hub.messageAppended({
    role: 'assistant',
    channel: 'internal',
    content: 'after stop',
  });
  assert.equal(newest.outputs.length, 1);

  finishMedia({
    ok: true,
    bytes: Buffer.from('stale'),
    mediaType: 'image/png',
    byteLength: 5,
    sha256: createHash('sha256').update('stale').digest('hex'),
  });
  await settle();
  assert.deepEqual(old.media, []);
});

test('media effects preserve local bytes while remaining bounded and path-free', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-bridge-media-'));
  const attachments = path.join(root, 'attachments');
  const message = path.join(attachments, 'message-1');
  fs.mkdirSync(message, { recursive: true });
  const bytes = Buffer.from([0, 1, 2, 0xff, 0x80, 0x41]);
  fs.writeFileSync(path.join(message, 'image.png'), bytes);
  const large = path.join(message, 'large.bin');
  fs.writeFileSync(large, '');
  fs.truncateSync(large, CONSOLE_MEDIA_MAX_BYTES + 1);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const mediaReader = createConsoleMediaReader({
    dataDirectory: root,
    attachmentDirectory: attachments,
  });
  const local = await mediaReader.read('/attachments/message-1/image.png');
  assert.equal(local.ok, true);
  const bridge = new GatewayConsoleBridge({
    hub: new ConsoleHub(),
    media: mediaReader,
  });
  const written = effectRecorder();
  const routes = [
    '/attachments/message-1/image.png',
    '/attachments/message-1/large.bin',
    '/attachments/../outside/secret.txt',
  ];
  for (const route of routes)
    bridge.handleFrame(
      frame({ type: 'media.get', requestId: request(), route }),
      written.sink,
    );
  for (let turn = 0; written.media.length < 3 && turn < 100; turn++)
    await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(written.media.length, 3);
  const success = written.media.find((effect) => effect.ok);
  assert.ok(success?.ok);
  assert.deepEqual(Buffer.from(success.data, 'base64'), bytes);
  assert.equal(success.byteLength, bytes.length);
  assert.equal(
    success.sha256,
    createHash('sha256').update(bytes).digest('hex'),
  );
  if (local.ok) {
    assert.deepEqual(Buffer.from(success.data, 'base64'), local.bytes);
    assert.equal(success.mediaType, local.mediaType);
  }
  assert.deepEqual(
    written.media
      .filter((effect) => !effect.ok)
      .map((effect) => effect.error.code)
      .sort(),
    ['invalid_route', 'too_large'],
  );
  const publicEffects = JSON.stringify(written.media);
  assert.equal(publicEffects.includes(root), false);
  assert.equal(publicEffects.includes('outside/secret.txt'), false);
  assert.equal(publicEffects.includes('/attachments/'), false);
});

test('shutdown is synchronous, idempotent, and attempts every hostile detach', async () => {
  const clients: HubClient[] = [];
  let detachCalls = 0;
  const hub: GatewayConsoleHub = {
    async addClient(client) {
      clients.push(client);
    },
    removeClient() {
      detachCalls += 1;
      throw new Error('hostile detach');
    },
    async sendSnapshot() {
      return true;
    },
    handleClientMessage() {},
  };
  const bridge = new GatewayConsoleBridge({
    hub,
    media: { read: async () => ({ ok: false, reason: 'not_found' }) },
  });
  const written = effectRecorder();
  for (const viewerId of [viewerA, viewerB])
    bridge.handleFrame(
      frame({ type: 'viewer.open', requestId: request(), viewerId }),
      written.sink,
    );
  await settle();
  assert.equal(clients.length, 2);
  assert.doesNotThrow(() => bridge.stop());
  assert.doesNotThrow(() => bridge.stop());
  assert.equal(detachCalls, 2);
  assert.equal(
    clients.every((client) => client.closed),
    true,
  );

  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewerA }),
    written.sink,
  );
  assert.equal(clients.length, 2);
});
