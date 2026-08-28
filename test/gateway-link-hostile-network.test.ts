import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import {
  LIMITS,
  PROTOCOL_VERSION,
  RESIDENT_CONTROL_PATHS,
  createGatewayHelloAck,
  createNodeCredential,
  createProtocolError,
  serializeGatewayFrame,
  type ConnectionId,
  type InstanceId,
} from '@elpis/gateway-protocol';
import {
  GatewayLinkController,
  WsGatewayLinkSocket,
  type GatewayLinkStatus,
} from '../src/gateway-link.js';
import type { GatewayResidentSnapshot } from '../src/store/gateway-resident.js';

const ORIGIN = 'https://gateway.example';
const INSTANCE = 'egi1.AAAAAAAAAAAAAAAAAAAAAA' as InstanceId;
const OTHER_CONNECTION = 'egx1.BBBBBBBBBBBBBBBBBBBBBB' as ConnectionId;

type Hello = {
  readonly connectionId: ConnectionId;
  readonly instanceId: InstanceId;
};

type Attack = {
  readonly name: string;
  readonly expectedCloseCode: number;
  readonly expectedCloseReason?: string;
  readonly reachesReady?: boolean;
  readonly send: (socket: WebSocket, hello: Hello) => void;
};

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(label + ' timed out');
}

function snapshot(credentialId: string): GatewayResidentSnapshot {
  return Object.freeze({
    instanceId: INSTANCE,
    phase: 'active',
    endpoint: ORIGIN,
    displayName: 'hostile network witness',
    requestId: null,
    activeCredentialId: credentialId,
    pendingCredentialId: null,
    createdAt: 1,
    updatedAt: 1,
    enrollmentStartedAt: 1,
    activatedAt: 1,
    rotationStartedAt: null,
  });
}

function ack(hello: Hello, connectionId = hello.connectionId, seq = 1): string {
  return serializeGatewayFrame(
    createGatewayHelloAck({
      connectionId,
      seq,
      instanceId: hello.instanceId,
      capabilities: ['identity.v1'],
    }),
  );
}

async function runAttack(attack: Attack): Promise<void> {
  const node = createNodeCredential();
  const state = snapshot(node.id);
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    maxPayload: LIMITS.frameBytes,
    perMessageDeflate: false,
  });
  const statuses: GatewayLinkStatus[] = [];
  const requested: Array<{ url: string; connectionId: string }> = [];
  let serverError: Error | null = null;
  let closeReceipt: { code: number; reason: string } | null = null;
  let controller: GatewayLinkController | null = null;

  server.on('connection', (socket) => {
    socket.on('error', () => undefined);
    socket.on('close', (code, reason) => {
      closeReceipt = { code, reason: reason.toString() };
    });
    socket.once('message', (data, binary) => {
      try {
        assert.equal(binary, false);
        const parsed = JSON.parse(data.toString()) as Hello & {
          type?: unknown;
        };
        assert.equal(parsed.type, 'hello');
        attack.send(socket, parsed);
      } catch (error) {
        serverError =
          error instanceof Error ? error : new Error('attack failed');
        socket.terminate();
      }
    });
  });

  try {
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('hostile server did not bind TCP');
    const localUrl =
      'ws://127.0.0.1:' + address.port + RESIDENT_CONTROL_PATHS.link;
    const expectedUrl = 'wss://gateway.example' + RESIDENT_CONTROL_PATHS.link;
    controller = new GatewayLinkController({
      remote: { url: ORIGIN, enrollmentToken: null },
      store: {
        read: () => state,
        activeNodeToken: () => node.token,
      },
      identity: { name: 'Hostile witness' },
      build: { version: '1.2.3' },
      retryBaseMs: 10_000,
      retryMaxMs: 10_000,
      random: () => 0,
      socketFactory: (url, options) => {
        assert.equal(url, expectedUrl);
        assert.deepEqual(Object.keys(options).sort(), [
          'authorization',
          'connectionId',
          'maxPayload',
          'perMessageDeflate',
        ]);
        requested.push({ url, connectionId: options.connectionId });
        return new WsGatewayLinkSocket(localUrl, options);
      },
      events: { status: (status) => statuses.push(status) },
    });
    controller.start();

    await waitFor(
      attack.name + ' rejection',
      () =>
        statuses.some((status) => status.state === 'backoff') &&
        closeReceipt !== null,
    );
    if (serverError !== null) throw serverError;
    assert.equal(requested.length, 1);
    assert.equal(closeReceipt!.code, attack.expectedCloseCode);
    if (attack.expectedCloseReason !== undefined)
      assert.equal(closeReceipt!.reason, attack.expectedCloseReason);
    assert.equal(
      statuses.some((status) => status.state === 'ready'),
      attack.reachesReady === true,
    );
    assert.deepEqual(statuses.at(-1), { state: 'backoff', failures: 1 });

    const statusEvidence = JSON.stringify(statuses);
    assert.equal(statusEvidence.includes(node.token), false);
    assert.equal(statusEvidence.includes(ORIGIN), false);
    assert.equal(statusEvidence.toLowerCase().includes('authorization'), false);
    const publicEvidence = JSON.stringify({ requested, closeReceipt });
    assert.equal(publicEvidence.includes(node.token), false);
    assert.equal(publicEvidence.toLowerCase().includes('authorization'), false);
  } finally {
    controller?.stop();
    for (const socket of server.clients) socket.terminate();
    if (server.address() !== null)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const attacks: readonly Attack[] = [
  {
    name: 'binary frame',
    expectedCloseCode: 1002,
    expectedCloseReason: 'binary_frame',
    send: (socket) => socket.send(Buffer.from('{}'), { binary: true }),
  },
  {
    name: 'invalid UTF-8 text',
    expectedCloseCode: 1007,
    send: (socket) => socket.send(Buffer.from([0xc3, 0x28]), { binary: false }),
  },
  {
    name: 'over-limit text',
    expectedCloseCode: 1009,
    send: (socket) =>
      socket.send(Buffer.alloc(LIMITS.frameBytes + 1, 0x20), { binary: false }),
  },
  {
    name: 'wrong acknowledgement connection',
    expectedCloseCode: 1002,
    expectedCloseReason: 'protocol_error',
    send: (socket, hello) => socket.send(ack(hello, OTHER_CONNECTION)),
  },
  {
    name: 'wrong acknowledgement sequence',
    expectedCloseCode: 1002,
    expectedCloseReason: 'protocol_error',
    send: (socket, hello) => socket.send(ack(hello, hello.connectionId, 2)),
  },
  {
    name: 'fatal post-ack protocol error',
    expectedCloseCode: 1002,
    expectedCloseReason: 'fatal_error',
    reachesReady: true,
    send: (socket, hello) => {
      socket.send(ack(hello));
      socket.send(
        serializeGatewayFrame(
          createProtocolError({
            connectionId: hello.connectionId,
            seq: 2,
            error: { code: 'invalid_frame', message: 'bounded hostile error' },
            fatal: true,
          }),
        ),
      );
    },
  },
  {
    name: 'abnormal transport close',
    expectedCloseCode: 1006,
    send: (socket) => socket.terminate(),
  },
];

test('production outbound socket rejects hostile network frames without secret-bearing status', async (t) => {
  assert.equal(PROTOCOL_VERSION, 1);
  for (const attack of attacks)
    await t.test(attack.name, () => runAttack(attack));
});
