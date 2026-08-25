export const RELEASE_PREFIXES = [
  'fix',
  'feat',
  'refactor',
  'perf',
  'docs',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
] as const;

type ReleasePrefix = (typeof RELEASE_PREFIXES)[number];

export interface ReleaseCommit {
  sha: string;
  subject: string;
  releaseOwned?: boolean;
}

export interface ClassifiedReleaseCommit {
  sha: string;
  subject: string;
  prefix: ReleasePrefix;
  scope: string | null;
}

export interface ReleaseDecision {
  previousVersion: string;
  nextVersion: string;
  bump: 'patch' | 'minor';
  reason: string;
  commits: ClassifiedReleaseCommit[];
  excludedReleaseCommits: string[];
}

export type ReleaseVersionErrorCode =
  | 'invalid_previous_version'
  | 'version_overflow'
  | 'invalid_commit_sha'
  | 'invalid_commit_subject'
  | 'reserved_release_prefix'
  | 'empty_commit_range'
  | 'release_commit_range_too_large'
  | 'invalid_release_state'
  | 'release_state_mismatch'
  | 'invalid_release_owner'
  | 'invalid_owned_release_sha'
  | 'owned_release_subject_mismatch'
  | 'owned_release_actor_mismatch'
  | 'owned_release_author_mismatch'
  | 'owned_release_committer_mismatch'
  | 'owned_release_transition_mismatch'
  | 'owned_release_paths_mismatch'
  | 'owned_release_tag_mismatch';

export class ReleaseVersionError extends Error {
  constructor(
    readonly code: ReleaseVersionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReleaseVersionError';
  }
}

const MAX_COMPONENT = BigInt(Number.MAX_SAFE_INTEGER);
const VERSION = /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SUBJECT =
  /^(fix|feat|refactor|perf|docs|test|build|ci|chore|revert)(?:\(([a-z0-9]+(?:[._/-][a-z0-9]+)*)\))?: (\S(?:[^\r\n]*\S)?)$/;
const RELEASE =
  /^chore\(release\): v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{7,64}$/;

export function classifyRelease(
  previousVersion: string,
  input: readonly ReleaseCommit[],
): ReleaseDecision {
  const previous = parseVersion(previousVersion);
  const commits: ClassifiedReleaseCommit[] = [];
  const excludedReleaseCommits: string[] = [];

  for (const commit of input) {
    if (!SHA.test(commit.sha)) {
      throw new ReleaseVersionError(
        'invalid_commit_sha',
        `invalid commit SHA: ${commit.sha}`,
      );
    }
    if (RELEASE.test(commit.subject)) {
      if (!commit.releaseOwned) {
        throw new ReleaseVersionError(
          'reserved_release_prefix',
          `release prefix is reserved for the release workflow: ${commit.sha}`,
        );
      }
      excludedReleaseCommits.push(commit.sha);
      continue;
    }
    if (commit.subject.startsWith('chore(release):')) {
      throw new ReleaseVersionError(
        'invalid_commit_subject',
        `malformed release commit subject: ${commit.sha}`,
      );
    }
    const match = SUBJECT.exec(commit.subject);
    if (!match) {
      throw new ReleaseVersionError(
        'invalid_commit_subject',
        `invalid conventional commit subject: ${commit.sha}`,
      );
    }
    commits.push({
      sha: commit.sha,
      subject: commit.subject,
      prefix: match[1] as ReleasePrefix,
      scope: match[2] ?? null,
    });
  }

  if (commits.length === 0) {
    throw new ReleaseVersionError(
      'empty_commit_range',
      'release range contains no non-release commits',
    );
  }

  const patch = commits.every((commit) => commit.prefix === 'fix');
  const next = patch
    ? [previous[0], previous[1], increment(previous[2])]
    : [previous[0], increment(previous[1]), 0n];
  const bump = patch ? 'patch' : 'minor';
  return {
    previousVersion: formatVersion(previous),
    nextVersion: formatVersion(next),
    bump,
    reason: patch
      ? 'every non-release commit is fix-prefixed'
      : 'at least one non-release commit is not fix-prefixed',
    commits,
    excludedReleaseCommits,
  };
}

function parseVersion(value: string): [bigint, bigint, bigint] {
  const match = VERSION.exec(value);
  if (!match) {
    throw new ReleaseVersionError(
      'invalid_previous_version',
      `invalid previous version: ${value}`,
    );
  }
  const version = [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])] as [
    bigint,
    bigint,
    bigint,
  ];
  if (version.some((component) => component > MAX_COMPONENT)) {
    throw new ReleaseVersionError(
      'version_overflow',
      `version component exceeds ${MAX_COMPONENT}`,
    );
  }
  return version;
}

