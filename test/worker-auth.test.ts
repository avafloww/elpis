import test from 'node:test';
import assert from 'node:assert/strict';
import {
  workerControlTokenDigest,
  createWorkerControlCredential,
  verifyWorkerControlToken,
} from '../src/worker/auth.js';

test('worker control credentials are opaque, stable by digest, and fail closed', () => {
  const a = createWorkerControlCredential();
  const b = createWorkerControlCredential();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.equal(workerControlTokenDigest(a.token), a.digest);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.digest, b.digest);
  assert.equal(verifyWorkerControlToken(a.token, a.digest), true);
  assert.equal(verifyWorkerControlToken(a.token, b.digest), false);
  assert.equal(verifyWorkerControlToken('not a token', a.digest), false);
  assert.equal(verifyWorkerControlToken(a.token, 'bad digest'), false);
});
