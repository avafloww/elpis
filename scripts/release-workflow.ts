import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  applyReleaseSync,
  planReleaseSync,
  verifyReleaseSync,
  type ReleaseSyncDependencies,
} from '../src/release-sync.js';
import {
  RELEASE_OWNED_PATHS,
  validateOwnedReleaseCommit,
  type GitIdentity,
  type OwnedReleaseCommitFacts,
  type ReleaseVersionState,
} from '../src/release-version.js';

const execFileAsync = promisify(execFile);
const SHA = /^[0-9a-f]{40}$/;
const TAG = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;

export const RELEASE_BOT_LOGIN = 'github-actions[bot]';
export const RELEASE_BOT_IDENTITY: GitIdentity = Object.freeze({
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
});

export class ReleaseWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseWorkflowError';
  }
}

export interface ReleaseWorkflowResult {
  format: 'elpis-release-workflow-v1';
  mode: 'none' | 'bootstrap' | 'release' | 'resume';
  baseSha: string;
  releaseSha: string;
  tag: string;
  version: string;
  previousTag: string;
  previousVersion: string;
  minorTag: string;
  shortSha: string;
  reason: string;
}

export interface ReleaseWorkflowDependencies {
  sync?: ReleaseSyncDependencies;
}

export async function prepareReleaseWorkflow(
  inputRoot: string,
  testedSha: string,
  actorLogin = '',
  dependencies: ReleaseWorkflowDependencies = {},
  bootstrap = false,
): Promise<ReleaseWorkflowResult> {
  const root = await canonicalRoot(inputRoot);
  requireSha(testedSha, 'tested SHA');
  const head = await git(root, ['rev-parse', 'HEAD']);
  const remote = await git(root, ['rev-parse', 'refs/remotes/origin/main']);
  if (head !== testedSha || remote !== testedSha) {
    throw new ReleaseWorkflowError('tested SHA is stale or not checked out');
  }
  if (
    (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) !==
    ''
  ) {
    throw new ReleaseWorkflowError('release checkout is not clean');
  }
  const currentTags = (
    await git(root, ['tag', '--points-at', 'HEAD', '--list', 'v*'])
  )
    .split('\n')
    .filter(Boolean)
    .filter((tag) => TAG.test(tag));
  if (currentTags.length > 1) {
    throw new ReleaseWorkflowError(
      'release commit has multiple canonical version tags',
    );
  }
  if (currentTags.length === 1) {
    if (bootstrap) {
      return validateBootstrapTag(root, testedSha, currentTags[0]);
    }
    if (actorLogin !== RELEASE_BOT_LOGIN && !LOGIN.test(actorLogin)) {
      throw new ReleaseWorkflowError(
        'release commit actor login is unavailable',
      );
    }
    return validateExistingRelease(root, testedSha, currentTags[0], actorLogin);
  }

  const reachableTags = (
    await git(root, ['tag', '--merged', testedSha, '--list', 'v*'])
  )
    .split('\n')
    .filter((tag) => TAG.test(tag));
  if (reachableTags.length === 0) {
    await verifyReleaseSync(root, '0.1.0');
    if (bootstrap) return prepareBootstrapTag(root, testedSha);
    return emptyResult(
      testedSha,
      'no reachable version tag; bootstrap is separate',
    );
  }
  if (bootstrap) {
    throw new ReleaseWorkflowError(
      'bootstrap requires a repository with no reachable version tag',
    );
  }
  const previousTag = await git(root, [
    'describe',
    '--tags',
    '--match',
    'v[0-9]*',
    '--abbrev=0',
    testedSha,
  ]);
  requireTag(previousTag);
  await requireAnnotatedTag(root, previousTag, false);
  const commits = await commitsBetween(root, previousTag, testedSha);
  const plan = await planReleaseSync(root, previousTag, commits);
  const applied = await applyReleaseSync(
    root,
    previousTag,
    commits,
    dependencies.sync,
  );
  if (
    plan.previousVersion !== applied.previousVersion ||
    plan.nextVersion !== applied.nextVersion ||
    plan.bump !== applied.bump
  ) {
    throw new ReleaseWorkflowError('release plan changed during application');
  }
  const worktreePaths = await changedWorktreePaths(root);
  if (!sameOwnedPaths(worktreePaths)) {
    throw new ReleaseWorkflowError(
      'release preparation changed unexpected paths',
    );
  }
  await git(root, ['add', '--', ...RELEASE_OWNED_PATHS]);
  const date = await git(root, ['show', '-s', '--format=%cI', testedSha]);
  const subject = `chore(release): v${applied.nextVersion}`;
  const identityEnvironment = releaseIdentityEnvironment(date);
  await git(
    root,
    ['commit', '--no-gpg-sign', '-m', subject],
    identityEnvironment,
  );
  const releaseSha = await git(root, ['rev-parse', 'HEAD']);
  requireSha(releaseSha, 'release SHA');
  const tag = `v${applied.nextVersion}`;
  if ((await git(root, ['tag', '--list', tag])) !== '') {
    throw new ReleaseWorkflowError('planned release tag already exists');
  }
  await git(
    root,
    [
      'tag',
      '--annotate',
      '--no-sign',
      '--message',
      `Elpis ${tag}`,
      tag,
      releaseSha,
    ],
    identityEnvironment,
  );
  await validateReleaseFacts(
    root,
    releaseSha,
    tag,
    plan.versionState,
    applied.versionState,
    RELEASE_BOT_LOGIN,
  );
  if (
    (await git(root, ['status', '--porcelain=v1', '--untracked-files=all'])) !==
    ''
  ) {
    throw new ReleaseWorkflowError(
      'release checkout is dirty after preparation',
    );
  }
  return result(
    'release',
    testedSha,
    releaseSha,
    tag,
    previousTag,
    plan.previousVersion,
    'release commit and annotated tag prepared locally',
  );
}