function increment(value: bigint): bigint {
  if (value >= MAX_COMPONENT) {
    throw new ReleaseVersionError(
      'version_overflow',
      `version component cannot exceed ${MAX_COMPONENT}`,
    );
  }
  return value + 1n;
}

function formatVersion(version: readonly bigint[]): string {
  return version.join('.');
}

export const RELEASE_SCALAR_VERSION_SOURCES = Object.freeze([
  'VERSION',
  'package-json',
  'package-lock-root',
  'package-lock-workspace',
  'Cargo-workspace',
] as const);

export const RELEASE_VERSION_SOURCES = Object.freeze([
  ...RELEASE_SCALAR_VERSION_SOURCES,
  'Cargo-lock-workspace',
] as const);

export const RELEASE_OWNED_PATHS = Object.freeze([
  'VERSION',
  'package.json',
  'package-lock.json',
  'rust/Cargo.toml',
  'rust/Cargo.lock',
] as const);

export type ReleaseScalarVersionSource =
  (typeof RELEASE_SCALAR_VERSION_SOURCES)[number];
export type ReleaseVersionSource = (typeof RELEASE_VERSION_SOURCES)[number];
export type ReleaseOwnedPath = (typeof RELEASE_OWNED_PATHS)[number];

export interface CargoLockWorkspaceVersion {
  name: string;
  version: string;
}

export type ReleaseVersionState = Record<ReleaseScalarVersionSource, string> & {
  'Cargo-lock-workspace': readonly CargoLockWorkspaceVersion[];
};

export interface ReleasePlan extends ReleaseDecision {
  versionState: ReleaseVersionState;
  changedPaths: readonly ReleaseOwnedPath[];
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface ReleaseOwner {
  actorLogin: string;
  author: GitIdentity;
  committer: GitIdentity;
}

export interface OwnedReleaseTagFacts {
  name: string;
  objectType: string;
  targetType: string;
  targetSha: string;
}

export interface OwnedReleaseCommitFacts {
  sha: string;
  subject: string;
  actorLogin: string;
  author: GitIdentity;
  committer: GitIdentity;
  previousVersions: ReleaseVersionState;
  currentVersions: ReleaseVersionState;
  changedPaths: readonly string[];
  tag: OwnedReleaseTagFacts;
}

export interface ValidatedOwnedReleaseCommit extends ReleaseCommit {
  readonly releaseOwned: true;
  readonly previousVersion: string;
  readonly currentVersion: string;
  readonly tagName: string;
}

const CANONICAL_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TAG_VERSION = /^(?:v)?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const VERSION_SOURCE_SET = new Set<string>(RELEASE_VERSION_SOURCES);
const OWNED_PATH_SET = new Set<string>(RELEASE_OWNED_PATHS);
const VALIDATED_OWNED_RELEASES = new WeakSet<object>();
const MAX_RELEASE_COMMITS = 10_000;
const MAX_COMMIT_SUBJECT = 512;
const MAX_WORKSPACE_PACKAGES = 4096;
const MAX_IDENTITY_FACT = 254;
const CARGO_PACKAGE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function validateReleaseVersionState(
  previousReachableTagVersion: string,
  versions: ReleaseVersionState,
): string {
  const previousVersion = canonicalTagVersion(previousReachableTagVersion);
  validateStateShape(versions);
  for (const source of RELEASE_SCALAR_VERSION_SOURCES) {
    const version = canonicalVersion(versions[source]);
    if (version !== previousVersion) {
      throw new ReleaseVersionError(
        'release_state_mismatch',
        `${source} version does not match previous reachable tag version`,
      );
    }
  }
  validateCargoLockWorkspaceVersions(
    versions['Cargo-lock-workspace'],
    previousVersion,
  );
  return previousVersion;
}

export function planRelease(
  previousReachableTagVersion: string,
  versions: ReleaseVersionState,
  commits: readonly ReleaseCommit[],
): ReleasePlan {
  const previousVersion = validateReleaseVersionState(
    previousReachableTagVersion,
    versions,
  );
  validateCommitRange(commits);
  const decision = classifyRelease(
    previousVersion,
    commits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      releaseOwned: VALIDATED_OWNED_RELEASES.has(commit),
    })),
  );
  return {
    ...decision,
    versionState: cloneVersionState(versions),
    changedPaths: RELEASE_OWNED_PATHS,
  };
}

