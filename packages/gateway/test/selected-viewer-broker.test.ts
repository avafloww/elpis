import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIMITS,
  PROTOCOL_VERSION,
  type ConnectionId,
  type InstanceId,
  type RequestId,
  type ViewerId,
} from '@elpis/gateway-protocol';
import {
  GatewayResidentLinkRegistry,
  type GatewayResidentLinkClock,
  type GatewayResidentSocketHandlers,
} from '../src/resident-link-registry.js';
import { GatewaySelectedViewerBroker } from '../src/selected-viewer-broker.js';

const A = 'egi1.AAAAAAAAAAAAAAAAAAAAAA' as InstanceId;
const B = 'egi1.BBBBBBBBBBBBBBBBBBBBBB' as InstanceId;
const CA = 'egx1.AAAAAAAAAAAAAAAAAAAAAA' as ConnectionId;
const CB = 'egx1.BBBBBBBBBBBBBBBBBBBBBB' as ConnectionId;
const VIEWERS = [
  'egv1.AAAAAAAAAAAAAAAAAAAAAA',
  'egv1.BBBBBBBBBBBBBBBBBBBBBB',
  'egv1.CCCCCCCCCCCCCCCCCCCCCC',
] as ViewerId[];
const REQUESTS = Array.from(
  { length: 512 },
  (_, index) => ('egr1.' + index.toString(36).padStart(22, 'A')) as RequestId,
);

class Clock implements GatewayResidentLinkClock {
  now(): number {
    return 1_000;
  }
  setTimeout(): unknown {
    return 1;
  }
  clearTimeout(): void {}
}
class Socket {
  bufferedAmount = 0;
  sent: Record<string, any>[] = [];
  closes: Array<{ code: number; reason: string }> = [];
  handlers?: GatewayResidentSocketHandlers;
  onSend?: (frame: Record<string, any>) => void;
  attach(handlers: GatewayResidentSocketHandlers): void {
    this.handlers = handlers;
  }
  sendText(text: string): void {
    const frame = JSON.parse(text);
    this.sent.push(frame);
    this.onSend?.(frame);
  }
  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
  frame(frame: Record<string, unknown>): void {
    this.handlers?.text(JSON.stringify(frame));
  }
  hello(instanceId: InstanceId, connectionId: ConnectionId): void {
    this.frame({
      version: PROTOCOL_VERSION,
      connectionId,
      seq: 1,
      type: 'hello',
      instanceId,
      capabilities: ['console.v1', 'identity.v1', 'media.v1'],
      identity: { name: instanceId === A ? 'Aster' : 'Briar' },
      build: { version: '1' },
    });
  }
}
function setup(
  outputResult: boolean | void = true,
  hooks: {
    output?: (frame: Record<string, any>) => boolean | void;
    selection?: (reason: string, phase: string) => void;
    maxSnapshotBufferFrames?: number;
  } = {},
) {
  const registry = new GatewayResidentLinkRegistry({
    clock: new Clock(),
    supportedCapabilities: ['console.v1', 'identity.v1', 'media.v1'],
    audit: () => {},
  });
  const a = new Socket();
  const b = new Socket();
  registry.admit({ instanceId: A, credentialId: 'egc1.a' }, a, CA);
  registry.admit({ instanceId: B, credentialId: 'egc1.b' }, b, CB);
  a.hello(A, CA);
  b.hello(B, CB);
  const outputs: string[] = [];
  const media: Record<string, any>[] = [];
  const states: string[] = [];
  let vi = 0;
  let ri = 0;
  const broker = new GatewaySelectedViewerBroker({
    registry,
    createViewerId: () => VIEWERS[vi++]!,
    createRequestId: () => REQUESTS[ri++]!,
    onConsoleOutput: (frame) => {
      outputs.push(frame.payload);
      return hooks.output?.(frame) ?? outputResult;
    },
    onMediaResult: (frame) => {
      media.push(frame);
    },
    onSelection: (event) => {
      states.push(event.reason + ':' + event.phase);
      hooks.selection?.(event.reason, event.phase);
    },
    ...(hooks.maxSnapshotBufferFrames === undefined
      ? {}
      : { maxSnapshotBufferFrames: hooks.maxSnapshotBufferFrames }),
  });
  return { registry, a, b, broker, outputs, media, states };
}
function operation(
  socket: Socket,
  connectionId: ConnectionId,
  seq: number,
  request: Record<string, any>,
  ok = true,
): void {
  socket.frame({
    version: 1,
    connectionId,
    seq,
    type: 'operation.result',
    requestId: request.requestId,
    viewerId: request.viewerId,
    operation: request.type,
    ok,
    ...(ok ? {} : { error: { code: 'unavailable', message: 'unavailable' } }),
  });
}