export async function runReleaseWorkflowCli(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  const parsed = parseArgs(args);
  const value = await prepareReleaseWorkflow(
    parsed.root,
    parsed.testedSha,
    parsed.actorLogin,
    {},
    parsed.bootstrap,
  );
  if (parsed.output !== '') await appendGitHubOutput(parsed.output, value);
  write(`${JSON.stringify(value)}\n`);
}

async function prepareBootstrapTag(
  root: string,
  testedSha: string,
): Promise<ReleaseWorkflowResult> {
  const tag = 'v0.1.0';
  if ((await git(root, ['tag', '--list', tag])) !== '') {
    throw new ReleaseWorkflowError('bootstrap tag already exists elsewhere');
  }
  const date = await git(root, ['show', '-s', '--format=%cI', testedSha]);
  await git(
    root,
    [
      'tag',
      '--annotate',
      '--no-sign',
      '--message',
      `Elpis ${tag}`,
      tag,
      testedSha,
    ],
    releaseIdentityEnvironment(date),
  );
  return validateBootstrapTag(root, testedSha, tag);
}

async function validateBootstrapTag(
  root: string,
  testedSha: string,
  tag: string,
): Promise<ReleaseWorkflowResult> {
  if (tag !== 'v0.1.0') {
    throw new ReleaseWorkflowError('bootstrap tag must be exactly v0.1.0');
  }
  await requireAnnotatedTag(root, tag, true);
  if ((await git(root, ['rev-parse', `${tag}^{}`])) !== testedSha) {
    throw new ReleaseWorkflowError('bootstrap tag does not target tested SHA');
  }
  const reachableTags = (
    await git(root, ['tag', '--merged', testedSha, '--list', 'v*'])
  )
    .split('\n')
    .filter((candidate) => TAG.test(candidate));
  if (reachableTags.length !== 1 || reachableTags[0] !== tag) {
    throw new ReleaseWorkflowError('bootstrap tag set is invalid');
  }
  await verifyReleaseSync(root, '0.1.0');
  return result(
    'bootstrap',
    testedSha,
    testedSha,
    tag,
    '',
    '',
    'validated explicit v0.1.0 bootstrap tag',
  );
}

