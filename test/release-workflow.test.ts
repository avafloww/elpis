import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareReleaseWorkflow,
  releaseNotesForResult,
  renderReleaseNotes,
  runReleaseWorkflowCli,
  RELEASE_BOT_IDENTITY,
  RELEASE_BOT_LOGIN,
  ReleaseWorkflowError,
} from '../scripts/release-workflow.js';

const execFileAsync = promisify(execFile);
const canonical = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;
const fixedEnvironment = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z',
};

const git = async (
  root: string,
  args: string[],
  env = fixedEnvironment,
): Promise<string> => {
  const result = await execFileAsync('git', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trimEnd();
};

const fixture = async (withTag: boolean): Promise<string> => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), 'elpis-release-workflow-test-'),
  );
  await fs.writeFile(path.join(root, 'VERSION'), '0.1.0\n');
  await fs.writeFile(
    path.join(root, 'package.json'),
    canonical({
      name: 'elpis',
      version: '0.1.0',
      private: true,
      workspaces: ['packages/*'],
    }),
  );
  await fs.mkdir(path.join(root, 'packages/gateway'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'packages/gateway/package.json'),
    canonical({ name: '@elpis/gateway', version: '0.1.0', private: true }),
  );
  await fs.writeFile(
    path.join(root, 'package-lock.json'),
    canonical({
      name: 'elpis',
      version: '0.1.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': {
          name: 'elpis',
          version: '0.1.0',
          workspaces: ['packages/*'],
        },
        'packages/gateway': {
          name: '@elpis/gateway',
          version: '0.1.0',
        },
      },
    }),
  );
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['add', '.']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'feat: initial']);
  if (withTag) {
    await git(root, [
      'tag',
      '--annotate',
      '--message',
      'Bootstrap v0.1.0',
      'v0.1.0',
    ]);
  }
  await git(root, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  return root;
};

const addWork = async (root: string): Promise<string> => {
  await fs.writeFile(path.join(root, 'README.md'), 'work\n');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '--no-gpg-sign', '-m', 'fix: work']);
  const sha = await git(root, ['rev-parse', 'HEAD']);
  await git(root, ['update-ref', 'refs/remotes/origin/main', sha]);
  return sha;
};

test('release notes render bounded escaped work commits with abbreviated hashes', () => {
  const notes = renderReleaseNotes([
    { sha: 'a'.repeat(40), subject: 'fix: plain' },
    {
      sha: 'b'.repeat(40),
      subject: 'feat: tensor @name [link](x) `tick` <tag> & star*',
    },
  ]);
  assert.equal(
    notes,
    [
      '## Changes',
      '',
      '- `aaaaaaa` fix: plain',
      '- `bbbbbbb` feat: tensor &#64;name \\[link\\]\\(x\\) \\`tick\\` &lt;tag&gt; &amp; star\\*',
      '',
    ].join('\n'),
  );
  assert.equal(
    renderReleaseNotes([
      { sha: `${'a'.repeat(7)}b${'0'.repeat(32)}`, subject: 'fix: first' },
      { sha: `${'a'.repeat(7)}c${'0'.repeat(32)}`, subject: 'fix: second' },
    ]),
    [
      '## Changes',
      '',
      '- `aaaaaaab` fix: first',
      '- `aaaaaaac` fix: second',
      '',
    ].join('\n'),
  );
  assert.throws(
    () =>
      renderReleaseNotes([
        { sha: 'd'.repeat(40), subject: 'fix: first' },
        { sha: 'd'.repeat(40), subject: 'fix: second' },
      ]),
    ReleaseWorkflowError,
  );
  assert.throws(
    () => renderReleaseNotes([{ sha: 'bad', subject: 'fix: work' }]),
    ReleaseWorkflowError,
  );
  assert.throws(
    () =>
      renderReleaseNotes([
        { sha: 'c'.repeat(40), subject: 'fix: first\nsecond' },
      ]),
    ReleaseWorkflowError,
  );
  assert.throws(
    () =>
      renderReleaseNotes(
        Array.from({ length: 513 }, (_, index) => ({
          sha: index.toString(16).padStart(40, '0'),
          subject: 'fix: work',
        })),
      ),
    ReleaseWorkflowError,
  );
});

