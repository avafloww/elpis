import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  planRelease,
  RELEASE_OWNED_PATHS,
  validateReleaseVersionState,
  type ReleaseCommit,
  type ReleasePlan,
  type ReleaseVersionState,
} from './release-version.js';

const MAX_SMALL_FILE = 1024 * 1024;
const MAX_LARGE_FILE = 16 * 1024 * 1024;
const MAX_COMMIT_FILE = 4 * 1024 * 1024;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export class ReleaseSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseSyncError';
  }
}

export interface ReleaseSyncReceipt {
  format: 'elpis-release-sync-v1';
  mode: 'verify' | 'plan' | 'apply';
  previousVersion: string;
  nextVersion: string;
  bump: 'none' | 'patch' | 'minor';
  reason: string;
  commits: readonly { sha: string; subject: string }[];
  changedPaths: readonly string[];
  versionState: ReleaseVersionState;
}

interface Snapshot {
  files: Map<string, Buffer>;
  modes: Map<string, number>;
  packageJson: Record<string, unknown>;
  packageLock: Record<string, unknown>;
  state: ReleaseVersionState;
}

interface Candidate {
  relativePath: string;
  bytes: Buffer;
  original: Buffer;
  mode: number;
}

export interface ReleaseSyncDependencies {
  rename?: (from: string, to: string) => Promise<void>;
}

export async function verifyReleaseSync(
  root: string,
  expectedVersion: string,
): Promise<ReleaseSyncReceipt> {
  const snapshot = await readSnapshot(root);
  const version = validateReleaseVersionState(expectedVersion, snapshot.state);
  return receipt(
    'verify',
    version,
    version,
    'none',
    'version state matches',
    [],
    snapshot.state,
  );
}

export async function planReleaseSync(
  root: string,
  previousTag: string,
  commits: readonly ReleaseCommit[],
): Promise<ReleaseSyncReceipt> {
  const snapshot = await readSnapshot(root);
  const plan = planRelease(previousTag, snapshot.state, commits);
  return planReceipt('plan', plan, snapshot.state);
}

export async function applyReleaseSync(
  root: string,
  previousTag: string,
  commits: readonly ReleaseCommit[],
  dependencies: ReleaseSyncDependencies = {},
): Promise<ReleaseSyncReceipt> {
  const snapshot = await readSnapshot(root);
  const plan = planRelease(previousTag, snapshot.state, commits);
  const candidates = prepareCandidates(snapshot, plan.nextVersion);
  const candidateSnapshot = parseCandidateSnapshot(snapshot, candidates);
  validateReleaseVersionState(plan.nextVersion, candidateSnapshot.state);
  await commitCandidates(root, candidates, dependencies.rename ?? fs.rename);
  return planReceipt('apply', plan, candidateSnapshot.state);
}

export async function readReleaseCommits(
  file: string,
): Promise<ReleaseCommit[]> {
  const absolute = requireAbsolute(file, 'commit file');
  const bytes = await readRegularFile(absolute, MAX_COMMIT_FILE, 'commit file');
  let value: unknown;
  try {
    value = JSON.parse(utf8(bytes, 'commit file'));
  } catch {
    throw new ReleaseSyncError('commit file is not valid JSON');
  }
  if (!Array.isArray(value)) {
    throw new ReleaseSyncError('commit file must contain an array');
  }
  return value as ReleaseCommit[];
}

export async function runReleaseSyncCli(
  args: readonly string[],
  write: (text: string) => void = (text) => process.stdout.write(text),
): Promise<void> {
  const parsed = parseArgs(args);
  let output: ReleaseSyncReceipt;
  if (parsed.mode === 'verify') {
    output = await verifyReleaseSync(parsed.root, parsed.version);
  } else {
    const commits = await readReleaseCommits(parsed.commitsFile);
    output =
      parsed.mode === 'plan'
        ? await planReleaseSync(parsed.root, parsed.tag, commits)
        : await applyReleaseSync(parsed.root, parsed.tag, commits);
  }
  write(`${JSON.stringify(output)}\n`);
}

function receipt(
  mode: ReleaseSyncReceipt['mode'],
  previousVersion: string,
  nextVersion: string,
  bump: ReleaseSyncReceipt['bump'],
  reason: string,
  commits: readonly { sha: string; subject: string }[],
  versionState: ReleaseVersionState,
): ReleaseSyncReceipt {
  return {
    format: 'elpis-release-sync-v1',
    mode,
    previousVersion,
    nextVersion,
    bump,
    reason,
    commits,
    changedPaths: bump === 'none' ? [] : RELEASE_OWNED_PATHS,
    versionState,
  };
}

function planReceipt(
  mode: 'plan' | 'apply',
  plan: ReleasePlan,
  versionState: ReleaseVersionState,
): ReleaseSyncReceipt {
  return receipt(
    mode,
    plan.previousVersion,
    plan.nextVersion,
    plan.bump,
    plan.reason,
    plan.commits.map(({ sha, subject }) => ({ sha, subject })),
    versionState,
  );
}

