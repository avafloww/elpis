import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CREDENTIAL_VECTORS,
  RESIDENT_CONTROL_ERROR_CODES,
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_LIMITS,
  RESIDENT_CONTROL_PATHS,
  ResidentControlCodecError,
  decodeCredentialVerifier,
  decodeResidentControlError,
  decodeResidentEnrollmentRequest,
  decodeResidentEnrollmentResult,
  decodeResidentRotationActivationRequest,
  decodeResidentRotationRequest,
  decodeResidentRotationResult,
  encodeCredentialVerifier,
  formatNodeBearerAuthorization,
  parseNodeBearerAuthorization,
  serializeResidentControlError,
  serializeResidentEnrollmentRequest,
  serializeResidentEnrollmentResult,
  serializeResidentRotationActivationRequest,
  serializeResidentRotationRequest,
  serializeResidentRotationResult,
  type ResidentControlError,
  type ResidentEnrollmentRequest,
  type ResidentEnrollmentResult,
  type ResidentRotationActivationRequest,
  type ResidentRotationRequest,
  type ResidentRotationResult,
} from '../src/index.js';

const requestId = 'egr1.AAAAAAAAAAAAAAAAAAAAAA' as const;
const instanceId = CREDENTIAL_VECTORS.instance.id;
const credentialId = CREDENTIAL_VECTORS.node.id;
const previousCredentialId = CREDENTIAL_VECTORS.enrollment.id;
const verifierBytes = Buffer.from(CREDENTIAL_VECTORS.node.verifierHex, 'hex');
const credentialVerifier = verifierBytes.toString('base64');

const enrollment: ResidentEnrollmentRequest = {
  format: RESIDENT_CONTROL_FORMATS.enrollmentRequest,
  grantToken: CREDENTIAL_VECTORS.enrollment.token,
  instanceId,
  displayName: ' Aster ',
  credentialId,
  credentialVerifier,
  requestId,
};
const rotation: ResidentRotationRequest = {
  format: RESIDENT_CONTROL_FORMATS.rotationRequest,
  credentialId,
  credentialVerifier,
  requestId,
};
const activation: ResidentRotationActivationRequest = {
  format: RESIDENT_CONTROL_FORMATS.rotationActivationRequest,
  requestId,
};
const enrollmentResult: ResidentEnrollmentResult = {
  format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
  instanceId,
  credentialId,
  replayed: false,
};
const rotationResult: ResidentRotationResult = {
  format: RESIDENT_CONTROL_FORMATS.rotationResult,
  instanceId,
  credentialId,
  previousCredentialId,
  replayed: true,
};

test('resident v1 control constants are exact and frozen', () => {
  assert.deepEqual(RESIDENT_CONTROL_PATHS, {
    enrollment: '/api/v1/resident/enrollment',
    rotation: '/api/v1/resident/rotation',
    rotationActivation: '/api/v1/resident/rotation/activate',
    link: '/api/v1/resident/link',
  });
  assert.equal(RESIDENT_CONTROL_LIMITS.bodyBytes, 4096);
  assert.equal(RESIDENT_CONTROL_LIMITS.displayNameBytes, 128);
  assert.deepEqual(RESIDENT_CONTROL_ERROR_CODES, [
    'invalid_request',
    'unauthorized',
    'expired',
    'revoked',
    'conflict',
    'rate_limited',
    'internal_error',
  ]);
  for (const value of [
    RESIDENT_CONTROL_PATHS,
    RESIDENT_CONTROL_FORMATS,
    RESIDENT_CONTROL_LIMITS,
    RESIDENT_CONTROL_ERROR_CODES,
  ])
    assert.ok(Object.isFrozen(value));
});

test('request codecs own, normalize, freeze, and serialize exact records', () => {
  const enrollmentWire = serializeResidentEnrollmentRequest(enrollment);
  const mutableWire = Buffer.from(enrollmentWire);
  const decodedEnrollment = decodeResidentEnrollmentRequest(mutableWire);
  mutableWire.fill(0);
  assert.ok(Object.isFrozen(decodedEnrollment));
  assert.equal(decodedEnrollment.displayName, 'Aster');
  assert.equal(decodedEnrollment.grantToken, enrollment.grantToken);
  assert.equal(decodedEnrollment.credentialVerifier, credentialVerifier);
  assert.deepEqual(Object.keys(JSON.parse(enrollmentWire)), [
    'format',
    'grantToken',
    'instanceId',
    'displayName',
    'credentialId',
    'credentialVerifier',
    'requestId',
  ]);

  const decodedRotation = decodeResidentRotationRequest(
    serializeResidentRotationRequest(rotation),
  );
  assert.deepEqual(decodedRotation, rotation);
  assert.ok(Object.isFrozen(decodedRotation));
  const decodedActivation = decodeResidentRotationActivationRequest(
    serializeResidentRotationActivationRequest(activation),
  );
  assert.deepEqual(decodedActivation, activation);
  assert.ok(Object.isFrozen(decodedActivation));
});

