import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';

const base = {
  soul: '',
  memory: '',
  now: '',
  harnessRoot: '/harness',
  dataDirectory: '/data',
};

test('memory prompt declares the data directory private and sharing explicit', () => {
  const prompt = build({
    ...base,
    profile: { restricted: false, source: 'normal' },
  });
  assert.match(prompt, /This directory is your private room by default/);
  assert.match(
    prompt,
    /only an artifact you explicitly choose to carry out becomes shared/,
  );
});