export function validateOwnedReleaseCommit(
  expected: Pick<ReleaseDecision, 'previousVersion' | 'nextVersion'>,
  owner: ReleaseOwner,
  facts: OwnedReleaseCommitFacts,
): ValidatedOwnedReleaseCommit {
  const previousVersion = canonicalVersion(expected.previousVersion);
  const currentVersion = canonicalVersion(expected.nextVersion);
  validateExpectedTransition(previousVersion, currentVersion);
  validateOwner(owner);
  if (facts === null || typeof facts !== 'object') {
    throw new ReleaseVersionError(
      'invalid_owned_release_sha',
      'owned release facts are invalid',
    );
  }
  if (typeof facts.sha !== 'string' || !SHA.test(facts.sha)) {
    throw new ReleaseVersionError(
      'invalid_owned_release_sha',
      'invalid owned release commit SHA',
    );
  }
  const subject = `chore(release): v${currentVersion}`;
  if (facts.subject !== subject) {
    throw new ReleaseVersionError(
      'owned_release_subject_mismatch',
      'owned release subject does not match the planned version',
    );
  }
  if (facts.actorLogin !== owner.actorLogin) {
    throw new ReleaseVersionError(
      'owned_release_actor_mismatch',
      'owned release actor login does not match',
    );
  }
  if (!sameIdentity(facts.author, owner.author)) {
    throw new ReleaseVersionError(
      'owned_release_author_mismatch',
      'owned release author identity does not match',
    );
  }
  if (!sameIdentity(facts.committer, owner.committer)) {
    throw new ReleaseVersionError(
      'owned_release_committer_mismatch',
      'owned release committer identity does not match',
    );
  }
  validateTransitionState(facts.previousVersions, previousVersion);
  validateTransitionState(facts.currentVersions, currentVersion);
  validateCargoWorkspaceTransition(
    facts.previousVersions['Cargo-lock-workspace'],
    facts.currentVersions['Cargo-lock-workspace'],
  );
  if (!hasExactOwnedPaths(facts.changedPaths)) {
    throw new ReleaseVersionError(
      'owned_release_paths_mismatch',
      'owned release changed paths do not match the release allowlist',
    );
  }
  if (
    facts.tag === null ||
    typeof facts.tag !== 'object' ||
    Array.isArray(facts.tag) ||
    Object.keys(facts.tag).length !== 4 ||
    facts.tag.name !== `v${currentVersion}` ||
    facts.tag.objectType !== 'tag' ||
    facts.tag.targetType !== 'commit' ||
    facts.tag.targetSha !== facts.sha
  ) {
    throw new ReleaseVersionError(
      'owned_release_tag_mismatch',
      'annotated release tag does not target the owned release commit',
    );
  }

  const validated: ValidatedOwnedReleaseCommit = Object.freeze({
    sha: facts.sha,
    subject,
    releaseOwned: true,
    previousVersion,
    currentVersion,
    tagName: facts.tag.name,
  });
  VALIDATED_OWNED_RELEASES.add(validated);
  return validated;
}

function canonicalVersion(value: string): string {
  return canonicalVersionWithPattern(value, CANONICAL_VERSION);
}

function canonicalTagVersion(value: string): string {
  return canonicalVersionWithPattern(value, TAG_VERSION);
}

function canonicalVersionWithPattern(value: string, pattern: RegExp): string {
  const match = typeof value === 'string' ? pattern.exec(value) : null;
  if (!match) {
    throw new ReleaseVersionError(
      'invalid_release_state',
      'invalid canonical release version',
    );
  }
  const components = [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
  if (components.some((component) => component > MAX_COMPONENT)) {
    throw new ReleaseVersionError(
      'invalid_release_state',
      `release version component exceeds ${MAX_COMPONENT}`,
    );
  }
  return formatVersion(components);
}

function validateStateShape(versions: ReleaseVersionState): void {
  if (
    versions === null ||
    typeof versions !== 'object' ||
    Array.isArray(versions)
  ) {
    throw new ReleaseVersionError(
      'invalid_release_state',
      'release version state must be an object',
    );
  }
  const keys = Object.keys(versions);
  if (
    keys.length !== RELEASE_VERSION_SOURCES.length ||
    keys.some((key) => !VERSION_SOURCE_SET.has(key))
  ) {
    throw new ReleaseVersionError(
      'invalid_release_state',
      'release version state has missing or unexpected sources',
    );
  }
}

function validateCargoLockWorkspaceVersions(
  entries: readonly CargoLockWorkspaceVersion[],
  expectedVersion: string,
): void {
  if (
    !Array.isArray(entries) ||
    entries.length === 0 ||
    entries.length > MAX_WORKSPACE_PACKAGES
  ) {
    throw new ReleaseVersionError(
      'invalid_release_state',
      'Cargo lock workspace package versions are invalid',
    );
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      !Object.hasOwn(entry, 'name') ||
      !Object.hasOwn(entry, 'version') ||
      typeof entry.name !== 'string' ||
      !CARGO_PACKAGE_NAME.test(entry.name) ||
      names.has(entry.name)
    ) {
      throw new ReleaseVersionError(
        'invalid_release_state',
        'Cargo lock workspace package versions are invalid',
      );
    }
    names.add(entry.name);
    if (canonicalVersion(entry.version) !== expectedVersion) {
      throw new ReleaseVersionError(
        'release_state_mismatch',
        `Cargo lock workspace package ${entry.name} does not match previous reachable tag version`,
      );
    }
  }
}

