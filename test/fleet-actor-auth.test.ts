import test from "node:test";
import assert from "node:assert/strict";
import {
  actorControlTokenDigest,
  createActorControlCredential,
  verifyActorControlToken,
} from "../src/fleet/actor-auth.js";

test("actor control credentials are opaque, stable by digest, and fail closed", () => {
  const a = createActorControlCredential();
  const b = createActorControlCredential();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  assert.equal(actorControlTokenDigest(a.token), a.digest);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.digest, b.digest);
  assert.equal(verifyActorControlToken(a.token, a.digest), true);
  assert.equal(verifyActorControlToken(a.token, b.digest), false);
  assert.equal(verifyActorControlToken("not a token", a.digest), false);
  assert.equal(verifyActorControlToken(a.token, "bad digest"), false);
});
