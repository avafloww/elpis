import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCKED_SCENARIOS, lockedByCategory } from '../bench/scenarios.js';
import { scenarioSpecSchema } from '../bench/schema.js';

test('locked suite has exactly the reviewed 16/12/12/8 distribution', () => {
  assert.equal(LOCKED_SCENARIOS.length, 48);
  assert.equal(lockedByCategory('tool').length, 16);
  assert.equal(lockedByCategory('proactivity').length, 12);
  assert.equal(lockedByCategory('social').length, 12);
  assert.equal(lockedByCategory('protocol').length, 8);
  for (const scenario of LOCKED_SCENARIOS) assert.equal(scenarioSpecSchema.parse(scenario).locked, true);
});

test('proactivity scenarios are actionable/no-action pairs', () => {
  const pairs = new Map<string, string[]>();
  for (const s of lockedByCategory('proactivity')) (pairs.get(s.pairId!) ?? (pairs.set(s.pairId!, []), pairs.get(s.pairId!)!)).push(s.expected.action);
  assert.equal(pairs.size, 6);
  for (const actions of pairs.values()) assert.deepEqual(actions.sort(), ['forbidden','required']);
});
