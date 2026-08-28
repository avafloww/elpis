import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import {
  CAPABILITIES,
  LIMITS,
  PROTOCOL_VERSION,
  RESIDENT_CONTROL_PATHS,
  createNodeCredential,
  formatNodeBearerAuthorization,
  newGatewayInstanceId,
  type ConnectionId,
} from '@elpis/gateway-protocol';
import {
  GatewayResidentLinkRegistry,
  createGatewayHttpService,
  createGatewayResidentLinkAuditWriter,
  openGatewayStore,
  type GatewayHttpService,
  type GatewayStore,
} from '../src/index.js';

const CONNECTIONS = [
  'egx1.AAAAAAAAAAAAAAAAAAAAAA',
  'egx1.BBBBBBBBBBBBBBBBBBBBBB',
  'egx1.CCCCCCCCCCCCCCCCCCCCCC',
  'egx1.DDDDDDDDDDDDDDDDDDDDDD',
  'egx1.EEEEEEEEEEEEEEEEEEEEEE',
] as ConnectionId[];

type Fixture = {
  directory: string;
  store: GatewayStore;
  service: GatewayHttpService;
  registry: GatewayResidentLinkRegistry;
  instanceId: string;
  token: string;
  credentialId: string;
  url: string;
};

async function fixture(
  t: Parameters<Parameters<typeof test>[1]>[0],
  timeout = 100,
): Promise<Fixture> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-resident-ws-'),
  );
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway');
  const store = openGatewayStore(path.join(directory, 'data'), {
    now: () => 1_000,
  });
  const node = createNodeCredential();
  const instanceId = newGatewayInstanceId();
  const grant = store.credentials.createEnrollmentGrant();
  store.credentials.enroll({
    grantToken: grant.token,
    instanceId,
    displayName: 'network resident',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  let nextConnection = 0;
  const registry = new GatewayResidentLinkRegistry({
    createConnectionId: () => CONNECTIONS[nextConnection++]!,
    clock: {
      now: Date.now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    supportedCapabilities: CAPABILITIES,
    audit: createGatewayResidentLinkAuditWriter(store),
    handshakeTimeoutMs: timeout,
  });
  const service = createGatewayHttpService({
    publicRoot,
    listen: { host: '127.0.0.1', port: 0 },
    store,
    residentCredentialStore: store.credentials,
    residentLinkRegistry: registry,
    residentRateLimiter: { allow: () => true },
    shutdownGraceMs: 200,
  });
  const address = await service.start();
  t.after(async () => {
    await service.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    store,
    service,
    registry,
    instanceId,
    token: node.token,
    credentialId: node.id,
    url: 'ws://127.0.0.1:' + address.port,
  };
}

function open(url: string, authorization: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: { Authorization: authorization },
      perMessageDeflate: false,
    });
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function close(socket: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

function message(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, binary) =>
      binary
        ? reject(new Error('unexpected binary response'))
        : resolve(data.toString()),
    );
  });
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([0x13, 0x37, 0x42, 0x99]);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, 0x80 | payload.length])
      : Buffer.from([0x81, 0xfe, payload.length >>> 8, payload.length & 0xff]);
  const masked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1)
    masked[index] = payload[index]! ^ mask[index % 4]!;
  return Buffer.concat([header, mask, masked]);
}