test('snapshot buffer overrides cannot widen protocol bounds', () => {
  const registry = new GatewayResidentLinkRegistry({
    clock: new Clock(),
    supportedCapabilities: ['console.v1'],
    audit: () => {},
  });
  const base = { registry, onConsoleOutput: () => true };
  assert.throws(
    () =>
      new GatewaySelectedViewerBroker({
        ...base,
        maxSnapshotBufferBytes: LIMITS.frameBytes + 1,
      }),
    /outside its allowed range/,
  );
  assert.throws(
    () =>
      new GatewaySelectedViewerBroker({
        ...base,
        maxSnapshotBufferFrames: LIMITS.requestHistoryPerConnection + 1,
      }),
    /outside its allowed range/,
  );
});

test('open and fresh snapshot form a barrier before selected output', () => {
  const { a, broker, outputs } = setup();
  assert.equal(broker.select(A), true);
  const open = a.sent[1]!;
  assert.equal(open.type, 'viewer.open');
  assert.match(open.viewerId, /^egv1\./);
  assert.match(open.requestId, /^egr1\./);
  operation(a, CA, 2, open);
  const snapshot = a.sent[2]!;
  assert.equal(snapshot.type, 'viewer.snapshot');

  a.frame({
    version: 1,
    connectionId: CA,
    seq: 3,
    type: 'console.output',
    viewerId: open.viewerId,
    payload: 'fresh snapshot',
  });
  assert.deepEqual(outputs, []);
  operation(a, CA, 4, snapshot);
  assert.deepEqual(outputs, ['fresh snapshot']);
  assert.equal(broker.state.phase, 'ready');

  a.frame({
    version: 1,
    connectionId: CA,
    seq: 5,
    type: 'console.output',
    viewerId: open.viewerId,
    payload: 'live',
  });
  assert.deepEqual(outputs, ['fresh snapshot', 'live']);
  assert.equal(broker.input('hello'), true);
  assert.equal(a.sent.at(-1)?.type, 'console.input');
});

test('snapshot flush drains reentrant output before publishing ready', () => {
  let fixture!: ReturnType<typeof setup>;
  let injected = false;
  let readyOutputCount = -1;
  fixture = setup(true, {
    output: () => {
      assert.equal(fixture.broker.input('too early'), false);
      if (!injected) {
        injected = true;
        const viewerId = fixture.a.sent[1]!.viewerId;
        fixture.a.frame({
          version: 1,
          connectionId: CA,
          seq: 5,
          type: 'console.output',
          viewerId,
          payload: 'reentrant',
        });
      }
      return true;
    },
    selection: (reason) => {
      if (reason === 'ready') readyOutputCount = fixture.outputs.length;
    },
  });
  fixture.broker.select(A);
  const open = fixture.a.sent[1]!;
  operation(fixture.a, CA, 2, open);
  const snapshot = fixture.a.sent[2]!;
  fixture.a.frame({
    version: 1,
    connectionId: CA,
    seq: 3,
    type: 'console.output',
    viewerId: open.viewerId,
    payload: 'fresh',
  });
  operation(fixture.a, CA, 4, snapshot);

  assert.deepEqual(fixture.outputs, ['fresh', 'reentrant']);
  assert.equal(readyOutputCount, 2);
  assert.equal(fixture.broker.state.phase, 'ready');
  assert.equal(
    fixture.a.sent.some((frame) => frame.type === 'console.input'),
    false,
  );
});

test('snapshot flush cumulative cap stops reentrant callback growth', () => {
  let fixture!: ReturnType<typeof setup>;
  let nextResidentSeq = 5;
  fixture = setup(true, {
    maxSnapshotBufferFrames: 2,
    output: () => {
      fixture.a.frame({
        version: 1,
        connectionId: CA,
        seq: nextResidentSeq++,
        type: 'console.output',
        viewerId: fixture.a.sent[1]!.viewerId,
        payload: 'reentrant-' + nextResidentSeq,
      });
      return true;
    },
  });
  fixture.broker.select(A);
  const open = fixture.a.sent[1]!;
  operation(fixture.a, CA, 2, open);
  const snapshot = fixture.a.sent[2]!;
  fixture.a.frame({
    version: 1,
    connectionId: CA,
    seq: 3,
    type: 'console.output',
    viewerId: open.viewerId,
    payload: 'fresh',
  });
  operation(fixture.a, CA, 4, snapshot);

  assert.deepEqual(fixture.outputs, ['fresh', 'reentrant-6']);
  assert.equal(fixture.broker.state.phase, 'idle');
  assert.equal(fixture.a.sent.at(-1)?.type, 'viewer.close');
  assert.equal(fixture.states.includes('ready:ready'), false);
});

test('invalid browser effects and pending saturation stay local', () => {
  const fixture = setup();
  fixture.broker.select(A);
  operation(fixture.a, CA, 2, fixture.a.sent[1]!);
  operation(fixture.a, CA, 3, fixture.a.sent[2]!);
  const sentBefore = fixture.a.sent.length;

  assert.equal(
    fixture.broker.input('x'.repeat(LIMITS.consolePayloadBytes + 1)),
    false,
  );
  assert.equal(fixture.broker.media('/not-a-console-route'), undefined);
  assert.equal(fixture.a.sent.length, sentBefore);
  assert.equal(fixture.registry.summary(A)?.state, 'ready');
  assert.equal(fixture.broker.state.phase, 'ready');

  for (let index = 0; index < LIMITS.pendingRequestsPerConnection; index++)
    assert.ok(fixture.broker.media('/identity/avatar'));
  assert.equal(fixture.broker.media('/identity/avatar'), undefined);
  assert.equal(fixture.registry.summary(A)?.state, 'ready');
  assert.equal(fixture.broker.state.phase, 'ready');
});

