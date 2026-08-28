import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  RESIDENT_CONTROL_HEADERS,
  RESIDENT_CONTROL_PATHS,
  createNodeCredential,
  formatNodeBearerAuthorization,
  newGatewayInstanceId,
  type ConnectionId,
  type RequestId,
} from '@elpis/gateway-protocol';
import {
  GATEWAY_BROWSER_RELAY_PATH,
  GatewayBrowserRelayConnection,
  GatewayResidentLinkRegistry,
  createGatewayHttpService,
  openGatewayStore,
  type GatewayBrowserRelaySocketHandlers,
} from '../src/index.js';

const ORIGIN = 'https://gateway.example';
const CONNECTION = 'egx1.AAAAAAAAAAAAAAAAAAAAAA' as ConnectionId;
const CLIENT_A = 'egr1.AAAAAAAAAAAAAAAAAAAAAA' as RequestId;
const CLIENT_B = 'egr1.BBBBBBBBBBBBBBBBBBBBBB' as RequestId;

class Inbox {
  readonly seen: Record<string, any>[] = [];
  readonly #queued: Record<string, any>[] = [];
  readonly #waiting: Array<{
    resolve: (value: Record<string, any>) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on('message', (data, binary) => {
      if (binary) {
        this.#waiting.shift()?.reject(new Error('unexpected binary frame'));
        return;
      }
      let value: Record<string, any>;
      try {
        value = JSON.parse(data.toString());
      } catch {
        this.#waiting.shift()?.reject(new Error('invalid JSON frame'));
        return;
      }
      this.seen.push(value);
      const waiter = this.#waiting.shift();
      if (waiter) waiter.resolve(value);
      else this.#queued.push(value);
    });
  }

  next(): Promise<Record<string, any>> {
    const queued = this.#queued.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) =>
      this.#waiting.push({ resolve, reject }),
    );
  }
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function closed(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

function rejected(
  url: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers,
      perMessageDeflate: false,
    });
    socket.once('open', () =>
      reject(new Error('unexpected WebSocket upgrade')),
    );
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.on('error', () => undefined);
  });
}

