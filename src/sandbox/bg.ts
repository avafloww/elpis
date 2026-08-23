// bg.ts — background jobs: detached subprocesses that survive a harness
// restart and can be tailed mid-flight. The `bg` global surface (A3).
//
// Jobs are `spawn(cmd, { shell: true, detached: true, stdio -> logFile })` so
// the process group outlives the harness and its stdout+stderr land in a log
// file under DATA_DIRECTORY/elpis-data/bg/<id>.log from the start (a spawn-time property
// that cannot be retrofitted onto a piped child). The registry is a JSON file
// in the same dir so `bg.list` after a reboot still finds running jobs and
// reports their status via `process.kill(pid, 0)` probing.
//
// A5's detach-to-future path registers into the SAME registry (futures have
// kind 'future'; jobs have kind 'job') so `bg.list` shows both uniformly.

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previewValue } from './preview.js';
import { isPidAlive, killTree } from '../lib/proc.js';
import { resolveDataLayout } from '../store/data-layout.js';

export interface BgJob {
  id: string;
  kind: 'job' | 'future';
  cmd?: string;
  src?: string;
  pid?: number;
  logFile?: string;
  startedAt: number;
  running: boolean;
  exitCode?: number | null;
  signal?: string | null;
  /** For futures: the settled value (retrievable via bg.get). */
  value?: unknown;
  /** For futures: whether it rejected (vs resolved). */
  rejected?: boolean;
  /** Abandoned TTL timestamp (futures only). */
  ttlAt?: number;
  /** Channel in which this work began. Jobs retain it for wake provenance;
   * futures use it for abandon notices. */
  originChannelId?: string;
  /** Job lifecycle timestamps. Persisted so restart recovery neither loses nor
   * repeats the five-minute and completion notices. */
  nudgeAt?: number;
  nudgeNotifiedAt?: number;
  finishedAt?: number;
  settleNotifiedAt?: number;
  /** Cancelled by the agent — a future ignores late settle; a job reports the
   * cancellation as its terminal state. */
  cancelled?: boolean;
}

export interface BgStartOpts {
  cwd?: string;
  /** Env overrides for the child. */
  env?: Record<string, string>;
  /** Internal provenance captured by elpis.bg.start from the active inbound. */
  originChannelId?: string;
}

export interface BgRegistry {
  /** Start a detached job. Returns { id, pid, logFile }. */
  start(
    cmd: string,
    opts?: BgStartOpts,
  ): { id: string; pid: number; logFile: string };
  /** List all jobs + futures (running and recently settled). */
  list(): BgJob[];
  /** Get detail for one entry (including a settled future's value). */
  get(id: string): BgJob | undefined;
  /** Tail the last N lines of a job's log (default 50). */
  tail(id: string, lines?: number): string;
  /** Cancel: kill the child process tree (jobs) or drop the reference (futures). */
  cancel(id: string): { ok: boolean; note: string };
  /** Register a detached future (used by A5's detach path). Returns the id.
   * `childPids` is the run's LIVE child-pid set: the future adopts it so
   * cancel/reap can kill sh/sudo children the detached run is still driving. */
  registerFuture(
    src: string,
    promise: Promise<unknown>,
    opts?: {
      ttlMs?: number;
      childPids?: Set<number>;
      originChannelId?: string;
    },
  ): string;
  /** Mark a future settled (called by A5 when a detached promise resolves).
   * Returns false if the future was cancelled or is gone — the caller must NOT
   * then deliver a settle notice. */
  settleFuture(id: string, value: unknown, rejected: boolean): boolean;
  /** Drop abandoned futures past their TTL. Returns ids dropped. */
  reapAbandoned(): string[];
  /** Observe future cancellation/TTL abandonment. Normal settlement uses settleFuture. */
  onFutureTerminal(
    listener: (id: string, outcome: 'cancelled' | 'abandoned') => void,
  ): () => void;
  /** Activate job lifecycle delivery after the Agent exists. Recovered jobs are
   * reconciled here; safe and idempotent. */
  activate(): void;
  /** Move the next still-running heartbeat (epoch ms). Defaults to one normal
   * interval from now and remains auto-rearming afterward. */
  rearm(id: string, at?: number): BgJob;
  /** Stop the background TTL reaper and job timers. For clean test teardown. */
  dispose(): void;
}

