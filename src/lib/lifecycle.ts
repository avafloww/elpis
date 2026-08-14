// lifecycle.ts — the harness's own systemd identity. The unit name and the
// detached restart spawn live here so `elpis.restart`/`elpis.deploy`, the
// /restart slash command, the heartbeat's uptime probe, and the restart-recovery
// heuristic all agree on ONE incantation instead of four hand-copied ones.

import { spawn, type ChildProcess } from 'node:child_process';

/** The systemd user unit the harness runs as. */
export const SERVICE_UNIT = 'elpis-harness';

/** Spawn `systemctl --user restart <unit>` detached so it survives this
 * process's own SIGTERM. Returns the child so callers can attach error
 * logging; it is already unref'd. */
export function restartHarnessService(): ChildProcess {
  const child = spawn('systemctl', ['--user', 'restart', SERVICE_UNIT],
    { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}
