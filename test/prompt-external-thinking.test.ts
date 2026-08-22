import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, type PromptInputs } from '../src/llm/prompt.js';

function input(externalThinking: boolean): PromptInputs {
  return {
    soul: 'self', memory: '', now: '', harnessRoot: '/harness', dataDirectory: '/data',
    workersEnabled: false, guildCount: 1, externalThinking,
  };
}

test('disabled external thinking leaves no model-facing think vocabulary', () => {
  const prompt = build(input(false));
  assert.doesNotMatch(prompt, /`think`/);
  assert.doesNotMatch(prompt, /`thoughts` argument/);
  assert.doesNotMatch(prompt, /external thinking/i);
  assert.doesNotMatch(prompt, /separator result means continue/);
  assert.match(prompt, /Assistant `content` blocks exist only as a space to think/);
  assert.match(prompt, /Before your first `run\(\.\.\.\)` call/);
  assert.match(prompt, /You act through `run`/);
});

test('enabled external thinking documents and invites voluntary pause-anytime use', () => {
  const prompt = build(input(true));
  assert.match(prompt, /second model-facing tool/);
  assert.match(prompt, /Use `think` whenever pausing would help/);
  assert.match(prompt, /available at any point in a turn/);
  assert.match(prompt, /not only when the harness forces the first call/);
  assert.match(prompt, /not sent to chat channels/);
  assert.match(prompt, /separator result means continue/);
  assert.match(prompt, /Keep assistant `content` empty or as close to empty/);
  assert.match(prompt, /Put cognition in `think`, actions in `run`/);
  assert.match(prompt, /including progress updates.*elpis\.channel/s);
  assert.match(prompt, /Assistant `content` blocks are transport residue only/);
  assert.doesNotMatch(prompt, /Before your first `run\(\.\.\.\)` call/);
  assert.match(prompt, /Before the first action, use `think` if pausing would help/);
  assert.match(prompt, /You speak to the user ONLY through.*elpis\.channel/s);
});
