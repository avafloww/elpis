import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { WorkerWorkspaceSource } from './client.js';

const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 60_000;

interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

function bounded(value: Buffer): string {
  return value.toString('utf8').trim().slice(0, 500) || 'no diagnostic';
}

function emptyDirectory(directory: string): void {
  if (!fs.existsSync(directory))
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.statSync(directory).isDirectory())
    throw new Error('worker workspace must be a directory');
  if (fs.readdirSync(directory).length !== 0)
    throw new Error('worker workspace must be empty before source checkout');
}

function verifySource(source: WorkerWorkspaceSource): void {
  const sha256 = createHash('sha256').update(source.data).digest('hex');
  if (
    !/^[0-9a-f]{40,64}$/.test(source.revision) ||
    !/^[0-9a-f]{64}$/.test(source.sha256) ||
    !Number.isSafeInteger(source.sizeBytes) ||
    source.sizeBytes < 0 ||
    source.data.length !== source.sizeBytes ||
    sha256 !== source.sha256
  )
    throw new Error('worker source archive failed verification');
}

async function command(
  binary: string,
  args: string[],
  options: { cwd?: string; allow?: number[] } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: os.tmpdir(),
        LC_ALL: 'C',
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error(`worker workspace command timed out: ${binary}`)),
      COMMAND_TIMEOUT_MS,
    );
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_COMMAND_OUTPUT)
        fail(
          new Error(`worker workspace command output is too large: ${binary}`),
        );
      else stdout.push(bytes);
    });
    child.stderr.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stderrBytes += bytes.length;
      if (stderrBytes > MAX_COMMAND_OUTPUT)
        fail(
          new Error(
            `worker workspace command diagnostic is too large: ${binary}`,
          ),
        );
      else stderr.push(bytes);
    });
    child.once('error', fail);
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (!(options.allow ?? [0]).includes(result.code)) {
        reject(
          new Error(
            `worker workspace command failed (${binary}, ${result.code}): ${bounded(result.stderr)}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function extractSource(
  source: WorkerWorkspaceSource,
  destination: string,
  scratch: string,
): Promise<void> {
  verifySource(source);
  emptyDirectory(destination);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const archive = path.join(scratch, 'source.tar.gz');
  fs.writeFileSync(archive, source.data, { mode: 0o600 });
  try {
    const listing = await command('tar', ['-tzf', archive]);
    const paths = listing.stdout.toString('utf8').split('\n').filter(Boolean);
    if (
      paths.some((entry) => {
        const normalized = path.posix.normalize(entry);
        return (
          entry.includes('\0') ||
          path.posix.isAbsolute(entry) ||
          normalized === '..' ||
          normalized.startsWith('../') ||
          normalized === '.git' ||
          normalized.startsWith('.git/')
        );
      })
    )
      throw new Error('worker source archive contains an unsafe path');
    const verbose = await command('tar', ['-tvzf', archive]);
    const unsafeType = verbose.stdout
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .find((line) => line[0] !== '-' && line[0] !== 'd');
    if (unsafeType)
      throw new Error('worker source archive contains a non-file entry');
    await command('tar', [
      '-xzf',
      archive,
      '--no-same-owner',
      '--no-same-permissions',
      '-C',
      destination,
    ]);
  } finally {
    fs.rmSync(archive, { force: true });
  }
}

export async function checkoutWorkerSource(
  source: WorkerWorkspaceSource,
  workspace: string,
  scratchRoot: string,
): Promise<void> {
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'elpis-checkout-'));
  try {
    await extractSource(source, workspace, scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export async function createWorkerPatch(
  source: WorkerWorkspaceSource,
  workspace: string,
  scratchRoot: string,
): Promise<Buffer> {
  const scratch = fs.mkdtempSync(path.join(scratchRoot, 'elpis-patch-'));
  const baseline = path.join(scratch, 'baseline');
  fs.mkdirSync(baseline, { mode: 0o700 });
  try {
    await extractSource(source, baseline, path.join(scratch, 'archive'));
    await command('git', ['init', '-q'], { cwd: baseline });
    await command('git', ['add', '-A'], { cwd: baseline });
    await command(
      'git',
      [
        '-c',
        'user.name=Elpis Worker Baseline',
        '-c',
        'user.email=worker@invalid',
        '-c',
        'core.hooksPath=/dev/null',
        'commit',
        '-qm',
        `baseline ${source.revision}`,
      ],
      { cwd: baseline },
    );
    const gitDirectory = path.join(baseline, '.git');
    const common = [
      `--git-dir=${gitDirectory}`,
      `--work-tree=${workspace}`,
      '-c',
      'core.hooksPath=/dev/null',
    ];
    await command('git', [...common, 'add', '-A']);
    const patch = await command('git', [
      ...common,
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      'HEAD',
      '--',
    ]);
    return gzipSync(patch.stdout, { level: 9 });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