async function validateExistingRelease(
  root: string,
  releaseSha: string,
  tag: string,
  actorLogin: string,
): Promise<ReleaseWorkflowResult> {
  await requireAnnotatedTag(root, tag, true);
  const parentLine = (
    await git(root, ['rev-list', '--parents', '-n', '1', releaseSha])
  ).split(' ');
  if (parentLine.length !== 2) {
    throw new ReleaseWorkflowError(
      'release commit must have exactly one parent',
    );
  }
  const parent = parentLine[1];
  const reachableTags = (
    await git(root, ['tag', '--merged', parent, '--list', 'v*'])
  )
    .split('\n')
    .filter((candidate) => TAG.test(candidate));
  if (reachableTags.length === 0) {
    throw new ReleaseWorkflowError(
      'release commit has no previous version tag',
    );
  }
  const previousTag = await git(root, [
    'describe',
    '--tags',
    '--match',
    'v[0-9]*',
    '--abbrev=0',
    parent,
  ]);
  requireTag(previousTag);
  await requireAnnotatedTag(root, previousTag, false);
  const currentVersion = tag.slice(1);
  const previousVersion = previousTag.slice(1);
  const currentState = (await verifyReleaseSync(root, currentVersion))
    .versionState;
  const container = await fs.mkdtemp(
    path.join(tmpdir(), 'elpis-release-previous-'),
  );
  const previousRoot = path.join(container, 'tree');
  let previousState: ReleaseVersionState;
  try {
    await git(root, ['worktree', 'add', '--detach', previousRoot, parent]);
    previousState = (await verifyReleaseSync(previousRoot, previousVersion))
      .versionState;
  } finally {
    await gitMaybe(root, ['worktree', 'remove', '--force', previousRoot]);
    await fs.rm(container, { recursive: true, force: true });
  }
  await validateReleaseFacts(
    root,
    releaseSha,
    tag,
    previousState,
    currentState,
    actorLogin,
  );
  return result(
    'resume',
    releaseSha,
    releaseSha,
    tag,
    previousTag,
    previousVersion,
    'validated existing release commit is ready for publication recovery',
  );
}

async function validateReleaseFacts(
  root: string,
  releaseSha: string,
  tag: string,
  previousVersions: ReleaseVersionState,
  currentVersions: ReleaseVersionState,
  actorLogin: string,
): Promise<void> {
  const fields = splitNul(
    await git(root, [
      'show',
      '-s',
      '--format=%s%x00%an%x00%ae%x00%cn%x00%ce',
      releaseSha,
    ]),
    5,
    'release commit identity',
  );
  const changedPaths = (
    await git(root, [
      'diff-tree',
      '--no-commit-id',
      '--name-only',
      '-r',
      `${releaseSha}^`,
      releaseSha,
    ])
  )
    .split('\n')
    .filter(Boolean);
  const facts: OwnedReleaseCommitFacts = {
    sha: releaseSha,
    subject: fields[0],
    actorLogin,
    author: { name: fields[1], email: fields[2] },
    committer: { name: fields[3], email: fields[4] },
    previousVersions,
    currentVersions,
    changedPaths,
    tag: {
      name: tag,
      objectType: await git(root, ['cat-file', '-t', `refs/tags/${tag}`]),
      targetType: await git(root, ['cat-file', '-t', `${tag}^{}`]),
      targetSha: await git(root, ['rev-parse', `${tag}^{}`]),
    },
  };
  validateOwnedReleaseCommit(
    {
      previousVersion: previousVersions.VERSION,
      nextVersion: currentVersions.VERSION,
    },
    {
      actorLogin: RELEASE_BOT_LOGIN,
      author: RELEASE_BOT_IDENTITY,
      committer: RELEASE_BOT_IDENTITY,
    },
    facts,
  );
}

