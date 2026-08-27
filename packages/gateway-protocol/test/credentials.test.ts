import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREDENTIAL_VECTORS,
  createEnrollmentCredential,
  createNodeCredential,
  exactVerifier,
  isCredentialId,
  isGatewayInstanceId,
  newGatewayInstanceId,
  parseEnrollmentCredential,
  parseNodeCredential,
  verifierMatches,
  type RandomBytes,
} from '../src/index.js';

const source = (hex: string): RandomBytes => {
  const value = Buffer.from(hex, 'hex');
  return (size) => {
    assert.equal(size, value.length);
    return value;
  };
};

test('credential vectors fix all three exact grammars and verifier derivation', () => {
  const vectors = CREDENTIAL_VECTORS;
  assert.equal(
    newGatewayInstanceId(source(vectors.instance.bytesHex)),
    vectors.instance.id,
  );
  const enrollmentValues = [
    Buffer.from(vectors.enrollment.idBytesHex, 'hex'),
    Buffer.from(vectors.enrollment.secretBytesHex, 'hex'),
  ];
  const enrollment = createEnrollmentCredential(() => enrollmentValues.shift()!);
  assert.deepEqual(
    {
      id: enrollment.id,
      token: enrollment.token,
      verifierHex: enrollment.verifier.toString('hex'),
    },
    {
      id: vectors.enrollment.id,
      token: vectors.enrollment.token,
      verifierHex: vectors.enrollment.verifierHex,
    },
  );
  const nodeValues = [
    Buffer.from(vectors.node.idBytesHex, 'hex'),
    Buffer.from(vectors.node.secretBytesHex, 'hex'),
  ];
  const node = createNodeCredential(() => nodeValues.shift()!);
  assert.equal(node.token, vectors.node.token);
  assert.equal(node.verifier.toString('hex'), vectors.node.verifierHex);
  assert.equal(isGatewayInstanceId(vectors.instance.id), true);
  assert.equal(isCredentialId(vectors.node.id), true);
  assert.equal(parseEnrollmentCredential(enrollment.token)?.id, enrollment.id);
  assert.equal(parseNodeCredential(node.token)?.id, node.id);
  assert.equal(parseEnrollmentCredential(node.token), null);
  assert.equal(parseNodeCredential(enrollment.token), null);
  assert.ok(Object.isFrozen(vectors));
  assert.ok(Object.isFrozen(vectors.enrollment));
  assert.ok(Object.isFrozen(enrollment));
  assert.ok(Object.isFrozen(parseNodeCredential(node.token)!));
});

test('random sources are exact Buffer producers and generated values own input', () => {
  for (const malformed of [
    (() => Buffer.alloc(15)) as RandomBytes,
    (() => Buffer.alloc(17)) as RandomBytes,
    (() => new Uint8Array(16)) as unknown as RandomBytes,
  ])
    assert.throws(() => newGatewayInstanceId(malformed), /exactly 16 bytes/);

  const id = Buffer.alloc(16, 0x5a);
  const secret = Buffer.alloc(32, 0x5a);
  const values = [id, secret];
  const material = createNodeCredential(() => values.shift()!);
  id.fill(0);
  secret.fill(0);
  assert.equal(material.id, CREDENTIAL_VECTORS.enrollment.id);
  assert.equal(
    material.verifier.toString('hex'),
    CREDENTIAL_VECTORS.enrollment.verifierHex,
  );
});

test('verifiers are copied, exact, and safely reject malformed comparisons', () => {
  const backing = Buffer.alloc(40, 0xaa);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 4, 32);
  const verifier = exactVerifier(view);
  assert.notEqual(verifier.buffer, view.buffer);
  view.fill(0);
  assert.equal(verifier.equals(Buffer.alloc(32, 0xaa)), true);
  assert.equal(verifierMatches(verifier, Buffer.alloc(32, 0xaa)), true);
  assert.equal(verifierMatches(verifier, Buffer.alloc(32, 0xab)), false);
  assert.equal(verifierMatches(verifier, Buffer.alloc(31, 0xaa)), false);
  assert.equal(verifierMatches(Buffer.alloc(31), Buffer.alloc(32)), false);
  assert.throws(() => exactVerifier(Buffer.alloc(31)), /exactly 32 bytes/);
});

test('credential recognizers reject prefix, alphabet, length, and suffix drift', () => {
  const { instance, enrollment, node } = CREDENTIAL_VECTORS;
  for (const invalid of [
    instance.id.slice(0, -1),
    instance.id + 'A',
    instance.id.replace('egi1.', 'EGI1.'),
    instance.id.replace(/A$/, '+'),
    null,
  ])
    assert.equal(isGatewayInstanceId(invalid), false);
  for (const invalid of [
    enrollment.token + '.extra',
    enrollment.token.replace('ege1.', 'egc1.'),
    enrollment.token.replace(/o$/, '+'),
    {},
  ])
    assert.equal(parseEnrollmentCredential(invalid), null);
  for (const invalid of [
    node.token + '\n',
    node.token.replace('egc1.', 'ege1.'),
    node.token.replace(/U$/, '='),
    undefined,
  ])
    assert.equal(parseNodeCredential(invalid), null);
});
