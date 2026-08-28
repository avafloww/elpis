import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANONICAL_IDS,
  CANONICAL_V1,
  LIMITS,
  PROTOCOL_VERSION,
  GatewayInboundSession,
  GatewayProtocolError,
  ResidentInboundSession,
  createGatewayHelloAck,
  createProtocolError,
  createResidentHello,
  newRequestId,
  type Capability,
  type GatewayToResidentFrame,
  type ResidentToGatewayFrame,
} from '../src/index.js';

const all: Capability[] = ['console.v1', 'identity.v1', 'media.v1'];
function expectCode(
  code: GatewayProtocolError['code'],
  fn: () => unknown,
): void {
  assert.throws(
    fn,
    (error: unknown) =>
      error instanceof GatewayProtocolError && error.code === code,
  );
}
function gatewaySession(
  supportedCapabilities: Capability[] = all,
): GatewayInboundSession {
  return new GatewayInboundSession({
    connectionId: CANONICAL_IDS.connectionId,
    instanceId: CANONICAL_IDS.instanceId,
    supportedCapabilities,
  });
}
function residentSession(
  offeredCapabilities: Capability[] = all,
  gatewayCapabilities: Capability[] | undefined = all,
): ResidentInboundSession {
  return new ResidentInboundSession({
    connectionId: CANONICAL_IDS.connectionId,
    instanceId: CANONICAL_IDS.instanceId,
    offeredCapabilities,
    gatewayCapabilities,
  });
}

test('authenticated resident hello is first and negotiates an explicit intersection', () => {
  const session = gatewaySession(['console.v1', 'identity.v1']);
  session.receive(CANONICAL_V1.residentHello);
  assert.deepEqual(session.negotiatedCapabilities, [
    'console.v1',
    'identity.v1',
  ]);
  assert.equal(session.hello?.identity.name, 'Elpis');

  const wrongInstance = gatewaySession();
  expectCode('instance_mismatch', () =>
    wrongInstance.receive({
      ...CANONICAL_V1.residentHello,
      instanceId: 'egi1.ZZZZZZZZZZZZZZZZZZZZZZ',
    }),
  );
  const noHello = gatewaySession();
  expectCode('invalid_handshake', () =>
    noHello.receive({ ...CANONICAL_V1.consoleOutput, seq: 1 }),
  );
  expectCode('invalid_handshake', () =>
    session.receive({ ...CANONICAL_V1.residentHello, seq: 2 }),
  );
});

test('gateway acknowledgement is first, echoes binding, and must be exact intersection', () => {
  const session = residentSession(all, ['console.v1', 'media.v1']);
  const ack = createGatewayHelloAck({
    connectionId: CANONICAL_IDS.connectionId,
    seq: 1,
    instanceId: CANONICAL_IDS.instanceId,
    capabilities: ['console.v1', 'media.v1'],
  });
  session.receive(ack);
  assert.deepEqual(session.negotiatedCapabilities, ['console.v1', 'media.v1']);

  const guessed = residentSession(all, ['console.v1', 'media.v1']);
  expectCode('invalid_handshake', () =>
    guessed.receive({ ...ack, capabilities: ['console.v1'] }),
  );
  const wrongEcho = residentSession();
  expectCode('instance_mismatch', () =>
    wrongEcho.receive({
      ...CANONICAL_V1.gatewayAck,
      instanceId: 'egi1.ZZZZZZZZZZZZZZZZZZZZZZ',
    }),
  );
});

test('sequence is independent by direction, starts at one, and rejects duplicate or gaps', () => {
  const badFirst = gatewaySession();
  expectCode('invalid_sequence', () =>
    badFirst.receive({ ...CANONICAL_V1.residentHello, seq: 2 }),
  );
  expectCode('invalid_handshake', () =>
    badFirst.receive(CANONICAL_V1.residentHello),
  );
  const duplicate = gatewaySession();
  duplicate.receive(CANONICAL_V1.residentHello);
  expectCode('invalid_sequence', () =>
    duplicate.receive({ ...CANONICAL_V1.consoleOutput, seq: 1 }),
  );
  const gap = gatewaySession();
  gap.receive(CANONICAL_V1.residentHello);
  expectCode('invalid_sequence', () =>
    gap.receive({ ...CANONICAL_V1.consoleOutput, seq: 3 }),
  );

  const opposite = residentSession();
  opposite.receive(CANONICAL_V1.gatewayAck); // Its own direction also starts at 1.
  opposite.receive(CANONICAL_V1.viewerOpen); // Then 2.
});