async function requireAnnotatedTag(
  root: string,
  tag: string,
  requireReleaseTagger: boolean,
): Promise<void> {
  if ((await git(root, ['cat-file', '-t', `refs/tags/${tag}`])) !== 'tag') {
    throw new ReleaseWorkflowError('version tag is not annotated');
  }
  if ((await git(root, ['cat-file', '-t', `${tag}^{}`])) !== 'commit') {
    throw new ReleaseWorkflowError('version tag does not target a commit');
  }
  if (!requireReleaseTagger) return;
  const tagger = splitNul(
    await git(root, [
      'for-each-ref',
      '--format=%(taggername)%00%(taggeremail)',
      `refs/tags/${tag}`,
    ]),
    2,
    'release tagger',
  );
  if (
    tagger[0] !== RELEASE_BOT_IDENTITY.name ||
    normalizeTaggerEmail(tagger[1]) !== RELEASE_BOT_IDENTITY.email
  ) {
    throw new ReleaseWorkflowError('release tagger identity does not match');
  }
  const message = await git(root, [
    'for-each-ref',
    '--format=%(contents)',
    `refs/tags/${tag}`,
  ]);
  if (message !== `Elpis ${tag}\n`) {
    throw new ReleaseWorkflowError('release tag message does not match');
  }
}

async function commitsBetween(
  root: string,
  previousTag: string,
  testedSha: string,
): Promise<Array<{ sha: string; subject: string }>> {
  const encoded = await git(root, [
    'log',
    '--reverse',
    '--format=%H%x00%s%x00',
    `${previousTag}..${testedSha}`,
  ]);
  const fields = encoded.split('\0');
  const commits: Array<{ sha: string; subject: string }> = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = fields[index].replace(/^\n+/, '');
    const subject = fields[index + 1];
    if (sha === '' && subject === '') continue;
    requireSha(sha, 'commit SHA');
    commits.push({ sha, subject });
  }
  return commits;
}

async function changedWorktreePaths(root: string): Promise<string[]> {
  return (await git(root, ['diff', '--name-only', '--']))
    .split('\n')
    .filter(Boolean);
}

function sameOwnedPaths(paths: readonly string[]): boolean {
  const allowed = new Set<string>(RELEASE_OWNED_PATHS);
  return (
    paths.length === allowed.size &&
    new Set(paths).size === allowed.size &&
    paths.every((entry) => allowed.has(entry))
  );
}

function result(
  mode: 'bootstrap' | 'release' | 'resume',
  baseSha: string,
  releaseSha: string,
  tag: string,
  previousTag: string,
  previousVersion: string,
  reason: string,
): ReleaseWorkflowResult {
  const version = tag.slice(1);
  const [major, minor] = version.split('.');
  return {
    format: 'elpis-release-workflow-v1',
    mode,
    baseSha,
    releaseSha,
    tag,
    version,
    previousTag,
    previousVersion,
    minorTag: `${major}.${minor}`,
    shortSha: releaseSha.slice(0, 7),
    reason,
  };
}

function emptyResult(baseSha: string, reason: string): ReleaseWorkflowResult {
  return {
    format: 'elpis-release-workflow-v1',
    mode: 'none',
    baseSha,
    releaseSha: '',
    tag: '',
    version: '',
    previousTag: '',
    previousVersion: '',
    minorTag: '',
    shortSha: '',
    reason,
  };
}

function releaseIdentityEnvironment(date: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: RELEASE_BOT_IDENTITY.name,
    GIT_AUTHOR_EMAIL: RELEASE_BOT_IDENTITY.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: RELEASE_BOT_IDENTITY.name,
    GIT_COMMITTER_EMAIL: RELEASE_BOT_IDENTITY.email,
    GIT_COMMITTER_DATE: date,
  };
}

