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
  | 'empty_commit_range';

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
