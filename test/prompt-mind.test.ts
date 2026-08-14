import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';

test('Mind practice documents the model-facing core API', () => {
  const prompt = build({ soul: '', memory: '', now: '', harnessRoot: '/h', dataDirectory: '/d' });
  for (const call of ['elpis.mind.add', '.get(id)', '.list(filters?)', '.ready(limit?)', '.status(id, status)', '.comment(id, body)', '.depends(id, onId)', '.remind(id, at)']) {
    assert.ok(prompt.includes(call), `missing ${call}`);
  }
});

test('background-job guidance trusts completion wakes instead of manual polling', () => {
  const prompt = build({ soul: '', memory: '', now: '', harnessRoot: '/h', dataDirectory: '/d' });
  assert.match(prompt, /yield and trust the completion wake/);
  assert.match(prompt, /do not manually sleep-poll unless an intermediate state genuinely changes the next decision/);
});
