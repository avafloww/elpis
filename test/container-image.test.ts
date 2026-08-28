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

test('unified workflow publishes both images while pull requests only build', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /"ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}"/);
  assert.match(
    workflow,
    /"ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/elpis-gateway"/,
  );
  assert.match(workflow, /Build pull-request containers without push/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /docker push "\$target"/);
  assert.match(workflow, /--tmpfs \/tmp:rw,noexec,nosuid,size=16m/);
  assert.match(workflow, /--env HOME=\/tmp/);
  assert.match(workflow, /--env TMPDIR=\/tmp/);
  assert.match(workflow, /value\.startsWith\("\/tmp\/\.elpis-"\)/);
  assert.match(
    workflow,
    /ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/elpis-gateway/,
  );
  assert.match(workflow, /deploy\/test-gateway-container\.sh/);
  const smoke = read('deploy/test-gateway-container.sh');
  assert.match(smoke, /--read-only/);
  assert.match(smoke, /--tmpfs \/data:rw,noexec,nosuid/);
  assert.match(smoke, /process\.getuid\(\) !== 10001/);
  assert.match(smoke, /\/data\/gateway\.db/);
  assert.match(smoke, /\/healthz/);
  assert.match(smoke, /\/readyz/);
});

test('resident image owns exactly the protocol workspace dependency', () => {
  const docker = read('Dockerfile');
  const dockerignore = read('.dockerignore');
  const rootPackage = JSON.parse(read('package.json'));
  const gatewayPackage = JSON.parse(read('packages/gateway/package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.equal(rootPackage.dependencies['@elpis/gateway-protocol'], '1.0.0');
  assert.equal(gatewayPackage.dependencies['@elpis/gateway-protocol'], '1.0.0');
  assert.equal(
    gatewayPackage.scripts.pretest,
    'npm run build --workspace @elpis/gateway-protocol',
  );
  assert.equal(
    JSON.parse(read('packages/gateway-protocol/package.json')).engines.node,
    rootPackage.engines.node,
  );
  assert.equal(lock.packages['packages/gateway-protocol'].version, '1.0.0');
  assert.deepEqual(lock.packages['node_modules/@elpis/gateway-protocol'], {
    resolved: 'packages/gateway-protocol',
    link: true,
  });
  assert.match(
    docker,
    /COPY packages\/gateway-protocol\/package\.json \.\/packages\/gateway-protocol\/package\.json/,
  );
  assert.match(
    docker,
    /npm ci --legacy-peer-deps --workspace @elpis\/gateway-protocol --include-workspace-root/,
  );
  assert.match(
    docker,
    /npm prune --omit=dev --legacy-peer-deps --workspace @elpis\/gateway-protocol --include-workspace-root/,
  );
  assert.match(
    docker,
    /COPY --from=build[^\n]+packages\/gateway-protocol\/dist \.\/packages\/gateway-protocol\/dist/,
  );
  assert.doesNotMatch(
    docker,
    /COPY (?:--from=build[^\n]+ )?packages\/gateway(?:\s|\/)/,
  );
  assert.match(dockerignore, /^!packages\/gateway-protocol\/src\/\*\*$/m);
  assert.match(dockerignore, /^!packages\/gateway\/src\/\*\*$/m);
  const gatewayDocker = read('Dockerfile.gateway');
  assert.match(
    gatewayDocker,
    /COPY packages\/gateway\/src packages\/gateway\/src/,
  );
  assert.match(
    gatewayDocker,
    /COPY packages\/gateway-protocol\/src packages\/gateway-protocol\/src/,
  );
  assert.deepEqual(gatewayDocker.match(/^COPY src\/[^\n]+$/gm), [
    'COPY src/console/client src/console/client',
    'COPY src/console/public src/console/public',
  ]);
  assert.doesNotMatch(gatewayDocker, /COPY src(?:\s|\/(?!console\/))/);
  assert.doesNotMatch(
    gatewayDocker,
    /node_modules\/elpis|\/opt\/gateway\/dist/,
  );
});
