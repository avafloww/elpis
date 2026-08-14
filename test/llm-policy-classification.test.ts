import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, NonRetriableError, RetriableError } from '../src/llm/llm.js';

test('policy denials are terminal even when the provider omits an HTTP status', () => {
  const wrapped = new Error('outer transport error', {
    cause: new Error('Invalid prompt: your prompt was flagged as potentially violating our usage policy.'),
  });
  assert.ok(classifyError(wrapped) instanceof NonRetriableError);
});

test('unknown non-policy errors retain the retriable fallback', () => {
  assert.ok(classifyError(new Error('socket weather')) instanceof RetriableError);
});