export interface BgRegistryOpts {
  /** Delivered when a future is abandoned past its TTL by the periodic reaper
   *, through the same path as settle notices. */
  onAbandoned?: (id: string, value: unknown, originChannelId: string) => void;
  /** Auto-rearming job heartbeat and terminal notice. Tail is bounded. */
  onJobStillRunning?: (job: BgJob, tail: string) => void;
  onJobSettled?: (job: BgJob, tail: string) => void;
  /** Delay before a one-time still-running wake. Default five minutes. */
  jobNudgeMs?: number;
  /** TTL-reaper interval (ms). Default 60s. */
  reapIntervalMs?: number;
}

export function createBgRegistry(
  dataDirectory: string,
  opts?: BgRegistryOpts,
): BgRegistry {
  const jobNudgeMs: number = opts?.jobNudgeMs ?? 5 * 60_000;
  const bgDir = resolveDataLayout(dataDirectory).bg;
  const registryFile = path.join(bgDir, 'registry.json');
  // In-memory map (the source of truth for live state; the file is the
  // restart-recovery view). On creation we load the file so post-reboot
  // bg.list sees prior jobs.
  const jobs = new Map<string, BgJob>();
  // Live child handles for jobs (so cancel can kill the tree).
  const children = new Map<string, ChildProcess>();
  const jobTimers = new Map<string, NodeJS.Timeout>();
  let jobDeliveryActive = false;
  // Live future references (so cancel can drop them; a promise itself can't
  // be cancelled, but its effects — a spawned child — can be killed if any).
  // childPids is the run's LIVE set (shared reference with the run scope), so it
  // reflects children spawned/exited AFTER detach, not just at detach time.
  const futures = new Map<
    string,
    { promise: Promise<unknown>; childPids: Set<number> }
  >();
  const futureTerminalListeners = new Set<
    (id: string, outcome: 'cancelled' | 'abandoned') => void
  >();

  fs.mkdirSync(bgDir, { recursive: true });
  loadRegistry();

  function loadRegistry(): void {
    try {
      const raw = fs.readFileSync(registryFile, 'utf8');
      const arr = JSON.parse(raw) as BgJob[];
      const now = Date.now();
      for (const j of arr) {
        // Re-probe running state for jobs. Pre-feature completed records are
        // grandfathered as already notified; a record that was running when
        // persisted but died while the harness was down remains pending.
        if (j.kind === 'job' && j.pid) {
          const wasRunning = j.running;
          j.running = isPidAlive(j.pid);
          if (!j.running) {
            if (j.exitCode === undefined) j.exitCode = null;
            j.finishedAt ??= now;
            if (!wasRunning && j.settleNotifiedAt === undefined)
              j.settleNotifiedAt = now;
          }
          j.nudgeAt ??= j.startedAt + jobNudgeMs;
        } else if (j.kind === 'future') {
          // futures don't survive a restart (the promise died with the process).
          if (j.running) {
            j.running = false;
            j.rejected = true;
            j.value = '[process restarted — future lost]';
          }
        }
        jobs.set(j.id, j);
      }
    } catch {
      /* no registry yet */
    }
  }

  function saveRegistry(): void {
    // Cap `value` payloads in the persisted file: keep full values in memory
    // (retrievable via bg.get) but write only a short preview to disk so the
    // registry file doesn't bloat with large settled-future payloads on every
    // start/exit/settle/cancel.
    const arr = Array.from(jobs.values())
      .slice(-50)
      .map((j) => {
        if (j.value === undefined) return j;
        return { ...j, value: previewValue(j.value, 200) };
      });
    try {
      fs.writeFileSync(registryFile, JSON.stringify(arr, null, 2));
    } catch {
      /* best-effort */
    }
  }

  let counter = 0;
  function nextId(prefix: string): string {
    counter++;
    return `${prefix}${Date.now().toString(36)}${counter}`;
  }

  function start(
    cmd: string,
    opts?: BgStartOpts,
  ): { id: string; pid: number; logFile: string } {
    const id = nextId('j');
    const logFile = path.join(bgDir, `${id}.log`);
    const fd = fs.openSync(logFile, 'w');
    const child = spawn(cmd, {
      shell: true,
      detached: true,
      stdio: ['ignore', fd, fd],
      cwd: opts?.cwd,
      env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    });
    fs.closeSync(fd);
    children.set(id, child);
    const startedAt = Date.now();
    const job: BgJob = {
      id,
      kind: 'job',
      cmd,
      pid: child.pid ?? undefined,
      logFile,
      startedAt,
      running: true,
      originChannelId: opts?.originChannelId,
      nudgeAt: startedAt + jobNudgeMs,
    };
    jobs.set(id, job);
    child.on('exit', (code, signal) => {
      const j = jobs.get(id);
      if (j) finishJob(j, code, signal);
      children.delete(id);
    });
    child.on('error', () => {
      const j = jobs.get(id);
      if (j) finishJob(j, 1, null);
      children.delete(id);
    });
    child.unref();
    saveRegistry();
    if (jobDeliveryActive) scheduleJobNudge(job);
    return { id, pid: child.pid ?? 0, logFile };
  }

  function list(): BgJob[] {
    // Re-probe running state for jobs on each list (cheap process.kill probes).
    // Hoist saveRegistry out of the loop: collect dead ids, save once at end.
    let changed = false;
    for (const j of jobs.values()) {
      if (j.kind === 'job' && j.pid && j.running && !isPidAlive(j.pid)) {
        finishJob(j, null, j.signal ?? null);
        changed = true;
      }
    }
    if (changed) saveRegistry();
    return Array.from(jobs.values());
  }

  function get(id: string): BgJob | undefined {
    const j = jobs.get(id);
    if (j && j.kind === 'job' && j.pid && j.running && !isPidAlive(j.pid)) {
      finishJob(j, null, j.signal ?? null);
    }
    return j;
  }

  function tail(id: string, lines = 50): string {
    const j = jobs.get(id);
    if (!j) return `no job ${id}`;
    if (!j.logFile) {
      // A detached future has no log file of its own (it isn't a spawned
      // process) — distinguish "no output yet, it's still going" from an
      // unknown id, and "no output because it already settled" from that.
      const state = j.running === false ? 'settled' : 'running';
      return `job ${id} (${j.kind}, ${state}) — no captured log yet (a detached future has no log file; check elpis.bg.list() or the settle notice)`;
    }
    try {
      // Read only the last ~64KB from the end of the file instead of the
      // whole thing into memory — log files can grow large for long-running jobs.
      const stat = fs.statSync(j.logFile);
      const CHUNK = 65536;
      const readSize = Math.min(stat.size, CHUNK);
      const fd = fs.openSync(j.logFile, 'r');
      try {
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
        const content = buf.toString('utf8');
        const all = content.split('\n');
        // If we read from the middle of the file, the first "line" is partial — drop it.
        const start = readSize < stat.size ? 1 : 0;
        return all.slice(Math.max(start, all.length - lines)).join('\n');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return `(empty log for ${id})`;
    }
  }

  function clearJobTimer(id: string): void {
    const timer = jobTimers.get(id);
    if (timer) clearTimeout(timer);
    jobTimers.delete(id);
  }

  function boundedTail(id: string): string {
    const value = tail(id, 20).trim();
    return value.length > 4000 ? value.slice(-4000) : value;
  }

  function notifyJobStillRunning(job: BgJob): void {
    if (!jobDeliveryActive || !job.running) return;
    const now = Date.now();
    job.nudgeNotifiedAt = now;
    job.nudgeAt = now + jobNudgeMs;
    saveRegistry();
    try {
      opts?.onJobStillRunning?.({ ...job }, boundedTail(job.id));
    } catch {
      /* notice is best-effort */
    }
    scheduleJobNudge(job);
  }

  function notifyJobSettled(job: BgJob): void {
    if (!jobDeliveryActive || job.running || job.settleNotifiedAt != null)
      return;
    job.settleNotifiedAt = Date.now();
    saveRegistry();
    try {
      opts?.onJobSettled?.({ ...job }, boundedTail(job.id));
    } catch {
      /* notice is best-effort */
    }
  }

  function scheduleJobNudge(job: BgJob): void {
    clearJobTimer(job.id);
    if (!jobDeliveryActive || !job.running) return;
    const at = job.nudgeAt ?? job.startedAt + jobNudgeMs;
    job.nudgeAt = at;
    // Node clamps delays above signed 32-bit milliseconds to 1ms. Chunk a long
    // absolute deadline instead, then recheck the current persisted target—this
    // also makes a manual rearm safe if an older timer callback was already due.
    const maxTimerMs = 2_147_000_000;
    const delay = Math.min(maxTimerMs, Math.max(0, at - Date.now()));
    const timer = setTimeout(() => {
      jobTimers.delete(job.id);
      if ((job.nudgeAt ?? 0) > Date.now()) {
        scheduleJobNudge(job);
        return;
      }
      if (job.pid && !isPidAlive(job.pid))
        finishJob(job, null, job.signal ?? null);
      else notifyJobStillRunning(job);
    }, delay);
    timer.unref?.();
    jobTimers.set(job.id, timer);
  }

  function finishJob(
    job: BgJob,
    code: number | null,
    signal: string | null,
  ): void {
    const firstFinish = job.finishedAt == null;
    job.running = false;
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt ??= Date.now();
    clearJobTimer(job.id);
    saveRegistry();
    if (firstFinish) notifyJobSettled(job);
  }

  function rearm(id: string, at = Date.now() + jobNudgeMs): BgJob {
    const job = jobs.get(id);
    if (!job || job.kind !== 'job') throw new Error(`no background job ${id}`);
    if (!job.running) throw new Error(`background job ${id} is not running`);
    if (!Number.isFinite(at))
      throw new Error('rearm time must be a finite epoch timestamp');
    job.nudgeAt = at;
    saveRegistry();
    if (jobDeliveryActive) scheduleJobNudge(job);
    return { ...job };
  }

  function activate(): void {
    if (jobDeliveryActive) return;
    jobDeliveryActive = true;
    for (const job of jobs.values()) {
      if (job.kind !== 'job') continue;
      if (job.running && job.pid && !isPidAlive(job.pid))
        finishJob(job, null, job.signal ?? null);
      else if (job.running) scheduleJobNudge(job);
      else notifyJobSettled(job);
    }
  }

  function cancel(id: string): { ok: boolean; note: string } {
    const j = jobs.get(id);
    if (!j) return { ok: false, note: `no job ${id}` };
    if (j.kind === 'job' && j.pid) {
      j.cancelled = true;
      killTree(j.pid);
      finishJob(j, null, 'SIGTERM');
      children.delete(id);
    } else if (j.kind === 'future') {
      const f = futures.get(id);
      if (f) for (const pid of f.childPids) killTree(pid);
      futures.delete(id);
      j.running = false;
      //: mark so a later settlement of the (uncancellable) promise is
      // ignored — no record overwrite, no spurious [bg settled] notice.
      j.cancelled = true;
      for (const listener of futureTerminalListeners) {
        try {
          listener(id, 'cancelled');
        } catch {
          /* lifecycle observers are best-effort */
        }
      }
    }
    saveRegistry();
    return { ok: true, note: `cancelled ${id}` };
  }

  function registerFuture(
    src: string,
    promise: Promise<unknown>,
    opts?: {
      ttlMs?: number;
      childPids?: Set<number>;
      originChannelId?: string;
    },
  ): string {
    const id = nextId('f');
    const ttl = opts?.ttlMs ?? 30 * 60 * 1000;
    const job: BgJob = {
      id,
      kind: 'future',
      src,
      startedAt: Date.now(),
      running: true,
      ttlAt: Date.now() + ttl,
      originChannelId: opts?.originChannelId,
    };
    jobs.set(id, job);
    futures.set(id, { promise, childPids: opts?.childPids ?? new Set() });
    saveRegistry();
    return id;
  }

  function settleFuture(
    id: string,
    value: unknown,
    rejected: boolean,
  ): boolean {
    const j = jobs.get(id);
    //: a cancelled (or already-gone) future is not overwritten and its
    // caller must not deliver a settle notice.
    if (!j || j.cancelled) return false;
    j.running = false;
    j.value = value;
    j.rejected = rejected;
    // Delete the in-memory future reference so the promise + captured scope
    // can be GC'd. The settled value stays in `jobs` (retrievable via bg.get)
    // until reapAbandoned caps total entries.
    futures.delete(id);
    saveRegistry();
    // Reap abandoned futures + cap entries now rather than waiting for an
    // external caller (reapAbandoned was previously never called at runtime,
    // leaking every detached promise for the process lifetime).
    reapAbandoned();
    return true;
  }

  function reapAbandoned(): string[] {
    const now = Date.now();
    const dropped: string[] = [];
    for (const [id, j] of jobs) {
      if (
        j.kind === 'future' &&
        j.running &&
        !j.cancelled &&
        j.ttlAt &&
        j.ttlAt <= now
      ) {
        const f = futures.get(id);
        if (f) for (const pid of f.childPids) killTree(pid);
        futures.delete(id);
        j.running = false;
        j.rejected = true;
        j.value = '[abandoned after TTL]';
        dropped.push(id);
        for (const listener of futureTerminalListeners) {
          try {
            listener(id, 'abandoned');
          } catch {
            /* lifecycle observers are best-effort */
          }
        }
        //: deliver an abandon notice through the same path as settle notices
        // so the agent learns the future will never arrive.
        opts?.onAbandoned?.(id, j.value, j.originChannelId ?? '');
      }
    }
    // Cap total entries: evict oldest abandoned silently.
    if (jobs.size > 20) {
      const abandoned = Array.from(jobs.values())
        .filter((j) => !j.running)
        .sort((a, b) => a.startedAt - b.startedAt);
      while (jobs.size > 20 && abandoned.length > 0) {
        const old = abandoned.shift()!;
        jobs.delete(old.id);
      }
    }
    if (dropped.length > 0) saveRegistry();
    return dropped;
  }

  //: an unref'd periodic reaper so TTL-expired futures are abandoned (and
  // their notice delivered) even when no other future settles to trigger the
  // inline reap. unref'd so it never keeps the process alive.
  const reaper = setInterval(() => {
    reapAbandoned();
  }, opts?.reapIntervalMs ?? 60_000);
  reaper.unref?.();

  function onFutureTerminal(
    listener: (id: string, outcome: 'cancelled' | 'abandoned') => void,
  ): () => void {
    futureTerminalListeners.add(listener);
    return () => {
      futureTerminalListeners.delete(listener);
    };
  }

  function dispose(): void {
    clearInterval(reaper);
    for (const timer of jobTimers.values()) clearTimeout(timer);
    jobTimers.clear();
    futureTerminalListeners.clear();
  }

  return {
    start,
    list,
    get,
    tail,
    cancel,
    registerFuture,
    settleFuture,
    reapAbandoned,
    onFutureTerminal,
    activate,
    rearm,
    dispose,
  };
}
