import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'yaml';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const workflowPath = path.join(root, '.github/workflows/release.yml');

const readWorkflow = async (): Promise<Record<string, any>> =>
  parse(await fs.readFile(workflowPath, 'utf8'), {
    uniqueKeys: true,
  }) as Record<string, any>;

test('unified workflow has exact triggers concurrency and least job permissions', async () => {
  const names = (await fs.readdir(path.join(root, '.github/workflows'))).sort();
  assert.deepEqual(names, ['release.yml']);
  const workflow = await readWorkflow();
  assert.equal(workflow.name, 'ci-release');
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    'pull_request',
    'push',
    'workflow_dispatch',
  ]);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.deepEqual(workflow.on.push['paths-ignore'], ['**/*.md']);
  assert.equal(workflow.on.push.tags, undefined);
  assert.equal(workflow.on.pull_request, null);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.bootstrap, {
    description: 'Publish the explicit first v0.1.0 release',
    required: true,
    default: false,
    type: 'boolean',
  });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(
    workflow.concurrency['cancel-in-progress'],
    "${{ github.event_name == 'pull_request' }}",
  );
  assert.deepEqual(workflow.jobs.validate.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.release.permissions, {
    contents: 'write',
    packages: 'write',
  });
  assert.equal(workflow.jobs.release.needs, 'validate');
  assert.equal(workflow.jobs.release.if, "github.event_name != 'pull_request'");

  const uses = Object.values(workflow.jobs)
    .flatMap((job: any) => job.steps)
    .flatMap((step: any) => (typeof step.uses === 'string' ? [step.uses] : []));
  const allowed = new Set([
    'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
    'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
    'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
  ]);
  assert.ok(uses.length > 0);
  assert.ok(
    uses.every((value) => allowed.has(value)),
    uses.join('\n'),
  );
  assert.ok(uses.every((value) => /@[0-9a-f]{40}$/.test(value)));

  const buildxSteps = Object.values(workflow.jobs)
    .flatMap((job: any) => job.steps)
    .filter((step: any) =>
      String(step.uses ?? '').startsWith('docker/setup-buildx-action@'),
    );
  assert.equal(buildxSteps.length, 2);
  assert.ok(buildxSteps.every((step: any) => step.with.version === 'v0.36.1'));
});