function pipelinedHello(
  url: string,
  authorization: string,
  wire: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = net.createConnection({
      host: target.hostname,
      port: Number(target.port),
    });
    let bytes = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error, value?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new Error('pipelined WebSocket response timed out')),
      2_000,
    );
    socket.on('error', (error) => finish(error));
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      const headerEnd = bytes.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = bytes.subarray(0, headerEnd).toString('ascii');
      if (!headers.startsWith('HTTP/1.1 101 ')) {
        finish(new Error('pipelined upgrade was rejected'));
        return;
      }
      const frame = bytes.subarray(headerEnd + 4);
      if (frame.length < 2) return;
      const shortLength = frame[1]! & 0x7f;
      const offset = shortLength === 126 ? 4 : 2;
      if (shortLength === 127) {
        finish(new Error('unexpected 64-bit response frame'));
        return;
      }
      if (frame.length < offset) return;
      const length =
        shortLength === 126 ? frame.readUInt16BE(2) : shortLength;
      if (frame.length < offset + length) return;
      finish(undefined, frame.subarray(offset, offset + length).toString());
    });
    socket.on('connect', () => {
      const key = Buffer.alloc(16, 0x5a).toString('base64');
      const request =
        `GET ${target.pathname} HTTP/1.1\r\n` +
        `Host: ${target.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        `Authorization: ${authorization}\r\n\r\n`;
      socket.write(Buffer.concat([Buffer.from(request), maskedTextFrame(wire)]));
    });
  });
}

function hello(instanceId: string, connectionId: ConnectionId): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    connectionId,
    seq: 1,
    type: 'hello',
    instanceId,
    capabilities: ['console.v1', 'identity.v1'],
    identity: { name: 'resident' },
    build: { version: '1' },
  });
}

function rejected(
  url: string,
  headers: Record<string, string | string[]>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers, perMessageDeflate: false });
    socket.once('open', () =>
      reject(new Error('unexpected WebSocket upgrade')),
    );
    socket.once('unexpected-response', (_request, response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString(),
        }),
      );
      response.resume();
    });
    socket.on('error', () => undefined);
  });
}

test('resident link configuration is all-or-none', async (t) => {
  const f = await fixture(t);
  const publicRoot = path.join(f.directory, 'public');
  assert.throws(() =>
    createGatewayHttpService({
      publicRoot,
      residentCredentialStore: f.store.credentials,
    }),
  );
  assert.throws(() =>
    createGatewayHttpService({
      publicRoot,
      residentLinkRegistry: f.registry,
    }),
  );
});

test('upgrade head preserves a pipelined first resident frame', async (t) => {
  const f = await fixture(t);
  const bearer = formatNodeBearerAuthorization(f.token);
  const response = await pipelinedHello(
    f.url + RESIDENT_CONTROL_PATHS.link,
    bearer,
    hello(f.instanceId, CONNECTIONS[0]!),
  );
  assert.equal(JSON.parse(response).type, 'hello.ack');
  assert.equal(f.registry.summary(f.instanceId)?.state, 'ready');
});

test('network resident link authenticates, preserves fragments, and acknowledges hello', async (t) => {
  const f = await fixture(t);
  const socket = await open(
    f.url + RESIDENT_CONTROL_PATHS.link,
    formatNodeBearerAuthorization(f.token),
  );
  const ack = message(socket);
  const wire = hello(f.instanceId, CONNECTIONS[0]!);
  const split = Math.floor(wire.length / 2);
  socket.send(wire.slice(0, split), { binary: false, fin: false });
  socket.send(wire.slice(split), { binary: false, fin: true });
  assert.deepEqual(JSON.parse(await ack), {
    version: 1,
    connectionId: CONNECTIONS[0],
    seq: 1,
    type: 'hello.ack',
    instanceId: f.instanceId,
    capabilities: ['console.v1', 'identity.v1'],
  });
  assert.equal(f.registry.summary(f.instanceId)?.state, 'ready');
  const ended = close(socket);
  socket.close(1000, 'done');
  assert.equal((await ended).code, 1000);
  const audit = f.store.audit();
  assert(audit.some((event) => event.action === 'gateway.resident.link.admitted'));
  assert(audit.some((event) => event.action === 'gateway.resident.link.ready'));
  const serialized = JSON.stringify(audit);
  assert(!serialized.includes(f.token));
  assert(!serialized.toLowerCase().includes('authorization'));
});

test('wrong, revoked, malformed, duplicate auth and wrong targets fail without credential echo', async (t) => {
  const f = await fixture(t);
  const bearer = formatNodeBearerAuthorization(f.token);
  const wrong = formatNodeBearerAuthorization(createNodeCredential().token);
  const failures = [
    await rejected(f.url + RESIDENT_CONTROL_PATHS.link, {
      Authorization: wrong,
    }),
    await rejected(f.url + RESIDENT_CONTROL_PATHS.link, {
      Authorization: 'bearer ' + f.token,
    }),
    await rejected(f.url + RESIDENT_CONTROL_PATHS.link + '?x=1', {
      Authorization: bearer,
    }),
    await rejected(
      f.url + RESIDENT_CONTROL_PATHS.link.replace('link', '%6cink'),
      { Authorization: bearer },
    ),
    await rejected(f.url + '/api/v1/resident/unknown', {
      Authorization: bearer,
    }),
    await rejected(f.url + RESIDENT_CONTROL_PATHS.link, {
      Authorization: bearer,
      Origin: 'https://browser.example',
    }),
    await rejected(f.url + RESIDENT_CONTROL_PATHS.link, {
      Authorization: [bearer, bearer],
    }),
  ];
  f.store.credentials.revokeCredential(f.credentialId);
  failures.push(
    await rejected(f.url + RESIDENT_CONTROL_PATHS.link, {
      Authorization: bearer,
    }),
  );
  for (const failure of failures) {
    assert([401, 404].includes(failure.status));
    assert.equal(failure.body, 'WebSocket upgrade rejected\n');
    assert(!failure.body.includes(f.token));
    assert(!failure.body.toLowerCase().includes('authorization'));
  }
});

test('duplicate live instance rejects before upgrade and reconnect succeeds after close', async (t) => {
  const f = await fixture(t);
  const bearer = formatNodeBearerAuthorization(f.token);
  const first = await open(f.url + RESIDENT_CONTROL_PATHS.link, bearer);
  const duplicate = await rejected(f.url + RESIDENT_CONTROL_PATHS.link, {
    Authorization: bearer,
  });
  assert.equal(duplicate.status, 409);
  const firstClosed = close(first);
  first.close();
  await firstClosed;
  const second = await open(f.url + RESIDENT_CONTROL_PATHS.link, bearer);
  const secondClosed = close(second);
  second.close();
  await secondClosed;
});

test('network frame limits, handshake timeout, and service shutdown close links', async (t) => {
  const f = await fixture(t, 50);
  const bearer = formatNodeBearerAuthorization(f.token);

  const waiting = await open(f.url + RESIDENT_CONTROL_PATHS.link, bearer);
  const timedOut = close(waiting);
  assert.equal((await timedOut).code, 1002);

  const binary = await open(f.url + RESIDENT_CONTROL_PATHS.link, bearer);
  const binaryClosed = close(binary);
  binary.send(Buffer.from('{}'), { binary: true });
  assert.equal((await binaryClosed).code, 1002);

  const invalidUtf8 = await open(f.url + RESIDENT_CONTROL_PATHS.link, bearer);
  const utf8Closed = close(invalidUtf8);
  invalidUtf8.send(Buffer.from([0xff]), { binary: false });
  assert.equal((await utf8Closed).code, 1007);

  const oversized = await open(f.url + RESIDENT_CONTROL_PATHS.link, bearer);
  const oversizedClosed = close(oversized);
  oversized.send(Buffer.alloc(LIMITS.frameBytes + 1, 0x20), { binary: false });
  assert.equal((await oversizedClosed).code, 1002);

  const live = await open(f.url + RESIDENT_CONTROL_PATHS.link, bearer);
  const shutdownClose = close(live);
  await f.service.stop();
  assert.equal((await shutdownClose).code, 1001);
  assert.equal(f.registry.stopped, true);
  assert.equal(f.registry.size, 0);
  await assert.rejects(open(f.url + RESIDENT_CONTROL_PATHS.link, bearer));
});
