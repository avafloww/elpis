// Unit tests for src/fleet/git.ts. Builds real throwaway git repos +
// worktrees under os.tmpdir — never inside this repo or its worktrees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { worktreeState, worktreeDiff, cwdDiff, removeWorktree } from '../src/fleet/git.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Fresh repo A with one commit, plus a worktree W checked out on a new
 * branch from that same commit. Registers cleanup on `t`. */
function fixture(t: { after: (fn: () => void) => void }): { repoDir: string; wtDir: string; headSha: string; branch: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-git-'));
  const repoDir = path.join(root, 'repo');
  const wtDir = path.join(root, 'wt');
  fs.mkdirSync(repoDir);
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'a@test.com']);
  git(repoDir, ['config', 'user.name', 'tester']);
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'hello\n');
  git(repoDir, ['add', '.']);
  git(repoDir, ['commit', '-q', '-m', 'init']);
  const headSha = git(repoDir, ['rev-parse', 'HEAD']).trim();
  const branch = 'feature';
  git(repoDir, ['worktree', 'add', '-q', '-b', branch, wtDir, headSha]);
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  return { repoDir, wtDir, headSha, branch };
}

test('worktreeState: clean worktree is 0 ahead with no dirty files', async (t) => {
  const { wtDir, headSha, branch } = fixture(t);
  const state = await worktreeState(wtDir, headSha);
  assert.equal(state.path, wtDir);
  assert.equal(state.branch, branch);
  assert.equal(state.base, headSha);
  assert.deepEqual(state.dirtyFiles, []);
  assert.equal(state.aheadCount, 0);
  assert.deepEqual(state.aheadOneline, []);
});

test('worktreeState: a commit in the worktree is reflected as ahead', async (t) => {
  const { wtDir, headSha } = fixture(t);
  fs.writeFileSync(path.join(wtDir, 'new.txt'), 'stuff\n');
  git(wtDir, ['add', '.']);
  git(wtDir, ['commit', '-q', '-m', 'add new.txt']);
  const state = await worktreeState(wtDir, headSha);
  assert.equal(state.aheadCount, 1);
  assert.equal(state.aheadOneline.length, 1);
  assert.match(state.aheadOneline[0], /add new\.txt/);
});

test('worktreeState: a dirty tracked file shows up in dirtyFiles', async (t) => {
  const { wtDir, headSha } = fixture(t);
  fs.writeFileSync(path.join(wtDir, 'base.txt'), 'changed\n');
  const state = await worktreeState(wtDir, headSha);
  assert.equal(state.dirtyFiles.length, 1);
  assert.match(state.dirtyFiles[0], /base\.txt/);
});

test('worktreeDiff: clean worktree has null committed/uncommitted', async (t) => {
  const { wtDir, headSha } = fixture(t);
  const diff = await worktreeDiff('feature', wtDir, headSha);
  assert.equal(diff.committed, null);
  assert.equal(diff.uncommitted, null);
  assert.equal(diff.stat.files, 0);
});

test('worktreeDiff: committed change in worktree shows in the diff + stat', async (t) => {
  const { wtDir, headSha } = fixture(t);
  fs.writeFileSync(path.join(wtDir, 'new.txt'), 'stuff\n');
  git(wtDir, ['add', '.']);
  git(wtDir, ['commit', '-q', '-m', 'add new.txt']);
  const diff = await worktreeDiff('feature', wtDir, headSha);
  assert.equal(diff.stat.files, 1);
  assert.ok(diff.committed !== null);
  assert.match(diff.committed as string, /new\.txt/);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].path, 'new.txt');
  assert.equal(diff.files[0].status, 'A');
  assert.equal(diff.files[0].insertions, 1);
});

test('worktreeDiff: dirty (uncommitted) tracked file is non-null', async (t) => {
  const { wtDir, headSha } = fixture(t);
  fs.writeFileSync(path.join(wtDir, 'base.txt'), 'changed\n');
  const diff = await worktreeDiff('feature', wtDir, headSha);
  assert.ok(diff.uncommitted !== null);
  assert.match(diff.uncommitted as string, /base\.txt/);
});

test('worktreeDiff: uncommitted includes an untracked-files summary', async (t) => {
  const { wtDir, headSha } = fixture(t);
  fs.writeFileSync(path.join(wtDir, 'scratch.txt'), 'new stuff\n');
  const diff = await worktreeDiff('feature', wtDir, headSha);
  assert.ok(diff.uncommitted !== null);
  assert.match(diff.uncommitted as string, /scratch\.txt/);
});

test('worktreeDiff: statOnly populates stat but leaves committed/uncommitted null', async (t) => {
  const { wtDir, headSha } = fixture(t);
  fs.writeFileSync(path.join(wtDir, 'new.txt'), 'stuff\n');
  git(wtDir, ['add', '.']);
  git(wtDir, ['commit', '-q', '-m', 'add new.txt']);
  const diff = await worktreeDiff('feature', wtDir, headSha, { statOnly: true });
  assert.equal(diff.committed, null);
  assert.equal(diff.uncommitted, null);
  assert.equal(diff.stat.files, 1);
  assert.equal(diff.files[0].path, 'new.txt');
});

test('worktreeDiff: a rename is reported as a single R entry, not split', async (t) => {
  const { wtDir, headSha } = fixture(t);
  git(wtDir, ['mv', 'base.txt', 'renamed.txt']);
  fs.appendFileSync(path.join(wtDir, 'renamed.txt'), 'more\n');
  git(wtDir, ['add', '.']);
  git(wtDir, ['commit', '-q', '-m', 'rename base.txt']);
  const diff = await worktreeDiff('feature', wtDir, headSha);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].path, 'renamed.txt');
  assert.equal(diff.files[0].status, 'R');
});

test('worktreeDiff: paths filter narrows the diff to matching files', async (t) => {
  const { wtDir, headSha } = fixture(t);
  fs.writeFileSync(path.join(wtDir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(wtDir, 'b.txt'), 'b\n');
  git(wtDir, ['add', '.']);
  git(wtDir, ['commit', '-q', '-m', 'add a and b']);
  const diff = await worktreeDiff('feature', wtDir, headSha, { paths: ['a.txt'] });
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].path, 'a.txt');
});

test('cwdDiff: reports name (cwd), base HEAD, and non-null uncommitted on a dirty repo', async (t) => {
  const { repoDir } = fixture(t);
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'dirty in cwd\n');
  const diff = await cwdDiff(repoDir);
  assert.equal(diff.name, '(cwd)');
  assert.equal(diff.base, 'HEAD');
  assert.equal(diff.committed, null);
  assert.ok(diff.uncommitted !== null);
  assert.match(diff.uncommitted as string, /base\.txt/);
});

test('cwdDiff: clean repo has null uncommitted', async (t) => {
  const { repoDir } = fixture(t);
  const diff = await cwdDiff(repoDir);
  assert.equal(diff.uncommitted, null);
});

test('removeWorktree deletes the worktree directory', async (t) => {
  const { repoDir, wtDir } = fixture(t);
  assert.ok(fs.existsSync(wtDir));
  await removeWorktree(repoDir, wtDir);
  assert.equal(fs.existsSync(wtDir), false);
});
