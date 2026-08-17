import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';
const base = { soul: '', memory: '', now: '', harnessRoot: '/harness', dataDirectory: '/data' };
test('restricted prompt removes host ownership privilege and self-deployment claims', () => {
  const p = build({ ...base, profile: { restricted: true, source: 'sentinel' } });
  assert.match(p, /running in a restricted container/);
  assert.match(p, /## Your restricted runtime/);
  assert.match(p, /You may write extensions under `DATA_DIR\/extensions\/`/);
  assert.match(p, /takes effect only after an external restart/);
  for (const absent of ['You own this server', 'passwordless sudo', 'You can modify your own harness', 'elpis.sudo(cmd', 'elpis.restart(reason', 'elpis.deploy(reason', 'HARNESS_ROOT', 'harness-source commits']) assert.equal(p.includes(absent), false, absent);
});
test('normal prompt retains self-managed host capabilities', () => {
  const p = build({ ...base, profile: { restricted: false, source: 'normal' } });
  for (const present of ['You own this server', '### `elpis.sudo', '### `elpis.restart', '### `elpis.deploy']) assert.equal(p.includes(present), true, present);
});
