import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRelease,
  ReleaseVersionError,
  type ReleaseCommit,
} from '../src/release-version.js';

const commit = (
  subject: string,
  sha = 'abcdef1',
  releaseOwned = false,
): ReleaseCommit => ({ sha, subject, releaseOwned });

const errorCode = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ReleaseVersionError);
    return error.code;
  }
  assert.fail('expected release classifier to throw');
};

test('all fix commits increment patch and preserve order', () => {
  const result = classifyRelease('v0.1.0', [
    commit('fix: first', 'aaaaaaa'),
    commit('fix(runtime): second', 'bbbbbbb'),
  ]);
  assert.equal(result.previousVersion, '0.1.0');
  assert.equal(result.nextVersion, '0.1.1');
  assert.equal(result.bump, 'patch');
  assert.deepEqual(
    result.commits.map(({ sha, prefix, scope }) => ({ sha, prefix, scope })),
    [
      { sha: 'aaaaaaa', prefix: 'fix', scope: null },
      { sha: 'bbbbbbb', prefix: 'fix', scope: 'runtime' },
    ],
  );
});

test('any allowed non-fix prefix increments minor and resets patch', () => {
  for (const subject of [
    'feat: feature',
    'refactor(core): structure',
    'perf: faster',
    'docs: explain',
    'test: cover',
    'build: package',
    'ci: automate',
    'chore: tend',
    'revert: undo',
  ]) {
    const result = classifyRelease('0.7.9', [
      commit('fix: repair', 'aaaaaaa'),
      commit(subject, 'bbbbbbb'),
    ]);
    assert.equal(result.nextVersion, '0.8.0', subject);
    assert.equal(result.bump, 'minor', subject);
  }
});

test('workflow-owned release commits are excluded without reordering work', () => {
  const result = classifyRelease('0.2.0', [
    commit('chore(release): v0.2.0', 'aaaaaaa', true),
    commit('fix: repair', 'bbbbbbb'),
  ]);
  assert.equal(result.nextVersion, '0.2.1');
  assert.deepEqual(result.excludedReleaseCommits, ['aaaaaaa']);
  assert.deepEqual(
    result.commits.map((item) => item.sha),
    ['bbbbbbb'],
  );
});

test('reserved release prefix is rejected for non-workflow commits', () => {
  assert.equal(
    errorCode(() =>
      classifyRelease('0.1.0', [commit('chore(release): v0.1.1', 'aaaaaaa')]),
    ),
    'reserved_release_prefix',
  );
});

test('strict subjects reject merges, malformed scopes, unknown prefixes, and multiline text', () => {
  for (const subject of [
    'Merge branch main',
    'feature: nope',
    'fix: ',
    'fix:   ',
    'fix: padded ',
    'fix(UPPER): nope',
    'fix(bad scope): nope',
    'fix: first\nsecond',
    'chore(release): nope',
  ]) {
    assert.equal(
      errorCode(() => classifyRelease('0.1.0', [commit(subject)])),
      'invalid_commit_subject',
      subject,
    );
  }
});

test('invalid versions, empty ranges, invalid shas, and overflow fail closed', () => {
  assert.equal(
    errorCode(() => classifyRelease('01.0.0', [commit('fix: x')])),
    'invalid_previous_version',
  );
  assert.equal(
    errorCode(() => classifyRelease('0.1.0', [])),
    'empty_commit_range',
  );
  assert.equal(
    errorCode(() => classifyRelease('0.1.0', [commit('fix: x', 'not-a-sha')])),
    'invalid_commit_sha',
  );
  assert.equal(
    errorCode(() =>
      classifyRelease('0.1.9007199254740991', [commit('fix: x')]),
    ),
    'version_overflow',
  );
  assert.equal(
    errorCode(() =>
      classifyRelease('0.9007199254740991.0', [commit('feat: x')]),
    ),
    'version_overflow',
  );
});
