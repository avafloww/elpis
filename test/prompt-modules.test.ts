import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';
import { resolveBuiltinModules } from '../src/builtin-modules.js';
import { makeConfig } from './helpers.js';

function prompt(
  config: ReturnType<typeof makeConfig>,
  motorSkills: Array<{ name: string; description: string }> = [],
) {
  return build({
    soul: '',
    memory: '',
    now: '',
    harnessRoot: '/harness',
    dataDirectory: '/data',
    modules: resolveBuiltinModules(config),
    motorSkills,
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
    [{ name: 'pixel-game', description: 'LeafGreen controls and save ritual' }],
  );
  assert.match(p, /Available motor skills for `opts\.skills`/);
  assert.match(p, /`pixel-game`: LeafGreen controls and save ritual/);
  assert.match(p, /inspectSkill\(name\)/);
  assert.doesNotMatch(p, /SUPER SECRET MOTOR BODY/);
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
