import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toggleExternalThinking } from '../scripts/toggle-external-thinking.js';

test('toggleExternalThinking flips the canonical boolean and preserves surrounding YAML', () => {
  const input =
    'llm:\n  model: gpt-test\n  external_thinking: true # grug\noperator:\n  name: Bramble\n';
  const result = toggleExternalThinking(input);
  assert.equal(result.before, true);
  assert.equal(result.after, false);
  assert.equal(
    result.text,
    'llm:\n  model: gpt-test\n  external_thinking: false # grug\noperator:\n  name: Bramble\n',
  );
  assert.equal(toggleExternalThinking(result.text).after, true);
});

test('toggleExternalThinking rejects missing, non-boolean, and duplicate keys', () => {
  assert.throws(
    () => toggleExternalThinking('llm:\n  model: x\n'),
    /boolean llm\.external_thinking/,
  );
  assert.throws(
    () => toggleExternalThinking('llm:\n  external_thinking: yes\n'),
    /boolean llm\.external_thinking/,
  );
  assert.throws(
    () =>
      toggleExternalThinking(
        'llm:\n  external_thinking: true\nother:\n  external_thinking: false\n',
      ),
    /exactly one/,
  );
});
