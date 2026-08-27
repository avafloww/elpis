import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CANONICAL_IDS,
  CANONICAL_V1,
  LIMITS,
  PROTOCOL_VERSION,
  GatewayProtocolError,
  decodeGatewayFrame,
  decodeResidentFrame,
  negotiateCapabilities,
  newConnectionId,
  newInstanceId,
  newRequestId,
  newViewerId,
  serializeGatewayFrame,
  serializeResidentFrame,
  type Capability,
} from '../src/index.js';

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
function resident(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...CANONICAL_V1.residentHello, ...overrides };
}
function gateway(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...CANONICAL_V1.gatewayAck, ...overrides };
}

test('canonical v1 vectors serialize and decode in their declared directions', () => {
  assert.deepEqual(
    decodeResidentFrame(serializeResidentFrame(CANONICAL_V1.residentHello)),
    CANONICAL_V1.residentHello,
  );
  assert.deepEqual(
    decodeGatewayFrame(serializeGatewayFrame(CANONICAL_V1.gatewayAck)),
    CANONICAL_V1.gatewayAck,
  );
  assert.deepEqual(
    decodeGatewayFrame(CANONICAL_V1.viewerOpen),
    CANONICAL_V1.viewerOpen,
  );
  assert.deepEqual(
    decodeResidentFrame(CANONICAL_V1.operationResult),
    CANONICAL_V1.operationResult,
  );
  assert.deepEqual(
    decodeResidentFrame(CANONICAL_V1.consoleOutput),
    CANONICAL_V1.consoleOutput,
  );
  assert.deepEqual(
    decodeResidentFrame(CANONICAL_V1.mediaResult),
    CANONICAL_V1.mediaResult,
  );
});

test('direction, version, type, exact keys, id grammars, and capabilities are strict', () => {
  expectCode('unknown_type', () =>
    decodeGatewayFrame(CANONICAL_V1.residentHello),
  );
  expectCode('unsupported_version', () =>
    decodeResidentFrame(resident({ version: 2 })),
  );
  expectCode('unknown_type', () =>
    decodeResidentFrame(resident({ type: 'future.magic' })),
  );
  expectCode('invalid_frame', () =>
    decodeResidentFrame(resident({ surprise: true })),
  );
  expectCode('invalid_frame', () =>
    decodeResidentFrame(resident({ connectionId: CANONICAL_IDS.viewerId })),
  );
  expectCode('unknown_capability', () =>
    decodeResidentFrame(resident({ capabilities: ['console.v1', 'root.v1'] })),
  );
  expectCode('invalid_frame', () =>
    decodeResidentFrame(resident({ capabilities: ['media.v1', 'console.v1'] })),
  );
  expectCode('invalid_frame', () =>
    decodeResidentFrame(
      resident({ capabilities: ['console.v1', 'console.v1'] }),
    ),
  );
  assert.deepEqual(
    negotiateCapabilities(
      ['console.v1', 'media.v1'],
      ['identity.v1', 'media.v1'],
    ),
    ['media.v1'],
  );
});

test('console payload remains opaque while its UTF-8 bytes are bounded', () => {
  const opaque = {
    ...CANONICAL_V1.consoleOutput,
    payload: 'not JSON and never parsed',
  };
  assert.equal(decodeResidentFrame(opaque).type, 'console.output');
  expectCode('invalid_frame', () =>
    decodeResidentFrame({
      ...opaque,
      payload: '😀'.repeat(Math.floor(LIMITS.consolePayloadBytes / 4) + 1),
    }),
  );
});

test('identity and build metadata are strict, bounded descriptors without bytes or paths', () => {
  const hello = resident({
    identity: {
      name: 'Soul name',
      avatar: {
        mediaType: 'image/webp',
        byteLength: 12,
        sha256: 'a'.repeat(64),
      },
    },
    build: { version: '1.2.3', revision: 'abc', state: 'dirty' },
  });
  assert.equal(decodeResidentFrame(hello).type, 'hello');
  expectCode('invalid_frame', () =>
    decodeResidentFrame(
      resident({
        identity: {
          name: 'x',
          avatar: {
            mediaType: 'image/gif',
            byteLength: 1,
            sha256: 'a'.repeat(64),
          },
        },
      }),
    ),
  );
  expectCode('invalid_frame', () =>
    decodeResidentFrame(
      resident({
        identity: {
          name: 'x',
          avatar: {
            mediaType: 'image/png',
            byteLength: 1,
            sha256: 'a'.repeat(64),
            path: '/secret',
          },
        },
      }),
    ),
  );
  expectCode('invalid_frame', () =>
    decodeResidentFrame(resident({ identity: { name: 'é'.repeat(65) } })),
  );
});

