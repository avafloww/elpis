// test/prompt-state.test.ts — verifies that the agent's state is interpolated into the prompt.

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

test('build prompt interpolates state JSON', () => {
  const prompt = build({
    ...baseInputs,
    state: { mood: 'curious', energy: 'high', __updated_at: '2026-01-01T00:00:00.000Z' },
  });
  assert.match(prompt, /"mood": "curious"/);
  assert.match(prompt, /"energy": "high"/);
 // Staleness hint is the ABSOLUTE timestamp, not a Date.now-relative age —
 // a relative age would drift the system-prompt bytes every turn and break
 // prefix caching. The absolute stamp is byte-stable until state.json is
 // rewritten.
  assert.match(prompt, /last updated 2026-01-01T00:00:00\.000Z/);
  assert.doesNotMatch(prompt, /__updated_at/);
});

test('build prompt shows empty state placeholder when state is absent', () => {
  const prompt = build({ ...baseInputs });
  assert.match(prompt, /## Current state/);
  assert.match(prompt, /{ }/);
});


test('build prompt omits age note when stripped state is empty', () => {
  const prompt = build({
    ...baseInputs,
    state: { __updated_at: '2026-01-01T00:00:00.000Z' },
  });
  assert.match(prompt, /## Current state/);
  assert.match(prompt, /{ }/);
  assert.doesNotMatch(prompt, /noted/);
  assert.doesNotMatch(prompt, /__updated_at/);
});
