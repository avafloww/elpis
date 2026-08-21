import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface ActorControlCredential {
  token: string;
  digest: string;
}

export function actorControlTokenDigest(token: string): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("actor control token is malformed");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createActorControlCredential(): ActorControlCredential {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: actorControlTokenDigest(token) };
}

export function verifyActorControlToken(
  token: string,
  expectedDigest: string,
): boolean {
  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = Buffer.from(actorControlTokenDigest(token), "hex");
    expected = Buffer.from(expectedDigest, "hex");
  } catch {
    return false;
  }
  return (
    actual.length === 32 &&
    expected.length === 32 &&
    timingSafeEqual(actual, expected)
  );
}
