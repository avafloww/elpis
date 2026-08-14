// test/prompt-fleet.test.ts — the `### elpis.fleet` prompt section is swapped
// for a "not available — do the work yourself" note when the fleet is disabled
// by config (fleet.enabled: false → PromptInputs.fleetEnabled: false). Omitted
// or true keeps the full verb documentation.

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

test('fleetEnabled: false swaps the section for the not-available note', () => {
  const prompt = build({ ...baseInputs, fleetEnabled: false });
 // The heading stays (so `elpis.fleet` is findable when the model wonders
 // about it) but every verb doc line is gone.
  assert.match(prompt, /### `elpis\.fleet`/);
  assert.match(prompt, /fleet is disabled in this harness's config/);
  assert.match(prompt, /perform code changes and other work yourself/);
  assert.doesNotMatch(prompt, /elpis\.fleet\.run/);
  assert.doesNotMatch(prompt, /elpis\.fleet\.send/);
  assert.doesNotMatch(prompt, /elpis\.fleet\.dismiss/);
});

test('the effort opt list still renders when the fleet is enabled', () => {
  const prompt = build({ ...baseInputs, fleetEnabled: true, fleetEfforts: ['low', 'high'] });
  assert.match(prompt, /`effort` \('low'\|'high'\)/);
});
