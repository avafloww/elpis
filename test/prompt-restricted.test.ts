import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../src/llm/prompt.js';
const base = { soul: '', memory: '', now: '', harnessRoot: '/harness', dataDirectory: '/data' };
test('restricted prompt removes host ownership privilege and self-deployment claims', () => {
  const p = build({ ...base, profile: { restricted: true, source: 'sentinel' } });
  assert.match(p, /running in a restricted container/);
  assert.match(p, /## Your restricted runtime/);
  assert.match(p, /You may write extensions under `DATA_DIR\/elpis-data\/config\/extensions\/`/);
  assert.match(p, /call `elpis\.restart\(\)` to ask the namespaced broker/);
  assert.match(p, /### `elpis\.restart\(reason\?\)`/);
  assert.match(p, /cannot choose a deployment, image, command, or Kubernetes credential/);
  for (const absent of ['You own this server', 'passwordless sudo', 'multi-command root script', 'You can modify your own harness', 'elpis.deploy', 'HARNESS_ROOT', 'harness-source commits']) assert.equal(p.includes(absent), false, absent);
});
test('normal prompt retains self-managed host capabilities', () => {
  const p = build({ ...base, profile: { restricted: false, source: 'normal' } });
  for (const present of ['You own this server', '### `elpis.sudo', 'shell operators in `elpis.sudo("a && b")` may leave `b` unprivileged', 'await elpis.sudo("sh -c " + elpis.sh.q(script))', '### `elpis.restart', '### `elpis.deploy']) assert.equal(p.includes(present), true, present);
});
