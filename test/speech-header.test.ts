import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSpeechHeader,
  eligibleSpeechHeader,
} from '../src/lib/speech-header.js';

test('speech header parses an explicit qualified target and optional reply', () => {
  assert.deepEqual(parseSpeechHeader('[send to=example/lounge]\nhello'), {
    target: 'example/lounge',
    text: 'hello',
  });
  assert.deepEqual(
    parseSpeechHeader('[send to=example/lounge replyTo=123]\r\n hello\n'),
    {
      target: 'example/lounge',
      replyTo: '123',
      text: ' hello\n',
    },
  );
  assert.equal(
    parseSpeechHeader('[send to=example/🌱]\nhello')?.target,
    'example/🌱',
  );
});

test('speech header never infers a destination or promotes quoted headers', () => {
  for (const content of [
    undefined,
    null,
    '',
    'hello',
    ' [send to=example/lounge]\nhello',
    '> [send to=example/lounge]\nhello',
    '```\n[send to=example/lounge]\nhello\n```',
    '[send to=lounge]\nhello',
    '[send to=123]\nhello',
    '[send to=example/lounge extra=yes]\nhello',
    '[send replyTo=123 to=example/lounge]\nhello',
    '[send to=example/lounge replyTo=abc]\nhello',
    '[send to=example/lounge replyTo=123 replyTo=456]\nhello',
    '[send to=example/lounge replyTo=123456789012345678901]\nhello',
    '[send to=example/lounge]',
    '[send to=example/lounge]\n \n',
  ])
    assert.equal(parseSpeechHeader(content), null);
});

test('speech header preserves the body rather than interpreting additional commands', () => {
  const text = 'literal example:\n[send to=other/lounge]\nquoted text';
  assert.deepEqual(parseSpeechHeader('[send to=example/lounge]\n' + text), {
    target: 'example/lounge',
    text,
  });
});

test('header eligibility requires complete unstripped assistant output', () => {
  const message = {
    role: 'assistant' as const,
    content: '[send to=example/lounge]\nhello',
  };
  assert.deepEqual(
    eligibleSpeechHeader({
      message,
      stripped: false,
      completionStatus: 'complete',
    }),
    {
      target: 'example/lounge',
      text: 'hello',
    },
  );
  for (const completionStatus of [
    undefined,
    'unknown',
    'incomplete',
  ] as const) {
    assert.equal(
      eligibleSpeechHeader({ message, stripped: false, completionStatus }),
      null,
    );
  }
  assert.equal(
    eligibleSpeechHeader({
      message,
      stripped: true,
      completionStatus: 'complete',
    }),
    null,
  );
  for (const role of ['user', 'tool', 'system'] as const) {
    assert.equal(
      eligibleSpeechHeader({
        message: { ...message, role },
        stripped: false,
        completionStatus: 'complete',
      }),
      null,
    );
  }
});
