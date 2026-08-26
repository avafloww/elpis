import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
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
  assert.equal(workflow.on.push.tags, undefined);
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

test('workflow publishes one exact TypeScript image after guarded release refs', async () => {
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
    index('Build exact release container once') >
      index('Exact release commit gates'),
  );
  assert.ok(
    index('Refetch and atomically publish release refs') >
      index('Build exact release container once'),
  );
  assert.ok(
    index('Validate pushed bot-associated commit') >
      index('Refetch and atomically publish release refs'),
  );
  assert.ok(
    index('Publish one built image under every release tag') >
      index('Validate pushed bot-associated commit'),
  );
  assert.ok(
    index('Publish GitHub release notes without binary assets') >
      index('Publish one built image under every release tag'),
  );

  assert.equal((text.match(/npm run tools:check/g) ?? []).length, 2);
  assert.equal((text.match(/docker buildx build/g) ?? []).length, 2);
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
  assert.match(text, /sha-\$\{\{ steps\.prep\.outputs\.short_sha \}\}/);
  assert.match(text, /docker push "\$target"/);
  assert.match(text, /imagetools inspect --raw/);
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