async function fixture(
  t: Parameters<Parameters<typeof test>[1]>[0],
  browserRelayMaxConnections?: number,
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-browser-relay-'),
  );
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway');
  const store = openGatewayStore(path.join(directory, 'data'), {
    now: () => 1_000,
  });
  store.setPublicUrl(ORIGIN);
  const node = createNodeCredential();
  const instanceId = newGatewayInstanceId();
  const grant = store.credentials.createEnrollmentGrant();
  store.credentials.enroll({
    grantToken: grant.token,
    instanceId,
    displayName: 'relay resident',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const registry = new GatewayResidentLinkRegistry({
    clock: {
      now: Date.now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    supportedCapabilities: CAPABILITIES,
    audit: () => {},
  });
  const service = createGatewayHttpService({
    publicRoot,
    listen: { host: '127.0.0.1', port: 0 },
    store,
    residentCredentialStore: store.credentials,
    residentLinkRegistry: registry,
    residentRateLimiter: { allow: () => true },
    shutdownGraceMs: 200,
    ...(browserRelayMaxConnections === undefined
      ? {}
      : { browserRelayMaxConnections }),
  });
  const address = await service.start();
  t.after(async () => {
    await service.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    service,
    registry,
    instanceId,
    token: node.token,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

async function connectResident(f: Awaited<ReturnType<typeof fixture>>) {
  const socket = new WebSocket(f.url + RESIDENT_CONTROL_PATHS.link, {
    headers: {
      Authorization: formatNodeBearerAuthorization(f.token),
      [RESIDENT_CONTROL_HEADERS.connectionId]: CONNECTION,
    },
    perMessageDeflate: false,
  });
  const inbox = new Inbox(socket);
  await opened(socket);
  socket.send(
    JSON.stringify({
      version: PROTOCOL_VERSION,
      connectionId: CONNECTION,
      seq: 1,
      type: 'hello',
      instanceId: f.instanceId,
      capabilities: ['console.v1', 'identity.v1', 'media.v1'],
      identity: { name: 'relay resident' },
      build: { version: '1' },
    }),
  );
  assert.equal((await inbox.next()).type, 'hello.ack');
  return { socket, inbox };
}

async function connectBrowser(
  url: string,
): Promise<{ socket: WebSocket; inbox: Inbox }> {
  const socket = new WebSocket(url + GATEWAY_BROWSER_RELAY_PATH, {
    headers: { Origin: ORIGIN },
    perMessageDeflate: false,
  });
  const inbox = new Inbox(socket);
  await opened(socket);
  return { socket, inbox };
}

test('browser relay enforces exact Origin and target before upgrade', async (t) => {
  const f = await fixture(t);
  assert.equal(await rejected(f.url + GATEWAY_BROWSER_RELAY_PATH), 403);
  assert.equal(
    await rejected(f.url + GATEWAY_BROWSER_RELAY_PATH, {
      Origin: 'https://wrong.example',
    }),
    403,
  );
  assert.equal(
    await rejected(f.url + GATEWAY_BROWSER_RELAY_PATH + '?x=1', {
      Origin: ORIGIN,
    }),
    404,
  );
});

test('browser relay capacity rejects then recovers after exact close', async (t) => {
  const f = await fixture(t, 1);
  const first = await connectBrowser(f.url);
  assert.equal(
    await rejected(f.url + GATEWAY_BROWSER_RELAY_PATH, { Origin: ORIGIN }),
    429,
  );
  const firstClosed = closed(first.socket);
  first.socket.close(1000, 'done');
  await firstClosed;
  const replacement = await connectBrowser(f.url);
  const replacementClosed = closed(replacement.socket);
  replacement.socket.close(1000, 'done');
  await replacementClosed;
});

test('browser relay carries snapshot, input, reverse media correlation, and close', async (t) => {
  const f = await fixture(t);
  const resident = await connectResident(f);
  const browser = await connectBrowser(f.url);

  browser.socket.send(
    JSON.stringify({ type: 'viewer.select', instanceId: f.instanceId }),
  );
  assert.deepEqual(await browser.inbox.next(), {
    type: 'viewer.selection',
    reason: 'selected',
    generation: 1,
    phase: 'opening',
    instanceId: f.instanceId,
  });
  const open = await resident.inbox.next();
  assert.equal(open.type, 'viewer.open');

  resident.socket.send(
    JSON.stringify({
      version: 1,
      connectionId: CONNECTION,
      seq: 2,
      type: 'operation.result',
      requestId: open.requestId,
      viewerId: open.viewerId,
      operation: 'viewer.open',
      ok: true,
    }),
  );
  assert.equal((await browser.inbox.next()).reason, 'snapshot');
  const snapshot = await resident.inbox.next();
  assert.equal(snapshot.type, 'viewer.snapshot');
  resident.socket.send(
    JSON.stringify({
      version: 1,
      connectionId: CONNECTION,
      seq: 3,
      type: 'console.output',
      viewerId: open.viewerId,
      payload: '{"type":"snapshot","value":"fresh"}',
    }),
  );
  resident.socket.send(
    JSON.stringify({
      version: 1,
      connectionId: CONNECTION,
      seq: 4,
      type: 'operation.result',
      requestId: snapshot.requestId,
      viewerId: open.viewerId,
      operation: 'viewer.snapshot',
      ok: true,
    }),
  );
  assert.deepEqual(await browser.inbox.next(), {
    type: 'console.output',
    payload: '{"type":"snapshot","value":"fresh"}',
  });
  assert.equal((await browser.inbox.next()).reason, 'ready');

  browser.socket.send(
    JSON.stringify({ type: 'console.input', payload: 'hello' }),
  );
  const input = await resident.inbox.next();
  assert.deepEqual(
    { type: input.type, viewerId: input.viewerId, payload: input.payload },
    { type: 'console.input', viewerId: open.viewerId, payload: 'hello' },
  );

  browser.socket.send(
    JSON.stringify({
      type: 'media.get',
      requestId: CLIENT_A,
      route: '/identity/avatar',
    }),
  );
  browser.socket.send(
    JSON.stringify({
      type: 'media.get',
      requestId: CLIENT_B,
      route: '/frames/watch/example/frame.png',
    }),
  );
  const mediaA = await resident.inbox.next();
  const mediaB = await resident.inbox.next();
  assert.equal(mediaA.type, 'media.get');
  assert.equal(mediaB.type, 'media.get');
  resident.socket.send(
    JSON.stringify({
      version: 1,
      connectionId: CONNECTION,
      seq: 5,
      type: 'media.result',
      requestId: mediaB.requestId,
      ok: false,
      error: { code: 'not_found', message: 'second' },
    }),
  );
  resident.socket.send(
    JSON.stringify({
      version: 1,
      connectionId: CONNECTION,
      seq: 6,
      type: 'media.result',
      requestId: mediaA.requestId,
      ok: false,
      error: { code: 'not_found', message: 'first' },
    }),
  );
  const browserMediaB = await browser.inbox.next();
  const browserMediaA = await browser.inbox.next();
  assert.deepEqual(
    [browserMediaB.requestId, browserMediaA.requestId],
    [CLIENT_B, CLIENT_A],
  );

  const browserClosed = closed(browser.socket);
  browser.socket.close(1000, 'done');
  const close = await resident.inbox.next();
  assert.equal(close.type, 'viewer.close');
  assert.equal(close.viewerId, open.viewerId);
  assert.equal((await browserClosed).code, 1000);
  resident.socket.send(
    JSON.stringify({
      version: 1,
      connectionId: CONNECTION,
      seq: 7,
      type: 'operation.result',
      requestId: close.requestId,
      viewerId: open.viewerId,
      operation: 'viewer.close',
      ok: true,
    }),
  );
  const residentClosed = closed(resident.socket);
  resident.socket.close(1000, 'done');
  await residentClosed;
});

test('browser relay rejects binary and malformed text with exact closes', async (t) => {
  const f = await fixture(t);
  const binary = await connectBrowser(f.url);
  const binaryClosed = closed(binary.socket);
  binary.socket.send(Buffer.from('{}'), { binary: true });
  assert.deepEqual(await binaryClosed, { code: 1003, reason: 'text_required' });

  const malformed = await connectBrowser(f.url);
  const malformedClosed = closed(malformed.socket);
  malformed.socket.send('{');
  assert.deepEqual(await malformedClosed, {
    code: 1008,
    reason: 'invalid_frame',
  });
});

test('browser relay attach close and throw are failure atomic', () => {
  const registry = new GatewayResidentLinkRegistry({
    clock: {
      now: () => 1,
      setTimeout: () => 1,
      clearTimeout: () => {},
    },
    supportedCapabilities: CAPABILITIES,
    audit: () => {},
  });
  let detached = 0;
  let disconnected = 0;
  const relay = new GatewayBrowserRelayConnection({
    registry,
    socket: {
      bufferedAmount: 0,
      sendText: () => {},
      close: () => {},
      attach: (handlers: GatewayBrowserRelaySocketHandlers) => {
        handlers.close();
        return () => {
          detached += 1;
        };
      },
    },
    onDisconnect: () => {
      disconnected += 1;
    },
  });
  assert.equal(relay.state.phase, 'closed');
  assert.equal(detached, 1);
  assert.equal(disconnected, 1);
  relay.disconnect();
  assert.equal(disconnected, 1);

  let failedDisconnect = 0;
  assert.throws(
    () =>
      new GatewayBrowserRelayConnection({
        registry,
        socket: {
          bufferedAmount: 0,
          sendText: () => {},
          close: () => {},
          attach: () => {
            throw new Error('attach failed');
          },
        },
        onDisconnect: () => {
          failedDisconnect += 1;
        },
      }),
    /attach failed/,
  );
  assert.equal(failedDisconnect, 1);
});
