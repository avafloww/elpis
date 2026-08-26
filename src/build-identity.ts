import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REPOSITORY = 'https://github.com/avafloww/elpis';

export type BuildState = 'release' | 'dev' | 'dirty' | 'unknown';

export interface BuildIdentity {
  version: string;
  versionTag: string;
  versionLabel: string;
  versionUrl: string;
  revision: string | null;
  revisionShort: string | null;
  revisionUrl: string | null;
  treeClean: boolean | null;
  exactRelease: boolean;
  state: BuildState;
  source: 'environment' | 'git' | 'unknown';
  display: string;
}

export interface BuildIdentityFacts {
  version: string;
  revision: string | null;
  treeClean: boolean | null;
  exactTag: string | null;
  source?: BuildIdentity['source'];
}

export interface ResolveBuildIdentityOptions {
  env?: NodeJS.ProcessEnv;
  readVersion?: (root: string) => Promise<string>;
  git?: (root: string, args: readonly string[]) => Promise<string | null>;
}

export class BuildIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BuildIdentityError';
  }
}

function canonicalVersion(value: string): string {
  const version = value.trim();
  if (!VERSION.test(version))
    throw new BuildIdentityError('invalid package version');
  return version;
}

function canonicalRevision(value: string | null): string | null {
  if (value === null) return null;
  const revision = value.trim().toLowerCase();
  if (!REVISION.test(revision))
    throw new BuildIdentityError('invalid build revision');
  return revision;
}

export function createBuildIdentity(facts: BuildIdentityFacts): BuildIdentity {
  const version = canonicalVersion(facts.version);
  const revision = canonicalRevision(facts.revision);
  const versionTag = `v${version}`;
  const exactTag = facts.exactTag?.trim() || null;
  if (
    exactTag !== null &&
    !/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(exactTag)
  ) {
    throw new BuildIdentityError('invalid exact build tag');
  }
  const exactRelease =
    revision !== null && facts.treeClean === true && exactTag === versionTag;
  const state: BuildState = exactRelease
    ? 'release'
    : facts.treeClean === false
      ? 'dirty'
      : revision !== null
        ? 'dev'
        : 'unknown';
  const versionLabel = exactRelease ? versionTag : `${versionTag}-${state}`;
  const revisionShort = revision?.slice(0, 12) ?? null;
  const versionUrl = `${REPOSITORY}/releases/tag/${versionTag}`;
  const revisionUrl = revision ? `${REPOSITORY}/commit/${revision}` : null;
  return Object.freeze({
    version,
    versionTag,
    versionLabel,
    versionUrl,
    revision,
    revisionShort,
    revisionUrl,
    treeClean: facts.treeClean,
    exactRelease,
    state,
    source: facts.source ?? 'unknown',
    display: revision ? `${versionLabel} + ${revision}` : versionLabel,
  });
}

async function readPackageVersion(root: string): Promise<string> {
  const file = path.join(root, 'package.json');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
    throw new BuildIdentityError('package.json is not a bounded regular file');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new BuildIdentityError('package.json could not be read');
  }
  const version =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).version
      : null;
  if (typeof version !== 'string')
    throw new BuildIdentityError('package.json has no version');
  return canonicalVersion(version);
}

async function gitText(
  root: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout;
  } catch {
    return null;
  }
}

function injectedDirty(value: string | undefined): boolean {
  if (value === undefined || value === 'false' || value === '0') return false;
  if (value === 'true' || value === '1') return true;
  throw new BuildIdentityError('ELPIS_BUILD_DIRTY must be true or false');
}

export async function resolveBuildIdentity(
  root: string,
  options: ResolveBuildIdentityOptions = {},
): Promise<BuildIdentity> {
  const readVersion = options.readVersion ?? readPackageVersion;
  const git = options.git ?? gitText;
  const env = options.env ?? process.env;
  const version = canonicalVersion(await readVersion(root));
  const injectedRevision = env.ELPIS_BUILD_REVISION?.trim() || null;
  if (injectedRevision !== null) {
    return createBuildIdentity({
      version,
      revision: injectedRevision,
      treeClean: !injectedDirty(env.ELPIS_BUILD_DIRTY),
      exactTag: env.ELPIS_BUILD_TAG?.trim() || null,
      source: 'environment',
    });
  }
  const revision = (await git(root, ['rev-parse', 'HEAD']))?.trim() || null;
  if (revision === null) {
    return createBuildIdentity({
      version,
      revision: null,
      treeClean: null,
      exactTag: null,
      source: 'unknown',
    });
  }
  const [status, tag] = await Promise.all([
    git(root, ['status', '--porcelain']),
    git(root, ['describe', '--tags', '--exact-match', 'HEAD']),
  ]);
  return createBuildIdentity({
    version,
    revision,
    treeClean: status === null ? null : status.trim().length === 0,
    exactTag: tag?.trim() || null,
    source: 'git',
  });
}