async function readSnapshot(inputRoot: string): Promise<Snapshot> {
  const root = await canonicalRoot(inputRoot);
  const paths = [
    ['VERSION', MAX_SMALL_FILE],
    ['package.json', MAX_SMALL_FILE],
    ['package-lock.json', MAX_LARGE_FILE],
  ] as const;
  const files = new Map<string, Buffer>();
  const modes = new Map<string, number>();
  for (const [relative, limit] of paths) {
    const absolute = path.join(root, relative);
    const stat = await regularStat(absolute, relative);
    if (stat.size > limit) {
      throw new ReleaseSyncError(`${relative} exceeds the bounded size`);
    }
    try {
      files.set(relative, await fs.readFile(absolute));
    } catch {
      throw new ReleaseSyncError(`${relative} is unavailable`);
    }
    modes.set(relative, stat.mode & 0o777);
  }
  const packageJson = canonicalJson(files.get('package.json')!, 'package.json');
  const packageLock = canonicalJson(
    files.get('package-lock.json')!,
    'package-lock.json',
  );
  const state = parseVersionState(
    files.get('VERSION')!,
    packageJson,
    packageLock,
  );
  return { files, modes, packageJson, packageLock, state };
}

function parseVersionState(
  versionFile: Buffer,
  packageJson: Record<string, unknown>,
  packageLock: Record<string, unknown>,
): ReleaseVersionState {
  const version = exactVersionFile(versionFile);
  const packageVersion = exactString(
    packageJson.version,
    'package.json version',
  );
  const lockRoot = exactString(
    packageLock.version,
    'package-lock root version',
  );
  const packages = exactObject(packageLock.packages, 'package-lock packages');
  const lockWorkspace = exactString(
    exactObject(packages[''], 'package-lock workspace').version,
    'package-lock workspace version',
  );
  const state: ReleaseVersionState = {
    VERSION: version,
    'package-json': packageVersion,
    'package-lock-root': lockRoot,
    'package-lock-workspace': lockWorkspace,
  };
  validateReleaseVersionState(version, state);
  return state;
}

function prepareCandidates(
  snapshot: Snapshot,
  nextVersion: string,
): Candidate[] {
  exactVersion(nextVersion, 'next version');
  const packageJson = structuredClone(snapshot.packageJson);
  packageJson.version = nextVersion;
  const packageLock = structuredClone(snapshot.packageLock);
  packageLock.version = nextVersion;
  const packages = exactObject(packageLock.packages, 'package-lock packages');
  exactObject(packages[''], 'package-lock workspace').version = nextVersion;
  const bytes = new Map<string, Buffer>([
    ['VERSION', Buffer.from(`${nextVersion}\n`)],
    ['package.json', Buffer.from(canonicalJsonText(packageJson))],
    ['package-lock.json', Buffer.from(canonicalJsonText(packageLock))],
  ]);
  return RELEASE_OWNED_PATHS.map((relativePath) => {
    const original = snapshot.files.get(relativePath)!;
    const candidate = bytes.get(relativePath)!;
    if (candidate.equals(original)) {
      throw new ReleaseSyncError(`${relativePath} did not change`);
    }
    return {
      relativePath,
      bytes: candidate,
      original,
      mode: snapshot.modes.get(relativePath)!,
    };
  });
}

function parseCandidateSnapshot(
  snapshot: Snapshot,
  candidates: readonly Candidate[],
): Snapshot {
  const files = new Map(snapshot.files);
  for (const candidate of candidates)
    files.set(candidate.relativePath, candidate.bytes);
  const packageJson = canonicalJson(files.get('package.json')!, 'package.json');
  const packageLock = canonicalJson(
    files.get('package-lock.json')!,
    'package-lock.json',
  );
  const state = parseVersionState(
    files.get('VERSION')!,
    packageJson,
    packageLock,
  );
  return { ...snapshot, files, packageJson, packageLock, state };
}

async function commitCandidates(
  root: string,
  candidates: readonly Candidate[],
  rename: (from: string, to: string) => Promise<void>,
): Promise<void> {
  const prepared: Array<Candidate & { temporary: string; absolute: string }> =
    [];
  const replaced: Array<Candidate & { absolute: string }> = [];
  try {
    for (const candidate of candidates) {
      const absolute = path.join(root, candidate.relativePath);
      const temporary = path.join(
        path.dirname(absolute),
        `.release-sync-${process.pid}-${randomBytes(8).toString('hex')}`,
      );
      const handle = await fs.open(temporary, 'wx', candidate.mode);
      try {
        await handle.writeFile(candidate.bytes);
        await handle.chmod(candidate.mode);
        await handle.sync();
      } finally {
        await handle.close();
      }
      prepared.push({ ...candidate, temporary, absolute });
    }
    for (const candidate of prepared) {
      await rename(candidate.temporary, candidate.absolute);
      replaced.push(candidate);
    }
    await syncDirectories(
      replaced.map((candidate) => path.dirname(candidate.absolute)),
    );
  } catch (error) {
    let rollbackFailed = false;
    for (const candidate of [...replaced].reverse()) {
      try {
        await restoreFile(
          candidate.absolute,
          candidate.original,
          candidate.mode,
        );
      } catch {
        rollbackFailed = true;
      }
    }
    try {
      await syncDirectories(
        replaced.map((candidate) => path.dirname(candidate.absolute)),
      );
    } catch {
      rollbackFailed = true;
    }
    if (rollbackFailed) {
      throw new ReleaseSyncError(
        'release file transaction and rollback failed',
      );
    }
    if (error instanceof ReleaseSyncError) throw error;
    throw new ReleaseSyncError('release file transaction failed');
  } finally {
    await Promise.allSettled(
      prepared.map((candidate) => fs.rm(candidate.temporary, { force: true })),
    );
  }
}

