import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

test('Gateway builds and packages its local provider transport dependency', () => {
  const docker = read('Dockerfile.gateway');
  const pkg = JSON.parse(read('package.json'));
  const gateway = JSON.parse(read('packages/gateway/package.json'));
  assert.ok(
    pkg.scripts['build:gateway'].includes('npm run build:provider-transport'),
  );
  assert.ok(
    pkg.scripts['build:gateway'].indexOf('build:provider-transport') <
      pkg.scripts['build:gateway'].indexOf(
        'npm run build --workspace @elpis/gateway',
      ),
  );
  assert.ok(
    gateway.scripts.pretest.includes('--workspace @elpis/provider-transport'),
  );
  assert.ok(
    docker.includes(
      'COPY packages/provider-transport/package.json packages/provider-transport/package.json',
    ),
  );
  assert.ok(
    docker.includes(
      'COPY packages/provider-transport/tsconfig.json packages/provider-transport/tsconfig.json',
    ),
  );
  assert.ok(
    docker.includes(
      'COPY packages/provider-transport/src packages/provider-transport/src',
    ),
  );
  assert.match(
    docker,
    /RUN npm ci[^\n]*--workspace @elpis\/provider-transport/,
  );
  assert.ok(
    docker.includes('npm pack --silent --workspace @elpis/provider-transport'),
  );
  assert.match(
    docker,
    /COPY --from=build[^\n]*\/opt\/artifacts\/transport\.tgz/,
  );
  assert.match(
    docker,
    /npm install --omit=dev --ignore-scripts[^\n]*\.\/transport\.tgz/,
  );
});

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

test('resident image owns exactly the shared resident workspace dependencies', () => {
  const docker = read('Dockerfile');
  const dockerignore = read('.dockerignore');
  const workflow = read('.github/workflows/release.yml');
  const rootPackage = JSON.parse(read('package.json'));
  const gatewayPackage = JSON.parse(read('packages/gateway/package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  for (const workspace of ['gateway-protocol', 'provider-transport']) {
    const name = `@elpis/${workspace}`;
    assert.equal(rootPackage.dependencies[name], '1.0.0');
    assert.equal(
      JSON.parse(read(`packages/${workspace}/package.json`)).engines.node,
      rootPackage.engines.node,
    );
    assert.equal(lock.packages[`packages/${workspace}`].version, '1.0.0');
    assert.deepEqual(lock.packages[`node_modules/${name}`], {
      resolved: `packages/${workspace}`,
      link: true,
    });
    assert.match(
      docker,
      new RegExp(
        `COPY packages/${workspace}/package\\.json \\.?/packages/${workspace}/package\\.json`,
      ),
    );
    assert.match(
      docker,
      new RegExp(
        `COPY packages/${workspace}/src \\.?/packages/${workspace}/src`,
      ),
    );
    assert.match(
      docker,
      new RegExp(
        `COPY --from=build[^\\n]+packages/${workspace}/dist \\.?/packages/${workspace}/dist`,
      ),
    );
    assert.match(
      dockerignore,
      new RegExp(`^!packages/${workspace}/src/\\*\\*$`, 'm'),
    );
  }
  assert.match(
    rootPackage.scripts['test:unit'],
    /^npm run test:provider-transport && /,
  );
  assert.match(workflow, /await import\('@elpis\/provider-transport'\)/);
  assert.equal(gatewayPackage.dependencies['@elpis/gateway-protocol'], '1.0.0');
  assert.equal(
    gatewayPackage.scripts.pretest,
    'npm run build --workspace @elpis/gateway-protocol && npm run build --workspace @elpis/provider-transport',
  );
  assert.match(
    docker,
    /npm ci --legacy-peer-deps[\s\\]+--workspace @elpis\/gateway-protocol[\s\\]+--workspace @elpis\/provider-transport[\s\\]+--include-workspace-root/,
  );
  assert.match(
    docker,
    /npm prune --omit=dev --legacy-peer-deps[\s\\]+--workspace @elpis\/gateway-protocol[\s\\]+--workspace @elpis\/provider-transport[\s\\]+--include-workspace-root/,
  );
  assert.doesNotMatch(
    docker,
    /COPY (?:--from=build[^\n]+ )?packages\/gateway(?:\s|\/)/,
  );
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
