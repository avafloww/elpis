import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_PATHS,
  createEnrollmentCredential,
  createNodeCredential,
  decodeResidentControlError,
  decodeResidentEnrollmentResult,
  decodeResidentRotationResult,
  encodeCredentialVerifier,
  formatNodeBearerAuthorization,
  newGatewayInstanceId,
  serializeResidentEnrollmentRequest,
  serializeResidentRotationActivationRequest,
  serializeResidentRotationRequest,
  type RequestId,
} from '@elpis/gateway-protocol';
import {
  BoundedResidentControlRateLimiter,
  ResidentControlApiError,
  createGatewayHttpService,
  createGatewayResidentControlApi,
  openGatewayStore,
  type GatewayHttpService,
  type GatewayStore,
  type ResidentControlApi,
  type ResidentControlRateLimiter,
  type ResidentControlSuccess,
} from '../src/index.js';

type Reply = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
};

function post(
  port: number,
  target: string,
  body: string,
  headers: string[] = [],
  method = 'POST',
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: target,
        method,
        headers: [
          'Host',
          '127.0.0.1',
          'Content-Type',
          'application/json',
          'Content-Length',
          String(Buffer.byteLength(body)),
          ...headers,
        ],
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (value) => chunks.push(Buffer.from(value)));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function fixture(
  t: Parameters<Parameters<typeof test>[1]>[0],
  limiter?: ResidentControlRateLimiter,
  control?: (store: GatewayStore) => ResidentControlApi,
): Promise<{
  store: GatewayStore;
  service: GatewayHttpService;
  port: number;
  setStoreNow(now: number): void;
}> {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-resident-http-'),
  );
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway');
  let storeNow = 1_000;
  const store = openGatewayStore(path.join(directory, 'data'), {
    now: () => storeNow,
  });
  const service = createGatewayHttpService({
    publicRoot,
    listen: { host: '127.0.0.1', port: 0 },
    store,
    residentControl:
      control?.(store) ?? createGatewayResidentControlApi(store.credentials),
    residentRateLimiter: limiter,
    residentNow: () => 1234,
  });
  t.after(async () => {
    await service.stop();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const address = await service.start();
  return {
    store,
    service,
    port: address.port,
    setStoreNow(now: number) {
      storeNow = now;
    },
  };
}

const requestId = (character: string): RequestId =>
  `egr1.${character.repeat(22)}` as RequestId;

function enrollmentOnly(
  enroll: ResidentControlApi['enroll'],
): ResidentControlApi {
  const unused = (): never => {
    throw new Error('unused resident control method');
  };
  return {
    authorizeProposal: unused,
    activationAuthorization: unused,
    enroll,
    proposeRotation: unused,
    activateRotation: unused,
  };
}

test('HTTP enrollment/rotation preserve exact replay and proof-before-revoke semantics', async (t) => {
  const { store, port, setStoreNow } = await fixture(t);
  const grant = store.credentials.createEnrollmentGrant();
  const instanceId = newGatewayInstanceId();
  const oldNode = createNodeCredential();
  const enrollmentBody = serializeResidentEnrollmentRequest({
    format: RESIDENT_CONTROL_FORMATS.enrollmentRequest,
    grantToken: grant.token,
    instanceId,
    displayName: ' Resident HTTP ',
    credentialId: oldNode.id,
    credentialVerifier: encodeCredentialVerifier(oldNode.verifier),
    requestId: requestId('A'),
  });

  const enrolled = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    enrollmentBody,
    [
      'Authorization',
      'not-a-session-or-bearer',
      'Origin',
      'https://attacker.invalid',
      'Cookie',
      'session=ignored',
      'X-Elpis-Csrf',
      'ignored',
    ],
  );
  assert.equal(enrolled.status, 201);
  assert.deepEqual(decodeResidentEnrollmentResult(enrolled.body), {
    format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
    instanceId,
    credentialId: oldNode.id,
    replayed: false,
  });
  // An ambiguous/lost first response remains replayable after grant expiry.
  setStoreNow(grant.expiresAt + 1);
  const enrollmentReplay = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    enrollmentBody,
  );
  assert.equal(enrollmentReplay.status, 200);
  assert.equal(
    decodeResidentEnrollmentResult(enrollmentReplay.body).replayed,
    true,
  );

  const nextNode = createNodeCredential();
  const proposalBody = serializeResidentRotationRequest({
    format: RESIDENT_CONTROL_FORMATS.rotationRequest,
    credentialId: nextNode.id,
    credentialVerifier: encodeCredentialVerifier(nextNode.verifier),
    requestId: requestId('B'),
  });
  const oldAuthorization = formatNodeBearerAuthorization(oldNode.token);
  const proposed = await post(
    port,
    RESIDENT_CONTROL_PATHS.rotation,
    proposalBody,
    ['Authorization', oldAuthorization, 'Origin', 'null'],
  );
  assert.equal(proposed.status, 201);
  assert.equal(decodeResidentRotationResult(proposed.body).replayed, false);
  const proposalReplay = await post(
    port,
    RESIDENT_CONTROL_PATHS.rotation,
    proposalBody,
    ['Authorization', oldAuthorization],
  );
  assert.equal(proposalReplay.status, 200);
  assert.equal(
    decodeResidentRotationResult(proposalReplay.body).replayed,
    true,
  );

  assert.ok(store.credentials.authenticateNode(oldNode.token));
  assert.equal(store.credentials.authenticateNode(nextNode.token), null);
  const unrelated = createNodeCredential();
  const deniedActivation = await post(
    port,
    RESIDENT_CONTROL_PATHS.rotationActivation,
    serializeResidentRotationActivationRequest({
      format: RESIDENT_CONTROL_FORMATS.rotationActivationRequest,
      requestId: requestId('C'),
    }),
    ['Authorization', formatNodeBearerAuthorization(unrelated.token)],
  );
  assert.equal(deniedActivation.status, 401);
  assert.equal(
    decodeResidentControlError(deniedActivation.body).code,
    'unauthorized',
  );
  assert.ok(store.credentials.authenticateNode(oldNode.token));

  const activationBody = serializeResidentRotationActivationRequest({
    format: RESIDENT_CONTROL_FORMATS.rotationActivationRequest,
    requestId: requestId('D'),
  });
  const newAuthorization = formatNodeBearerAuthorization(nextNode.token);
  const activated = await post(
    port,
    RESIDENT_CONTROL_PATHS.rotationActivation,
    activationBody,
    ['Authorization', newAuthorization],
  );
  assert.equal(activated.status, 200);
  assert.equal(decodeResidentRotationResult(activated.body).replayed, false);
  assert.equal(store.credentials.authenticateNode(oldNode.token), null);
  assert.ok(store.credentials.authenticateNode(nextNode.token));
  const activationReplay = await post(
    port,
    RESIDENT_CONTROL_PATHS.rotationActivation,
    activationBody,
    ['Authorization', newAuthorization],
  );
  assert.equal(activationReplay.status, 200);
  assert.equal(
    decodeResidentRotationResult(activationReplay.body).replayed,
    true,
  );
});