test('result and error codecs fix exact shapes', () => {
  assert.deepEqual(
    decodeResidentEnrollmentResult(
      serializeResidentEnrollmentResult(enrollmentResult),
    ),
    enrollmentResult,
  );
  assert.deepEqual(
    decodeResidentRotationResult(
      serializeResidentRotationResult(rotationResult),
    ),
    rotationResult,
  );
  const withoutRequest: ResidentControlError = {
    format: RESIDENT_CONTROL_FORMATS.error,
    code: 'unauthorized',
  };
  const withRequest: ResidentControlError = {
    format: RESIDENT_CONTROL_FORMATS.error,
    code: 'conflict',
    requestId,
  };
  assert.deepEqual(
    decodeResidentControlError(serializeResidentControlError(withoutRequest)),
    withoutRequest,
  );
  assert.deepEqual(
    decodeResidentControlError(serializeResidentControlError(withRequest)),
    withRequest,
  );
  assert.throws(
    () =>
      decodeResidentControlError(
        JSON.stringify({ ...withRequest, message: 'no' }),
      ),
    ResidentControlCodecError,
  );
});

test('verifier codec requires canonical padded standard base64 and copies bytes', () => {
  const source = new Uint8Array(verifierBytes);
  const encoded = encodeCredentialVerifier(source);
  assert.equal(encoded, credentialVerifier);
  source.fill(0);
  const decoded = decodeCredentialVerifier(encoded);
  assert.deepEqual(decoded, verifierBytes);
  decoded.fill(0);
  assert.deepEqual(
    verifierBytes,
    Buffer.from(CREDENTIAL_VECTORS.node.verifierHex, 'hex'),
  );
  for (const invalid of [
    encoded.slice(0, -1),
    encoded.slice(0, -1) + '_',
    encoded.replace(/=$/, ''),
    Buffer.alloc(31).toString('base64'),
    Buffer.alloc(33).toString('base64'),
  ])
    assert.throws(
      () => decodeCredentialVerifier(invalid),
      ResidentControlCodecError,
    );
  assert.throws(
    () => encodeCredentialVerifier(Buffer.alloc(31)),
    ResidentControlCodecError,
  );
});

test('body, shape, id, format, display name, and UTF-8 validation is fatal', () => {
  const valid = JSON.parse(serializeResidentEnrollmentRequest(enrollment));
  for (const malformed of [
    { ...valid, extra: true },
    { ...valid, requestId: null },
    { ...valid, requestId: 'request' },
    { ...valid, credentialId: credentialId + 'A' },
    { ...valid, instanceId: instanceId + 'A' },
    { ...valid, format: RESIDENT_CONTROL_FORMATS.rotationRequest },
    { ...valid, displayName: '   ' },
    { ...valid, displayName: 'bad\u0000name' },
    { ...valid, displayName: 'é'.repeat(65) },
    { ...valid, credentialVerifier: credentialVerifier.replace(/=$/, '') },
  ])
    assert.throws(
      () => decodeResidentEnrollmentRequest(JSON.stringify(malformed)),
      ResidentControlCodecError,
    );
  assert.throws(
    () =>
      decodeResidentEnrollmentRequest(
        ' '.repeat(RESIDENT_CONTROL_LIMITS.bodyBytes + 1),
      ),
    ResidentControlCodecError,
  );
  assert.throws(
    () => decodeResidentEnrollmentRequest(Uint8Array.from([0x7b, 0xff, 0x7d])),
    ResidentControlCodecError,
  );
  assert.throws(
    () => decodeResidentEnrollmentRequest('{"format":"broken"'),
    ResidentControlCodecError,
  );
  assert.throws(
    () => decodeResidentEnrollmentRequest('\ufeff' + JSON.stringify(valid)),
    ResidentControlCodecError,
  );
  assert.throws(
    () =>
      decodeResidentEnrollmentRequest(
        JSON.stringify({ ...valid, displayName: '\ud800' }),
      ),
    ResidentControlCodecError,
  );
});

test('node bearer formatter and parser enforce one exact authorization value', () => {
  const token = CREDENTIAL_VECTORS.node.token;
  const header = formatNodeBearerAuthorization(token);
  assert.equal(header, 'Bearer ' + token);
  assert.equal(parseNodeBearerAuthorization(header), token);
  for (const invalid of [
    token,
    'bearer ' + token,
    'Bearer  ' + token,
    'Bearer ' + token + ' ',
    'Bearer ' + CREDENTIAL_VECTORS.enrollment.token,
    ['Bearer ' + token],
  ])
    assert.equal(parseNodeBearerAuthorization(invalid), null);
  assert.throws(
    () => formatNodeBearerAuthorization(CREDENTIAL_VECTORS.enrollment.token),
    ResidentControlCodecError,
  );
});

test('codec failures never echo body or credential material', () => {
  const secret = CREDENTIAL_VECTORS.enrollment.token;
  let caught: unknown;
  try {
    decodeResidentEnrollmentRequest('{"grantToken":"' + secret + '"');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ResidentControlCodecError);
  assert.equal(caught.code, 'invalid_request');
  assert.equal(String(caught).includes(secret), false);
  assert.equal(String(caught).includes(credentialVerifier), false);
  assert.equal(String(caught).includes('grantToken'), false);
  assert.throws(
    () => formatNodeBearerAuthorization(secret),
    (error: unknown) =>
      error instanceof ResidentControlCodecError &&
      !String(error).includes(secret),
  );
});