async function appendGitHubOutput(
  output: string,
  value: ReleaseWorkflowResult,
): Promise<void> {
  if (!path.isAbsolute(output) || path.normalize(output) !== output) {
    throw new ReleaseWorkflowError('GitHub output path must be absolute');
  }
  const pairs: Record<string, string> = {
    mode: value.mode,
    base_sha: value.baseSha,
    release_sha: value.releaseSha,
    tag: value.tag,
    version: value.version,
    previous_tag: value.previousTag,
    previous_version: value.previousVersion,
    minor_tag: value.minorTag,
    short_sha: value.shortSha,
  };
  await fs.appendFile(
    output,
    `${Object.entries(pairs)
      .map(([key, item]) => `${key}=${item}`)
      .join('\n')}\n`,
    { encoding: 'utf8' },
  );
}

function splitNul(value: string, count: number, label: string): string[] {
  const fields = value.split('\0');
  if (fields.length !== count || fields.some((field) => field === '')) {
    throw new ReleaseWorkflowError(`${label} is invalid`);
  }
  return fields;
}

function normalizeTaggerEmail(value: string): string {
  return value.startsWith('<') && value.endsWith('>')
    ? value.slice(1, -1)
    : value;
}

function requireSha(value: string, label: string): void {
  if (!SHA.test(value)) throw new ReleaseWorkflowError(`${label} is invalid`);
}

function requireTag(value: string): void {
  if (!TAG.test(value))
    throw new ReleaseWorkflowError('version tag is invalid');
}

async function canonicalRoot(input: string): Promise<string> {
  if (!path.isAbsolute(input) || path.normalize(input) !== input) {
    throw new ReleaseWorkflowError(
      'repository root must be a safe absolute path',
    );
  }
  let real: string;
  try {
    real = await fs.realpath(input);
  } catch {
    throw new ReleaseWorkflowError('repository root is unavailable');
  }
  if (real !== input)
    throw new ReleaseWorkflowError('repository root must be canonical');
  return real;
}

async function git(
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: MAX_GIT_OUTPUT,
    });
    return result.stdout.replace(/\n$/, '');
  } catch {
    throw new ReleaseWorkflowError(`git ${args[0] ?? 'command'} failed`);
  }
}

async function gitMaybe(
  root: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await git(root, args);
  } catch {
    return null;
  }
}

type ParsedArgs = {
  root: string;
  testedSha: string;
  actorLogin: string;
  output: string;
  bootstrap: boolean;
};

function parseArgs(args: readonly string[]): ParsedArgs {
  if (args[0] !== 'prepare') {
    throw new ReleaseWorkflowError(
      'usage: release-workflow prepare --root ABSOLUTE --tested-sha SHA [--actor-login LOGIN] [--output ABSOLUTE] [--bootstrap true|false]',
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      throw new ReleaseWorkflowError('release workflow arguments are invalid');
    }
    values.set(key, value);
  }
  if (
    values.size < 2 ||
    values.size > 5 ||
    !values.get('--root') ||
    !values.get('--tested-sha') ||
    [...values.keys()].some(
      (key) =>
        ![
          '--root',
          '--tested-sha',
          '--actor-login',
          '--output',
          '--bootstrap',
        ].includes(key),
    )
  ) {
    throw new ReleaseWorkflowError('release workflow arguments are invalid');
  }
  return {
    root: values.get('--root')!,
    testedSha: values.get('--tested-sha')!,
    actorLogin: values.get('--actor-login') ?? '',
    output: values.get('--output') ?? '',
    bootstrap: parseBoolean(values.get('--bootstrap') ?? 'false'),
  };
}

function parseBoolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ReleaseWorkflowError('bootstrap must be true or false');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await runReleaseWorkflowCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'release workflow preparation failed'}\n`,
    );
    process.exitCode = 1;
  }
}
