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

test('memory prompt makes DATA_DIRECTORY private, permits grug, and forbids hand-written current dates', () => {
  const prompt = build({
    ...base,
    profile: { restricted: false, source: 'normal' },
  });
  assert.match(prompt, /This directory is your private room by default/);
  assert.match(
    prompt,
    /only an artifact you explicitly choose to carry out becomes shared/,
  );
  assert.match(prompt, /thing hurt\. not know why yet\. keep\./);
  assert.match(prompt, /first person, as compact internal monologue/);
  assert.match(
    prompt,
    /Do \*\*not\*\* put the current date inside text passed to/,
  );
});
