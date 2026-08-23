import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensurePrivateDir } from './store.js';

export interface DockerLimits {
  memoryMb?: number;
  cpus?: number;
  pids?: number;
  timeoutMs?: number;
}
export interface DockerEpisodeOptions {
  image: string;
  workDir: string;
  resultDir: string;
  clockFile: string;
  name: string;
  limits?: DockerLimits;
}

function assertAbsoluteSafe(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root)
    throw new Error(`${label} cannot be a filesystem root`);
  return resolved;
}

export function dockerRunArgs(opts: DockerEpisodeOptions): string[] {
  const work = assertAbsoluteSafe(opts.workDir, 'workDir');
  const results = assertAbsoluteSafe(opts.resultDir, 'resultDir');
  const clock = assertAbsoluteSafe(opts.clockFile, 'clockFile');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 65532;
  const gid = typeof process.getgid === 'function' ? process.getgid() : 65532;
  const limits = opts.limits ?? {};
  return [
    'run',
    '--rm',
    '--interactive',
    '--name',
    opts.name,
    '--read-only',
    '--network',
    'none',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    `${uid}:${gid}`,
    '--pids-limit',
    String(limits.pids ?? 128),
    '--memory',
    `${limits.memoryMb ?? 1024}m`,
    '--cpus',
    String(limits.cpus ?? 1),
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=128m',
    // Bind mounts are read-write by default. `rw` is valid with `-v` but is
    // not a standalone field in Docker's stricter `--mount` grammar.
    '--mount',
    `type=bind,src=${work},dst=/home/agent/data`,
    '--mount',
    `type=bind,src=${results},dst=/run/elpis-state`,
    '--mount',
    `type=bind,src=${clock},dst=/run/elpis-clock,readonly`,
    '--env',
    'FAKETIME_TIMESTAMP_FILE=/run/elpis-clock',
    '--env',
    'FAKETIME_NO_CACHE=1',
    // Node/libuv requires a genuinely monotonic timer source. Only wall-clock
    // APIs should observe benchmark clock jumps.
    '--env',
    'FAKETIME_DONT_FAKE_MONOTONIC=1',
    opts.image,
  ];
}

export function prepareEpisodeMounts(
  workDir: string,
  resultDir: string,
  clockFile: string,
  initialClock = new Date(),
): void {
  ensurePrivateDir(assertAbsoluteSafe(workDir, 'workDir'));
  ensurePrivateDir(assertAbsoluteSafe(resultDir, 'resultDir'));
  ensurePrivateDir(path.dirname(assertAbsoluteSafe(clockFile, 'clockFile')));
  fs.writeFileSync(clockFile, `${formatFaketime(initialClock)}\n`, {
    mode: 0o600,
  });
}

function formatFaketime(value: Date): string {
  // libfaketime's timestamp-file grammar uses the same absolute-time string as
  // FAKETIME itself. The container runs in UTC, so this is unambiguous.
  return `@${value
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '')}`;
}

export function advanceClockFile(clockFile: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0 || ms > 14 * 24 * 60 * 60 * 1000)
    throw new Error('clock advance must be between 0 and 14 days');
  const raw = fs.readFileSync(clockFile, 'utf8').trim();
  const parsed = /^@(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(raw);
  const timestamp = parsed
    ? Date.parse(`${parsed[1]}T${parsed[2]}Z`)
    : Number.NaN;
  if (!Number.isFinite(timestamp))
    throw new Error('invalid benchmark clock file');
  fs.writeFileSync(clockFile, `${formatFaketime(new Date(timestamp + ms))}\n`, {
    mode: 0o600,
  });
}

export function startEpisodeContainer(
  opts: DockerEpisodeOptions,
): ChildProcessWithoutNullStreams {
  return spawn('docker', dockerRunArgs(opts), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });
}

export async function removeContainer(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn('docker', ['rm', '-f', name], { stdio: 'ignore' });
    child.once('exit', () => resolve());
    child.once('error', () => resolve());
  });
}

export async function withContainerTimeout<T>(
  child: ChildProcessWithoutNullStreams,
  name: string,
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`episode timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
    if (!child.killed) child.kill('SIGTERM');
    await removeContainer(name);
  }
}