test('no reachable tag is a successful no-release bootstrap boundary', async (t) => {
  const root = await fixture(false);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sha = await git(root, ['rev-parse', 'HEAD']);
  const value = await prepareReleaseWorkflow(root, sha);
  assert.equal(value.mode, 'none');
  assert.match(value.reason, /bootstrap/);
  assert.equal(await git(root, ['rev-parse', 'HEAD']), sha);
  assert.equal(await git(root, ['status', '--porcelain=v1']), '');
});

test('CLI writes exact bounded no-release GitHub outputs', async (t) => {
  const root = await fixture(false);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, '.git/release-output');
  const notes = path.join(root, '.git/release-notes.md');
  await fs.writeFile(output, '');
  const sha = await git(root, ['rev-parse', 'HEAD']);
  let receipt = '';
  await runReleaseWorkflowCli(
    [
      'prepare',
      '--root',
      root,
      '--tested-sha',
      sha,
      '--output',
      output,
      '--notes-output',
      notes,
    ],
    (text) => {
      receipt += text;
    },
  );
  assert.equal(JSON.parse(receipt).mode, 'none');
  assert.match(
    await fs.readFile(output, 'utf8'),
    /^mode=none\nbase_sha=[0-9a-f]{40}\n/,
  );
  assert.match(await fs.readFile(output, 'utf8'), /release_notes_sha256=\n/);
  await assert.rejects(fs.lstat(notes), { code: 'ENOENT' });
});

test('explicit bootstrap creates only deterministic v0.1.0 tag and supports recovery', async (t) => {
  const roots = await Promise.all([fixture(false), fixture(false)]);
  t.after(() =>
    Promise.all(
      roots.map((root) => fs.rm(root, { recursive: true, force: true })),
    ),
  );
  const shas = await Promise.all(
    roots.map((root) => git(root, ['rev-parse', 'HEAD'])),
  );
  assert.equal(shas[0], shas[1]);
  const values = await Promise.all(
    roots.map((root, index) =>
      prepareReleaseWorkflow(root, shas[index], '', {}, true),
    ),
  );
  assert.ok(values.every((value) => value.mode === 'bootstrap'));
  assert.ok(values.every((value) => value.tag === 'v0.1.0'));
  assert.ok(values.every((value, index) => value.releaseSha === shas[index]));
  assert.equal(
    await git(roots[0], ['rev-parse', 'refs/tags/v0.1.0']),
    await git(roots[1], ['rev-parse', 'refs/tags/v0.1.0']),
  );
  assert.equal(await git(roots[0], ['rev-parse', 'v0.1.0^{}']), shas[0]);
  assert.equal(await git(roots[0], ['rev-parse', 'HEAD']), shas[0]);
  const recovered = await prepareReleaseWorkflow(
    roots[0],
    shas[0],
    'human',
    {},
    true,
  );
  assert.equal(recovered.mode, 'bootstrap');
  await assert.rejects(
    prepareReleaseWorkflow(roots[0], shas[0], 'human'),
    ReleaseWorkflowError,
  );
});

test('CLI bootstrap flag is exact and emits bootstrap outputs', async (t) => {
  const root = await fixture(false);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = path.join(root, '.git/bootstrap-output');
  const notes = path.join(root, '.git/bootstrap-notes.md');
  await fs.writeFile(output, '');
  const sha = await git(root, ['rev-parse', 'HEAD']);
  let receipt = '';
  await runReleaseWorkflowCli(
    [
      'prepare',
      '--root',
      root,
      '--tested-sha',
      sha,
      '--bootstrap',
      'true',
      '--output',
      output,
      '--notes-output',
      notes,
    ],
    (text) => {
      receipt += text;
    },
  );
  const parsed = JSON.parse(receipt);
  assert.equal(parsed.mode, 'bootstrap');
  const body = await fs.readFile(notes, 'utf8');
  assert.equal(body, `## Changes\n\n- \`${sha.slice(0, 7)}\` feat: initial\n`);
  assert.equal((await fs.stat(notes)).mode & 0o777, 0o600);
  assert.match(
    await fs.readFile(output, 'utf8'),
    new RegExp(`release_notes_sha256=${parsed.releaseNotesSha256}\\n`),
  );
  await assert.rejects(
    runReleaseWorkflowCli([
      'prepare',
      '--root',
      root,
      '--tested-sha',
      sha,
      '--bootstrap',
      'yes',
    ]),
    /bootstrap must be true or false/,
  );
});

