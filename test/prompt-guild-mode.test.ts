import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';
const base = { soul: '', memory: '', now: '', harnessRoot: '/h', dataDirectory: '/d' };
test('single-guild prompt uses singular room norms without multi-world prose', () => {
  const p = build({ ...base, guildCount: 1 });
  assert.match(p, /## Living in this server/);
  assert.match(p, /one configured Discord server/);
  for (const absent of ['several Discord servers', 'separate social world', 'social servers', 'which social world']) assert.equal(p.includes(absent), false, absent);
});
test('multi-guild prompt retains the server-wall contract', () => {
  const p = build({ ...base, guildCount: 2 });
  assert.match(p, /## Living in several servers/);
  assert.match(p, /Each server is a separate social world/);
  assert.match(p, /travel to social servers/);
});
