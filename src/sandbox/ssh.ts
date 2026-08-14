// ssh.ts — persistent SSH sessions over OpenSSH ControlMaster/ControlPersist.
//
// The `elpis.ssh` global surface. Each `elpis.ssh(host)` returns a HANDLE bound
// to one host; `.exec(cmd)` runs a command over a SINGLE multiplexed ssh
// connection instead of re-handshaking every call (which is what
// `elpis.sh("ssh host '...'")` does — slow, and env/PATH is lost between calls).
//
// Reuse is delegated to ssh itself: every exec passes
// `-o ControlMaster=auto -o ControlPath=<socket> -o ControlPersist=10m`, so the
// first exec establishes the master and subsequent execs (and a fresh handle to
// the same host+user) reuse it. No new npm deps — we shell out like `elpis.sh`.
// ControlPersist gives natural expiry (the master self-closes after 10m idle);
// `handle.close` and `registry.dispose` tear it down eagerly on shutdown.
//
// The result shape mirrors `elpis.sh` (`{ stdout, stderr, code, signal }`) plus
// `host`, so the agent's existing `.code`-checking habit transfers directly.
// The control-path + argv construction is split into PURE exported helpers so
// it can be unit-tested without a live ssh (CI has no network).

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { slugify } from '../lib/slug.js';

/** The shape returned by `elpis.ssh(host).exec(cmd)` — same as `elpis.sh` plus `host`. */
export interface SshResult {
  host: string;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
}

export interface SshExecOpts {
  /** Per-exec timeout in ms (default 60s). Mirrors `elpis.sh`'s timeout. */
  timeout?: number;
  /** Per-stream byte cap (default 32MB, same as `elpis.sh`'s SH_MAX_BUFFER). */
  maxBuffer?: number;
}

export interface SshHandle {
  /** The host this handle is bound to. */
  host: string;
  /** The ControlPath socket backing this connection (stable for host+user). */
  controlPath: string;
  /** Run a command on the remote host over the multiplexed connection.
 * Returns `{ stdout, stderr, code, signal, host }` — never throws on a
 * nonzero exit; check `.code`. */
  exec(cmd: string, opts?: SshExecOpts): Promise<SshResult>;
  /** Tear down the ssh ControlMaster for this host (best-effort). Subsequent
 * execs re-establish it. */
  close(): Promise<{ ok: boolean; note: string }>;
}

export interface SshRegistryOpts {
  /** Override the socket directory (tests). Defaults to <dataDir>/.ssh-sockets/. */
  socketDir?: string;
  /** Override the ssh binary (tests). Defaults to 'ssh'. */
  sshBinary?: string;
  /** ControlPersist idle lifetime. Defaults to '10m'. */
  controlPersist?: string;
  /** Track a spawned child against the current run's scope so a bg detach can
 * kill the ssh process tree. globals.ts passes a runScope-backed impl;
 * returns an unregister fn. Omit → no tracking. */
  trackChild?: (pid: number) => () => void;
}

/** Max bytes accumulated per stdout/stderr stream before truncation. Matches
 * `elpis.sh`'s SH_MAX_BUFFER so a runaway remote command can't OOM the harness. */
export const SSH_MAX_BUFFER = 32 * 1024 * 1024;

const DEFAULT_TIMEOUT = 60_000;
const DEFAULT_PERSIST = '10m';

/** Slugify an ssh target (host or user@host) into a filesystem-safe control-socket
 * name component. Collapses runs of non-alnum to a single dash, trims edges.
 * Pure + unit-tested. */
export function slugifyHost(host: string): string {
  return slugify(host, 'host');
}

/** Derive the ControlPath socket for a host. Stable for a given (host, user, dir)
 * so two handles to the same target share ONE master — that's the whole point.
 * Pure + unit-tested (no fs, no network). */
export function controlPath(
  host: string,
  opts: { socketDir: string; user?: string } = { socketDir: '' },
): string {
  const u = opts.user ? `${slugifyHost(opts.user)}-` : '';
  return path.join(opts.socketDir, `elpis-ssh-${u}${slugifyHost(host)}`);
}

/** Build the OpenSSH option list applied to EVERY exec (the reuse enabler).
 * `ControlMaster=auto` establishes a master on the first connect if none exists
 * and reuses one if it does; `ControlPath` selects the socket; `ControlPersist`
 * keeps the master alive `persist` of idle time after the last exec detaches.
 * `BatchMode=yes` disables password/interactive prompts (key-based auth only) so
 * a missing key surfaces as a nonzero exit + stderr, not an indefinite tty hang. */
export function controlOpts(controlPathStr: string, persist: string): string[] {
  return [
    '-o', 'ControlMaster=auto',
    '-o', `ControlPath=${controlPathStr}`,
    '-o', `ControlPersist=${persist}`,
    '-o', 'BatchMode=yes',
  ];
}

/** Build the full argv for an `ssh ... host -- cmd` exec. PURE + unit-tested.
 * argv-array spawn, never `shell:true` (the harness-wide rule from fleet/git). */
export function execArgv(
  binary: string,
  host: string,
  cmd: string,
  opts: { controlPath: string; persist: string; user?: string } = { controlPath: '', persist: DEFAULT_PERSIST },
): string[] {
  const target = opts.user ? `${opts.user}@${host}` : host;
  return [binary, ...controlOpts(opts.controlPath, opts.persist), target, '--', cmd];
}

