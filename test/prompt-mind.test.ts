import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';

test('Mind practice documents the model-facing core API', () => {
  const prompt = build({ soul: '', memory: '', now: '', harnessRoot: '/h', dataDirectory: '/d' });
  for (const call of ['elpis.mind.add', '.get(id)', '.list(filters?)', '.ready(limit?)', '.status(id, status)', '.comment(id, body)', '.depends(id, onId)', '.remind(id, at)']) {
    assert.ok(prompt.includes(call), `missing ${call}`);
  }
});