test('media routes are console-relative allowlisted paths and media data is self-consistent', () => {
  const base = {
    version: PROTOCOL_VERSION,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 2,
    type: 'media.get',
    requestId: CANONICAL_IDS.requestId,
  } as const;
  for (const route of [
    '/frames/watch/a.png',
    '/attachments/message/file.pdf',
    '/identity/avatar',
  ]) {
    assert.equal(decodeGatewayFrame({ ...base, route }).type, 'media.get');
  }
  for (const route of [
    'https://resident/secret',
    '/config',
    '/frames/watch/../x',
    '/attachments/a/%2e%2e/x',
    '/frames/a.png?token=x',
    '/frames/unknown/a.png',
    '/attachments/only-one',
    '/frames/watch/a%00.png',
  ]) {
    expectCode('invalid_frame', () => decodeGatewayFrame({ ...base, route }));
  }
  const data = Buffer.from('different');
  expectCode('invalid_frame', () =>
    decodeResidentFrame({
      ...CANONICAL_V1.mediaResult,
      byteLength: data.byteLength,
      data: data.toString('base64'),
    }),
  );
  assert.equal(
    createHash('sha256').update('hi').digest('hex'),
    CANONICAL_V1.mediaResult.sha256,
  );
});

test('JSON and total frame byte failures are typed and visible', () => {
  expectCode('invalid_json', () => decodeResidentFrame('{'));
  expectCode('frame_too_large', () =>
    decodeResidentFrame(' '.repeat(LIMITS.frameBytes + 1)),
  );
  const overlongError = {
    version: 1,
    connectionId: CANONICAL_IDS.connectionId,
    seq: 2,
    type: 'error',
    fatal: true,
    error: {
      code: 'bad',
      message: 'é'.repeat(LIMITS.errorMessageBytes / 2 + 1),
    },
  };
  expectCode('invalid_frame', () => decodeResidentFrame(overlongError));
});

test('generated ids use stable, distinct v1 grammars', () => {
  assert.match(newInstanceId(), /^egi1.[A-Za-z0-9_-]{22}$/);
  assert.match(newConnectionId(), /^egx1.[A-Za-z0-9_-]{22}$/);
  assert.match(newViewerId(), /^egv1.[A-Za-z0-9_-]{22}$/);
  assert.match(newRequestId(), /^egr1.[A-Za-z0-9_-]{22}$/);
  assert.notEqual(newConnectionId(), newConnectionId());
});

test('all outer sequences must be positive safe integers', () => {
  for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expectCode('invalid_frame', () => decodeResidentFrame(resident({ seq })));
  assert.equal(
    decodeResidentFrame(resident({ seq: Number.MAX_SAFE_INTEGER })).seq,
    Number.MAX_SAFE_INTEGER,
  );
});

test('malformed frame mutations fail closed without coercion', () => {
  const malformed: unknown[] = [
    null,
    true,
    1,
    [],
    '',
    { ...CANONICAL_V1.residentHello, seq: '1' },
    { ...CANONICAL_V1.residentHello, capabilities: null },
    { ...CANONICAL_V1.residentHello, identity: [] },
    { ...CANONICAL_V1.residentHello, build: { version: 'ok', extra: 1 } },
  ];
  for (const candidate of malformed)
    assert.throws(() => decodeResidentFrame(candidate), GatewayProtocolError);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expectCode('invalid_frame', () => decodeResidentFrame(cyclic));
});
test('decoded frames are owned deeply frozen values and errors do not echo input', () => {
  const input = structuredClone(CANONICAL_V1.residentHello);
  const decoded = decodeResidentFrame(input);
  input.identity.name = 'mutated after validation';
  assert.equal(decoded.type, 'hello');
  assert.equal(decoded.identity.name, 'Elpis');
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(Object.isFrozen(decoded.identity), true);
  assert.equal(Object.isFrozen(decoded.capabilities), true);
  assert.equal(Object.isFrozen(CANONICAL_V1.residentHello.identity), true);
  assert.throws(() =>
    (decoded.capabilities as Capability[]).push('console.v1'),
  );

  const marker = 'do-not-echo-this-value';
  assert.throws(
    () => decodeResidentFrame(resident({ capabilities: [marker] })),
    (error: unknown) =>
      error instanceof GatewayProtocolError &&
      error.code === 'unknown_capability' &&
      !error.message.includes(marker),
  );
});

test('media base64 must be canonical, not merely decodable', () => {
  assert.equal(Buffer.from('aGl=', 'base64').toString(), 'hi');
  expectCode('invalid_frame', () =>
    decodeResidentFrame({ ...CANONICAL_V1.mediaResult, data: 'aGl=' }),
  );
});
