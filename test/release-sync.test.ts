import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyReleaseSync,
  planReleaseSync,
  ReleaseSyncError,
  runReleaseSyncCli,
  verifyReleaseSync,
  type ReleaseSyncDependencies,
} from '../src/release-sync.js';
import type { ReleaseCommit } from '../src/release-version.js';

const commits: ReleaseCommit[] = [{ sha: 'abcdef1', subject: 'fix: repair' }];
const ownedPaths = [
  'VERSION',
  'package.json',
  'packages/gateway/package.json',
  'package-lock.json',
] as const;
const canonical = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const fixture = async (): Promise<string> => {
  const root = await fs.mkdtemp(
    path.join(tmpdir(), 'elpis-release-sync-test-'),
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
  return root;
};

const snapshot = async (root: string): Promise<Map<string, Buffer>> => {
  const result = new Map<string, Buffer>();
  for (const relative of ownedPaths)
    result.set(relative, await fs.readFile(path.join(root, relative)));
  return result;
};

const unchanged = async (
  root: string,
  before: Map<string, Buffer>,
): Promise<void> => {
  for (const [relative, bytes] of before)
    assert.deepEqual(
      await fs.readFile(path.join(root, relative)),
      bytes,
      relative,
    );
};

test('verify and plan read every canonical TypeScript version source without mutation', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await snapshot(root);
  const verified = await verifyReleaseSync(root, '0.1.0');
  assert.equal(verified.mode, 'verify');
  assert.deepEqual(verified.versionState, {
    VERSION: '0.1.0',
    'package-json': '0.1.0',
    'gateway-package-json': '0.1.0',
    'package-lock-root': '0.1.0',
    'package-lock-workspace': '0.1.0',
    'package-lock-gateway-workspace': '0.1.0',
  });
  const planned = await planReleaseSync(root, 'v0.1.0', commits);
  assert.equal(planned.nextVersion, '0.1.1');
  assert.deepEqual(planned.changedPaths, ownedPaths);
  await unchanged(root, before);
});

test('checked-in repository release sources are synchronized', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const version = (
    await fs.readFile(path.join(root, 'VERSION'), 'utf8')
  ).trim();
  const verified = await verifyReleaseSync(root, version);
  assert.equal(verified.nextVersion, version);
  assert.deepEqual(verified.changedPaths, []);
});

test('owned file parents must be canonical and contained', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packages = path.join(root, 'packages');
  const target = path.join(root, 'packages-target');
  await fs.rename(packages, target);
  await fs.symlink(target, packages);
  await assert.rejects(
    verifyReleaseSync(root, '0.1.0'),
    /parent must be canonical and contained/,
  );
});

test('Gateway workspace parent must be canonical and contained', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const gateway = path.join(root, 'packages/gateway');
  const target = path.join(root, 'gateway-target');
  await fs.rename(gateway, target);
  await fs.symlink(target, gateway);
  await assert.rejects(
    verifyReleaseSync(root, '0.1.0'),
    /parent must be canonical and contained/,
  );
});

test('validation mismatch fails before any repository file changes', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lockPath = path.join(root, 'package-lock.json');
  const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  lock.version = '0.1.1';
  await fs.writeFile(lockPath, canonical(lock));
  const before = await snapshot(root);
  await assert.rejects(applyReleaseSync(root, 'v0.1.0', commits));
  await unchanged(root, before);
});

test('apply changes exactly four owned files and preserves modes', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const beforeModes = new Map<string, number>();
  for (const relative of ownedPaths)
    beforeModes.set(
      relative,
      (await fs.stat(path.join(root, relative))).mode & 0o777,
    );
  const receipt = await applyReleaseSync(root, 'v0.1.0', commits);
  assert.equal(receipt.mode, 'apply');
  assert.equal(receipt.nextVersion, '0.1.1');
  assert.equal((await verifyReleaseSync(root, '0.1.1')).nextVersion, '0.1.1');
  assert.equal(
    await fs.readFile(path.join(root, 'VERSION'), 'utf8'),
    '0.1.1\n',
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
      .version,
    '0.1.1',
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(root, 'packages/gateway/package.json'),
        'utf8',
      ),
    ).version,
    '0.1.1',
  );
  const lock = JSON.parse(
    await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'),
  );
  assert.equal(lock.version, '0.1.1');
  assert.equal(lock.packages[''].version, '0.1.1');
  assert.equal(lock.packages['packages/gateway'].version, '0.1.1');
  for (const [relative, mode] of beforeModes)
    assert.equal((await fs.stat(path.join(root, relative))).mode & 0o777, mode);
  assert.deepEqual(
    (await fs.readdir(root)).filter((name) =>
      name.startsWith('.release-sync-'),
    ),
    [],
  );
});

test('rename failure rolls back every already-replaced file', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const before = await snapshot(root);
  let calls = 0;
  const rename: NonNullable<ReleaseSyncDependencies['rename']> = async (
    from,
    to,
  ) => {
    calls += 1;
    if (calls === 3) throw new Error('injected rename failure');
    await fs.rename(from, to);
  };
  await assert.rejects(
    applyReleaseSync(root, 'v0.1.0', commits, { rename }),
    ReleaseSyncError,
  );
  await unchanged(root, before);
});

test('symlinked and noncanonical owned files fail closed', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packagePath = path.join(root, 'package.json');
  const targetPath = path.join(root, 'package-target.json');
  await fs.rename(packagePath, targetPath);
  await fs.symlink(targetPath, packagePath);
  await assert.rejects(verifyReleaseSync(root, '0.1.0'), /regular file/);

  await fs.rm(packagePath);
  await fs.rename(targetPath, packagePath);
  await fs.writeFile(packagePath, '{"name":"elpis","version":"0.1.0"}\n');
  await assert.rejects(verifyReleaseSync(root, '0.1.0'), /canonical JSON/);
});

test('CLI emits one bounded JSON line and rejects duplicate arguments', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let output = '';
  await runReleaseSyncCli(
    ['verify', '--root', root, '--version', '0.1.0'],
    (text) => (output += text),
  );
  assert.equal(output.split('\n').length, 2);
  assert.equal(JSON.parse(output).format, 'elpis-release-sync-v1');
  const commitFile = path.join(root, 'commits.json');
  await fs.writeFile(commitFile, canonical(commits));
  output = '';
  await runReleaseSyncCli(
    ['plan', '--root', root, '--tag', 'v0.1.0', '--commits', commitFile],
    (text) => (output += text),
  );
  assert.equal(JSON.parse(output).nextVersion, '0.1.1');
  await assert.rejects(
    runReleaseSyncCli([
      'verify',
      '--root',
      root,
      '--root',
      root,
      '--version',
      '0.1.0',
    ]),
    ReleaseSyncError,
  );
});
