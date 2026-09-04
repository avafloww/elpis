import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  NonRetriableError,
  RetriableError,
} from '../src/llm/llm.js';

test('policy denials are terminal even when the provider omits an HTTP status', () => {
  const wrapped = new Error('outer transport error', {
    cause: new Error(
      'Invalid prompt: your prompt was flagged as potentially violating our usage policy.',
    ),
  });
  assert.ok(classifyError(wrapped) instanceof NonRetriableError);
});

test('unknown non-policy errors retain the retriable fallback', () => {
  assert.ok(
    classifyError(new Error('socket weather')) instanceof RetriableError,
  );
});

test('cybersecurity denials are terminal without an HTTP status', () => {
  const denial = new Error(
    'This content was flagged for possible cybersecurity risk.',
  );
  assert.ok(classifyError(denial) instanceof NonRetriableError);
  assert.ok(
    classifyError(new Error('transport error', { cause: denial })) instanceof
      NonRetriableError,
  );
});

test('cybersecurity discussion alone does not classify a transport error as policy denial', () => {
  assert.ok(
    classifyError(
      new Error('connection lost while reviewing cybersecurity risk'),
    ) instanceof RetriableError,
  );
});
