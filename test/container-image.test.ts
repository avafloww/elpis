import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('official image hard-codes the restricted non-root runtime contract', () => {
  const docker = read('Dockerfile');
  assert.equal((docker.match(/FROM node:24-trixie-slim/g) ?? []).length, 2);
  assert.doesNotMatch(docker, /bookworm/);
  assert.match(docker, /touch \/etc\/elpis\/restricted/);
  assert.match(docker, /chmod 0444 \/etc\/elpis\/restricted/);
  assert.match(docker, /ELPIS_CONFIG=\/config\.yaml/);
  assert.doesNotMatch(docker, /ELPIS_CONFIG=\/data\//);
  assert.match(docker, /USER 10001:10001/);
  assert.match(docker, /VOLUME \["\/data"\]/);
  assert.match(docker, /HEALTHCHECK/);
  for (const tool of ['bash', 'curl', 'jq', 'python3', 'python3-pip', 'python3-venv', 'ripgrep', 'wget']) {
    assert.match(docker, new RegExp(`\\b${tool}\\b`));
  }
  assert.match(docker, /--shell \/bin\/bash/);
  assert.doesNotMatch(docker, /\bsudo\b/);
});

test('container entrypoint fails closed around sentinel config and writable data', () => {
  const entry = read('deploy/container-entrypoint.sh');
  assert.match(entry, /! -r \/etc\/elpis\/restricted/);
  assert.match(entry, /! -w \/data/);
  assert.match(entry, /! -r "\$ELPIS_CONFIG"/);
  assert.match(entry, /read-only at \/config\.yaml/);
  assert.match(entry, /exec "\$@"/);
});

test('GHCR workflow publishes the official repository while PRs only build', () => {
  const workflow = read('.github/workflows/container.yml');
  assert.match(workflow, /ghcr\.io\/avafloww\/elpis/);
  assert.match(workflow, /push: \$\{\{ github\.event_name != 'pull_request' \}\}/);
});
