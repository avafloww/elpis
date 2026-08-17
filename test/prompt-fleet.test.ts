// test/prompt-fleet.test.ts — fleet docs appear only while the module is active.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';

const baseInputs = {
  soul: '',
  memory: '',
  now: '',
  harnessRoot: '/tmp',
  dataDirectory: '/tmp',
};

test('fleet section documents the verbs when fleetEnabled is omitted', () => {
  const prompt = build({ ...baseInputs });
  assert.match(prompt, /### `elpis\.fleet`/);
  assert.match(prompt, /elpis\.fleet\.run\(prompt, opts\?\)/);
  assert.match(prompt, /elpis\.fleet\.dismiss\(ref\)/);
  assert.doesNotMatch(prompt, /fleet is disabled/);
});

test('fleetEnabled: true keeps the full fleet section', () => {
  const prompt = build({ ...baseInputs, fleetEnabled: true });
  assert.match(prompt, /elpis\.fleet\.run\(prompt, opts\?\)/);
  assert.doesNotMatch(prompt, /fleet is disabled/);
});

test('fleetEnabled: false omits the unavailable fleet from the prompt', () => {
  const prompt = build({ ...baseInputs, fleetEnabled: false });
  assert.doesNotMatch(prompt, /### `elpis\.fleet`/);
  assert.doesNotMatch(prompt, /elpis\.fleet\./);
  assert.doesNotMatch(prompt, /fleet is disabled/);
});

test('the effort opt list still renders when the fleet is enabled', () => {
  const prompt = build({ ...baseInputs, fleetEnabled: true, fleetEfforts: ['low', 'high'] });
  assert.match(prompt, /`effort` \('low'\|'high'\)/);
});