async function restoreFile(
  absolute: string,
  bytes: Buffer,
  mode: number,
): Promise<void> {
  const temporary = `${absolute}.release-sync-rollback-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function syncDirectories(directories: readonly string[]): Promise<void> {
  for (const directory of new Set(directories)) {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

function canonicalJson(bytes: Buffer, label: string): Record<string, unknown> {
  const text = utf8(bytes, label);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ReleaseSyncError(`${label} is invalid JSON`);
  }
  const object = exactObject(parsed, label);
  if (canonicalJsonText(object) !== text) {
    throw new ReleaseSyncError(`${label} is not canonical JSON`);
  }
  return object;
}

function canonicalJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReleaseSyncError(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new ReleaseSyncError(`${label} is not a string`);
  return exactVersion(value, label);
}

function exactVersionFile(bytes: Buffer): string {
  const text = utf8(bytes, 'VERSION');
  if (!text.endsWith('\n') || text.slice(0, -1).includes('\n')) {
    throw new ReleaseSyncError('VERSION is invalid');
  }
  return exactVersion(text.slice(0, -1), 'VERSION');
}

function exactVersion(value: string, label: string): string {
  if (!VERSION.test(value)) throw new ReleaseSyncError(`${label} is invalid`);
  return value;
}

function utf8(bytes: Buffer, label: string): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes))
    throw new ReleaseSyncError(`${label} is not UTF-8`);
  return text;
}

async function canonicalRoot(input: string): Promise<string> {
  const absolute = requireAbsolute(input, 'root');
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new ReleaseSyncError('root is unavailable');
  }
  if (real !== absolute) throw new ReleaseSyncError('root must be canonical');
  let stat;
  try {
    stat = await fs.stat(real);
  } catch {
    throw new ReleaseSyncError('root is unavailable');
  }
  if (!stat.isDirectory())
    throw new ReleaseSyncError('root is not a directory');
  return real;
}

function requireAbsolute(input: string, label: string): string {
  if (
    !path.isAbsolute(input) ||
    path.normalize(input) !== input ||
    input === path.parse(input).root
  ) {
    throw new ReleaseSyncError(`${label} must be a safe absolute path`);
  }
  return input;
}

async function readRegularFile(
  absolute: string,
  max: number,
  label: string,
): Promise<Buffer> {
  const stat = await regularStat(absolute, label);
  if (stat.size > max)
    throw new ReleaseSyncError(`${label} exceeds the bounded size`);
  try {
    return await fs.readFile(absolute);
  } catch {
    throw new ReleaseSyncError(`${label} is unavailable`);
  }
}

async function regularStat(absolute: string, label: string) {
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch {
    throw new ReleaseSyncError(`${label} is unavailable`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ReleaseSyncError(`${label} must be a regular file`);
  }
  return stat;
}

type CliArgs =
  | { mode: 'verify'; root: string; version: string }
  | { mode: 'plan' | 'apply'; root: string; tag: string; commitsFile: string };

function parseArgs(args: readonly string[]): CliArgs {
  const mode = args[0];
  if (mode !== 'verify' && mode !== 'plan' && mode !== 'apply') {
    throw new ReleaseSyncError(
      'usage: release-sync verify|plan|apply --root ABSOLUTE ...',
    );
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      throw new ReleaseSyncError('release-sync arguments are invalid');
    }
    values.set(key, value);
  }
  const root = values.get('--root');
  if (!root) throw new ReleaseSyncError('--root is required');
  if (mode === 'verify') {
    if (values.size !== 2 || !values.get('--version')) {
      throw new ReleaseSyncError('verify requires --root and --version');
    }
    return { mode, root, version: values.get('--version')! };
  }
  if (values.size !== 3 || !values.get('--tag') || !values.get('--commits')) {
    throw new ReleaseSyncError(`${mode} requires --root, --tag, and --commits`);
  }
  return {
    mode,
    root,
    tag: values.get('--tag')!,
    commitsFile: values.get('--commits')!,
  };
}