test('viewer open, output, fresh snapshot, close and outer request correlation are stateful', () => {
  const gateway = gatewaySession();
  gateway.receive(CANONICAL_V1.residentHello);
  gateway.registerRequest(CANONICAL_V1.viewerOpen);
  gateway.receive(CANONICAL_V1.operationResult);
  gateway.receive(CANONICAL_V1.consoleOutput);

  const snapshot = {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 3,
    type: 'viewer.snapshot',
    requestId: 'egr1.EEEEEEEEEEEEEEEEEEEEEE',
    viewerId: CANONICAL_IDS.viewerId,
  } as const;
  gateway.registerRequest(snapshot);
  gateway.receive({
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 4,
    type: 'operation.result',
    requestId: snapshot.requestId,
    viewerId: snapshot.viewerId,
    operation: snapshot.type,
    ok: true,
  });

  const resident = residentSession();
  resident.receive(CANONICAL_V1.gatewayAck);
  resident.receive(CANONICAL_V1.viewerOpen);
  resident.completeOperation(CANONICAL_V1.operationResult);
  resident.receive(snapshot);
  resident.completeOperation({
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 3,
    type: 'operation.result',
    requestId: snapshot.requestId,
    viewerId: snapshot.viewerId,
    operation: snapshot.type,
    ok: true,
  });
  const close = {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 4,
    type: 'viewer.close',
    requestId: 'egr1.FFFFFFFFFFFFFFFFFFFFFF',
    viewerId: CANONICAL_IDS.viewerId,
  } as const;
  resident.receive(close);
  resident.completeOperation({
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 4,
    type: 'operation.result',
    requestId: close.requestId,
    viewerId: close.viewerId,
    operation: close.type,
    ok: true,
  });
  expectCode('request_mismatch', () =>
    resident.receive({
      version: PROTOCOL_VERSION,
      connectionId: CANONICAL_IDS.connectionId,
      seq: 5,
      type: 'console.input',
      viewerId: CANONICAL_IDS.viewerId,
      payload: '{}',
    }),
  );
});

test('operation and media results must match registered outer requests', () => {
  const unsolicited = gatewaySession();
  unsolicited.receive(CANONICAL_V1.residentHello);
  expectCode('request_mismatch', () =>
    unsolicited.receive(CANONICAL_V1.operationResult),
  );

  const mediaGet = {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 2,
    type: 'media.get',
    requestId: CANONICAL_IDS.requestId,
    route: '/frames/watch/a.png',
  } as const;
  const mismatched = gatewaySession();
  mismatched.receive(CANONICAL_V1.residentHello);
  mismatched.registerRequest(mediaGet);
  expectCode('request_mismatch', () =>
    mismatched.receive({ ...CANONICAL_V1.operationResult, seq: 2 }),
  );

  const gateway = gatewaySession();
  gateway.receive(CANONICAL_V1.residentHello);
  gateway.registerRequest(mediaGet);
  gateway.receive({ ...CANONICAL_V1.mediaResult, seq: 2 });
});

test('operations cannot silently use an unnegotiated capability', () => {
  const gateway = gatewaySession(['identity.v1']);
  gateway.receive(CANONICAL_V1.residentHello);
  expectCode('capability_required', () =>
    gateway.registerRequest(CANONICAL_V1.viewerOpen),
  );

  const resident = residentSession(['identity.v1'], ['identity.v1']);
  resident.receive({
    ...CANONICAL_V1.gatewayAck,
    capabilities: ['identity.v1'],
  });
  expectCode('capability_required', () =>
    resident.receive(CANONICAL_V1.viewerOpen),
  );
});

test('unsupported versions fail visibly and a fatal compatibility error may replace ack', () => {
  const unsupported = residentSession();
  expectCode('unsupported_version', () =>
    unsupported.receive({ ...CANONICAL_V1.gatewayAck, version: 99 }),
  );
  expectCode('invalid_handshake', () =>
    unsupported.receive(CANONICAL_V1.gatewayAck),
  );
  const failureSession = residentSession();
  const failure = createProtocolError({
    connectionId: CANONICAL_IDS.connectionId,
    seq: 1,
    fatal: true,
    error: {
      code: 'unsupported_version',
      message: 'Gateway supports only protocol version 1',
    },
  });
  assert.equal(failureSession.receive(failure).type, 'error');
  expectCode('invalid_handshake', () => failureSession.receive(failure));
});

test('constructors set only fixed version and type fields', () => {
  const hello = createResidentHello({
    connectionId: CANONICAL_IDS.connectionId,
    seq: 1,
    instanceId: CANONICAL_IDS.instanceId,
    capabilities: all,
    identity: { name: 'Elpis' },
    build: { version: '1.0.0' },
  });
  assert.equal(hello.version, 1);
  assert.equal(hello.type, 'hello');
  assert.equal(
    createGatewayHelloAck({
      connectionId: CANONICAL_IDS.connectionId,
      seq: 1,
      instanceId: CANONICAL_IDS.instanceId,
      capabilities: all,
    }).type,
    'hello.ack',
  );
});
test('pending request state is bounded', () => {
  const gateway = gatewaySession();
  gateway.receive(CANONICAL_V1.residentHello);
  for (let index = 0; index < LIMITS.pendingRequestsPerConnection; index += 1) {
    gateway.registerRequest({
      version: PROTOCOL_VERSION,
      connectionId: CANONICAL_IDS.connectionId,
      seq: index + 2,
      type: 'media.get',
      requestId: newRequestId(),
      route: '/frames/watch/a.png',
    });
  }
  expectCode('request_limit', () =>
    gateway.registerRequest({
      version: PROTOCOL_VERSION,
      connectionId: CANONICAL_IDS.connectionId,
      seq: LIMITS.pendingRequestsPerConnection + 2,
      type: 'media.get',
      requestId: newRequestId(),
      route: '/frames/watch/a.png',
    }),
  );
});

