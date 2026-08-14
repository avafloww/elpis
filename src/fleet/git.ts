// git.ts — pure async git plumbing for the fleet subsystem: worktree state
// (dirty files, ahead count) for the dismiss gate, review diffs (committed +
// uncommitted text, per-file stat), and worktree removal.
//
// Every git invocation goes through execGit, built on child_process.spawn
// with argument ARRAYS — never `shell: true`. A worktree path, branch name,
// or ref handed in here is not something we can assume is shell-safe.
//
// `base` is `git merge-base HEAD <parentRepoHead>`, falling back to the
// literal ref 'HEAD' when parentRepoHead is null or merge-base fails (e.g.
// unrelated histories). With base = 'HEAD', every `base...HEAD` diff and
// `base..HEAD` count below degenerates to empty/zero rather than throwing —
// that's the intended fallback, not a bug: a worktree whose ancestry we can't
// resolve just reports no committed-ahead state.
//
// Numstat's default rename notation folds a common path prefix into
// "dir/{old => new}.txt", which can't be split back into old/new paths
// unambiguously. `-z` sidesteps this: a renamed/copied entry's path field
// comes back EMPTY, followed by the raw old and new paths as their own
// NUL-terminated tokens — see parseNumstatZ / parseNameStatusZ.
//
// FleetWorktreeDiff.committed/uncommitted are string|null (null = none/clean,
// NEVER empty string) and held in full — no capping; that's a rendering-time
// concern for callers, not this module's.

import { spawn } from 'node:child_process';

export interface WorktreeState {
  path: string;
  branch: string | null;
  base: string;
  dirtyFiles: string[];
  aheadCount: number;
  aheadOneline: string[];
}

export interface FleetWorktreeDiff {
  name: string;
  path: string;
  branch: string | null;
  base: string;
  stat: { files: number; insertions: number; deletions: number };
  files: Array<{ path: string; status: 'A' | 'M' | 'D' | 'R'; insertions: number; deletions: number }>;
  committed: string | null;
  uncommitted: string | null;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function execGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Run git, throwing (with stderr attached) on a nonzero exit — for calls
 * where failure is always unexpected (status/log/diff/rev-list against a
 * ref we already know is valid). */
async function gitOrThrow(args: string[], cwd: string): Promise<string> {
  const r = await execGit(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  }
  return r.stdout;
}

/** merge-base of HEAD and parentRepoHead, falling back to the literal ref
 * 'HEAD' when parentRepoHead is unknown or merge-base fails. See header. */
async function resolveBase(cwd: string, parentRepoHead: string | null): Promise<string> {
  if (!parentRepoHead) return 'HEAD';
  const r = await execGit(['merge-base', 'HEAD', parentRepoHead], cwd);
  if (r.code !== 0) return 'HEAD';
  return r.stdout.trim() || 'HEAD';
}

/** `git rev-parse HEAD` in cwd, or null on any failure (not a repo, no
 * commits yet, ...). The sole async replacement for the fleet registry's old
 * synchronous `spawnSyncGit` — every call site here is already inside an
 * async flow. */
export async function repoHead(cwd: string): Promise<string | null> {
  const r = await execGit(['rev-parse', 'HEAD'], cwd);
  if (r.code !== 0) return null;
  const out = r.stdout.trim();
  return out || null;
}

async function currentBranch(cwd: string): Promise<string | null> {
 // Fails (nonzero) on a detached HEAD — that's a legitimate outcome, not an
 // unexpected failure, so this doesn't go through gitOrThrow.
  const r = await execGit(['symbolic-ref', '-q', '--short', 'HEAD'], cwd);
  if (r.code !== 0) return null;
  const b = r.stdout.trim();
  return b || null;
}

function pathArgs(paths?: string[]): string[] {
  return paths && paths.length > 0 ? ['--', ...paths] : [];
}

/** `git status --porcelain [-- paths]`, split into dirty tracked-file paths
 * and untracked ('??') paths, in encounter order. */
async function statusPorcelain(cwd: string, paths?: string[]): Promise<{ dirty: string[]; untracked: string[] }> {
  const out = await gitOrThrow(['status', '--porcelain', ...pathArgs(paths)], cwd);
  const dirty: string[] = [];
  const untracked: string[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const code = line.slice(0, 2);
    const rest = line.slice(3);
    if (code === '??') untracked.push(rest);
    else dirty.push(rest);
  }
  return { dirty, untracked };
}

/** Parse `git diff --numstat -z` output into per-file {path, insertions,
 * deletions}. See header for why -z. A binary file's counts come back as
 * '-' from git; those are reported as 0 here. */
function parseNumstatZ(buf: string): Array<{ path: string; insertions: number; deletions: number }> {
  const tokens = buf.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const out: Array<{ path: string; insertions: number; deletions: number }> = [];
  let i = 0;
  while (i < tokens.length) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tokens[i]);
    if (!m) { i++; continue; }
    const insertions = m[1] === '-' ? 0 : parseInt(m[1], 10);
    const deletions = m[2] === '-' ? 0 : parseInt(m[2], 10);
    let filePath = m[3];
    i++;
    if (filePath === '') {
 // rename/copy: next two tokens are the old path, then the new path.
      i++; // old path — unused; the file list is keyed by the current path
      filePath = tokens[i] ?? '';
      i++;
    }
    out.push({ path: filePath, insertions, deletions });
  }
  return out;
}

