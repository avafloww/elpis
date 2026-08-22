import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface WorkerControlCredential {
  token: string;
  digest: string;
}

export function workerControlTokenDigest(token: string): string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("worker control token is malformed");
  }
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createWorkerControlCredential(): WorkerControlCredential {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: workerControlTokenDigest(token) };
}

export function verifyWorkerControlToken(
  token: string,
  expectedDigest: string,
): boolean {
  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = Buffer.from(workerControlTokenDigest(token), "hex");
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
