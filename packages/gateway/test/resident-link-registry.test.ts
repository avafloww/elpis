import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIMITS,
  PROTOCOL_VERSION,
  type ConnectionId,
  type InstanceId,
} from '@elpis/gateway-protocol';
import {
  GatewayResidentLinkRegistry,
  type GatewayResidentLinkAuditEvent,
  type GatewayResidentLinkClock,
  type GatewayResidentSocketHandlers,
} from '../src/resident-link-registry.js';

const INSTANCE = 'egi1.AAAAAAAAAAAAAAAAAAAAAA' as InstanceId;
const OTHER_INSTANCE = 'egi1.BBBBBBBBBBBBBBBBBBBBBB' as InstanceId;
const CONNECTIONS = [
  'egx1.AAAAAAAAAAAAAAAAAAAAAA',
  'egx1.BBBBBBBBBBBBBBBBBBBBBB',
  'egx1.CCCCCCCCCCCCCCCCCCCCCC',
] as ConnectionId[];

class FakeClock implements GatewayResidentLinkClock {
  time = 1_000;
  next = 1;
  timers = new Map<number, () => void>();
  now(): number {
    return this.time;
  }
  setTimeout(callback: () => void): unknown {
    const id = this.next++;
    this.timers.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  fireAll(): void {
    const callbacks = [...this.timers.values()];
    this.timers.clear();
    for (const callback of callbacks) callback();
  }
}
class FakeSocket {
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  handlers?: GatewayResidentSocketHandlers;
  attach(handlers: GatewayResidentSocketHandlers): () => void {
    this.handlers = handlers;
    return () => {
      /* retain callback to exercise stale-event safety */
    };
  }
  sendText(text: string): void {
    this.sent.push(text);
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
  text(value: unknown): void {
    this.handlers?.text(typeof value === 'string' ? value : (value as string));
  }
  binary(): void {
    this.handlers?.binary();
  }
  peerClose(): void {
    this.handlers?.close();
  }
  fail(): void {
    this.handlers?.error();
  }
}
function hello(
  connectionId = CONNECTIONS[0]!,
  instanceId = INSTANCE,
  capabilities: unknown = ['console.v1', 'identity.v1'],
  seq = 1,
): string {
  return JSON.stringify({
    version: PROTOCOL_VERSION,
    connectionId,
    seq,
    type: 'hello',
    instanceId,
    capabilities,
    identity: { name: 'resident' },
    build: { version: '1' },
  });
}
function setup(
  options: {
    maxBufferedAmount?: number;
    maxLinks?: number;
    onFrame?: (frame: unknown) => void;
  } = {},
) {
  const clock = new FakeClock();
  const audit: GatewayResidentLinkAuditEvent[] = [];
  const registry = new GatewayResidentLinkRegistry({
    clock,
    supportedCapabilities: ['console.v1', 'identity.v1', 'media.v1'],
    audit: (event) => audit.push(event),
    handshakeTimeoutMs: 50,
    ...(options.maxBufferedAmount === undefined
      ? {}
      : { maxBufferedAmount: options.maxBufferedAmount }),
    ...(options.maxLinks === undefined ? {} : { maxLinks: options.maxLinks }),
    ...(options.onFrame === undefined
      ? {}
      : { onFrame: (_link, frame) => options.onFrame?.(frame) }),
  });
  return { registry, clock, audit };
}
function admit(
  registry: GatewayResidentLinkRegistry,
  socket: FakeSocket,
  instanceId = INSTANCE,
  connectionId = CONNECTIONS[0]!,
) {
  return registry.admit(
    { instanceId, credentialId: 'egc1.public-id-only' },
    socket,
    connectionId,
  );
}
function lastFrame(socket: FakeSocket): Record<string, any> {
  return JSON.parse(socket.sent.at(-1)!) as Record<string, any>;
}

test('matching hello emits exactly one canonical ack and frozen summaries', () => {
  const { registry } = setup();
  const socket = new FakeSocket();
  const admission = admit(registry, socket);
  assert.equal(admission.accepted, true);
  socket.text(hello());
  assert.equal(socket.sent.length, 1);
  assert.deepEqual(lastFrame(socket), {
    version: 1,
    connectionId: CONNECTIONS[0],
    seq: 1,
    type: 'hello.ack',
    instanceId: INSTANCE,
    capabilities: ['console.v1', 'identity.v1'],
  });
  const summary = registry.lookup(INSTANCE, CONNECTIONS[0]!);
  assert.equal(summary?.state, 'ready');
  assert.deepEqual(summary?.capabilities, ['console.v1', 'identity.v1']);
  assert(Object.isFrozen(summary));
  assert(Object.isFrozen(summary?.capabilities));
  assert(Object.isFrozen(registry.summaries()));
});

test('hello reaches the internal frame sink and sink failure closes the link', () => {
  const frames: unknown[] = [];
  const delivered = setup({ onFrame: (frame) => frames.push(frame) });
  const live = new FakeSocket();
  admit(delivered.registry, live);
  live.text(hello());
  assert.equal((frames[0] as { type: string }).type, 'hello');
  assert.equal(delivered.registry.size, 1);

  const failed = setup({
    onFrame: () => {
      throw new Error('relay sink failed');
    },
  });
  const broken = new FakeSocket();
  admit(failed.registry, broken);
  broken.text(hello());
  assert.equal(failed.registry.size, 0);
  assert.equal(broken.closes[0]?.reason, 'internal_error');
});

test('wrong instance and non-hello receive fatal error then close', () => {
  for (const input of [
    hello(CONNECTIONS[0], OTHER_INSTANCE),
    hello(CONNECTIONS[1], INSTANCE),
    JSON.stringify({
      version: 1,
      connectionId: CONNECTIONS[0],
      seq: 1,
      type: 'operation.result',
      requestId: 'egr1.AAAAAAAAAAAAAAAAAAAAAA',
      viewerId: 'egv1.AAAAAAAAAAAAAAAAAAAAAA',
      operation: 'viewer.open',
      ok: true,
    }),
  ]) {
    const { registry } = setup();
    const socket = new FakeSocket();
    admit(registry, socket);
    socket.text(input);
    assert.equal(lastFrame(socket).type, 'error');
    assert.equal(lastFrame(socket).fatal, true);
    assert.equal(socket.closes.length, 1);
    assert.equal(registry.size, 0);
  }
});

test('binary, oversize, malformed, sequence, and capability violations are fatal', () => {
  const cases: Array<(socket: FakeSocket) => void> = [
    (socket) => socket.binary(),
    (socket) => socket.text('x'.repeat(LIMITS.frameBytes + 1)),
    (socket) => socket.text('{'),
    (socket) => socket.text(hello(CONNECTIONS[0], INSTANCE, ['console.v1'], 2)),
    (socket) => socket.text(hello(CONNECTIONS[0], INSTANCE, ['made.up'])),
    (socket) => {
      socket.text(hello(CONNECTIONS[0], INSTANCE, []));
      socket.text(
        JSON.stringify({
          version: 1,
          connectionId: CONNECTIONS[0],
          seq: 2,
          type: 'console.output',
          viewerId: 'egv1.AAAAAAAAAAAAAAAAAAAAAA',
          payload: 'secret payload',
        }),
      );
    },
  ];
  const expected = [
    'invalid_frame',
    'frame_too_large',
    'invalid_json',
    'invalid_sequence',
    'unknown_capability',
    'capability_required',
  ];
  cases.forEach((act, index) => {
    const { registry } = setup();
    const socket = new FakeSocket();
    admit(registry, socket);
    act(socket);
    assert.equal(lastFrame(socket).error.code, expected[index]);
    assert.equal(socket.closes.length, 1);
    assert.equal(registry.size, 0);
  });
});

test('first live link wins and stale close cannot delete replacement', () => {
  const { registry } = setup();
  const first = new FakeSocket();
  const duplicate = new FakeSocket();
  assert.equal(admit(registry, first).accepted, true);
  const staleClose = first.handlers!.close;
  assert.deepEqual(admit(registry, duplicate), {
    accepted: false,
    reason: 'duplicate',
  });
  assert.equal(duplicate.closes[0]?.reason, 'duplicate_instance');
  first.peerClose();
  assert.equal(registry.size, 0);
  const replacement = new FakeSocket();
  const accepted = admit(registry, replacement, INSTANCE, CONNECTIONS[1]);
  assert.equal(accepted.accepted, true);
  staleClose();
  assert.equal(registry.size, 1);
  assert.equal(registry.summary(INSTANCE)?.connectionId, CONNECTIONS[1]);
});

test('capacity, reentrant adapters, timers, and connection IDs fail closed', () => {
  const limited = setup({ maxLinks: 1 });
  const first = new FakeSocket();
  const second = new FakeSocket();
  assert.equal(admit(limited.registry, first, INSTANCE).accepted, true);
  assert.deepEqual(admit(limited.registry, second, OTHER_INSTANCE), {
    accepted: false,
    reason: 'capacity',
  });
  assert.equal(second.closes[0]?.reason, 'registry_capacity');

  const reentrant = setup();
  const reentrantSocket = new FakeSocket();
  let detached = false;
  reentrantSocket.attach = (handlers): (() => void) => {
    reentrantSocket.handlers = handlers;
    handlers.text(hello());
    return () => {
      detached = true;
    };
  };
  assert.deepEqual(admit(reentrant.registry, reentrantSocket), {
    accepted: false,
    reason: 'transport-error',
  });
  assert.equal(reentrant.registry.size, 0);
  assert.equal(reentrantSocket.closes[0]?.reason, 'transport_error');
  assert.equal(detached, true);

  const immediateSocket = new FakeSocket();
  const immediate = new GatewayResidentLinkRegistry({
    clock: {
      now: () => 1_000,
      setTimeout(callback) {
        callback();
        return 1;
      },
      clearTimeout() {},
    },
    supportedCapabilities: ['console.v1'],
    audit: () => {},
  });
  assert.deepEqual(admit(immediate, immediateSocket), {
    accepted: false,
    reason: 'transport-error',
  });
  assert.equal(immediate.size, 0);
  assert.equal(immediateSocket.closes[0]?.reason, 'protocol_error');

  const idSocket = new FakeSocket();
  const badId = setup().registry;
  assert.deepEqual(
    badId.admit(
      { instanceId: INSTANCE, credentialId: 'egc1.public-id-only' },
      idSocket,
      'egx1.invalid' as ConnectionId,
    ),
    { accepted: false, reason: 'transport-error' },
  );
  assert.equal(idSocket.closes[0]?.reason, 'transport_error');
});

test('preflight mirrors admission bounds and emits one secret-free rejection', () => {
  const { registry, audit } = setup({ maxLinks: 1 });
  const first = new FakeSocket();
  admit(registry, first, INSTANCE);
  const binding = {
    instanceId: OTHER_INSTANCE,
    credentialId: 'egc1.other-public-id',
  };
  assert.equal(
    registry.preflight({
      instanceId: INSTANCE,
      credentialId: 'egc1.public-id-only',
    }),
    'duplicate',
  );
  assert.equal(registry.preflight(binding), 'capacity');
  assert.equal(registry.size, 1);
  assert.deepEqual(
    audit.slice(-2).map((event) => event.action),
    ['duplicate-rejected', 'capacity-rejected'],
  );
  first.peerClose();
  registry.stop();
  assert.equal(registry.preflight(binding), 'stopped');
  assert.equal(audit.at(-1)?.action, 'stopped-rejected');
});

test('handshake timeout sends fatal error, closes, and permits replacement', () => {
  const { registry, clock, audit } = setup();
  const socket = new FakeSocket();
  admit(registry, socket);
  clock.fireAll();
  assert.equal(lastFrame(socket).error.code, 'invalid_handshake');
  assert.equal(socket.closes.length, 1);
  assert.equal(registry.size, 0);
  assert(audit.some((event) => event.action === 'handshake-timeout'));
});

test('bounded bufferedAmount rejects ack and later exact sends', () => {
  const blocked = setup({ maxBufferedAmount: 256 });
  const socket = new FakeSocket();
  socket.bufferedAmount = 256;
  admit(blocked.registry, socket);
  socket.text(hello());
  assert.equal(socket.sent.length, 0);
  assert.equal(socket.closes[0]?.reason, 'backpressure');
  assert.equal(blocked.registry.size, 0);

  const active = setup({ maxBufferedAmount: 1024 });
  const live = new FakeSocket();
  admit(active.registry, live);
  live.text(hello());
  live.bufferedAmount = 1024;
  const sent = active.registry.send(INSTANCE, CONNECTIONS[0]!, {
    version: 1,
    connectionId: CONNECTIONS[0]!,
    seq: 2,
    type: 'console.input',
    viewerId: 'egv1.AAAAAAAAAAAAAAAAAAAAAA',
    payload: 'not queued',
  });
  assert.equal(sent, false);
  assert.equal(live.sent.length, 1);
  assert.equal(active.registry.size, 1);
  assert.equal(
    active.registry.send(INSTANCE, CONNECTIONS[1]!, lastFrame(live) as any),
    false,
  );
});

test('audit events and public summaries cannot leak frame/header/bearer payloads', () => {
  const { registry, audit } = setup();
  const socket = new FakeSocket();
  const bearer = 'Bearer SUPER-SECRET';
  admit(registry, socket);
  socket.text(hello().replace('resident', bearer));
  const publicData = JSON.stringify({ audit, summaries: registry.summaries() });
  assert(!publicData.includes('SUPER-SECRET'));
  for (const event of audit) {
    assert(Object.isFrozen(event));
    assert.deepEqual(
      Object.keys(event)
        .sort()
        .filter((key) =>
          ['header', 'bearer', 'frame', 'payload', 'message'].includes(key),
        ),
      [],
    );
  }
});

test('stop closes every link, leaves registry empty, and is idempotent', () => {
  const { registry } = setup();
  const first = new FakeSocket();
  const second = new FakeSocket();
  admit(registry, first, INSTANCE);
  admit(registry, second, OTHER_INSTANCE);
  registry.stop();
  registry.stop();
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.summaries(), []);
  assert.equal(first.closes.length, 1);
  assert.equal(second.closes.length, 1);
  const late = new FakeSocket();
  assert.deepEqual(admit(registry, late), {
    accepted: false,
    reason: 'stopped',
  });
  assert.equal(registry.size, 0);
  first.handlers?.close();
  second.handlers?.error();
  assert.equal(registry.size, 0);
});