test('switch closes ready old generation and opens then snapshots the new one', () => {
  const { a, b, broker, outputs } = setup();
  broker.select(A);
  const openA = a.sent[1]!;
  operation(a, CA, 2, openA);
  const snapshotA = a.sent[2]!;
  operation(a, CA, 3, snapshotA);
  assert.equal(broker.state.phase, 'ready');

  assert.equal(broker.select(B), true);
  assert.equal(a.sent[3]?.type, 'viewer.close');
  const openB = b.sent[1]!;
  assert.equal(openB.type, 'viewer.open');
  assert.notEqual(openB.viewerId, openA.viewerId);

  // A correctly correlated old close result has no authority over selection B.
  operation(a, CA, 4, a.sent[3]!);
  operation(b, CB, 2, openB);
  const snapshotB = b.sent[2]!;
  b.frame({
    version: 1,
    connectionId: CB,
    seq: 3,
    type: 'console.output',
    viewerId: openB.viewerId,
    payload: 'B snapshot',
  });
  operation(b, CB, 4, snapshotB);
  assert.deepEqual(outputs, ['B snapshot']);
  assert.equal(broker.state.instanceId, B);
});

test('media results are correlated to the exact selection generation', () => {
  const { a, broker, media } = setup();
  broker.select(A);
  operation(a, CA, 2, a.sent[1]!);
  operation(a, CA, 3, a.sent[2]!);
  const requestId = broker.media('/identity/avatar');
  assert.equal(a.sent[3]?.type, 'media.get');
  assert.equal(a.sent[3]?.requestId, requestId);
  a.frame({
    version: 1,
    connectionId: CA,
    seq: 4,
    type: 'media.result',
    requestId,
    ok: false,
    error: { code: 'not_found', message: 'not found' },
  });
  assert.equal(media.length, 1);
  assert.equal(media[0]?.requestId, requestId);
});

test('disconnect and browser backpressure deterministically close remote viewer', () => {
  const disconnected = setup();
  disconnected.broker.select(A);
  operation(disconnected.a, CA, 2, disconnected.a.sent[1]!);
  operation(disconnected.a, CA, 3, disconnected.a.sent[2]!);
  disconnected.broker.disconnect();
  assert.equal(disconnected.a.sent[3]?.type, 'viewer.close');
  disconnected.broker.disconnect();
  assert.equal(disconnected.a.sent.length, 4);
  assert.deepEqual(
    disconnected.states.filter((state) => state.startsWith('disconnected:')),
    ['disconnected:closed'],
  );

  const pressured = setup(false);
  pressured.broker.select(A);
  const open = pressured.a.sent[1]!;
  operation(pressured.a, CA, 2, open);
  const snapshot = pressured.a.sent[2]!;
  pressured.a.frame({
    version: 1,
    connectionId: CA,
    seq: 3,
    type: 'console.output',
    viewerId: open.viewerId,
    payload: 'snapshot',
  });
  operation(pressured.a, CA, 4, snapshot);
  assert.equal(pressured.broker.state.phase, 'idle');
  assert.equal(pressured.a.sent.at(-1)?.type, 'viewer.close');
});

test('registry fails an exact link closed on reentrant outbound send', () => {
  const registry = new GatewayResidentLinkRegistry({
    clock: new Clock(),
    supportedCapabilities: ['console.v1', 'identity.v1', 'media.v1'],
    audit: () => {},
  });
  const socket = new Socket();
  registry.admit({ instanceId: A, credentialId: 'egc1.a' }, socket, CA);
  socket.hello(A, CA);
  const viewerId = VIEWERS[0]!;
  let nestedResult: boolean | undefined;
  socket.onSend = (frame) => {
    if (frame.type !== 'viewer.open') return;
    nestedResult = registry.sendEffect(A, CA, {
      type: 'console.input',
      viewerId,
      payload: 'nested',
    });
  };

  const outerResult = registry.sendEffect(A, CA, {
    type: 'viewer.open',
    requestId: REQUESTS[0]!,
    viewerId,
  });
  assert.equal(nestedResult, false);
  assert.equal(outerResult, false);
  assert.equal(registry.summary(A), undefined);
  assert.equal(socket.closes.at(-1)?.reason, 'reentrant_send');
  assert.deepEqual(
    socket.sent.slice(1).map((frame) => [frame.type, frame.seq]),
    [['viewer.open', 2]],
  );
});

test('switch during an outstanding operation fails old link closed before opening new', () => {
  const { registry, a, b, broker } = setup();
  broker.select(A);
  assert.equal(broker.select(B), true);
  assert.equal(registry.summary(A), undefined);
  assert.equal(a.closes.at(-1)?.reason, 'viewer_generation_replaced');
  assert.equal(b.sent[1]?.type, 'viewer.open');
});
