import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_RUN_WAKE_MS, encodeRunWakePayload, parseRunCallArguments, parseRunWake, parseRunWakePayload, resolveRunWake } from '../src/sandbox/wake.js';

const DISPATCH = Date.parse('2030-01-02T03:04:05.000Z');

test('run wake accepts exactly one relative or absolute key', () => {
  assert.deepEqual(parseRunWake({ after: '5m' }, DISPATCH), { kind: 'after', delayMs: 300_000 });
  assert.deepEqual(parseRunWake({ after: 1250 }, DISPATCH), { kind: 'after', delayMs: 1250 });
  assert.deepEqual(parseRunWake({ at: '2030-01-02T04:04:05Z' }, DISPATCH), { kind: 'at', targetAt: DISPATCH + 3_600_000 });
  for (const value of [null, [], {}, { after: '1m', at: '2030-01-02T04:04:05Z' }, { after: '1m', extra: true }, { nope: '1m' }]) {
    assert.throws(() => parseRunWake(value, DISPATCH), /exactly|one key/);
  }
});

test('run wake rejects malformed, nonpositive, past, and 24h-or-later values before execution', () => {
  for (const value of [{ after: 0 }, { after: -1 }, { after: '0s' }]) {
    assert.throws(() => parseRunWake(value, DISPATCH), /greater than zero/);
  }
  for (const value of [{ after: MAX_RUN_WAKE_MS }, { after: '24h' }, { at: new Date(DISPATCH + MAX_RUN_WAKE_MS).toISOString() }]) {
    assert.throws(() => parseRunWake(value, DISPATCH), /less than 24h/);
  }
  assert.throws(() => parseRunWake({ at: new Date(DISPATCH).toISOString() }, DISPATCH), /strictly in the future/);
  assert.throws(() => parseRunWake({ at: new Date(DISPATCH - 1).toISOString() }, DISPATCH), /strictly in the future/);
  assert.throws(() => parseRunWake({ at: 'tomorrow' }, DISPATCH), /ISO-8601/);
  assert.throws(() => parseRunWake({ after: 'soon' }, DISPATCH), /duration/);
});

test('relative wake anchors after successful completion while absolute wake keeps wall time', () => {
  const after = parseRunWake({ after: '5m' }, DISPATCH);
  assert.deepEqual(resolveRunWake(after, DISPATCH + 90_000), { armAt: DISPATCH + 390_000, elapsed: false });
  const at = parseRunWake({ at: '2030-01-02T03:14:05Z' }, DISPATCH);
  assert.deepEqual(resolveRunWake(at, DISPATCH + 90_000), { armAt: DISPATCH + 600_000, elapsed: false });
  assert.deepEqual(resolveRunWake(at, DISPATCH + 600_000), { armAt: null, elapsed: true });
  assert.deepEqual(resolveRunWake(at, DISPATCH + 700_000), { armAt: null, elapsed: true });
});

test('run-call parsing rejects legacy end and validates wake before execution', () => {
  assert.deepEqual(parseRunCallArguments('{"code":"1"}', DISPATCH), { code: '1' });
  assert.deepEqual(parseRunCallArguments('{"code":"2","sandbox":"quietly-crimson-ibis","wake":{"after":"2m"}}', DISPATCH), {
    code: '2', sandbox: 'quietly-crimson-ibis', wake: { kind: 'after', delayMs: 120_000 },
  });
  assert.throws(() => parseRunCallArguments('{"code":"would run","end":true}', DISPATCH), /unsupported key: end/);
  assert.throws(() => parseRunCallArguments('{"code":"would run","wake":{"after":0}}', DISPATCH), /greater than zero/);
  assert.throws(() => parseRunCallArguments('{"code":1}', DISPATCH), /run\.code must be a string/);
  assert.throws(() => parseRunCallArguments('{"code":"1","sandbox":""}', DISPATCH), /non-empty exact alias/);
});

test('durable run-wake payload round-trips only the bounded v3 shape', () => {
  const payload = { type: 'elpis-run-wake-v3' as const, kind: 'at' as const, state: 'armed' as const, requestedAt: 1000, targetAt: 2000 };
  assert.deepEqual(parseRunWakePayload(encodeRunWakePayload(payload)), payload);
  assert.equal(parseRunWakePayload('{"type":"other"}'), null);
  assert.equal(parseRunWakePayload('{"type":"elpis-run-wake-v3","kind":"at","state":"armed","requestedAt":1.2,"targetAt":2}'), null);
});
