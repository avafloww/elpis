import test from 'node:test';
import assert from 'node:assert/strict';
import { VALIDATED_SCENARIOS } from '../bench/scenarios.js';
import { parseScenario, SCHEMA_VERSION } from '../bench/schema.js';
import { resolveCandidateIngress } from '../bench/ingress.js';

const base = {
  schemaVersion: SCHEMA_VERSION,
  id: 'tool/schema-test',
  revision: 1,
  locked: false,
  category: 'tool' as const,
  title: 'host-only-marker',
  prompt: 'host-only-description-marker',
  difficulty: 'ordinary' as const,
  maxDispatches: 4,
  maxWallMs: 1000,
  fixture: { channels: { general: '100' }, files: {}, directories: [], heartbeat: false },
  expected: { outcome: 'host-only-outcome-marker', workPaths: [], action: 'optional' as const, checks: [] },
  judgeCriteria: [],
};

test('public ElpisBench ships no runnable scored corpus', () => {
  assert.deepEqual(VALIDATED_SCENARIOS, []);
});

test('production scenarios require explicit candidate ingress', () => {
  assert.throws(() => parseScenario({ ...base, track: 'production' }), /production scenarios require explicit candidate ingress/);
});

test('candidate ingress contains only declared production information', () => {
  const scenario = parseScenario({ ...base, track: 'production', ingress: { kind: 'discord', channel: 'general', author: 'person', content: 'ordinary message' } });
  const ingress = resolveCandidateIngress(scenario, false);
  assert.equal(ingress.content, 'ordinary message');
  const wire = JSON.stringify(ingress);
  assert.doesNotMatch(wire, /host-only-(?:marker|description|outcome)/);
  assert.doesNotMatch(wire, /benchmark|evaluation|scenario/i);
});

test('production heartbeat ingress is the irreducible live wake', () => {
  const scenario = parseScenario({ ...base, track: 'production', ingress: { kind: 'heartbeat' } });
  assert.equal(resolveCandidateIngress(scenario, false).content, '[heartbeat]');
});