/** Build the argv to tear down a master: `ssh -O exit -o ControlPath=... target`. PURE. */
export function closeArgv(
  binary: string,
  host: string,
  controlPathStr: string,
  user?: string,
): string[] {
  const target = user ? `${user}@${host}` : host;
  return [binary, '-O', 'exit', '-o', `ControlPath=${controlPathStr}`, target];
}

export interface SshRegistry {
  /** Get (or lazily create) a handle bound to `host` (optionally `user@host`).
 * Deduped by control-path so two calls for the same target share one master. */
  open(host: string, opts?: { user?: string }): SshHandle;
  /** Tear down every live master this registry created (best-effort). Called on
 * harness shutdown so ControlPersist sockets don't linger. */
  dispose(): Promise<void>;
}

export function createSshRegistry(dataDirectory: string, opts?: SshRegistryOpts): SshRegistry {
  const socketDir = opts?.socketDir ?? path.join(dataDirectory, '.ssh-sockets');
  fs.mkdirSync(socketDir, { recursive: true });
  const sshBinary = opts?.sshBinary ?? 'ssh';
  const persist = opts?.controlPersist ?? DEFAULT_PERSIST;
  const trackChild = opts?.trackChild;
 // Track live handles so dispose can close every master we opened. A Map keyed
 // by control-path dedupes: two `elpis.ssh(host)` calls share one handle (and
 // thus one master), so the agent can hold a handle in a top-level const and
 // reuse it across run calls.
  const handles = new Map<string, SshHandle>();

  /** The shared exec implementation. Mirrors `elpis.sh`'s shape: spawn detached,
 * cap each stream at maxBuffer, resolve with a TIMEOUT signal on overrun, and
 * NEVER throw — the caller checks `.code`. */
  function exec(cmd: string, host: string, cp: string, user: string | undefined, o: SshExecOpts = {}): Promise<SshResult> {
    const timeoutMs = o.timeout ?? DEFAULT_TIMEOUT;
    const maxBuffer = o.maxBuffer ?? SSH_MAX_BUFFER;
    const argv = execArgv(sshBinary, host, cmd, { controlPath: cp, persist, user });
    const { promise, resolve } = Promise.withResolvers<SshResult>();
    const child = spawn(argv[0]!, argv.slice(1), { detached: true });
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, sig); return; } catch { /* group gone */ } }
      try { child.kill(sig); } catch { /* already gone */ }
    };
    let stdout = '';
    let stderr = '';
    let stdoutTrunc = false;
    let stderrTrunc = false;
    let done = false;
    const appendCapped = (cur: string, chunk: string, trunc: boolean): [string, boolean] => {
      if (trunc) return [cur, true];
      if (cur.length + chunk.length <= maxBuffer) return [cur + chunk, false];
      return [cur + chunk.slice(0, Math.max(0, maxBuffer - cur.length)) + `\n[output truncated at ${maxBuffer} bytes]`, true];
    };
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
        killTimer.unref?.();
        resolve({ host, stdout, stderr: stderr + `\n[elpis.ssh TIMED OUT after ${timeoutMs}ms — output above is partial]`, code: null, signal: 'TIMEOUT' });
      }
    }, timeoutMs);
 // Track against the current run's scope so a bg detach / bg.cancel can
 // kill this ssh's process tree, exactly like `elpis.sh` children.
    const unregister = child.pid && trackChild ? trackChild(child.pid) : undefined;
    child.stdout?.on('data', (d: Buffer) => { [stdout, stdoutTrunc] = appendCapped(stdout, d.toString('utf8'), stdoutTrunc); });
    child.stderr?.on('data', (d: Buffer) => { [stderr, stderrTrunc] = appendCapped(stderr, d.toString('utf8'), stderrTrunc); });
    child.on('error', (err) => {
      if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
      if (!done) {
        done = true; clearTimeout(timer); unregister?.();
 // ssh binary missing / spawn failure — surface as a nonzero exit, not a
 // throw, matching the "never throws" contract the agent expects.
        resolve({ host, stdout: '', stderr: `ssh spawn failed: ${err.message}`, code: 127, signal: null });
      }
    });
    child.on('close', (code, signal) => {
      if (killTimer) { clearTimeout(killTimer); killTimer = undefined; }
      if (!done) { done = true; clearTimeout(timer); unregister?.(); resolve({ host, stdout, stderr, code, signal: signal ?? null }); }
    });
    return promise;
  }

  function makeHandle(host: string, user?: string): SshHandle {
    const cp = controlPath(host, { socketDir, user });
    return {
      host,
      controlPath: cp,
      exec: (cmd: string, o?: SshExecOpts) => exec(cmd, host, cp, user, o),
      close: async () => {
        const argv = closeArgv(sshBinary, host, cp, user);
        const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: 'ignore' });
 // `ssh -O exit` exits promptly; resolve once it closes.
        return new Promise<{ ok: boolean; note: string }>((r) => {
          child.on('error', () => r({ ok: false, note: `close failed for ${host} (ssh not found)` }));
          child.on('close', (code) => r({ ok: code === 0, note: `control master closed for ${host} (exit ${code})` }));
          child.unref();
        });
      },
    };
  }

  return {
    open(host: string, opts?: { user?: string }) {
      const user = opts?.user;
      const key = controlPath(host, { socketDir, user });
      let h = handles.get(key);
      if (!h) { h = makeHandle(host, user); handles.set(key, h); }
      return h;
    },
    async dispose() {
      const hs = Array.from(handles.values());
      handles.clear();
      await Promise.all(hs.map((h) => h.close().catch(() => {})));
    },
  };
}