function validateCommitRange(commits: readonly ReleaseCommit[]): void {
  if (!Array.isArray(commits) || commits.length > MAX_RELEASE_COMMITS) {
    throw new ReleaseVersionError(
      'release_commit_range_too_large',
      'release commit range exceeds the bounded limit',
    );
  }
  for (const commit of commits) {
    if (
      commit === null ||
      typeof commit !== 'object' ||
      typeof commit.sha !== 'string' ||
      commit.sha.length > 64
    ) {
      throw new ReleaseVersionError('invalid_commit_sha', 'invalid commit SHA');
    }
    if (
      typeof commit.subject !== 'string' ||
      commit.subject.length > MAX_COMMIT_SUBJECT
    ) {
      throw new ReleaseVersionError(
        'invalid_commit_subject',
        'invalid commit subject',
      );
    }
  }
}

function cloneVersionState(versions: ReleaseVersionState): ReleaseVersionState {
  return {
    VERSION: versions.VERSION,
    'package-json': versions['package-json'],
    'package-lock-root': versions['package-lock-root'],
    'package-lock-workspace': versions['package-lock-workspace'],
    'Cargo-workspace': versions['Cargo-workspace'],
    'Cargo-lock-workspace': versions['Cargo-lock-workspace'].map((entry) => ({
      name: entry.name,
      version: entry.version,
    })),
  };
}

function validateCargoWorkspaceTransition(
  previous: readonly CargoLockWorkspaceVersion[],
  current: readonly CargoLockWorkspaceVersion[],
): void {
  const previousNames = new Set(previous.map((entry) => entry.name));
  if (
    current.length !== previous.length ||
    current.some((entry) => !previousNames.has(entry.name))
  ) {
    throw new ReleaseVersionError(
      'owned_release_transition_mismatch',
      'owned release Cargo workspace package set changed',
    );
  }
}

function validateExpectedTransition(
  previousVersion: string,
  currentVersion: string,
): void {
  const previous = previousVersion.split('.').map(BigInt);
  const patch =
    previous[2] < MAX_COMPONENT
      ? formatVersion([previous[0], previous[1], previous[2] + 1n])
      : null;
  const minor =
    previous[1] < MAX_COMPONENT
      ? formatVersion([previous[0], previous[1] + 1n, 0n])
      : null;
  if (currentVersion !== patch && currentVersion !== minor) {
    throw new ReleaseVersionError(
      'owned_release_transition_mismatch',
      'owned release version is not one patch or minor step',
    );
  }
}

function validateOwner(owner: ReleaseOwner): void {
  if (
    owner === null ||
    typeof owner !== 'object' ||
    Array.isArray(owner) ||
    Object.keys(owner).length !== 3 ||
    !plainFact(owner.actorLogin, 100) ||
    !validIdentity(owner.author) ||
    !validIdentity(owner.committer)
  ) {
    throw new ReleaseVersionError(
      'invalid_release_owner',
      'release owner facts must be bounded single-line strings',
    );
  }
}

function validIdentity(identity: GitIdentity): boolean {
  return (
    identity !== null &&
    typeof identity === 'object' &&
    !Array.isArray(identity) &&
    Object.keys(identity).length === 2 &&
    Object.hasOwn(identity, 'name') &&
    Object.hasOwn(identity, 'email') &&
    plainFact(identity.name, MAX_IDENTITY_FACT) &&
    plainFact(identity.email, MAX_IDENTITY_FACT)
  );
}

function plainFact(value: string, maxLength: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\r\n]/.test(value)
  );
}

function sameIdentity(actual: GitIdentity, expected: GitIdentity): boolean {
  return (
    validIdentity(actual) &&
    actual.name === expected.name &&
    actual.email === expected.email
  );
}

function validateTransitionState(
  versions: ReleaseVersionState,
  expectedVersion: string,
): void {
  try {
    validateReleaseVersionState(expectedVersion, versions);
  } catch (error) {
    if (error instanceof ReleaseVersionError) {
      throw new ReleaseVersionError(
        'owned_release_transition_mismatch',
        'owned release version transition does not match the plan',
      );
    }
    throw error;
  }
}

function hasExactOwnedPaths(paths: readonly string[]): boolean {
  if (!Array.isArray(paths) || paths.length !== RELEASE_OWNED_PATHS.length) {
    return false;
  }
  const unique = new Set(paths);
  return (
    unique.size === RELEASE_OWNED_PATHS.length &&
    [...unique].every((path) => OWNED_PATH_SET.has(path))
  );
}