test('an errored viewer open releases provisional Gateway state', () => {
  const gateway = gatewaySession();
  gateway.receive(CANONICAL_V1.residentHello);
  gateway.registerRequest(CANONICAL_V1.viewerOpen);
  gateway.receive({
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 2,
    type: 'error',
    fatal: false,
    requestId: CANONICAL_IDS.requestId,
    error: { code: 'request_mismatch', message: 'open failed' },
  });
  gateway.registerRequest({
    ...CANONICAL_V1.viewerOpen,
    seq: 3,
    requestId: newRequestId(),
  });
});

test('resident viewer state changes only through a matching effect result', () => {
  const resident = residentSession();
  resident.receive(CANONICAL_V1.gatewayAck);
  resident.receive(CANONICAL_V1.viewerOpen);
  resident.completeOperation({
    ...CANONICAL_V1.operationResult,
    ok: false,
    error: { code: 'effect_failed', message: 'addClient failed' },
  });
  expectCode('request_mismatch', () =>
    resident.receive({
      version: PROTOCOL_VERSION,
      connectionId: CANONICAL_IDS.connectionId,
      seq: 3,
      type: 'viewer.snapshot',
      requestId: newRequestId(),
      viewerId: CANONICAL_IDS.viewerId,
    }),
  );
});

test('resident typed effects own sequence and reject replay or unknown targets', () => {
  const resident = residentSession();
  resident.receive(CANONICAL_V1.gatewayAck);
  resident.receive(CANONICAL_V1.viewerOpen);

  const opened = resident.operationResult({
    requestId: CANONICAL_IDS.requestId,
    viewerId: CANONICAL_IDS.viewerId,
    operation: 'viewer.open',
    ok: true,
  });
  assert.equal(opened.seq, 2);
  assert.equal(opened.connectionId, CANONICAL_IDS.connectionId);
  const output = resident.consoleOutput({
    viewerId: CANONICAL_IDS.viewerId,
    payload: '{"ready":true}',
  });
  assert.equal(output.seq, 3);

  expectCode('request_mismatch', () =>
    resident.operationResult({
      requestId: CANONICAL_IDS.requestId,
      viewerId: CANONICAL_IDS.viewerId,
      operation: 'viewer.open',
      ok: true,
    }),
  );
  expectCode('request_mismatch', () =>
    resident.consoleOutput({
      viewerId: 'egv1.ZZZZZZZZZZZZZZZZZZZZZZ',
      payload: '{}',
    }),
  );

  const mediaRequest = 'egr1.EEEEEEEEEEEEEEEEEEEEEE' as const;
  resident.receive({
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 3,
    type: 'media.get',
    requestId: mediaRequest,
    route: '/frames/watch/a.png',
  });
  const media = resident.mediaResult({
    requestId: mediaRequest,
    ok: false,
    error: { code: 'not_found', message: 'missing' },
  });
  assert.equal(media.seq, 4);
  expectCode('request_mismatch', () =>
    resident.mediaResult({
      requestId: mediaRequest,
      ok: false,
      error: { code: 'not_found', message: 'missing' },
    }),
  );
  expectCode('request_mismatch', () =>
    resident.mediaResult({
      requestId: 'egr1.FFFFFFFFFFFFFFFFFFFFFF',
      ok: false,
      error: { code: 'not_found', message: 'missing' },
    }),
  );
});

test('resident typed effects cannot override envelope or consume sequence on rejection', () => {
  const resident = residentSession();
  resident.receive(CANONICAL_V1.gatewayAck);
  resident.receive(CANONICAL_V1.viewerOpen);
  const result = resident.operationResult({
    requestId: CANONICAL_IDS.requestId,
    viewerId: CANONICAL_IDS.viewerId,
    operation: 'viewer.open',
    ok: true,
    seq: 99,
    connectionId: 'egx1.ZZZZZZZZZZZZZZZZZZZZZZ',
  } as unknown as Parameters<ResidentInboundSession['operationResult']>[0]);
  assert.equal(result.seq, 2);
  assert.equal(result.connectionId, CANONICAL_IDS.connectionId);

  expectCode('invalid_frame', () =>
    resident.consoleOutput({
      viewerId: CANONICAL_IDS.viewerId,
      payload: 'x'.repeat(LIMITS.consolePayloadBytes + 1),
    }),
  );
  assert.equal(
    resident.consoleOutput({
      viewerId: CANONICAL_IDS.viewerId,
      payload: '{}',
    }).seq,
    3,
  );
});
