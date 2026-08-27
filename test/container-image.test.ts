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

test('unified workflow publishes the current repository while PRs only build', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /image="ghcr\.io\/\$\{GITHUB_REPOSITORY,,\}"/);
  assert.match(workflow, /Build pull-request container without push/);
  assert.match(workflow, /if: github\.event_name == 'pull_request'/);
  assert.match(workflow, /docker push "\$target"/);
});

test('resident image owns exactly the protocol workspace dependency', () => {
  const docker = read('Dockerfile');
  const dockerignore = read('.dockerignore');
  const rootPackage = JSON.parse(read('package.json'));
  const gatewayPackage = JSON.parse(read('packages/gateway/package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.equal(rootPackage.dependencies['@elpis/gateway-protocol'], '1.0.0');
  assert.equal(
    gatewayPackage.dependencies['@elpis/gateway-protocol'],
    '1.0.0',
  );
  assert.equal(
    gatewayPackage.scripts.pretest,
    'npm run build --workspace @elpis/gateway-protocol',
  );
  assert.equal(
    JSON.parse(read('packages/gateway-protocol/package.json')).engines.node,
    rootPackage.engines.node,
  );
  assert.equal(
    lock.packages['packages/gateway-protocol'].version,
    '1.0.0',
  );
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
  assert.doesNotMatch(docker, /COPY (?:--from=build[^\n]+ )?packages\/gateway(?:\s|\/)/);
  assert.match(dockerignore, /^!packages\/gateway-protocol\/src\/\*\*$/m);
  assert.doesNotMatch(dockerignore, /^!packages\/gateway\//m);
});
