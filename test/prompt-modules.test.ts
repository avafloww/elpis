import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';
import { resolveBuiltinModules } from '../src/builtin-modules.js';
import { makeConfig } from './helpers.js';

function prompt(
  config: ReturnType<typeof makeConfig>,
  motorSkills: Array<{ name: string; description: string }> = [],
  llmTools: Array<{
    tier: 'weak' | 'medium' | 'strong';
    ref: string;
    model: string;
    providerType: 'openai-compatible';
    contextSize: number | null;
  }> = [],
) {
  return build({
    soul: '',
    memory: '',
    now: '',
    harnessRoot: '/harness',
    dataDirectory: '/data',
    modules: resolveBuiltinModules(config),
    motorSkills,
    llmTools,
  });
}

test('only active built-in modules enter the prompt', () => {
  const p = prompt(
    makeConfig({
      modules: { enabled: ['kagi', 'bsky', 'browser'], disabled: [] },
      kagi: { apiKey: 'configured' },
      bluesky: null,
    }),
  );
  assert.match(p, /### `elpis\.extract/);
  assert.match(p, /### `elpis\.search/);
  assert.match(p, /### `elpis\.browser`/);
  for (const absent of [
    '### `elpis.bsky`',
    '### `elpis.computer`',
    '### `elpis.motor`',
    'Bluesky is selected but not configured',
  ])
    assert.equal(p.includes(absent), false, absent);
});

test('active motor docs expose only the resident-selectable motor-skill catalog', () => {
  const p = prompt(
    makeConfig({
      modules: { enabled: ['computer', 'motor'], disabled: [] },
    }),
    [
      {
        name: 'pixel-game',
        description: 'Pixel game controls',
        ...{ body: 'SUPER SECRET MOTOR BODY' },
      },
    ],
  );
  assert.match(p, /Available motor skills for `opts\.skills`/);
  assert.match(p, /`pixel-game`: Pixel game controls/);
  assert.match(p, /inspectSkill\(name\)/);
  assert.doesNotMatch(p, /SUPER SECRET MOTOR BODY/);
});

test('active computer docs expose exact-window lifecycle cleanup', () => {
  const p = prompt(
    makeConfig({
      modules: { enabled: ['computer'], disabled: [] },
    }),
  );
  assert.match(p, /closeWindow\(id\).*exact-window lifecycle cleanup/);
});

test('bare LLM docs appear only for an opted-in sanitized model catalog', () => {
  const absent = prompt(makeConfig());
  assert.doesNotMatch(absent, /### `elpis\.llm`/);
  const present = prompt(
    makeConfig(),
    [],
    [
      {
        tier: 'weak',
        ref: 'p/weak',
        model: 'wire-weak',
        providerType: 'openai-compatible',
        contextSize: 32000,
        ...{
          endpoint: 'https://private-endpoint.example.com',
          apiKey: 'synthetic-key',
          reasoningContent: 'private-reasoning',
        },
      },
    ],
  );
  assert.match(present, /### `elpis\.llm`/);
  assert.match(present, /`weak` or `p\/weak`: `wire-weak`/);
  assert.doesNotMatch(
    present,
    /private-endpoint|apiKey|synthetic-key|reasoningContent|private-reasoning/,
  );
});

test('disabled and unavailable modules are both entirely absent from prompt text', () => {
  const p = prompt(
    makeConfig({
      modules: { enabled: ['kagi'], disabled: [] },
      kagi: { apiKey: null },
    }),
  );
  for (const token of [
    'elpis.extract',
    'elpis.search',
    'elpis.bsky',
    'elpis.browser',
    'elpis.computer',
    'elpis.motor',
  ])
    assert.equal(p.includes(token), false, token);
});