test('resident HTTP failures are protocol-only, bounded, generic, and do not echo secrets', async (t) => {
  const { store, port, setStoreNow } = await fixture(t);
  const grant = store.credentials.createEnrollmentGrant();
  const node = createNodeCredential();
  const secretBody = JSON.stringify({
    grantToken: grant.token,
    extra: node.token,
  });
  const malformed = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    secretBody,
  );
  assert.equal(malformed.status, 400);
  assert.deepEqual(decodeResidentControlError(malformed.body), {
    format: RESIDENT_CONTROL_FORMATS.error,
    code: 'invalid_request',
  });
  assert.equal(malformed.body.includes(grant.token), false);
  assert.equal(malformed.body.includes(node.token), false);
  assert.equal(malformed.headers['access-control-allow-origin'], undefined);

  const oversized = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    ' '.repeat(4097),
  );
  assert.equal(oversized.status, 413);
  assert.equal(
    decodeResidentControlError(oversized.body).code,
    'invalid_request',
  );
  const encodedBody = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    '{}',
    ['Content-Encoding', 'gzip'],
  );
  assert.equal(encodedBody.status, 400);
  assert.equal(
    decodeResidentControlError(encodedBody.body).code,
    'invalid_request',
  );
  const encodedTarget = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment +
      '?grant=' +
      encodeURIComponent(grant.token),
    '{}',
  );
  assert.equal(encodedTarget.status, 404);
  assert.equal(
    decodeResidentControlError(encodedTarget.body).code,
    'invalid_request',
  );
  assert.equal(encodedTarget.body.includes(grant.token), false);
  const percentTarget = await post(port, '/api/v1/resident/%65nrollment', '{}');
  assert.equal(percentTarget.status, 404);
  assert.equal(
    decodeResidentControlError(percentTarget.body).code,
    'invalid_request',
  );
  const wrongMethod = await post(
    port,
    RESIDENT_CONTROL_PATHS.rotation,
    '{}',
    [],
    'PUT',
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(
    decodeResidentControlError(wrongMethod.body).code,
    'invalid_request',
  );

  // Authentication precedes malformed proposal body handling.
  const unauthorized = await post(
    port,
    RESIDENT_CONTROL_PATHS.rotation,
    secretBody,
    ['Authorization', formatNodeBearerAuthorization(node.token)],
  );
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(decodeResidentControlError(unauthorized.body), {
    format: RESIDENT_CONTROL_FORMATS.error,
    code: 'unauthorized',
  });
  assert.equal(unauthorized.body.includes(node.token), false);
  const duplicate = await post(port, RESIDENT_CONTROL_PATHS.rotation, '{}', [
    'Authorization',
    formatNodeBearerAuthorization(node.token),
    'Authorization',
    formatNodeBearerAuthorization(node.token),
  ]);
  assert.equal(duplicate.status, 401);
  assert.equal(decodeResidentControlError(duplicate.body).code, 'unauthorized');

  const revokedGrant = store.credentials.createEnrollmentGrant(1_000);
  store.credentials.revokeEnrollmentGrant(revokedGrant.id);
  const candidate = createNodeCredential();
  const credentialRequest = (grantToken: string, id: RequestId): string =>
    serializeResidentEnrollmentRequest({
      format: RESIDENT_CONTROL_FORMATS.enrollmentRequest,
      grantToken,
      instanceId: newGatewayInstanceId(),
      displayName: 'Mapped failure',
      credentialId: candidate.id,
      credentialVerifier: encodeCredentialVerifier(candidate.verifier),
      requestId: id,
    });
  const revoked = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    credentialRequest(revokedGrant.token, requestId('E')),
  );
  assert.equal(revoked.status, 403);
  assert.deepEqual(decodeResidentControlError(revoked.body), {
    format: RESIDENT_CONTROL_FORMATS.error,
    code: 'revoked',
    requestId: requestId('E'),
  });

  const expiredGrant = store.credentials.createEnrollmentGrant(1_000);
  setStoreNow(expiredGrant.expiresAt);
  const expired = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    credentialRequest(expiredGrant.token, requestId('F')),
  );
  assert.equal(expired.status, 410);
  assert.equal(decodeResidentControlError(expired.body).code, 'expired');
  const unknownGrant = createEnrollmentCredential();
  const unknown = await post(
    port,
    RESIDENT_CONTROL_PATHS.enrollment,
    credentialRequest(unknownGrant.token, requestId('G')),
  );
  assert.equal(unknown.status, 401);
  assert.equal(decodeResidentControlError(unknown.body).code, 'unauthorized');
  for (const usable of [
    revokedGrant.token,
    expiredGrant.token,
    unknownGrant.token,
  ]) {
    assert.equal(revoked.body.includes(usable), false);
    assert.equal(expired.body.includes(usable), false);
    assert.equal(unknown.body.includes(usable), false);
    assert.equal(JSON.stringify(store.audit()).includes(usable), false);
  }
});

