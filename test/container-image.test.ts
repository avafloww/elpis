import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('official image hard-codes the restricted non-root runtime contract', () => {
  const docker = read('Dockerfile');
  const dockerignore = read('.dockerignore');
  assert.equal((docker.match(/FROM node:24-trixie-slim/g) ?? []).length, 2);
  assert.match(docker, /COPY tsconfig\.json tsconfig\.console\.json \.\//);
  assert.match(
    docker,
    /COPY scripts\/build-console\.mjs \.\/scripts\/build-console\.mjs/,
  );
  assert.match(dockerignore, /^!tsconfig\.console\.json$/m);
  assert.match(dockerignore, /^!scripts\/build-console\.mjs$/m);
  assert.doesNotMatch(docker, /bookworm/);
  assert.match(docker, /touch \/etc\/elpis\/restricted/);
  assert.match(docker, /chmod 0444 \/etc\/elpis\/restricted/);
  assert.match(docker, /ELPIS_CONFIG=\/config\.yaml/);
  assert.doesNotMatch(docker, /ELPIS_CONFIG=\/data\//);
  assert.match(docker, /USER 10001:10001/);
  assert.match(docker, /VOLUME \["\/data"\]/);
  assert.match(docker, /HEALTHCHECK/);
  for (const tool of [
    'bash',
    'curl',
    'jq',
    'python3',
    'python3-pip',
    'python3-venv',
    'ripgrep',
    'wget',
  ]) {
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

test('unified workflow limits PRs to no-push builds and release publication to GHCR', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /Build pull-request container without push/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /docker buildx build --load --tag "elpis-pr:/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /docker\/login-action@[0-9a-f]{40}/);
  assert.match(workflow, /image="ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}"/);
  assert.match(workflow, /oras cp --from-oci-layout/);
  assert.match(workflow, /oras manifest index create/);
  assert.match(workflow, /oras tag "\$image@\$index_digest"/);
  assert.doesNotMatch(workflow, /docker push|imagetools create/);
  assert.match(workflow, /application\/vnd\.oci\.image\.index\.v1\+json/);
  assert.doesNotMatch(workflow, /^\s+tags:\s*\[?'v\*'/m);
});
