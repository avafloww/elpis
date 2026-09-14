import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

// Static deployment guards complement CI's actual container build and boot probes.
test('image recipe declares the restricted non-root runtime boundary', () => {
  const docker = read('Dockerfile');
  assert.match(docker, /touch \/etc\/elpis\/restricted/);
  assert.match(docker, /chmod 0444 \/etc\/elpis\/restricted/);
  assert.match(docker, /ELPIS_CONFIG=\/config\.yaml/);
  assert.doesNotMatch(docker, /ELPIS_CONFIG=\/data\//);
  assert.match(docker, /USER 10001:10001/);
  assert.match(docker, /VOLUME \["\/data"\]/);
  assert.match(docker, /HEALTHCHECK/);
  assert.doesNotMatch(docker, /\bsudo\b/);
});

test('entrypoint source retains sentinel, config, and private-directory guards', () => {
  const entry = read('deploy/container-entrypoint.sh');
  assert.match(entry, /! -r \/etc\/elpis\/restricted/);
  assert.match(entry, /! -w \/data/);
  assert.match(entry, /! -r "\$ELPIS_CONFIG"/);
  assert.match(entry, /read-only at \/config\.yaml/);
  assert.match(entry, /private_runtime_dir/);
  assert.match(entry, /chmod 0700 "\$path" 2>\/dev\/null/);
  assert.match(entry, /HOME=\$\(private_runtime_dir "\$HOME" \.elpis-home\)/);
  assert.match(
    entry,
    /TMPDIR=\$\(private_runtime_dir "\$TMPDIR" \.elpis-tmp\)/,
  );
  assert.doesNotMatch(entry, /chmod 0700 "\$HOME" "\$TMPDIR"/);
  assert.match(entry, /exec "\$@"/);
});

test('container embeds immutable build identity inputs', () => {
  const docker = read('Dockerfile');
  const workflow = read('.github/workflows/release.yml');
  assert.match(docker, /ARG ELPIS_BUILD_REVISION/);
  assert.match(
    docker,
    /ENV NODE_ENV=production[\s\S]*ELPIS_BUILD_REVISION=\$\{ELPIS_BUILD_REVISION\}/,
  );
  assert.match(docker, /ELPIS_BUILD_TAG=\$\{ELPIS_BUILD_TAG\}/);
  assert.match(docker, /ELPIS_BUILD_DIRTY=\$\{ELPIS_BUILD_DIRTY\}/);
  const gatewayDocker = read('Dockerfile.gateway');
  assert.match(gatewayDocker, /ARG ELPIS_BUILD_REVISION/);
  assert.match(gatewayDocker, /ARG ELPIS_BUILD_TAG/);
  assert.match(gatewayDocker, /ARG ELPIS_BUILD_DIRTY=false/);
  assert.match(
    gatewayDocker,
    /ELPIS_BUILD_REVISION=\$\{ELPIS_BUILD_REVISION\}/,
  );
  assert.match(gatewayDocker, /ELPIS_BUILD_TAG=\$\{ELPIS_BUILD_TAG\}/);
  assert.match(gatewayDocker, /ELPIS_BUILD_DIRTY=\$\{ELPIS_BUILD_DIRTY\}/);
  assert.match(workflow, /ELPIS_BUILD_REVISION=\$\{GITHUB_SHA\}/);
  assert.match(
    workflow,
    /ELPIS_BUILD_REVISION=\$\{\{ steps\.prep\.outputs\.release_sha \}\}/,
  );
  assert.match(
    workflow,
    /ELPIS_BUILD_TAG=\$\{\{ steps\.prep\.outputs\.tag \}\}/,
  );
  assert.match(workflow, /ELPIS_BUILD_DIRTY=false/);
});

test('container smoke scripts retain read-only execution and private temporary directories', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /--tmpfs \/tmp:rw,noexec,nosuid,size=16m/);
  assert.match(workflow, /--env HOME=\/tmp/);
  assert.match(workflow, /--env TMPDIR=\/tmp/);
  assert.match(workflow, /value\.startsWith\("\/tmp\/\.elpis-"\)/);
  const smoke = read('deploy/test-gateway-container.sh');
  assert.match(smoke, /--read-only/);
  assert.match(smoke, /--tmpfs \/data:rw,noexec,nosuid/);
  assert.match(smoke, /process\.getuid\(\) !== 10001/);
  assert.match(smoke, /\/data\/gateway\.db/);
  assert.match(smoke, /\/healthz/);
  assert.match(smoke, /\/readyz/);
});

test('image source boundaries keep resident internals out of Gateway', () => {
  const docker = read('Dockerfile');
  assert.doesNotMatch(
    docker,
    /COPY (?:--from=build[^\n]+ )?packages\/gateway(?:\s|\/)/,
  );
  const gatewayDocker = read('Dockerfile.gateway');
  assert.doesNotMatch(gatewayDocker, /COPY src(?:\s|\/(?!console\/))/);
  assert.doesNotMatch(
    gatewayDocker,
    /node_modules\/elpis|\/opt\/gateway\/dist/,
  );
});
