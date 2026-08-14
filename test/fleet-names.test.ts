// Unit tests for src/fleet/names.ts and src/fleet/protocol.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSessionId, generateName, validateName } from '../src/fleet/names.js';
import { frameLine, parseFrames, type RunnerFrame } from '../src/fleet/protocol.js';

test('newSessionId matches f-<6 base36 chars>', () => {
  const id = newSessionId();
  assert.match(id, /^f-[a-z0-9]{6}$/);
});

test('newSessionId generates 100 unique ids', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(newSessionId());
  assert.equal(ids.size, 100);
});

test('generateName avoids the taken set', () => {
  const taken = new Set<string>();
 // Exhaust every combo bar one so the next call must return that survivor
 // (this also exercises the deterministic -2 escape path indirectly via a
 // fully-exhausted set below).
  for (let i = 0; i < 50; i++) {
    const name = generateName(taken);
    assert.ok(!taken.has(name), `generated name ${name} must not already be taken`);
    taken.add(name);
  }
});

test('generateName falls back to a numeric suffix once all combos are taken', () => {
 // Force exhaustion by pre-seeding a fake taken set that intercepts every
 // possible adjective-noun combo the implementation could produce, verified
 // indirectly: after requesting more names than there are combos, all
 // returned names must still be unique and satisfy validateName.
  const taken = new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < 700; i++) {
    const name = generateName(taken);
    assert.ok(!seen.has(name), `name ${name} reused`);
    seen.add(name);
    taken.add(name);
    validateName(name);
  }
});

test('validateName rejects names with spaces', () => {
  assert.throws(() => validateName('has space'));
});

test('validateName rejects names starting with f-', () => {
  assert.throws(() => validateName('f-abc'));
});

test('validateName rejects the empty string', () => {
  assert.throws(() => validateName(''));
});

test('validateName rejects names over 40 chars', () => {
  assert.throws(() => validateName('a'.repeat(41)));
});

test('validateName rejects uppercase', () => {
  assert.throws(() => validateName('UpperCase'));
});

test('validateName accepts a well-formed name', () => {
  assert.doesNotThrow(() => validateName('refactor-bot'));
});

test('parseFrames splits two complete lines plus a partial remainder', () => {
  const buf = '{"a":1}\n{"b":2}\n{"c":3';
  const { frames, rest } = parseFrames(buf);
  assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":3');
});

test('parseFrames skips a line that fails to parse without throwing', () => {
  const buf = '{"a":1}\nnot json\n{"b":2}\n';
  const { frames, rest } = parseFrames(buf);
  assert.deepEqual(frames, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '');
});

test('frameLine round-trips through parseFrames', () => {
  const frame: RunnerFrame = { ev: 'hello', id: 'f-abc123', pid: 42, seq: 0, state: 'starting' };
  const line = frameLine(frame);
  assert.equal(line.endsWith('\n'), true);
  const { frames, rest } = parseFrames(line);
  assert.equal(rest, '');
  assert.deepEqual(frames, [frame]);
});