test('stale tested SHA fails before release preparation', async (t) => {
  const root = await fixture(true);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stale = await git(root, ['rev-parse', 'HEAD']);
  await addWork(root);
  await git(root, ['update-ref', 'refs/remotes/origin/main', stale]);
  await assert.rejects(
    prepareReleaseWorkflow(root, await git(root, ['rev-parse', 'HEAD'])),
    /stale/,
  );
});

test('release preparation creates and validates exact deterministic bot commit and annotated tag', async (t) => {
  const root = await fixture(true);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseSha = await addWork(root);
  const value = await prepareReleaseWorkflow(root, baseSha, 'human');
  assert.equal(value.mode, 'release');
  assert.equal(value.tag, 'v0.1.1');
  assert.equal(value.previousTag, 'v0.1.0');
  assert.equal(value.baseSha, baseSha);
  assert.equal(await git(root, ['cat-file', '-t', 'refs/tags/v0.1.1']), 'tag');
  assert.equal(await git(root, ['rev-parse', 'v0.1.1^{}']), value.releaseSha);
  assert.equal(
    await git(root, [
      'show',
      '-s',
      '--format=%an%x00%ae%x00%cn%x00%ce',
      'HEAD',
    ]),
    [
      RELEASE_BOT_IDENTITY.name,
      RELEASE_BOT_IDENTITY.email,
      RELEASE_BOT_IDENTITY.name,
      RELEASE_BOT_IDENTITY.email,
    ].join('\0'),
  );
  assert.deepEqual(
    (
      await git(root, [
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        'HEAD',
      ])
    )
      .split('\n')
      .sort(),
    [
      'VERSION',
      'package-lock.json',
      'package.json',
      'packages/gateway/package.json',
    ].sort(),
  );
  const freshNotes = await releaseNotesForResult(root, value);
  assert.equal(
    freshNotes,
    `## Changes\n\n- \`${baseSha.slice(0, 7)}\` fix: work\n`,
  );
  assert.doesNotMatch(freshNotes, new RegExp(value.releaseSha.slice(0, 7)));

  await git(root, ['update-ref', 'refs/remotes/origin/main', value.releaseSha]);
  const resumed = await prepareReleaseWorkflow(
    root,
    value.releaseSha,
    RELEASE_BOT_LOGIN,
  );
  assert.equal(resumed.mode, 'resume');
  assert.equal(resumed.releaseSha, value.releaseSha);
  assert.equal(resumed.tag, value.tag);
  assert.equal(await releaseNotesForResult(root, resumed), freshNotes);
});

test('release commit and annotated tag reproduce across independent repositories', async (t) => {
  const roots = await Promise.all([fixture(true), fixture(true)]);
  t.after(() =>
    Promise.all(
      roots.map((root) => fs.rm(root, { recursive: true, force: true })),
    ),
  );
  const bases = await Promise.all(roots.map(addWork));
  assert.equal(bases[0], bases[1]);
  const releases = await Promise.all(
    roots.map((root, index) => prepareReleaseWorkflow(root, bases[index], '')),
  );
  assert.equal(releases[0].releaseSha, releases[1].releaseSha);
  const tagObjects = await Promise.all(
    roots.map((root) => git(root, ['rev-parse', 'refs/tags/v0.1.1'])),
  );
  assert.equal(tagObjects[0], tagObjects[1]);
});

test('resume rejects a non-bot associated login', async (t) => {
  const root = await fixture(true);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const baseSha = await addWork(root);
  const value = await prepareReleaseWorkflow(root, baseSha, '');
  await git(root, ['update-ref', 'refs/remotes/origin/main', value.releaseSha]);
  await assert.rejects(
    prepareReleaseWorkflow(root, value.releaseSha, 'human'),
    /actor login/,
  );
});
