// xxhash.ts — pure-TS XXH64, for the Claude Code billing-header `cch`
// attestation (see anthropic-client.ts). Claude Code computes the `cch` as
// XXH64(request-body-with-placeholder, seed) low-20-bits; upstream (oh-my-pi)
// uses Bun's native `Bun.hash.xxHash64`, but the harness runs on Node, so we
// need our own byte-exact XXH64. Verified against the canonical XXH64 test
// vectors (see test/xxhash.test.ts).

const MASK = 0xffffffffffffffffn;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;

const mul = (a: bigint, b: bigint): bigint => (a * b) & MASK;
const add = (a: bigint, b: bigint): bigint => (a + b) & MASK;

function rotl(x: bigint, r: bigint): bigint {
  return ((x << r) | (x >> (64n - r))) & MASK;
}

function round(acc: bigint, input: bigint): bigint {
  acc = add(acc, mul(input, PRIME2));
  acc = rotl(acc, 31n);
  return mul(acc, PRIME1);
}

function mergeRound(acc: bigint, val: bigint): bigint {
  val = round(0n, val);
  acc ^= val;
  return add(mul(acc, PRIME1), PRIME4);
}

function read64(buf: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(buf[i + b]);
  return v;
}

function read32(buf: Uint8Array, i: number): bigint {
  let v = 0n;
  for (let b = 3; b >= 0; b--) v = (v << 8n) | BigInt(buf[i + b]);
  return v;
}

/** XXH64 over `buf` with `seed`. Returns the full 64-bit hash as a bigint. */
export function xxh64(buf: Uint8Array, seed: bigint): bigint {
  const len = buf.length;
  let h64: bigint;
  let p = 0;

  if (len >= 32) {
    let v1 = add(add(seed, PRIME1), PRIME2);
    let v2 = add(seed, PRIME2);
    let v3 = seed & MASK;
    let v4 = (seed - PRIME1) & MASK;
    const limit = len - 32;
    while (p <= limit) {
      v1 = round(v1, read64(buf, p)); p += 8;
      v2 = round(v2, read64(buf, p)); p += 8;
      v3 = round(v3, read64(buf, p)); p += 8;
      v4 = round(v4, read64(buf, p)); p += 8;
    }
    h64 = add(add(rotl(v1, 1n), rotl(v2, 7n)), add(rotl(v3, 12n), rotl(v4, 18n)));
    h64 = mergeRound(h64, v1);
    h64 = mergeRound(h64, v2);
    h64 = mergeRound(h64, v3);
    h64 = mergeRound(h64, v4);
  } else {
    h64 = add(seed, PRIME5);
  }

  h64 = add(h64, BigInt(len));

  while (p + 8 <= len) {
    h64 ^= round(0n, read64(buf, p));
    h64 = add(mul(rotl(h64, 27n), PRIME1), PRIME4);
    p += 8;
  }
  if (p + 4 <= len) {
    h64 ^= mul(read32(buf, p), PRIME1);
    h64 = add(mul(rotl(h64, 23n), PRIME2), PRIME3);
    p += 4;
  }
  while (p < len) {
    h64 ^= mul(BigInt(buf[p]), PRIME5);
    h64 = mul(rotl(h64, 11n), PRIME1);
    p += 1;
  }

  h64 ^= h64 >> 33n;
  h64 = mul(h64, PRIME2);
  h64 ^= h64 >> 29n;
  h64 = mul(h64, PRIME3);
  h64 ^= h64 >> 32n;
  return h64 & MASK;
}