test('workflow publishes exact resident and Gateway images after guarded release refs', async () => {
  const text = await fs.readFile(workflowPath, 'utf8');
  const workflow = await readWorkflow();
  const releaseSteps = workflow.jobs.release.steps as any[];
  const index = (name: string): number =>
    releaseSteps.findIndex((step) => step.name === name);
  assert.ok(index('Prepare or resume release') > 0);
  assert.ok(
    index('Exact release commit gates') > index('Prepare or resume release'),
  );
  assert.ok(
    index('Build exact release containers once') >
      index('Exact release commit gates'),
  );
  assert.ok(
    index('Refetch and atomically publish release refs') >
      index('Build exact release containers once'),
  );
  assert.ok(
    index('Validate pushed bot-associated commit') >
      index('Refetch and atomically publish release refs'),
  );
  assert.ok(
    index('Publish both built images under every release tag') >
      index('Validate pushed bot-associated commit'),
  );
  assert.ok(
    index('Verify anonymous Gateway image pull') >
      index('Publish both built images under every release tag'),
  );
  assert.ok(
    index('Publish GitHub release notes without binary assets') >
      index('Verify anonymous Gateway image pull'),
  );

  assert.equal((text.match(/npm run tools:check/g) ?? []).length, 2);
  assert.equal((text.match(/npm run test:gateway/g) ?? []).length, 2);
  assert.equal((text.match(/npm run build:gateway/g) ?? []).length, 2);
  assert.equal((text.match(/docker buildx build/g) ?? []).length, 4);
  assert.equal((text.match(/git push --atomic/g) ?? []).length, 2);
  assert.equal(
    (text.match(/npm run release:workflow -- prepare/g) ?? []).length,
    2,
  );
  assert.equal((text.match(/--bootstrap "\$BOOTSTRAP"/g) ?? []).length, 2);
  assert.match(
    text,
    /ELPIS_BUILD_REVISION=\$\{\{ steps\.prep\.outputs\.release_sha \}\}/,
  );
  assert.match(text, /ELPIS_BUILD_TAG=\$\{\{ steps\.prep\.outputs\.tag \}\}/);
  assert.match(text, /ELPIS_BUILD_DIRTY=false/);
  assert.match(text, /docker image inspect/);
  assert.match(text, /docker run --rm --entrypoint node/);
  assert.match(text, /await import\('@elpis\/gateway-protocol'\)/);
  assert.match(text, /existsSync\('\/opt\/elpis\/packages\/gateway'\)/);
  assert.match(text, /sha-\$\{\{ steps\.prep\.outputs\.short_sha \}\}/);
  assert.match(text, /docker push "\$target"/);
  assert.match(text, /imagetools inspect --raw/);
  assert.match(text, /--file Dockerfile\.gateway/);
  assert.match(text, /elpis-gateway-release:/);
  assert.match(
    text,
    /ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/elpis-gateway/,
  );
  assert.match(text, /deploy\/test-gateway-container\.sh "\$gateway_image"/);
  assert.match(text, /publish_family[\s\S]*publish_family/);
  assert.match(text, /https:\/\/ghcr\.io\/token\?service=ghcr\.io/);
  assert.match(text, /repository:\$\{repository\}:pull/);
  assert.match(text, /ghcr\.io\/v2\/\$\{repository\}\/manifests/);
  assert.match(text, /Verify anonymous Gateway image pull/);
  assert.match(text, /gh release create/);
  assert.match(text, /gh release edit/);
  assert.doesNotMatch(text, /gh release upload/);
  assert.match(text, /\.assets \| length/);
  assert.match(text, /release\.assets\.length !== 0/);
  assert.match(text, /release_notes_sha256/);
  assert.match(text, /cmp -s/);
  assert.doesNotMatch(text, /--generate-notes/);
  assert.doesNotMatch(text, /cargo|rustup|rust\/|ORAS|executor distribution/i);
  assert.doesNotMatch(text, /build-push-action/);
  assert.doesNotMatch(
    text,
    /personal[_ -]?access|\bPAT\b|skip release|\[skip/i,
  );
  assert.doesNotMatch(text, /^\s+tags:\s*\[?'v\*'/m);
});

test('every workflow run block is valid Bash after expression substitution', async () => {
  const workflow = await readWorkflow();
  for (const job of Object.values(workflow.jobs) as any[]) {
    for (const step of job.steps as any[]) {
      if (typeof step.run !== 'string') continue;
      const normalized = step.run.replace(
        /\$\{\{[\s\S]*?\}\}/g,
        'github_value',
      );
      await execFileAsync('bash', ['-n', '-c', normalized], {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
    }
  }
});

test('audit script retries only bounded transient network failures', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-audit-ci-'));
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.writeFile(
    path.join(bin, 'npm'),
    `#!/bin/bash
count=0
[ ! -f "$COUNT_FILE" ] || count="$(cat "$COUNT_FILE")"
count=$((count + 1))
printf '%s' "$count" >"$COUNT_FILE"
case "$CASE" in
  transient)
    if [ "$count" -eq 1 ]; then
      echo 'npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/'
      echo 'npm error audit endpoint returned an error'
      exit 1
    fi
    echo 'found 0 vulnerabilities'
    exit 0
    ;;
  unauthorized)
    echo 'npm warn audit 401 Unauthorized - POST https://registry.npmjs.org/'
    echo 'npm error audit endpoint returned an error'
    exit 1
    ;;
  advisory-text)
    echo 'high severity advisory: network timeout at dependency boundary'
    exit 1
    ;;
  outage)
    echo 'npm warn audit network timeout at: https://registry.npmjs.org/'
    echo 'npm error audit endpoint returned an error'
    exit 1
    ;;
  *) exit 99 ;;
esac
`,
    { mode: 0o700 },
  );
  await fs.writeFile(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', {
    mode: 0o700,
  });

  const cases = [
    { name: 'transient', status: 0, calls: 2 },
    { name: 'unauthorized', status: 1, calls: 1 },
    { name: 'advisory-text', status: 1, calls: 1 },
    { name: 'outage', status: 1, calls: 3 },
  ];
  try {
    for (const fixture of cases) {
      const countFile = path.join(tmp, `${fixture.name}.count`);
      let status = 0;
      try {
        await execFileAsync(path.join(root, 'scripts/npm-audit-ci.sh'), [], {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CASE: fixture.name,
            COUNT_FILE: countFile,
          },
        });
      } catch (error) {
        status = (error as { code?: number }).code ?? -1;
      }
      assert.equal(status, fixture.status, fixture.name);
      assert.equal(
        Number(await fs.readFile(countFile, 'utf8')),
        fixture.calls,
        fixture.name,
      );
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
