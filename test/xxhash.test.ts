import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xxh64 } from '../src/llm/oauth/xxhash.js';

// Reference vectors generated with the canonical `xxhashjs` implementation
// (cross-checked against the published XXH64 vectors for empty/"abc" seed 0).
// These pin our pure-TS XXH64 to be byte-exact with Bun's native xxHash64,
// which is what oh-my-pi / Claude Code compute the `cch` attestation with.
const hex = (buf: Uint8Array, seed: bigint) => xxh64(buf, seed).toString(16).padStart(16, '0');
const bytes = (s: string) => new TextEncoder().encode(s);

test('xxh64: canonical vectors, seed 0', () => {
  assert.equal(hex(bytes(''), 0n), 'ef46db3751d8e999');
  assert.equal(hex(bytes('abc'), 0n), '44bc2cf5ad770999');
 // 47 bytes — exercises the ≥32-byte main stripe loop plus the 8/4/1 tail.
  assert.equal(hex(bytes('The quick brown fox jumps over the lazy dog!!!!'), 0n), 'a9b4233048596906');
});

test('xxh64: seeded vectors (the real cch seed)', () => {
  const seed = 0x4d659218e32a3268n;
  assert.equal(hex(bytes('harness cch attestation body placeholder cch=00000'), seed), '8fe0ad3ded3a9017');
  assert.equal(hex(bytes('short seeded'), seed), '96f746d5279d4339');
});

test('xxh64: low-20-bit cch derivation is 5 hex chars', () => {
  const h = xxh64(bytes('anything'), 0x4d659218e32a3268n);
  const cch = (h & 0xfffffn).toString(16).padStart(5, '0');
  assert.equal(cch.length, 5);
  assert.match(cch, /^[0-9a-f]{5}$/);
});
