import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRelease,
  planRelease,
  RELEASE_OWNED_PATHS,
  RELEASE_VERSION_SOURCES,
  ReleaseVersionError,
  validateOwnedReleaseCommit,
  validateReleaseVersionState,
  type OwnedReleaseCommitFacts,
  type ReleaseCommit,
  type ReleaseOwner,
  type ReleaseVersionState,
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

const versionState = (version: string): ReleaseVersionState => ({
  VERSION: version,
  'package-json': version,
  'gateway-package-json': version,
  'package-lock-root': version,
  'package-lock-workspace': version,
  'package-lock-gateway-workspace': version,
});

const releaseOwner: ReleaseOwner = {
  actorLogin: 'release-bot',
  author: {
    name: 'Elpis Release Bot',
    email: 'release-bot@example.invalid',
  },
  committer: {
    name: 'Elpis Release Bot',
    email: 'release-bot@example.invalid',
  },
};

const ownedFacts = (): OwnedReleaseCommitFacts => ({
  sha: 'abcdef1234567890',
  subject: 'chore(release): v1.2.4',
  actorLogin: releaseOwner.actorLogin,
  author: { ...releaseOwner.author },
  committer: { ...releaseOwner.committer },
  previousVersions: versionState('1.2.3'),
  currentVersions: versionState('1.2.4'),
  changedPaths: [...RELEASE_OWNED_PATHS].reverse(),
  tag: {
    name: 'v1.2.4',
    objectType: 'tag',
    targetType: 'commit',
    targetSha: 'abcdef1234567890',
  },
});

const ownedError = (
  mutate: (facts: OwnedReleaseCommitFacts) => void,
  owner = releaseOwner,
  expected = { previousVersion: '1.2.3', nextVersion: '1.2.4' },
): string => {
  const facts = ownedFacts();
  mutate(facts);
  return errorCode(() => validateOwnedReleaseCommit(expected, owner, facts));
};

test('release state accepts a reachable v-tag and checks every owned source', () => {
  assert.equal(
    validateReleaseVersionState('v1.2.3', versionState('1.2.3')),
    '1.2.3',
  );

  for (const invalid of [
    'V1.2.3',
    'v01.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2',
    '1.2.3-alpha',
    '1.2.3\n',
    '1.2.9007199254740992',
  ]) {
    assert.equal(
      errorCode(() =>
        validateReleaseVersionState(invalid, versionState('1.2.3')),
      ),
      'invalid_release_state',
      invalid,
    );
  }

  for (const source of RELEASE_VERSION_SOURCES) {
    const versions = versionState('1.2.3');
    versions[source] = '1.2.4';
    assert.equal(
      errorCode(() => validateReleaseVersionState('v1.2.3', versions)),
      'release_state_mismatch',
      source,
    );
  }

  const missing = versionState('1.2.3') as Partial<ReleaseVersionState>;
  delete missing['package-json'];
  assert.equal(
    errorCode(() =>
      validateReleaseVersionState('v1.2.3', missing as ReleaseVersionState),
    ),
    'invalid_release_state',
  );
  const extra = { ...versionState('1.2.3'), unexpected: '1.2.3' };
  assert.equal(
    errorCode(() => validateReleaseVersionState('v1.2.3', extra)),
    'invalid_release_state',
  );
});

test('release planner derives patch and minor plans, preserves order, and deep-copies state', () => {
  const versions = versionState('1.2.3');
  const patch = planRelease('v1.2.3', versions, [
    commit('fix: first', 'aaaaaaa'),
    commit('fix(core): second', 'bbbbbbb'),
  ]);
  assert.equal(patch.bump, 'patch');
  assert.equal(patch.nextVersion, '1.2.4');
  assert.deepEqual(
    patch.commits.map(({ sha }) => sha),
    ['aaaaaaa', 'bbbbbbb'],
  );
  assert.deepEqual(patch.changedPaths, RELEASE_OWNED_PATHS);
  versions['package-json'] = '9.9.9';
  assert.equal(patch.versionState['package-json'], '1.2.3');
  assert.ok(Object.isFrozen(RELEASE_OWNED_PATHS));
  assert.equal(
    RELEASE_OWNED_PATHS.includes(
      'packages/gateway-protocol/package.json' as (typeof RELEASE_OWNED_PATHS)[number],
    ),
    false,
  );
  assert.ok(Object.isFrozen(RELEASE_VERSION_SOURCES));

  const minor = planRelease('1.2.3', versionState('1.2.3'), [
    commit('fix: first', 'aaaaaaa'),
    commit('feat: second', 'bbbbbbb'),
  ]);
  assert.equal(minor.bump, 'minor');
  assert.equal(minor.nextVersion, '1.3.0');
});

test('planner bounds commit input and never trusts a caller-owned flag', () => {
  assert.equal(
    errorCode(() =>
      planRelease('1.2.3', versionState('1.2.3'), [
        commit('chore(release): v1.2.4', 'aaaaaaa', true),
      ]),
    ),
    'reserved_release_prefix',
  );
  assert.equal(
    errorCode(() =>
      planRelease('1.2.3', versionState('1.2.3'), [
        commit(`fix: ${'x'.repeat(513)}`, 'aaaaaaa'),
      ]),
    ),
    'invalid_commit_subject',
  );
  const tooMany = Array.from({ length: 10_001 }, (_, index) =>
    commit('fix: bounded', index.toString(16).padStart(7, 'a')),
  );
  assert.equal(
    errorCode(() => planRelease('1.2.3', versionState('1.2.3'), tooMany)),
    'release_commit_range_too_large',
  );
});