test('resident limiter uses direct peer and exact route and returns protocol 429', async (t) => {
  const seen: Array<{ peerAddress: string; route: string; now: number }> = [];
  const limiter: ResidentControlRateLimiter = {
    allow(input) {
      seen.push(input);
      return false;
    },
  };
  const { port } = await fixture(t, limiter);
  const response = await post(port, RESIDENT_CONTROL_PATHS.enrollment, '{}', [
    'X-Forwarded-For',
    '203.0.113.9',
  ]);
  assert.equal(response.status, 429);
  assert.deepEqual(decodeResidentControlError(response.body), {
    format: RESIDENT_CONTROL_FORMATS.error,
    code: 'rate_limited',
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.route, 'enrollment');
  assert.equal(seen[0]?.now, 1234);
  assert.notEqual(seen[0]?.peerAddress, '203.0.113.9');
});

test('resident HTTP owns status/code pairs and rejects adapter accessors', async (t) => {
  const invalidStatus = await fixture(t, undefined, () =>
    enrollmentOnly(() => {
      throw new ResidentControlApiError(201, 'unauthorized');
    }),
  );
  const invalid = await post(
    invalidStatus.port,
    RESIDENT_CONTROL_PATHS.enrollment,
    '{}',
  );
  assert.equal(invalid.status, 500);
  assert.deepEqual(decodeResidentControlError(invalid.body), {
    format: RESIDENT_CONTROL_FORMATS.error,
    code: 'internal_error',
  });

  let bodyGetterRead = false;
  const accessor = await fixture(t, undefined, () =>
    enrollmentOnly(() => {
      const value: Record<string, unknown> = { status: 201 };
      Object.defineProperty(value, 'body', {
        enumerable: true,
        get() {
          bodyGetterRead = true;
          return 'not-a-protocol-result';
        },
      });
      return value as unknown as ResidentControlSuccess;
    }),
  );
  const denied = await post(
    accessor.port,
    RESIDENT_CONTROL_PATHS.enrollment,
    '{}',
  );
  assert.equal(denied.status, 500);
  assert.equal(decodeResidentControlError(denied.body).code, 'internal_error');
  assert.equal(bodyGetterRead, false);
});

test('default resident limiter has fixed peer bounds and deterministic reset', () => {
  const limiter = new BoundedResidentControlRateLimiter({
    maxEntries: 1,
    windowMs: 10,
    requestsPerWindow: 1,
  });
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.1', route: 'enrollment', now: 0 }),
    true,
  );
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.1', route: 'enrollment', now: 1 }),
    false,
  );
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.2', route: 'enrollment', now: 1 }),
    false,
  );
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.1', route: 'enrollment', now: 10 }),
    true,
  );
  assert.equal(
    limiter.allow({ peerAddress: '', route: 'enrollment', now: 10 }),
    false,
  );
  assert.equal(
    limiter.allow({ peerAddress: '127.0.0.1', route: 'enrollment', now: -1 }),
    false,
  );
});
