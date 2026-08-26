import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BuildIdentityError,
  createBuildIdentity,
  resolveBuildIdentity,
} from '../src/build-identity.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';

test('exact clean matching tag is a release identity', () => {
  const identity = createBuildIdentity({
    version: '0.8.0',
    revision: SHA,
    treeClean: true,
    exactTag: 'v0.8.0',
    source: 'git',
  });
  assert.equal(identity.state, 'release');
  assert.equal(identity.exactRelease, true);
  assert.equal(identity.versionLabel, 'v0.8.0');
  assert.equal(identity.display, `v0.8.0 + ${SHA}`);
  assert.equal(
    identity.versionUrl,
    'https://github.com/avafloww/elpis/releases/tag/v0.8.0',
  );
  assert.equal(
    identity.revisionUrl,
    `https://github.com/avafloww/elpis/commit/${SHA}`,
  );
});

test('clean commits beyond the package release are visibly dev builds', () => {
  const identity = createBuildIdentity({
    version: '0.8.0',
    revision: SHA,
    treeClean: true,
    exactTag: null,
  });
  assert.equal(identity.state, 'dev');
  assert.equal(identity.versionLabel, 'v0.8.0-dev');
  assert.equal(identity.revisionShort, SHA.slice(0, 12));
});

test('dirty trees are visibly dirty even at a matching tag', () => {
  const identity = createBuildIdentity({
    version: '0.8.0',
    revision: SHA,
    treeClean: false,
    exactTag: 'v0.8.0',
  });
  assert.equal(identity.state, 'dirty');
  assert.equal(identity.versionLabel, 'v0.8.0-dirty');
  assert.equal(identity.exactRelease, false);
});

test('injected container identity takes precedence without invoking git', async () => {
  let calls = 0;
  const identity = await resolveBuildIdentity('/unused', {
    env: {
      ELPIS_BUILD_REVISION: SHA.toUpperCase(),
      ELPIS_BUILD_TAG: 'v0.8.0',
      ELPIS_BUILD_DIRTY: 'false',
    },
    readVersion: async () => '0.8.0',
    git: async () => {
      calls++;
      return null;
    },
  });
  assert.equal(calls, 0);
  assert.equal(identity.source, 'environment');
  assert.equal(identity.revision, SHA);
  assert.equal(identity.exactRelease, true);
});

test('git identity preserves full revision and distinguishes dirty state', async () => {
  const replies = new Map([
    ['rev-parse HEAD', `${SHA}\n`],
    ['status --porcelain', ' M src/index.ts\n'],
    ['describe --tags --exact-match HEAD', 'v0.8.0\n'],
  ]);
  const identity = await resolveBuildIdentity('/repo', {
    env: {},
    readVersion: async () => '0.8.0',
    git: async (_root, args) => replies.get(args.join(' ')) ?? null,
  });
  assert.equal(identity.revision, SHA);
  assert.equal(identity.treeClean, false);
  assert.equal(identity.state, 'dirty');
});

test('missing Git is unknown rather than falsely dirty or released', async () => {
  const identity = await resolveBuildIdentity('/repo', {
    env: {},
    readVersion: async () => '0.8.0',
    git: async () => null,
  });
  assert.equal(identity.state, 'unknown');
  assert.equal(identity.treeClean, null);
  assert.equal(identity.revision, null);
  assert.equal(identity.versionLabel, 'v0.8.0-unknown');
});

test('invalid explicit build facts fail closed', async () => {
  await assert.rejects(
    resolveBuildIdentity('/unused', {
      env: { ELPIS_BUILD_REVISION: 'not-a-sha' },
      readVersion: async () => '0.8.0',
    }),
    BuildIdentityError,
  );
  await assert.rejects(
    resolveBuildIdentity('/unused', {
      env: { ELPIS_BUILD_REVISION: SHA, ELPIS_BUILD_DIRTY: 'sometimes' },
      readVersion: async () => '0.8.0',
    }),
    /ELPIS_BUILD_DIRTY/,
  );
});