test('valid owned release is immutable, branded, and requires the exact transition', () => {
  const validated = validateOwnedReleaseCommit(
    { previousVersion: '1.2.3', nextVersion: '1.2.4' },
    releaseOwner,
    ownedFacts(),
  );
  assert.ok(Object.isFrozen(validated));
  assert.deepEqual(
    {
      sha: validated.sha,
      subject: validated.subject,
      releaseOwned: validated.releaseOwned,
      previousVersion: validated.previousVersion,
      currentVersion: validated.currentVersion,
      tagName: validated.tagName,
    },
    {
      sha: 'abcdef1234567890',
      subject: 'chore(release): v1.2.4',
      releaseOwned: true,
      previousVersion: '1.2.3',
      currentVersion: '1.2.4',
      tagName: 'v1.2.4',
    },
  );

  const recursive = planRelease('v1.2.4', versionState('1.2.4'), [
    validated,
    commit('fix: after release', 'bbbbbbb'),
  ]);
  assert.deepEqual(recursive.excludedReleaseCommits, ['abcdef1234567890']);
  assert.equal(recursive.nextVersion, '1.2.5');

  const cloned = { ...validated };
  assert.equal(
    errorCode(() => planRelease('1.2.4', versionState('1.2.4'), [cloned])),
    'reserved_release_prefix',
  );

  for (const expected of [
    { previousVersion: '1.2.3', nextVersion: '1.2.3' },
    { previousVersion: '1.2.3', nextVersion: '1.2.5' },
    { previousVersion: '1.2.3', nextVersion: '1.4.0' },
    { previousVersion: '1.2.3', nextVersion: '2.0.0' },
  ]) {
    assert.equal(
      ownedError(() => undefined, releaseOwner, expected),
      'owned_release_transition_mismatch',
    );
  }
});

test('owned release rejects subject, actor, author, committer, owner bounds, and sha mismatches', () => {
  const cases: Array<
    [string, (facts: OwnedReleaseCommitFacts) => void, string]
  > = [
    [
      'subject version',
      (facts) => (facts.subject = 'chore(release): v1.2.5'),
      'owned_release_subject_mismatch',
    ],
    [
      'human subject',
      (facts) => (facts.subject = 'fix: impersonate release'),
      'owned_release_subject_mismatch',
    ],
    [
      'actor',
      (facts) => (facts.actorLogin = 'human'),
      'owned_release_actor_mismatch',
    ],
    [
      'author',
      (facts) => (facts.author.name = 'Human'),
      'owned_release_author_mismatch',
    ],
    [
      'committer',
      (facts) => (facts.committer.email = 'human@example.invalid'),
      'owned_release_committer_mismatch',
    ],
    ['sha', (facts) => (facts.sha = 'not-a-sha'), 'invalid_owned_release_sha'],
  ];
  for (const [name, mutate, code] of cases) {
    assert.equal(ownedError(mutate), code, name);
  }

  for (const actorLogin of [
    ' release-bot',
    `r${'x'.repeat(100)}`,
    'bot\nname',
  ]) {
    assert.equal(
      ownedError(() => undefined, { ...releaseOwner, actorLogin }),
      'invalid_release_owner',
    );
  }
});

test('owned release rejects every owned transition-state mismatch', () => {
  for (const source of RELEASE_VERSION_SOURCES) {
    assert.equal(
      ownedError((facts) => {
        facts.previousVersions[source] = '1.2.2';
      }),
      'owned_release_transition_mismatch',
      `previous ${source}`,
    );
    assert.equal(
      ownedError((facts) => {
        facts.currentVersions[source] = '1.2.5';
      }),
      'owned_release_transition_mismatch',
      `current ${source}`,
    );
  }
});

test('owned release changed paths reject omissions, duplicates, extras, traversal, and lookalikes', () => {
  for (const paths of [
    RELEASE_OWNED_PATHS.slice(1),
    [...RELEASE_OWNED_PATHS.slice(0, -1), 'VERSION'],
    [...RELEASE_OWNED_PATHS, 'README.md'],
    ['../VERSION', ...RELEASE_OWNED_PATHS.slice(1)],
    ['./VERSION', ...RELEASE_OWNED_PATHS.slice(1)],
    ['version', ...RELEASE_OWNED_PATHS.slice(1)],
    ['package.json/../package-lock.json', ...RELEASE_OWNED_PATHS.slice(1)],
    ['package\\json', ...RELEASE_OWNED_PATHS.slice(1)],
    ['package.jsoI', ...RELEASE_OWNED_PATHS.slice(1)],
  ]) {
    assert.equal(
      ownedError((facts) => {
        facts.changedPaths = paths;
      }),
      'owned_release_paths_mismatch',
      paths.join(','),
    );
  }
});

test('owned release annotated tag facts must all exactly target the commit', () => {
  const cases: Array<[string, (facts: OwnedReleaseCommitFacts) => void]> = [
    ['name', (facts) => (facts.tag.name = 'v1.2.5')],
    ['lightweight', (facts) => (facts.tag.objectType = 'commit')],
    ['target type', (facts) => (facts.tag.targetType = 'tree')],
    ['target sha', (facts) => (facts.tag.targetSha = '1111111')],
  ];
  for (const [name, mutate] of cases) {
    assert.equal(ownedError(mutate), 'owned_release_tag_mismatch', name);
  }
});
