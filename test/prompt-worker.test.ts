import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from '../src/llm/prompt.js';

const baseInputs = {
  soul: '',
  memory: '',
  now: '',
  harnessRoot: '/tmp',
  dataDirectory: '/tmp',
};

test('disabled worker section is explicit without advertising verbs', () => {
  const prompt = build(baseInputs);
  assert.match(prompt, /### `elpis\.worker`/);
  assert.doesNotMatch(prompt, /elpis\.worker\.start/);
  assert.doesNotMatch(prompt, /elpis\.fleet/);
});

test('enabled worker section advertises the supported Mind-rooted calls', () => {
  const prompt = build({ ...baseInputs, workersEnabled: true });
  assert.match(
    prompt,
    /await elpis\.worker\.start\(mindId, \{ modelRef\? \}\)/,
  );
  assert.match(prompt, /await elpis\.worker\.send\(ref, text\)/);
  assert.match(prompt, /await elpis\.worker\.status\(ref\)/);
  assert.match(prompt, /await elpis\.worker\.artifact\(ref, key\?\)/);
  assert.match(prompt, /await elpis\.worker\.dismiss\(ref\)/);
  assert.doesNotMatch(prompt, /elpis\.fleet/);
});