/** Parse `git diff --name-status -z` output into a status map keyed by the
 * file's CURRENT (new) path. Copy (C) is folded into 'R' — FleetWorktreeDiff
 * only distinguishes A/M/D/R. */
function parseNameStatusZ(buf: string): Map<string, 'A' | 'M' | 'D' | 'R'> {
  const tokens = buf.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const out = new Map<string, 'A' | 'M' | 'D' | 'R'>();
  let i = 0;
  while (i < tokens.length) {
    const letter = tokens[i][0];
    i++;
    if (letter === 'R' || letter === 'C') {
      i++; // old path
      const newPath = tokens[i] ?? '';
      i++;
      out.set(newPath, 'R');
    } else {
      const p = tokens[i] ?? '';
      i++;
      out.set(p, letter === 'A' || letter === 'D' ? letter : 'M');
    }
  }
  return out;
}

/** Joined numstat + name-status → FleetWorktreeDiff's stat/files, against
 * `range` (either 'HEAD' for the working-tree-vs-HEAD case, or
 * '<base>...HEAD' for a worktree's committed diff). */
async function statAndFiles(
  cwd: string,
  range: string,
  paths: string[] | undefined,
): Promise<{ stat: FleetWorktreeDiff['stat']; files: FleetWorktreeDiff['files'] }> {
  const extra = pathArgs(paths);
  const [numstatOut, nameStatusOut] = await Promise.all([
    gitOrThrow(['diff', '--numstat', '-z', range, ...extra], cwd),
    gitOrThrow(['diff', '--name-status', '-z', range, ...extra], cwd),
  ]);
  const statusByPath = parseNameStatusZ(nameStatusOut);
  const files = parseNumstatZ(numstatOut).map((f) => ({
    path: f.path,
    status: statusByPath.get(f.path) ?? 'M',
    insertions: f.insertions,
    deletions: f.deletions,
  }));
  const stat = files.reduce(
    (acc, f) => ({
      files: acc.files + 1,
      insertions: acc.insertions + f.insertions,
      deletions: acc.deletions + f.deletions,
    }),
    { files: 0, insertions: 0, deletions: 0 },
  );
  return { stat, files };
}

/** `git diff HEAD [-- paths]` plus a labeled untracked-files summary (`git
 * diff` never shows untracked content). null when both are empty. */
async function buildUncommitted(cwd: string, paths: string[] | undefined): Promise<string | null> {
  const [diffText, { untracked }] = await Promise.all([
    gitOrThrow(['diff', 'HEAD', ...pathArgs(paths)], cwd),
    statusPorcelain(cwd, paths),
  ]);
  if (diffText === '' && untracked.length === 0) return null;
  if (untracked.length === 0) return diffText;
  const block = `Untracked files:\n${untracked.map((p) => `  ${p}`).join('\n')}`;
  return diffText === '' ? block : `${diffText}\n\n${block}`;
}

export async function worktreeState(wtPath: string, parentRepoHead: string | null): Promise<WorktreeState> {
  const base = await resolveBase(wtPath, parentRepoHead);
  const [branch, { dirty, untracked }, aheadCountOut, aheadOnelineOut] = await Promise.all([
    currentBranch(wtPath),
    statusPorcelain(wtPath),
    gitOrThrow(['rev-list', '--count', `${base}..HEAD`], wtPath),
    gitOrThrow(['log', '--oneline', `${base}..HEAD`], wtPath),
  ]);
  return {
    path: wtPath,
    branch,
    base,
    dirtyFiles: [...dirty, ...untracked],
    aheadCount: parseInt(aheadCountOut.trim(), 10) || 0,
    aheadOneline: aheadOnelineOut.split('\n').filter((l) => l !== ''),
  };
}

export async function worktreeDiff(
  name: string,
  wtPath: string,
  parentRepoHead: string | null,
  opts: { statOnly?: boolean; paths?: string[] } = {},
): Promise<FleetWorktreeDiff> {
  const base = await resolveBase(wtPath, parentRepoHead);
  const [branch, { stat, files }] = await Promise.all([
    currentBranch(wtPath),
    statAndFiles(wtPath, `${base}...HEAD`, opts.paths),
  ]);

  let committed: string | null = null;
  let uncommitted: string | null = null;
  if (!opts.statOnly) {
    const [committedText, uncommittedText] = await Promise.all([
      gitOrThrow(['diff', `${base}...HEAD`, ...pathArgs(opts.paths)], wtPath),
      buildUncommitted(wtPath, opts.paths),
    ]);
    committed = committedText === '' ? null : committedText;
    uncommitted = uncommittedText;
  }

  return { name, path: wtPath, branch, base, stat, files, committed, uncommitted };
}

export async function cwdDiff(
  cwd: string,
  opts: { statOnly?: boolean; paths?: string[] } = {},
): Promise<FleetWorktreeDiff> {
  const [branch, { stat, files }] = await Promise.all([
    currentBranch(cwd),
    statAndFiles(cwd, 'HEAD', opts.paths),
  ]);
  const uncommitted = opts.statOnly ? null : await buildUncommitted(cwd, opts.paths);
  return { name: '(cwd)', path: cwd, branch, base: 'HEAD', stat, files, committed: null, uncommitted };
}

export async function removeWorktree(parentRepo: string, wtPath: string): Promise<void> {
  await gitOrThrow(['-C', parentRepo, 'worktree', 'remove', '--force', wtPath], parentRepo);
}
