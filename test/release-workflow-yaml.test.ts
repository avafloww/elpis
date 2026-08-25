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

test('unified workflow has exact triggers concurrency and least job permissions', async () => {
  const names = (await fs.readdir(path.join(root, '.github/workflows'))).sort();
  assert.deepEqual(names, ['release.yml']);
  const text = await fs.readFile(workflowPath, 'utf8');
  const workflow = parse(text) as Record<string, any>;
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
  const releaseSteps = workflow.jobs.release.steps as any[];
  const prepIndex = releaseSteps.findIndex((step) => step.id === 'prep');
  assert.ok(prepIndex > 0);
  assert.match(releaseSteps[prepIndex - 1].run, /refs\/heads\/main/);
  assert.match(releaseSteps[prepIndex - 1].run, /refs\/tags\/\*/);
  const uses = Object.values(workflow.jobs)
    .flatMap((job: any) => job.steps)
    .flatMap((step: any) => (typeof step.uses === 'string' ? [step.uses] : []));
  assert.ok(
    uses.every((value) =>
      [
        'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
        'actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444',
        'actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830',
        'docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f',
        'docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
      ].includes(value),
    ),
  );
  const buildxSteps = Object.values(workflow.jobs)
    .flatMap((job: any) => job.steps)
    .filter((step: any) =>
      String(step.uses ?? '').startsWith('docker/setup-buildx-action@'),
    );
  assert.equal(buildxSteps.length, 2);
  assert.ok(buildxSteps.every((step: any) => step.with.version === 'v0.36.1'));
});

test('workflow builds each release artifact once and publishes through guarded exact seams', async () => {
  const text = await fs.readFile(workflowPath, 'utf8');
  assert.equal((text.match(/npm run tools:check/g) ?? []).length, 2);
  assert.equal((text.match(/cargo xtask dist/g) ?? []).length, 1);
  assert.equal((text.match(/docker buildx build/g) ?? []).length, 2);
  assert.equal((text.match(/git push --atomic/g) ?? []).length, 2);
  assert.equal((text.match(/:refs\/heads\/main/g) ?? []).length, 2);
  assert.equal(
    (text.match(/npm run release:workflow -- prepare/g) ?? []).length,
    2,
  );
  assert.equal((text.match(/--bootstrap "\$BOOTSTRAP"/g) ?? []).length, 2);
  assert.match(
    text,
    /elif \[ "\$\{\{ steps\.prep\.outputs\.mode \}\}" = bootstrap \]/,
  );
  assert.match(text, /origin\/main\).*base_sha|base_sha/);
  assert.match(text, /gh release upload/);
  assert.match(text, /gh release create/);
  assert.match(text, /docker image inspect --format '\{\{\.Id\}\}'/);
  assert.equal(
    (text.match(/--output "type=docker,name=\$local_image"/g) ?? []).length,
    1,
  );
  assert.equal(
    (
      text.match(
        /--output "type=oci,dest=\$oci_archive,name=\$local_image"/g,
      ) ?? []
    ).length,
    1,
  );
  assert.match(text, /ORAS_VERSION: 1\.3\.3/);
  assert.match(
    text,
    /9ce999f8d2de03fc03968b29d743077a58783e545e5eaa53917ca177352d0e59/,
  );
  assert.equal((text.match(/oras cp --from-oci-layout/g) ?? []).length, 1);
  assert.equal((text.match(/oras manifest index create/g) ?? []).length, 1);
  assert.equal(
    (text.match(/oras tag "\$image@\$index_digest"/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(text, /docker push|imagetools create/);
  assert.match(text, /application\/vnd\.oci\.image\.index\.v1\+json/);
  assert.match(text, /sha-\$\{\{ steps\.prep\.outputs\.short_sha \}\}/);
  assert.doesNotMatch(text, /build-push-action/);
  assert.doesNotMatch(
    text,
    /personal[_ -]?access|\bPAT\b|skip release|\[skip/i,
  );
  assert.doesNotMatch(text, /^\s+tags:\s*\[?'v\*'/m);
});

test('every workflow run block is valid Bash after expression substitution', async () => {
  const workflow = parse(await fs.readFile(workflowPath, 'utf8')) as Record<
    string,
    any
  >;
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
