import assert from 'node:assert/strict';
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
  GatewayConsoleBridge,
  type GatewayConsoleHub,
} from '../src/gateway-console-bridge.js';
import type { ConsoleMediaReadResult } from '../src/console/media.js';
import type { HubClient } from '../src/console/hub.js';
import type { GatewayLinkEffectSink } from '../src/gateway-link.js';

const viewer = 'egv1.AAAAAAAAAAAAAAAAAAAAAA' as ViewerId;
let requestNumber = 0;
const request = (): RequestId =>
  `egr1.${String(++requestNumber).padStart(22, 'A')}` as RequestId;

function frame(
  value:
    | { type: 'viewer.open' | 'viewer.close' | 'viewer.snapshot'; requestId: RequestId; viewerId: ViewerId }
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

class FakeHub implements GatewayConsoleHub {
  readonly clients = new Set<HubClient>();
  readonly removed: HubClient[] = [];
  readonly inputs: string[] = [];
  snapshots = 0;

  async addClient(client: HubClient): Promise<void> {
    this.clients.add(client);
    client.send(JSON.stringify({ t: 'snapshot', number: ++this.snapshots }));
  }
  removeClient(client: HubClient): void {
    this.clients.delete(client);
    this.removed.push(client);
  }
  async sendSnapshot(client: HubClient): Promise<boolean> {
    client.send(JSON.stringify({ t: 'snapshot', number: ++this.snapshots }));
    return true;
  }
  handleClientMessage(_client: HubClient, raw: string): void {
    this.inputs.push(raw);
  }
}

function effects() {
  const order: string[] = [];
  const operations: ResidentOperationResultEffect[] = [];
  const outputs: ResidentConsoleOutputEffect[] = [];
  const media: ResidentMediaResultEffect[] = [];
  const sink: GatewayLinkEffectSink = {
    operationResult(effect) {
      operations.push(effect);
      order.push('operation:' + effect.operation);
      return true;
    },
    consoleOutput(effect) {
      outputs.push(effect);
      order.push('output');
      return true;
    },
    mediaResult(effect) {
      media.push(effect);
      order.push('media');
      return true;
    },
  };
  return { sink, order, operations, outputs, media };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test('GatewayConsoleBridge maps one HubClient per viewer and correlates operations', async () => {
  const hub = new FakeHub();
  const written = effects();
  const bridge = new GatewayConsoleBridge({
    hub,
    media: { read: async () => ({ ok: false, reason: 'not_found' }) },
  });

  const openId = request();
  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: openId, viewerId: viewer }),
    written.sink,
  );
  await tick();
  assert.equal(hub.clients.size, 1);
  assert.deepEqual(written.operations[0], {
    requestId: openId,
    viewerId: viewer,
    operation: 'viewer.open',
    ok: true,
  });
  assert.deepEqual(written.order.slice(0, 2), ['operation:viewer.open', 'output']);
  assert.equal(JSON.parse(written.outputs[0].payload).t, 'snapshot');

  bridge.handleFrame(
    frame({ type: 'console.input', viewerId: viewer, payload: '{"t":"backfill"}' }),
    written.sink,
  );
  assert.deepEqual(hub.inputs, ['{"t":"backfill"}']);

  const snapshotId = request();
  bridge.handleFrame(
    frame({ type: 'viewer.snapshot', requestId: snapshotId, viewerId: viewer }),
    written.sink,
  );
  await tick();
  assert.equal(written.operations.at(-1)?.requestId, snapshotId);
  assert.equal(hub.snapshots, 2);
  assert.deepEqual(written.order.slice(-2), [
    'output',
    'operation:viewer.snapshot',
  ]);

  const closeId = request();
  bridge.handleFrame(
    frame({ type: 'viewer.close', requestId: closeId, viewerId: viewer }),
    written.sink,
  );
  assert.equal(hub.clients.size, 0);
  assert.equal(hub.removed.length, 1);
  assert.deepEqual(written.operations.at(-1), {
    requestId: closeId,
    viewerId: viewer,
    operation: 'viewer.close',
    ok: true,
  });
});

test('GatewayConsoleBridge detaches on reconnect and fences stale media', async () => {
  const hub = new FakeHub();
  const written = effects();
  let finish!: (result: ConsoleMediaReadResult) => void;
  const pending = new Promise<ConsoleMediaReadResult>((resolve) => {
    finish = resolve;
  });
  const bridge = new GatewayConsoleBridge({
    hub,
    media: { read: () => pending },
  });

  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewer }),
    written.sink,
  );
  const mediaId = request();
  bridge.handleFrame(
    frame({ type: 'media.get', requestId: mediaId, route: '/attachments/a.png' }),
    written.sink,
  );
  bridge.disconnect();
  assert.equal(hub.clients.size, 0);
  assert.equal(hub.removed.length, 1);

  finish({
    ok: true,
    bytes: Buffer.from('stale'),
    mediaType: 'image/png',
    byteLength: 5,
    sha256: 'a'.repeat(64),
  });
  await tick();
  assert.deepEqual(written.media, []);

  bridge.handleFrame(
    frame({ type: 'viewer.open', requestId: request(), viewerId: viewer }),
    written.sink,
  );
  await tick();
  assert.equal(hub.clients.size, 1);
  bridge.stop();
  assert.equal(hub.clients.size, 0);
});

test('GatewayConsoleBridge returns bounded media as a typed base64 effect', async () => {
  const hub = new FakeHub();
  const written = effects();
  const bytes = Buffer.from('image bytes');
  const bridge = new GatewayConsoleBridge({
    hub,
    media: {
      read: async () => ({
        ok: true,
        bytes,
        mediaType: 'image/webp',
        byteLength: bytes.length,
        sha256: 'b'.repeat(64),
      }),
    },
  });
  const id = request();
  bridge.handleFrame(
    frame({ type: 'media.get', requestId: id, route: '/frames/browser/a.webp' }),
    written.sink,
  );
  await tick();
  assert.deepEqual(written.media, [
    {
      requestId: id,
      ok: true,
      mediaType: 'image/webp',
      byteLength: bytes.length,
      sha256: 'b'.repeat(64),
      data: bytes.toString('base64'),
    },
  ]);
});
