// proc.ts — tiny shared child-process helpers. One home for the spawn-collect
// idiom and the process-group teardown that bg jobs, worker episodes, and the
// heartbeat digest all need — the copies had already started to drift (EPERM
// handling) before they were consolidated here.

import { spawn } from 'node:child_process';

/** Spawn a command and resolve with its stdout (empty on any error/close).
 * Async so callers on the event loop (heartbeat digest probes, console git
 * info) never block the way spawnSync would. */
export function spawnText(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args);
      let out = '';
      child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
      child.on('error', () => resolve(''));
      child.on('close', () => resolve(out));
    } catch { resolve(''); }
  });
}

/** Best-effort SIGTERM the process group then the process, escalating to
 * SIGKILL of the group after a 2s grace window. Detached children are spawned
 * as process-group leaders, so `-pid` reaches their whole tree. The escalation
 * timer is unref'd — it must never hold the harness open on shutdown. */
export function killTree(pid: number): void {
  try { process.kill(-pid, 'SIGTERM'); } catch { /* group may not exist */ }
  try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 2000).unref();
}

/** True when `pid` is a live process. EPERM counts as alive: the signal-0 probe
 * failing on permissions still proves a process owns the pid. */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
