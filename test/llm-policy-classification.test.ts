import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  NonRetriableError,
  RetriableError,
  UsageLimitError,
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

test('usage-limit 429s are terminal without reclassifying ordinary throttling', () => {
  assert.ok(
    classifyError({
      status: 429,
      message: '429 The usage limit has been reached',
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      code: 'insufficient_quota',
      message: 'You exceeded your current quota.',
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      message:
        "You've reached your usage limit. Your usage limit resets at 00:00 UTC.",
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      message: 'Your plan limit is exhausted; it resets on Saturday.',
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      message: "You've exhausted your quota.",
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      message: 'You hit your quota limit.',
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      message: 'Your quota has been exceeded.',
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      message: 'Your quota limit has been hit.',
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      message: 'Your usage window will reset in 2 hours.',
    }) instanceof UsageLimitError,
  );
  assert.ok(
    classifyError({
      status: 429,
      code: 'rate_limit_exceeded',
      message: 'Rate limit reached for requests.',
    }) instanceof RetriableError,
  );
  assert.ok(
    classifyError(new Error('The usage limit has been reached')) instanceof
      RetriableError,
  );
  assert.ok(
    classifyError({
      status: 503,
      message: "You've reached your usage limit.",
    }) instanceof RetriableError,
  );
  assert.ok(
    classifyError({
      status: 503,
      message: "You've exhausted your quota.",
    }) instanceof RetriableError,
  );
  assert.ok(
    classifyError(
      new Error('Your usage window will reset in 2 hours.'),
    ) instanceof RetriableError,
  );
  assert.ok(
    classifyError(new Error('You hit your quota limit.')) instanceof
      RetriableError,
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
