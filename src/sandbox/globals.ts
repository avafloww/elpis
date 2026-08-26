// globals.ts — injected tools, consolidated under the `elpis` namespace.
// Every harness verb becomes a property of `elpis`, so the agent writes
// `elpis.sh("whoami")`, not a bare `sh(...)` and not `tools.sh(...)`. Functions
// injected as real references work in-process with zero marshaling — the
// whole reason we stayed in `node:vm`. `elpis` itself is deep-frozen: neither
// the namespace object nor any of its members can be reassigned or clobbered.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as editor from '../lib/editor.js';
import { fill } from '../lib/fill.js';
import { preview } from './preview.js';
import {
  RUN_OPERATION_COMMAND_MAX_BYTES,
  RUN_OPERATION_ERROR_MAX_BYTES,
  RUN_OPERATION_RECEIPT_MAX_COUNT,
  RUN_OPERATION_STREAM_MAX_BYTES,
  type RunOperationReceipt,
} from './metadata.js';

import { createStalenessTracker } from './esm-staleness.js';
import type { SandboxDeps } from '../types.js';
import { isMindId, type MindId } from '../store/mind-id.js';
import type { BgStartOpts } from './bg.js';
import { INTERNAL_CHANNEL_ID } from '../types.js';
import type { Config } from '../config.js';
import {
  resolveBuiltinModules,
  type BuiltinModuleId,
} from '../builtin-modules.js';
import { parseFrontmatter } from '../lib/frontmatter.js';
import { appendDatedBullet, writePrivateFileAtomic } from '../store/memory.js';
import { clearResumeMarker, writeResumeMarker } from '../store/resume.js';
import { requestRestrictedRestart } from '../lib/restart-request.js';
import { restartHarnessService } from '../lib/lifecycle.js';
import { slugifyName, authorHasPeopleFile } from './people.js';
import { formatRead } from './read.js';
import { kagiSearch, kagiExtract } from './web.js';
import { extractChatGptShare, isChatGptShareUrl } from './chatgpt-share.js';
import { createBrowserTools } from './browser.js';
import { createComputerTools, displayShellCommand } from './computer.js';
import { createMotorController } from './motor.js';
import {
  bskyPost,
  bskyFeed,
  bskyNotifications,
  bskyReply,
  bskyLike,
  bskyFollow,
  bskyTimeline,
} from './bsky.js';
import type { SshRegistry, SshHandle } from './ssh.js';
import { resolveDataLayout } from '../store/data-layout.js';
import { parseMindId } from '../store/mind.js';

// ─── Per-run scope (A5 / / ) ─────────────────────────────────────────
// Each run(code) call establishes its OWN scope via AsyncLocalStorage so that
// console.log writes to that run's buffer and sh/sudo children are tracked
// against that run — even across awaits and even after the run detaches into a
// bg future (the async continuations inherit the store). This replaces the old
// deps.logbuf save/swap/restore dance, which was non-reentrant (two concurrent
// runs shared one buffer) and leaked a detached run's post-detach logs into the
// NEXT run. `childPids` is a LIVE set: sh/sudo add on spawn and remove on exit,
// so a detach can adopt the currently-live children (bg.cancel / TTL reap kill
// the tree).
export type RunProcessErrorKind = 'unhandledRejection' | 'uncaughtException';
export interface RunScope {
  logbuf: string[];
  childPids: Set<number>;
  sends: { channel: string; text: string }[];
  operationReceipts: RunOperationReceipt[];
  operationReceiptsDropped: number;
  processError?: (kind: RunProcessErrorKind, error: unknown) => boolean;
}
export const runScope = new AsyncLocalStorage<RunScope>();

export function routeRunProcessError(
  kind: RunProcessErrorKind,
  error: unknown,
): boolean {
  const handler = runScope.getStore()?.processError;
  if (!handler) return false;
  try {
    return handler(kind, error);
  } catch {
    return false;
  }
}

/** Max bytes accumulated per sh/sudo stream before truncation. Matches
 * the old spawnSync maxBuffer (per-stream). Overridable via opts.maxBuffer for
 * tests. Beyond the cap we stop growing the buffer but let the process run. */
export const SH_MAX_BUFFER = 32 * 1024 * 1024;

type RunOperationDescriptor = Pick<
  RunOperationReceipt,
  'kind' | 'name' | 'command'
>;

function boundedReceiptText(
  value: string,
  maxBytes: number,
): {
  text: string;
  bytes: number;
  truncated: boolean;
} {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes)
    return { text: value, bytes: bytes.length, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    text: bytes.subarray(0, end).toString('utf8'),
    bytes: bytes.length,
    truncated: true,
  };
}

function beginOperationReceipt(
  descriptor: RunOperationDescriptor | undefined,
): RunOperationReceipt | undefined {
  const scope = runScope.getStore();
  if (!scope || !descriptor) return undefined;
  if (scope.operationReceipts.length >= RUN_OPERATION_RECEIPT_MAX_COUNT) {
    scope.operationReceiptsDropped++;
    return undefined;
  }
  const command = boundedReceiptText(
    descriptor.command,
    RUN_OPERATION_COMMAND_MAX_BYTES,
  );
  const receipt: RunOperationReceipt = {
    sequence: scope.operationReceipts.length,
    kind: descriptor.kind,
    name: descriptor.name,
    command: command.text,
    commandBytes: command.bytes,
    commandTruncated: command.truncated || undefined,
    state: 'running',
    startedAt: Date.now(),
  };
  scope.operationReceipts.push(receipt);
  return receipt;
}

function completeOperationReceipt(
  receipt: RunOperationReceipt | undefined,
  result: {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
  },
  source?: {
    stdoutBytes?: number;
    stderrBytes?: number;
    stdoutTruncated?: boolean;
    stderrTruncated?: boolean;
  },
): void {
  if (!receipt) return;
  const stdout = boundedReceiptText(
    result.stdout,
    RUN_OPERATION_STREAM_MAX_BYTES,
  );
  const stderr = boundedReceiptText(
    result.stderr,
    RUN_OPERATION_STREAM_MAX_BYTES,
  );
  receipt.state = 'completed';
  receipt.durationMs = Math.max(0, Date.now() - receipt.startedAt);
  receipt.ok = result.code === 0 && result.signal === null;
  receipt.code = result.code;
  receipt.signal = result.signal;
  if (stdout.text) receipt.stdout = stdout.text;
  if (stderr.text) receipt.stderr = stderr.text;
  receipt.stdoutBytes = source?.stdoutBytes ?? stdout.bytes;
  receipt.stderrBytes = source?.stderrBytes ?? stderr.bytes;
  receipt.stdoutTruncated =
    source?.stdoutTruncated || stdout.truncated || undefined;
  receipt.stderrTruncated =
    source?.stderrTruncated || stderr.truncated || undefined;
}

function failOperationReceipt(
  receipt: RunOperationReceipt | undefined,
  error: unknown,
): void {
  if (!receipt) return;
  const message = boundedReceiptText(
    error instanceof Error ? error.message : String(error),
    RUN_OPERATION_ERROR_MAX_BYTES,
  );
  receipt.state = 'failed';
  receipt.durationMs = Math.max(0, Date.now() - receipt.startedAt);
  receipt.ok = false;
  receipt.error = message.text;
}

// require rooted at the harness module: resolves `node:` builtins and any npm
// package installed alongside the harness. The VM context IS the sandbox
// boundary, so the agent gets real fs/crypto/http access in-process instead of
// round-tripping through `sh("cat ...")`. sh/sudo already grant full-machine
// passwordless spawnSync, so this adds reach without adding blast radius.
const baseRequire = createRequire(import.meta.url);
// Auto-fresh require for LOCAL FILE paths (relative/absolute): bust the module
// cache before delegating, so an edited on-disk helper (.cjs the agent just
// rewrote) is re-read. Bare specifiers (node: builtins, node_modules) stay
// cached — no package-singleton breakage, no heavy re-init. Trade-off: a helper
// that holds module-level state across calls loses it on re-require (fine for
// scratch helpers; use files or Mind for durable state).
// The cache-bust below is a no-op for ES modules (this package is
// `"type": "module"`, so all of dist/ is ESM and require routes through the
// ESM loader, whose map require.cache does not index). We cannot evict that
// map, so the tracker warns when a re-required ESM file has changed on disk —
// otherwise the process silently keeps serving the first version it loaded.
const staleness = createStalenessTracker();
const require_ = Object.assign(function requireFresh(id: string): unknown {
  if (id.startsWith('.') || id.startsWith('/')) {
    let resolved: string | null = null;
    try {
      resolved = baseRequire.resolve(id);
    } catch {
      /* real error below */
    }
    if (resolved) {
      delete baseRequire.cache[resolved];
      const warning = staleness.check(resolved);
      // Must land in the RUN's logbuf, not process stdout — a warning the agent
      // cannot see is the same silence it was written to break. (Caught only by
      // live verification: the unit tests covered the tracker, not delivery.)
      if (warning) {
        const buf = runScope.getStore()?.logbuf;
        if (buf) buf.push('[warn] ' + warning);
        else console.warn(warning);
      }
    }
  }
  return baseRequire(id);
}, baseRequire) as NodeJS.Require;

// ─── Reserved harness-global names ───────────────────────────────────────────
// The renamed harness verbs (sh, sudo, channel, memory, …, ssh, …) now live
// ONLY on the `elpis` namespace object. Their bare names are
// free for the agent to use as ordinary variables. (No hand-count asserted here —
// the set is enumerated in the `globals.ts` source-map row in AGENTS.md and in
// docs/sandbox.md, and grows over time.)
// Reserved: `elpis` itself, the other bare survivors (`_`, `console`, `fs`), the
// full JS/Node builtin tier, AND the SCREAMING_CASE path constants
// (`HARNESS_ROOT`, `DATA_DIR`). Top-level declarations binding one of THESE
// names would silently, permanently clobber the harness helper (the transform
// rewrites every top-level decl into a `globalThis.<name> =` assignment, so a
// `const elpis = ...` would REPLACE the whole namespace with no error).
// transform.ts rejects such declarations at pre-parse time with a clear,
// teachable message. Keep this list in sync with `buildGlobals`.
export const RESERVED_GLOBALS: Readonly<Record<string, true>> = {
  elpis: true,
  fs: true,
  _: true,
  console: true,
  process: true,
  require: true,
  Buffer: true,
  URL: true,
  URLSearchParams: true,
  TextEncoder: true,
  TextDecoder: true,
  fetch: true,
  btoa: true,
  atob: true,
  crypto: true,
  Object: true,
  Array: true,
  JSON: true,
  Math: true,
  Date: true,
  Promise: true,
  RegExp: true,
  Map: true,
  Set: true,
  Error: true,
  Symbol: true,
  Number: true,
  String: true,
  Boolean: true,
  structuredClone: true,
  parseInt: true,
  parseFloat: true,
  isNaN: true,
  isFinite: true,
  setTimeout: true,
  clearTimeout: true,
  setInterval: true,
  clearInterval: true,
  queueMicrotask: true,
  globalThis: true,
  HARNESS_ROOT: true,
  DATA_DIR: true,
};

// Deep-freeze an object graph: freezes `o` and recurses into every OWN,
// value-holding property (functions included — a frozen function can't gain
// stray properties either). Accessor properties (getters, like the live
// `inbound`) are skipped entirely — freezing the object doesn't touch them,
// and recursing into a getter's return would snapshot a live value and break
// liveness. Guards against cycles via `Object.isFrozen`.
function deepFreeze(o: unknown): void {
  if (o === null || (typeof o !== 'object' && typeof o !== 'function')) return;
  if (Object.isFrozen(o)) return;
  Object.freeze(o);
  for (const k of Object.getOwnPropertyNames(o)) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (d && 'value' in d) deepFreeze(d.value);
  }
}

function safeInspect(v: unknown): string {
  // minimal inspect: prefer preview's bounded stringification
  try {
    return preview(v, 1024);
  } catch {
    return String(v);
  }
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  return safeInspect(a);
}

/** Coerce a schedule nextRunAt (epoch-ms | ISO string | Date) to finite epoch-ms, or throw. */
export function coerceNextRunAt(v: unknown): number {
  if (v instanceof Date) v = v.getTime();
  if (typeof v === 'string') v = Date.parse(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(
      `elpis.schedule: nextRunAt must be finite epoch-ms, an ISO-8601 string, or a Date (got ${JSON.stringify(v)})`,
    );
  }
  return v;
}

export function createRunLogger(
  fallback: string[],
): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    const buf = runScope.getStore()?.logbuf ?? fallback;
    buf.push(args.map(fmtArg).join(' '));
  };
}

export function buildGlobals(deps: SandboxDeps): Record<string, unknown> {
  const g: Record<string, unknown> = {};
  // Every harness verb is built onto `e`, then deep-frozen and hung off
  // `g.elpis` at the end of this function — see the deepFreeze call below.
  const e: Record<string, unknown> = {};
  const modules =
    deps.modules ?? resolveBuiltinModules(deps.config as unknown as Config);
  const profile = deps.profile ?? {
    restricted: false,
    source: 'normal' as const,
  };
  const unavailableFunction =
    (key: string, reason: string) =>
    async (..._args: unknown[]) => {
      throw new Error(`elpis.${key}: unavailable — ${reason}`);
    };
  const unavailableObject = (key: string, reason: string) =>
    new Proxy(Object.freeze({}), {
      get(_target, property) {
        if (property === Symbol.toStringTag) return 'UnavailableModule';
        return unavailableFunction(`${key}.${String(property)}`, reason);
      },
    });
  const installUnavailableModule = (id: BuiltinModuleId) => {
    if (modules.state(id) !== 'unavailable') return;
    const reason = modules.reason(id) ?? `${id} module is unavailable`;
    for (const key of modules.statuses.find((status) => status.id === id)
      ?.keys ?? []) {
      e[key] =
        id === 'kagi'
          ? unavailableFunction(key, reason)
          : unavailableObject(key, reason);
    }
  };

  // Protect a bare reserved global from silent clobbering: plain assignment
  // (`elpis = 5`, which the transform does NOT rewrite) throws instead of
  // replacing the helper. The transform catches re-declarations (the common
  // path) at pre-parse; this is the belt-and-braces for raw assignment.
  const protect = (key: string) => {
    const desc = Object.getOwnPropertyDescriptor(g, key);
    // Accessor properties on `g` (none currently — the live `elpis.inbound`
    // getter lives on `e`, not `g`) must not be replaced with a frozen static
    // value — that would snapshot the getter's current return and break
    // liveness. A getter-only property already rejects plain assignment in
    // strict mode, so it needs no extra protection.
    if (desc?.get) return;
    const v = g[key];
    if (v === undefined) return;
    Object.defineProperty(g, key, {
      value: v,
      writable: false,
      configurable: false,
    });
  };

  // Persistent full sandboxes retain the last completion value. Fresh core
  // sandboxes deliberately have no `_` global or cross-run last-value state.
  if (deps.surface !== 'core') g._ = undefined;

  // inbound — structured metadata for the Discord message currently being
  // processed (or null on heartbeats). A LIVE getter over deps.inbound (the
  // agent publishes ctx.lastInbound via setCurrentInbound each turn), so the
  // agent always reads the current message, not a boot-time snapshot. Restored
  // after the A6 rework dropped it while prompt.ts + RESERVED_GLOBALS still
  // referenced it (agents got a ReferenceError and couldn't even shadow it).
  // Lives on `e` (elpis.inbound). It stays configurable only until the surface
  // projection can omit it; deepFreeze seals retained accessors before exposure.
  Object.defineProperty(e, 'inbound', {
    get: () => deps.inbound ?? null,
    enumerable: true,
    configurable: true,
  });

  // console capture → the CURRENT run's buffer. Reads runScope so each
  // run(code) writes to its own buffer end-to-end (reentrant; a detached run's
  // post-detach logs land in ITS buffer, not the next run's). Falls back to
  // deps.logbuf for any log emitted outside a run (belt-and-braces; shouldn't
  // happen). Returns undefined (not the buffer length) so a run ending in
  // console.log(...) does NOT clobber `_` with a meaningless number.
  const makeLog = () => createRunLogger(deps.logbuf);
  g.console = {
    log: makeLog(),
    error: makeLog(),
    warn: makeLog(),
    info: makeLog(),
  };

  // shell — ASYNC-FIRST (A5). sh/sudo return a Promise<{stdout, stderr,
  // code, signal}> with the same shape as before, now non-blocking so the
  // event loop (Discord gateway, typing indicator, other channels) stays alive.
  // sh.async/sudo.async are deleted (no alias — the short name IS the async one).
  //
  // The promise is wrapped in a Proxy with property traps: accessing .stdout /
  // .stderr / .code / .signal on an UN-awaited promise throws immediately with a
  // teachable error, so the agent's ingrained `sh(...).stdout` habit breaks
  // loudly on the first offending turn instead of silently yielding undefined.
  // then/catch/finally pass through so `await` and Promise.all work normally.
  type ShResult = {
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
  };
  async function shImpl(
    cmd: string,
    opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
    descriptor?: RunOperationDescriptor,
  ): Promise<ShResult> {
    const timeoutMs = opts.timeout ?? 60_000;
    const maxBuffer = opts.maxBuffer ?? SH_MAX_BUFFER;
    const { promise, resolve, reject } = Promise.withResolvers<ShResult>();
    const receipt = beginOperationReceipt(descriptor);
    // detached: true puts the shell in its OWN process group so a timeout can
    // signal the whole tree (grandchildren the shell spawned), not just the
    // direct shell. Killing -pid targets the group.
    let child;
    try {
      child = spawn(cmd, { shell: true, cwd: opts.cwd, detached: true });
    } catch (error) {
      failOperationReceipt(receipt, error);
      throw error;
    }
    // Kill the child's process group, falling back to the child itself if the
    // group signal fails (pid gone / no group).
    const killGroup = (sig: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch {
          /* group gone */
        }
      }
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    // Register this child against the current run's scope so a detach can
    // adopt it and bg.cancel / TTL reap can kill the tree. Removed on exit so a
    // reused pid is never killed by mistake.
    const scope = runScope.getStore();
    if (scope && child.pid) scope.childPids.add(child.pid);
    const unregister = () => {
      if (scope && child.pid) scope.childPids.delete(child.pid);
    };
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTrunc = false;
    let stderrTrunc = false;
    let done = false;
    // Bound each stream at maxBuffer: the sync→async migration dropped
    // the old spawnSync maxBuffer, so `stdout += d` grew unbounded — multi-GB
    // output OOM-killed the harness. Past the cap we stop accumulating (keep the
    // process running) and note the truncation once.
    const appendCapped = (
      cur: string,
      chunk: string,
      trunc: boolean,
    ): [string, boolean] => {
      if (trunc) return [cur, true];
      if (cur.length + chunk.length <= maxBuffer) return [cur + chunk, false];
      return [
        cur +
          chunk.slice(0, Math.max(0, maxBuffer - cur.length)) +
          `\n[output truncated at ${maxBuffer} bytes]`,
        true,
      ];
    };
    // SIGKILL escalation timer, armed on timeout and cleared when the child
    // actually closes: the old code never cleared it, so it lingered
    // (holding the event loop) after the SIGTERM already reaped the tree.
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        unregister();
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
        killTimer.unref?.();
        // resolve with TIMEOUT signal + partial output (matches the contract
        // of "never throws"; the agent checks .signal/.code). Append a visible
        // marker to stderr too: an agent that only inspects .stdout otherwise
        // sees empty output and can't tell timeout from silence.
        const result = {
          stdout,
          stderr:
            stderr +
            `\n[elpis.sh TIMED OUT after ${timeoutMs}ms — output above is partial]`,
          code: null,
          signal: 'TIMEOUT',
        };
        completeOperationReceipt(receipt, result, {
          stdoutBytes,
          stderrBytes,
          stdoutTruncated: stdoutTrunc,
          stderrTruncated: stderrTrunc,
        });
        resolve(result);
      }
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      [stdout, stdoutTrunc] = appendCapped(
        stdout,
        d.toString('utf8'),
        stdoutTrunc,
      );
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBytes += d.length;
      [stderr, stderrTrunc] = appendCapped(
        stderr,
        d.toString('utf8'),
        stderrTrunc,
      );
    });
    child.on('error', (err) => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (!done) {
        done = true;
        clearTimeout(timer);
        unregister();
        failOperationReceipt(receipt, err);
        reject(err);
      }
    });
    child.on('close', (code, signal) => {
      // Clear the escalation timer regardless of `done` — the child may close
      // after a timeout-triggered SIGTERM but before the 5s SIGKILL fires.
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
      if (!done) {
        done = true;
        clearTimeout(timer);
        unregister();
        const result = { stdout, stderr, code, signal: signal ?? null };
        completeOperationReceipt(receipt, result, {
          stdoutBytes,
          stderrBytes,
          stdoutTruncated: stdoutTrunc,
          stderrTruncated: stderrTrunc,
        });
        resolve(result);
      }
    });
    return promise;
  }

  const SH_RESULT_KEYS = new Set(['stdout', 'stderr', 'code', 'signal']);
  /** Wrap a sh promise so property access on the un-awaited promise throws a
   * teachable error. then/catch/finally pass through. */
  function guardShPromise(
    p: Promise<ShResult>,
    name: string,
  ): Promise<ShResult> {
    return new Proxy(p, {
      get(target, prop, recv) {
        // Promise internals (then, catch, finally) must be bound to the TARGET
        // promise, not the proxy, or `await`/Promise.all throw "called on
        // incompatible receiver". Bind them; pass everything else through.
        if (
          typeof prop === 'string' &&
          (prop === 'then' || prop === 'catch' || prop === 'finally')
        ) {
          const fn = Reflect.get(target, prop, target);
          return typeof fn === 'function' ? fn.bind(target) : fn;
        }
        if (typeof prop !== 'string') {
          return Reflect.get(target, prop, recv);
        }
        if (SH_RESULT_KEYS.has(prop)) {
          throw new TypeError(
            `${name}() is now async — write (await ${name}(...)).${prop} (you forgot to await)`,
          );
        }
        return Reflect.get(target, prop, recv);
      },
    }) as Promise<ShResult>;
  }

  const sh = ((
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) =>
    guardShPromise(
      shImpl(cmd, opts, { kind: 'shell', name: 'sh', command: cmd }),
      'elpis.sh',
    )) as ((
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) => Promise<ShResult>) & { q: (s: unknown) => string };
  // sh.q(value) — POSIX single-quote a value for safe embedding in a shell
  // command: elpis.sh(`grep -n ${elpis.sh.q(pattern)} file`). Handles embedded
  // quotes, spaces, $, backticks — the hand-counted-backslash dance this
  // replaces cost the agent a dozen turns in one observed session.
  sh.q = (s: unknown) => `'${String(s).replace(/'/g, "'\\''")}'`;
  e.sh = sh;
  const sudo = (
    cmd: string,
    opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
  ) =>
    guardShPromise(
      shImpl(`sudo ${cmd}`, opts, {
        kind: 'shell',
        name: 'sudo',
        command: cmd,
      }),
      'elpis.sudo',
    );
  if (!profile.restricted) e.sudo = sudo;

  // grep(pattern, opts?) — recursive text search, defaulting to the harness
  // src/ tree. Replaces the fs.readFileSync + indexOf probing the agent fell
  // back to when tracing a symbol across files. Returns the raw `file:line:text`
  // hits as a string (preview renders it raw), or a "no matches" note.
  // elpis.grep("createSandbox") // src/ by default
  // elpis.grep("TODO", { path: DATA_DIR, glob: "*.md" })
  // elpis.grep("channel(", { fixed: true, ignoreCase: true, max: 50 })
  e.grep = async (
    pattern: string,
    opts: {
      path?: string;
      glob?: string;
      ignoreCase?: boolean;
      fixed?: boolean;
      max?: number;
    } = {},
  ) => {
    if (typeof pattern !== 'string' || pattern === '') {
      throw new Error(
        'grep(pattern, opts?): pattern must be a non-empty string',
      );
    }
    const where = opts.path ?? path.join(deps.config.paths.harnessRoot, 'src');
    const flags = ['-rn', '--color=never'];
    if (opts.ignoreCase) flags.push('-i');
    // Extended regex by default: a bare `|` in BRE is a literal, which made
    // alternation patterns silently report "no matches" (-08-03 #20).
    if (!opts.fixed) flags.push('-E');
    if (opts.fixed) flags.push('-F');
    if (opts.glob) flags.push(`--include=${sh.q(opts.glob)}`);
    const max = Number.isFinite(opts.max)
      ? Math.max(1, Math.floor(opts.max as number))
      : 200;
    const cmd = `grep ${flags.join(' ')} -e ${sh.q(pattern)} ${sh.q(where)} 2>/dev/null | head -n ${max}`;
    const receipt = beginOperationReceipt({
      kind: 'file',
      name: 'grep',
      command: `${pattern} · ${where}`,
    });
    try {
      const r = await shImpl(cmd, {
        cwd: deps.config.paths.harnessRoot,
        timeout: 30_000,
      });
      const hits = r.stdout.trimEnd();
      const out = hits
        ? hits
        : `grep: no matches for ${JSON.stringify(pattern)} in ${where}`;
      completeOperationReceipt(receipt, {
        stdout: out,
        stderr: r.stderr,
        code: r.code,
        signal: r.signal,
      });
      return out;
    } catch (error) {
      failOperationReceipt(receipt, error);
      throw error;
    }
  };

  // ssh — persistent remote sessions over OpenSSH ControlMaster/ControlPersist.
  // `elpis.ssh(host)` returns a handle whose `.exec(cmd)` runs over ONE reused
  // ssh connection (no per-call handshake, env/PATH persists across calls),
  // replacing the slow `elpis.sh("ssh host '...'")` pattern. Same `{stdout,
  // stderr, code, signal}` shape as `elpis.sh` (plus `host`); never throws on a
  // nonzero exit. Defined unconditionally: when deps.ssh is absent the global
  // surfaces a clear 'ssh not wired' error instead of `elpis.ssh` being
  // undefined. trackChild wires spawned ssh into the
  // current run's scope so a bg detach can kill the tree, matching shImpl.
  const requireSsh = (): SshRegistry => {
    if (!deps.ssh)
      throw new Error(
        'ssh not wired — the harness did not construct an ssh registry',
      );
    return deps.ssh;
  };
  e.ssh = (host: string, opts?: { user?: string }): SshHandle => {
    if (typeof host !== 'string' || host === '') {
      throw new Error(
        'elpis.ssh(host): host must be a non-empty string — e.g. elpis.ssh("ai.example.com").exec("uptime")',
      );
    }
    return requireSsh().open(host, opts);
  };

  // filesystem global so the agent stops re-importing fs in every script
  g.fs = fs;

  // edit — the ONE self-editing verb. Claude-Code-Edit semantics: exact
  // substring match, unique-or-throw unless { replaceAll: true }, throws (with a
  // near-miss window) on not-found — never a silent no-op. The JS sandbox is the
  // batching mechanism: call elpis.edit several times in one run to change
  // multiple sites or files; each call is its own atomic read-modify-write.
  const DIFF_EDGE = 12;
  const renderEditDiff = (p: string, hunks: editor.EditHunk[]): string => {
    const rows: string[] = [];
    for (const h of hunks) {
      rows.push(
        `${p} @@ -${h.from},${h.removed.length} +${h.from},${h.inserted.length} @@`,
      );
      const emit = (sign: '-' | '+', ls: string[]) => {
        const tag = (i: number) =>
          `${sign}${String(h.from + i).padStart(4)}: ${ls[i]}`;
        if (ls.length <= DIFF_EDGE * 2 + 1) {
          for (let i = 0; i < ls.length; i++) rows.push(tag(i));
        } else {
          for (let i = 0; i < DIFF_EDGE; i++) rows.push(tag(i));
          rows.push(`${sign}      … (${ls.length - DIFF_EDGE * 2} more lines)`);
          for (let i = ls.length - DIFF_EDGE; i < ls.length; i++)
            rows.push(tag(i));
        }
      };
      emit('-', h.removed);
      emit('+', h.inserted);
    }
    return rows.join('\n');
  };
  e.edit = (
    p: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean },
  ) => {
    const src = fs.readFileSync(p, 'utf8');
    const r = editor.replace(src, oldString, newString, {
      all: opts?.replaceAll,
    }); // throws BEFORE any write
    fs.writeFileSync(p, r.source);
    return {
      ok: true as const,
      path: p,
      replacements: r.count,
      diff: renderEditDiff(p, r.hunks),
    };
  };

  // fill — opt-in {{key}} substitution into a (usually heredoc-carried) template.
  // Heredocs stay raw; fill is the separate, explicit way to inject a value.
  e.fill = (template: string, vars: Record<string, unknown>) =>
    fill(template, vars);

  // memory helpers (thin wrappers over memory.ts)
  e.memory = {
    read: () => deps.memory.read(),
    append: (text: string) => deps.memory.append(text),
    write: (text: string) => deps.memory.overwrite(text),
  };
  e.remember = (text: string) => deps.memory.append(text); // ergonomic alias

  // read(path, opts?) — line-numbered file reading, the agent's most common
  // op. Returns a string with the path, line count, and numbered lines so it
  // drops straight into context (the full value also lands in `_`). Avoids the
  // hand-written split/map/pad/join/console.log incantation every time.
  e.read = (
    p: string,
    opts: { from?: number; to?: number; numbers?: boolean } = {},
  ) => {
    const receipt = beginOperationReceipt({
      kind: 'file',
      name: 'read',
      command: p,
    });
    try {
      const out = formatRead(
        p,
        fs.readFileSync(p, 'utf8'),
        opts,
        deps.config.sandbox.previewMaxBytes,
      );
      completeOperationReceipt(receipt, {
        stdout: out,
        stderr: '',
        code: 0,
        signal: null,
      });
      // Tee into the run's log buffer: only the run's FINAL value is previewed,
      // so a read assigned to a variable used to vanish from view entirely.
      (runScope.getStore()?.logbuf ?? deps.logbuf).push(out);
      return out;
    } catch (error) {
      failOperationReceipt(receipt, error);
      throw error;
    }
  };

  // ponder/ — open questions / thinking-in-progress, one file per thread.
  // ponder(thread, text) appends a dated bullet to ponder/<thread>.md (creates
  // it with the first line as the seed question if new). ponder.close(thread,
  // conclusion?) archives the file to ponder/resolved/. Reading and
  // restructuring stay plain fs/read.
  const ponderDir = path.join(deps.config.paths.dataDirectory, 'ponder');
  const ponderResolvedDir = path.join(ponderDir, 'resolved');
  const ponderFn = ((thread: string, text: string) => {
    fs.mkdirSync(ponderDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(ponderDir, 0o700);
    // Slugify the thread name so `ponder('../SOUL',...)` can't escape the
    // ponder dir and `design/api` doesn't ENOENT on a missing subdir. Same
    // mapping as people/<slug>.md.
    const slug = slugifyName(thread);
    const file = path.join(ponderDir, `${slug}.md`);
    const stamp = new Date().toISOString().slice(0, 10);
    // New thread: first line is the seed question, then a (thread opened) bullet.
    // Existing thread: append a dated bullet. One existence probe — no
    // dead read; appendDatedBullet does its own single read+write.
    if (fs.existsSync(file)) {
      appendDatedBullet(file, text, stamp);
    } else {
      writePrivateFileAtomic(file, `${text}\n- [${stamp}] (thread opened)\n`);
    }
    return { ok: true, thread, file };
  }) as ((
    thread: string,
    text: string,
  ) => { ok: true; thread: string; file: string }) & {
    close: (
      thread: string,
      conclusion?: string,
    ) => { ok: true; thread: string; archivedTo?: string };
  };
  ponderFn.close = (thread: string, conclusion?: string) => {
    const slug = slugifyName(thread);
    const file = path.join(ponderDir, `${slug}.md`);
    fs.mkdirSync(ponderResolvedDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(ponderResolvedDir, 0o700);
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { ok: true, thread };
    }
    if (conclusion) {
      // Append the resolution bullet to the body before archiving.
      const stamp = new Date().toISOString().slice(0, 10);
      body =
        body.replace(/\n*$/, '') + `\n- [${stamp}] (resolved) ${conclusion}\n`;
    }
    // Collision-safe: never clobber an existing resolved/<slug>.md —
    // append -2, -3… when a same-named thread was resolved before.
    let dest = path.join(ponderResolvedDir, `${slug}.md`);
    for (let n = 2; fs.existsSync(dest); n++) {
      dest = path.join(ponderResolvedDir, `${slug}-${n}.md`);
    }
    writePrivateFileAtomic(dest, body);
    try {
      fs.unlinkSync(file);
    } catch {
      /* already moved */
    }
    return { ok: true, thread, archivedTo: dest };
  };
  e.ponder = ponderFn;

  // bg — background jobs + futures (A3). Deliberate detached subprocesses that
  // survive a restart and can be tailed mid-flight, plus the registry A5's
  // detach path registers pending promises into.
  if (deps.bg) {
    const bgReg = deps.bg;
    e.bg = {
      start: (cmd: string, opts?: BgStartOpts) =>
        bgReg.start(cmd, {
          ...opts,
          originChannelId: deps.inbound?.channelId ?? opts?.originChannelId,
        }),
      list: () => bgReg.list(),
      get: (id: string) => bgReg.get(id),
      tail: (id: string, lines?: number) => bgReg.tail(id, lines),
      rearm: (id: string, when?: unknown) =>
        bgReg.rearm(id, when === undefined ? undefined : coerceNextRunAt(when)),
      cancel: (id: string) => bgReg.cancel(id),
    };
  }

  // memory.person(name, text) — append a dated bullet to people/<name>.md,
  // creating it with a frontmatter stub (ids pre-filled from inbound when the
  // author has no file yet). General, non-person facts use remember.
  const peopleDir = path.join(deps.config.paths.dataDirectory, 'people');
  const personFn = (name: string, text: string) => {
    fs.mkdirSync(peopleDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(peopleDir, 0o700);
    const slug = slugifyName(name);
    const file = path.join(peopleDir, `${slug}.md`);
    // Ensure frontmatter stub exists for a new person.
    try {
      fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Pre-fill ids ONLY when this new file plausibly belongs to the current
      // inbound author: the slug matches the author's own name AND that author
      // has no people/ file yet. Without both guards,
      // Writing a file for somebody other than the current speaker must not
      // stamp the speaker's Discord id onto it — durable identity corruption.
      const authorId = deps.inbound?.authorId;
      const isAuthorFile =
        !!authorId &&
        slug === slugifyName(deps.inbound!.author) &&
        !authorHasPeopleFile(peopleDir, authorId);
      const ids = isAuthorFile ? `ids: [discord:${authorId}]` : 'ids: []';
      writePrivateFileAtomic(file, `---\nname: ${name}\n${ids}\n---\n\n`);
    }
    appendDatedBullet(file, text);
    return { ok: true, name, file };
  };
  (e.memory as Record<string, unknown>).person = personFn;

  // memory.search(pattern) — one query across the whole brain: MEMORY.md,
  // NOW.md, SOUL.md, people/, ponder/ (+resolved), notes/. Replaces the
  // hand-rolled sh("grep -rn ...") the agent reached for every time it needed
  // to find a fact. Strings match case-insensitively; pass a RegExp for
  // control. Returns [{ file, line, text }] capped at `limit` (default 50).
  (e.memory as Record<string, unknown>).search = (
    pattern: string | RegExp,
    opts: { limit?: number } = {},
  ) => {
    const limit = opts.limit ?? 50;
    const re =
      typeof pattern === 'string'
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
        : pattern;
    const dataDir = deps.config.paths.dataDirectory;
    // MEMORY.md / SOUL.md always live at the data-dir root (config.ts derives
    // both from DATA_DIRECTORY; there is no separate path knob).
    const roots: string[] = [
      path.join(dataDir, 'MEMORY.md'),
      path.join(dataDir, 'NOW.md'),
      path.join(dataDir, 'SOUL.md'),
    ];
    for (const sub of [
      'people',
      'ponder',
      path.join('ponder', 'resolved'),
      'notes',
    ]) {
      const dir = path.join(dataDir, sub);
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (name.endsWith('.md')) roots.push(path.join(dir, name));
      }
    }
    const matches: { file: string; line: number; text: string }[] = [];
    let truncated = false;
    for (const file of roots) {
      let raw: string;
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        if (matches.length >= limit) {
          truncated = true;
          break;
        }
        matches.push({
          file: path.relative(dataDir, file),
          line: i + 1,
          text: lines[i].trim().slice(0, 300),
        });
      }
      if (truncated) break;
    }
    return { ok: true, count: matches.length, truncated, matches };
  };

  // give the sandbox the standard library it expects
  g.Object = Object;
  g.Array = Array;
  g.JSON = JSON;
  g.Math = Math;
  g.Date = Date;
  g.Promise = Promise;
  g.RegExp = RegExp;
  g.Map = Map;
  g.Set = Set;
  g.Error = Error;
  g.structuredClone = structuredClone;
  g.Symbol = Symbol;
  g.Number = Number;
  g.String = String;
  g.Boolean = Boolean;
  g.parseInt = parseInt;
  g.parseFloat = parseFloat;
  g.isNaN = isNaN;
  g.isFinite = isFinite;
  g.setTimeout = setTimeout;
  g.clearTimeout = clearTimeout;
  g.setInterval = setInterval;
  g.clearInterval = clearInterval;
  g.undefined = undefined;
  g.NaN = NaN;
  g.Infinity = Infinity;
  g.globalThis = g;

  // Tier-3 SCREAMING_CASE path constants. They ARE reserved (in
  // RESERVED_GLOBALS) and protected like every other harness global — see the
  // reserved-name policy in transform.ts. Surface the harness + data paths so
  // the agent doesn't hand-prefix `cd ... &&` on every harness command.
  g.HARNESS_ROOT = deps.config.paths.harnessRoot;
  g.DATA_DIR = deps.config.paths.dataDirectory;

  // Node host. The VM context is the sandbox boundary; sh/sudo already hand out
  // full-machine passwordless spawnSync, so withholding Node builtins would add
  // no isolation — only worse ergonomics. Expose the real process, the
  // harness-rooted require, and the ambient globals a standard Node process has.
  g.process = process;
  g.require = require_;
  g.Buffer = Buffer;
  g.URL = URL;
  g.URLSearchParams = URLSearchParams;
  g.TextEncoder = TextEncoder;
  g.TextDecoder = TextDecoder;
  g.fetch = fetch;
  g.btoa = btoa;
  g.atob = atob;
  g.queueMicrotask = queueMicrotask;
  g.crypto = crypto;
  // Kagi handles general search/extraction. Pinned ChatGPT share routes use the
  // native decoder and need no Kagi credential, while module policy still owns
  // whether the overall web surface exists.
  if (modules.isActive('kagi')) {
    e.search = (query: string, opts?: { limit?: number; workflow?: string }) =>
      kagiSearch(deps, query, opts);
    e.extract = (url: string, opts?: { timeout?: number; format?: string }) =>
      isChatGptShareUrl(url)
        ? extractChatGptShare(url, opts)
        : kagiExtract(deps, url, opts);
  } else if (modules.state('kagi') === 'unavailable') {
    const reason = modules.reason('kagi') ?? 'Kagi is unavailable';
    e.search = unavailableFunction('search', reason);
    const unavailableExtract = unavailableFunction('extract', reason);
    e.extract = (url: string, opts?: { timeout?: number; format?: string }) =>
      isChatGptShareUrl(url)
        ? extractChatGptShare(url, opts)
        : unavailableExtract(url, opts);
  }

  // Browser and whole-desktop control share the one real Xorg seat. Headless
  // Playwright ignores these variables; headed sessions render onto the exact
  // same :0 screen that elpis.computer and the Proxmox console observe.
  const harnessData = resolveDataLayout(deps.config.paths.dataDirectory);
  const computerDir = harnessData.computer;
  const computerDisplay = ':0';
  const computerXauthority = path.join(computerDir, 'Xauthority');

  // browser automation: a thin, structured wrapper over the locally pinned
  // Playwright CLI. Session state + screenshots live under DATA_DIR/elpis-data/browser so
  // repeated run calls and harness restarts can keep the same page open.
  if (modules.isActive('browser')) {
    const browserDir = harnessData.browser;
    const browserBin = path.join(
      deps.config.paths.harnessRoot,
      'node_modules',
      '.bin',
      'playwright-cli',
    );
    const maximizedChromiumConfig = path.join(
      browserDir,
      'maximized-chromium.config.json',
    );
    const maximizedConfigBody =
      JSON.stringify(
        {
          browser: {
            browserName: 'chromium',
            launchOptions: { args: ['--start-maximized'] },
            contextOptions: { viewport: null },
          },
        },
        null,
        2,
      ) + '\n';
    fs.mkdirSync(browserDir, { recursive: true });
    if (
      !fs.existsSync(maximizedChromiumConfig) ||
      fs.readFileSync(maximizedChromiumConfig, 'utf8') !== maximizedConfigBody
    ) {
      fs.writeFileSync(maximizedChromiumConfig, maximizedConfigBody);
    }
    e.browser = createBrowserTools({
      browserDir,
      maximizedChromiumConfig,
      watch: deps.watch,
      run: async (args, opts) => {
        if (!fs.existsSync(browserBin))
          throw new Error(
            'elpis.browser: local playwright-cli is not installed; run npm install in HARNESS_ROOT',
          );
        const command = [
          sh.q(browserBin),
          ...args.map((arg) => sh.q(arg)),
        ].join(' ');
        return shImpl(
          `env DISPLAY=${sh.q(computerDisplay)} XAUTHORITY=${sh.q(computerXauthority)} ${command}`,
          {
            cwd: browserDir,
            timeout: opts?.timeout ?? 60_000,
            maxBuffer: SH_MAX_BUFFER,
          },
        );
      },
    });
  } else installUnavailableModule('browser');

  type MotorComputerApi = {
    screenshot(opts: { filename: string }): Promise<{ file: string }>;
    click(x: number, y: number, opts?: { count?: number }): Promise<unknown>;
    drag(
      fromX: number,
      fromY: number,
      toX: number,
      toY: number,
    ): Promise<unknown>;
    type(text: string): Promise<unknown>;
    key(keys: string | string[]): Promise<unknown>;
    scroll(clicks: number): Promise<unknown>;
  };
  let computerApi: MotorComputerApi | null = null;

  // Real Xorg :0 is a root system service driving the VM VGA; Openbox/tint2
  // are a user service. The sandbox supplies window/input/clipboard/screenshot
  // control and injects the display credentials into each short command.
  if (modules.isActive('computer')) {
    const computer = createComputerTools({
      computerDir,
      display: computerDisplay,
      xauthority: computerXauthority,
      serviceName: 'elpis-desktop',
      xorgServiceName: 'elpis-xorg',
      watch: deps.watch,
      run: (command, opts) =>
        shImpl(
          displayShellCommand(command, computerDisplay, computerXauthority),
          {
            cwd: computerDir,
            timeout: opts?.timeout ?? 60_000,
            maxBuffer: SH_MAX_BUFFER,
          },
        ),
    });
    e.computer = computer;
    computerApi = computer as unknown as MotorComputerApi;
  } else installUnavailableModule('computer');

  if (modules.isActive('motor')) {
    if (!computerApi)
      throw new Error(
        'motor module resolved enabled without computer dependency',
      );
    const motorComputer = computerApi;
    e.motor = createMotorController({
      dataDirectory: deps.config.paths.dataDirectory,
      completeStandalone: (messages, opts) => {
        if (!deps.motorCompleteStandalone)
          throw new Error(
            'elpis.motor: configured motor role has no isolated standalone completion path',
          );
        return deps.motorCompleteStandalone(messages, opts);
      },
      screenshot: (filename) => motorComputer.screenshot({ filename }),
      click: (x, y, opts) => motorComputer.click(x, y, opts),
      drag: (fromX, fromY, toX, toY) =>
        motorComputer.drag(fromX, fromY, toX, toY),
      type: (text) => motorComputer.type(text),
      key: (keys) => motorComputer.key(keys),
      scroll: (clicks) => motorComputer.scroll(clicks),
      originChannelId: () => deps.inbound?.channelId ?? null,
      notifyOversight: (packet) => {
        if (!packet.frame) return;
        deps.watch?.(
          [packet.frame],
          `motor oversight episode=${packet.episodeId} checkpoint=${packet.checkpointSeq} status=${packet.status} turns=${packet.turns}\ngoal: ${packet.goal}\nrecent: ${JSON.stringify(packet.recent)}`,
          packet.originChannelId,
        );
      },
    });
  } else installUnavailableModule('motor');

  // bluesky/atproto (`bluesky.*` config); bodies in bsky.ts
  if (modules.isActive('bsky')) {
    const bskyCfg = () => {
      const c = deps.config.bluesky;
      if (!c)
        throw new Error(
          'bsky: not configured — set bluesky.identifier + bluesky.app_password in config.yaml',
        );
      return c;
    };
    e.bsky = {
      post: async (text: string) => bskyPost(bskyCfg(), text),
      reply: async (
        text: string,
        parent: { uri: string; cid: string },
        root?: { uri: string; cid: string },
      ) => bskyReply(bskyCfg(), text, parent, root),
      like: async (uri: string, cid: string) => bskyLike(bskyCfg(), uri, cid),
      follow: async (did: string) => bskyFollow(bskyCfg(), did),
      feed: async (limit = 10) => bskyFeed(bskyCfg(), limit),
      timeline: async (limit = 20) => bskyTimeline(bskyCfg(), limit),
      notifications: async (limit = 10) => bskyNotifications(bskyCfg(), limit),
    };
  } else installUnavailableModule('bsky');

  // preview(x, opts?) — the same bounded, type-aware renderer the harness uses
  // for run results, callable on demand so the agent can drill into a value
  // (usually `_`) without re-running the command that produced it. `depth`
  // bounds recursion, `strings` bounds each nested string, `max` bounds the
  // whole output. Returns the preview string (so a run ending in preview(...)
  // puts it straight into the tool result).
  e.preview = (
    v: unknown,
    opts: { max?: number; depth?: number; strings?: number } = {},
  ) =>
    preview(v, opts.max ?? deps.config.sandbox.previewMaxBytes, {
      maxDepth: opts.depth,
      strCap: opts.strings,
    });

  // triggerRestart — shared choreography behind restart and deploy's
  // success tail: flush transcripts, write the resume marker, then spawn a
  // detached systemctl restart. `notePrefix` is the only difference between
  // the two callers' notes ("restarting…" vs "built and restarting…").
  const triggerRestart = (
    reason: string | undefined,
    notePrefix: string,
  ): { ok: true; note: string } => {
    if (deps.restart) return deps.restart(reason);
    deps.flushTranscripts?.();
    writeResumeMarker(deps.config.paths.dataDirectory, reason);
    restartHarnessService();
    return {
      ok: true,
      note: `${notePrefix}${reason ? `: ${reason}` : ''} — this is your last turn before reboot; you'll get a [restart complete] message when you're back`,
    };
  };

  // restart — normal hosts hand off to systemd; restricted containers submit
  // one fixed refresh request to their namespaced Kubernetes broker.
  const triggerRestrictedRestart = async (reason?: string) => {
    if (deps.restart) return deps.restart(reason);
    deps.flushTranscripts?.();
    writeResumeMarker(deps.config.paths.dataDirectory, reason);
    try {
      await (deps.requestRestrictedRestart ?? requestRestrictedRestart)(reason);
    } catch (error) {
      clearResumeMarker(deps.config.paths.dataDirectory);
      return {
        ok: false,
        note: `restart request failed: ${error instanceof Error ? error.message : String(error)} — the current container is still running`,
      };
    }
    return {
      ok: true,
      note: `restart accepted${reason ? `: ${reason}` : ''} — the Kubernetes broker will refresh this container; this is your last turn before reboot and you'll get a [restart complete] message when back`,
    };
  };
  e.restart = profile.restricted
    ? (reason?: string) => triggerRestrictedRestart(reason)
    : (reason?: string) => triggerRestart(reason, 'restarting');

  // deploy — build the harness, then restart ONLY if the build succeeded.
  // Replaces the easy-to-forget `npm run build` + elpis.restart two-step:
  // the harness runs compiled dist/, so restarting without building runs
  // stale code, and building without checking the exit code deploys a broken
  // build. On failure the tail of the compiler output is returned and NO
  // restart happens.
  const deploy = async (reason?: string, opts?: { allowDirty?: boolean }) => {
    const root = deps.config.paths.harnessRoot;
    // Ship-step gate: refuse to restart into code that isn't in git.
    // A dirty tree or unpushed commit means a fresh checkout of origin would NOT
    // match what's about to run — the divergence that let a "deployed" fix live
    // only in dist/ with no commit behind it. `{ allowDirty: true }` overrides.
    if (!opts?.allowDirty) {
      const status = await shImpl('git status --porcelain', {
        cwd: root,
        timeout: 30_000,
      });
      if (status.code === 0 && status.stdout.trim() !== '') {
        return {
          ok: false,
          note:
            'deploy aborted: uncommitted changes in the harness tree — commit + push first ' +
            '(elpis.git.commitAndPush("...")), or elpis.deploy(reason, { allowDirty: true }) to build from the dirty tree anyway.',
          dirty: status.stdout.trim().slice(0, 1000),
        };
      }
      const upstream = await shImpl('git rev-parse --abbrev-ref @{u}', {
        cwd: root,
        timeout: 30_000,
      });
      if (upstream.code === 0) {
        const unpushed = await shImpl('git log @{u}.. --oneline', {
          cwd: root,
          timeout: 30_000,
        });
        if (unpushed.code === 0 && unpushed.stdout.trim() !== '') {
          return {
            ok: false,
            note:
              'deploy aborted: local commit(s) not pushed to origin — push first (elpis.git.push()) so a ' +
              'fresh checkout matches what you deploy, or elpis.deploy(reason, { allowDirty: true }).',
            unpushed: unpushed.stdout.trim().slice(0, 1000),
          };
        }
      }
    }
    const res = await shImpl('npm run build', {
      cwd: deps.config.paths.harnessRoot,
      timeout: 180_000,
    });
    if (res.code !== 0) {
      return {
        ok: false,
        note: 'build FAILED — not restarting (the running harness is unchanged). Fix the errors and elpis.deploy() again.',
        stderr: res.stderr.slice(-4000),
        stdout: res.stdout.slice(-2000),
      };
    }
    const configCheck = await shImpl(
      'node --input-type=module -e "import { loadConfigFile } from \'./dist/config.js\'; loadConfigFile();"',
      { cwd: root, timeout: 30_000 },
    );
    if (configCheck.code !== 0) {
      return {
        ok: false,
        note: 'live config preflight FAILED against the freshly built harness — not restarting (the running harness is unchanged). Fix the config/code mismatch and elpis.deploy() again.',
        stderr: configCheck.stderr.slice(-4000),
        stdout: configCheck.stdout.slice(-2000),
      };
    }
    return triggerRestart(reason, 'built, config-checked, and restarting');
  };
  if (!profile.restricted) e.deploy = deploy;

  // git helpers — stage, commit, and push without the easy-to-forget cwd / exit-code
  // dance. Defaults to the DATA dir (the brain repo) — that's where memory/notes/
  // people live. Pass `{ cwd: HARNESS_ROOT }` for harness-source commits
  // (elpis.deploy handles its own cwd).
  type GitOpts = { cwd?: string; timeout?: number };
  async function gitRun(args: string, opts: GitOpts = {}): Promise<ShResult> {
    const command = `git ${args}`;
    const action = args.trim().split(/\s+/, 1)[0] || 'command';
    return shImpl(
      command,
      {
        cwd: opts.cwd ?? deps.config.paths.dataDirectory,
        timeout: opts.timeout ?? 60_000,
      },
      { kind: 'git', name: action, command },
    );
  }
  const gitApi = {
    status: async (opts?: GitOpts) => {
      const r = await gitRun('status --short --branch', opts);
      return { ok: r.code === 0, ...r };
    },
    diff: async (opts?: GitOpts) => {
      const r = await gitRun('diff', opts);
      return { ok: r.code === 0, ...r };
    },
    add: async (paths?: string | string[], opts?: GitOpts) => {
      const spec =
        paths === undefined
          ? '.'
          : Array.isArray(paths)
            ? paths.join(' ')
            : String(paths);
      const r = await gitRun(`add -- ${spec}`, opts);
      // Throw on failure: a returned {ok:false} that the caller ignored
      // is how two fixes were silently lost — a git op that fails must fail loud.
      if (r.code !== 0)
        throw new Error(
          `elpis.git.add failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
        );
      return { ok: true, ...r };
    },
    commit: async (message: string, opts?: GitOpts & { add?: boolean }) => {
      if (typeof message !== 'string' || message === '') {
        throw new Error(
          'elpis.git.commit(message): message must be a non-empty string',
        );
      }
      const flags = opts?.add ? '-a' : '';
      const r = await gitRun(
        `commit ${flags} -m ${JSON.stringify(message)}`,
        opts,
      );
      // Throw on failure — including "nothing to commit" (nothing staged), the
      // exact silent no-op that lost the fetchContextWindow + send fixes twice.
      if (r.code !== 0)
        throw new Error(
          `elpis.git.commit failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
        );
      const sha = (await gitRun('rev-parse --short HEAD', opts)).stdout.trim();
      return {
        ok: true,
        sha,
        stdout: r.stdout,
        stderr: r.stderr,
        code: r.code,
        signal: r.signal,
      };
    },
    push: async (opts?: GitOpts) => {
      const r = await gitRun('push', opts);
      if (r.code !== 0)
        throw new Error(
          `elpis.git.push failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
        );
      return { ok: true, ...r };
    },
    // Stage EVERYTHING (tracked + untracked) by default, then commit + push.
    // `{ add: false }` skips staging (you staged yourself). Any failed stage
    // throws (from add/commit/push), so a broken ship can't look like success.
    commitAndPush: async (
      message: string,
      opts?: GitOpts & { add?: boolean },
    ) => {
      if (opts?.add !== false) await gitApi.add('.', opts);
      const commitRes = await gitApi.commit(message, { ...opts, add: false });
      const pushRes = await gitApi.push(opts);
      return { ok: true, sha: commitRes.sha, commit: commitRes, push: pushRes };
    },
  };
  e.git = gitApi;

  // focus(text) — overwrite NOW.md, the agent's self-maintained working-state note
  // (≤10 lines: currently doing, next, don't forget). Injected into every
  // context's system prompt beside MEMORY.md. Overwrite-only so it can't grow
  // unbounded. Verb form matches remember/ponder; named `focus` rather than `now`
  // since `now` is a near-certain local-variable collision (A6).
  const nowPath = path.join(deps.config.paths.dataDirectory, 'NOW.md');
  e.focus = (text: string) => {
    writePrivateFileAtomic(nowPath, text);
    return { ok: true, note: 'NOW.md updated — visible in every room' };
  };
  const extensionRoot = Object.create(null) as Record<string, unknown>;
  for (const summary of deps.extensions?.summaries ?? []) {
    extensionRoot[summary.namespace] = deps.extensions?.apis[summary.namespace];
  }
  extensionRoot.$failures = () => deps.extensions?.failures ?? [];
  extensionRoot.$help = (namespace?: string) => {
    const summaries = deps.extensions?.summaries ?? [];
    if (namespace === undefined) return summaries;
    if (typeof namespace !== 'string')
      throw new Error('elpis.ext.$help(namespace) requires a string namespace');
    const found = summaries.find((summary) => summary.namespace === namespace);
    if (!found) throw new Error(`unknown extension namespace: ${namespace}`);
    return found;
  };
  e.ext = Object.freeze(extensionRoot);

  // channel(idOrRef) -> { send(text), id, name } for outbound Discord messages.
  //: an explicit target is ALWAYS required — there is no "current channel"
  // to default to (one history interleaves every room, so a mid-turn inbound
  // from another room makes any default ambiguous). Accepts a Discord id (all
  // digits) or a guild-qualified 'slug/name' ref — a BARE name
  // throws even when it uniquely matches, because guessing wrong here delivers
  // a private message to the wrong friend group; resolveChannel (agent-side)
  // renders that throw listing qualified candidates, so it's allowed to
  // propagate unmodified here. Refuses the 'internal' provenance label. Known
  // channels come from the directory.
  e.channel = (idOrRef?: string) => {
    if (idOrRef === undefined || idOrRef === null || idOrRef === '') {
      const known = deps.listChannelsWithNames
        ? deps.listChannelsWithNames().map((c) => c.name)
        : [];
      throw new Error(
        `elpis.channel(): a channel ref is required — a raw id or a guild-qualified 'slug/name' (e.g. elpis.channel('home/general').send(…)). ` +
          `Known: ${known.length ? known.join(', ') : '(none yet — wait for a real message)'}`,
      );
    }
    let channelId = idOrRef;
    if (channelId === INTERNAL_CHANNEL_ID) {
      throw new Error(
        `elpis.channel('internal') is not a real room — it is a provenance label. Pass a real channel ref or id.`,
      );
    }
    // Resolve a ref to an id (a Discord id is all digits and skips resolution).
    // A bare unqualified name THROWS from resolveChannel itself (agent.ts) —
    // that throw already lists qualified candidates, so it propagates as-is.
    if (!/^\d+$/.test(channelId) && deps.resolveChannel) {
      const resolved = deps.resolveChannel(channelId);
      if (resolved) {
        channelId = resolved;
      } else {
        const known = deps.listChannelsWithNames
          ? deps.listChannelsWithNames().map((c) => c.name)
          : [];
        throw new Error(
          `elpis.channel(): unknown channel "${channelId}" — pass a guild-qualified name ('friends-a/lounge') or a raw id. Known: ${known.length ? known.join(', ') : '(none yet)'}`,
        );
      }
    }
    // Resolve a display name/label for the send-result echo (mis-target guardrail).
    // channelLabel always returns a string — for an unknown channel it's the
    // raw id itself, so append '(id)' only when the label is an actual name;
    // otherwise the echo would read '999999 (999999)'.
    const resolvedName = deps.channelName ? deps.channelName(channelId) : null;
    const resolvedLabel = deps.channelLabel
      ? deps.channelLabel(channelId)
      : channelId;
    const label =
      resolvedLabel !== channelId
        ? `${resolvedLabel} (${channelId})`
        : channelId;
    return {
      id: channelId,
      name: resolvedName,
      send: async (
        content: unknown,
        sendOpts?: {
          allowEscapes?: boolean;
          files?: { path: string; name?: string }[];
        },
      ) => {
        const hasFiles =
          Array.isArray(sendOpts?.files) &&
          sendOpts!.files.some(
            (f) => typeof (f as { path?: unknown }).path === 'string',
          );
        // Bind to a fresh `string` (reassigning the `unknown` param doesn't
        // narrow for downstream uses). Attachment-only send: caption optional.
        let text: string;
        if (typeof content === 'string') text = content;
        else if (hasFiles) text = '';
        else
          throw new Error(
            'elpis.channel().send(content) requires a string (or pass { files } for an attachment-only send)',
          );
        if (!deps.send) {
          throw new Error(
            'elpis.channel().send() is not wired in this harness',
          );
        }
        // Escape guard: literal `\n`/`\t`/`\uXXXX` render as backslash-n.
        if (
          !sendOpts?.allowEscapes &&
          /\\(?:n|t|r|u[0-9a-fA-F]{4})/.test(text)
        ) {
          throw new Error(
            'elpis.channel().send: message contains literal escape sequences (\\n, \\t, or \\uXXXX) that will ' +
              'render as backslash-n to the reader, not line breaks. Use REAL newlines (a <<<HEREDOC block ' +
              'authors multi-line text with zero escaping). To send the backslashes literally, pass ' +
              'elpis.channel(id).send(text, { allowEscapes: true }).',
          );
        }
        const files = Array.isArray(sendOpts?.files)
          ? sendOpts.files.filter(
              (f: unknown): f is { path: string; name?: string } =>
                typeof (f as { path?: unknown }).path === 'string',
            )
          : undefined;
        await deps.send(channelId, text, { files });
        // Record the send on the current run scope for turn accounting, console
        // rendering, transcript recovery, and detached-future delivery.
        const sendRecord: { channel: string; text: string; files?: string[] } =
          { channel: channelId, text };
        if (files && files.length > 0)
          sendRecord.files = files
            .map((f) => f.name || String(f.path).split('/').pop())
            .filter((n): n is string => typeof n === 'string');
        runScope.getStore()?.sends.push(sendRecord);
        // Echo the resolved room first (mis-target guardrail): a misdirect
        // becomes visible in the very next tool result.
        return {
          ok: true,
          channelId,
          note: `message delivered to ${label}. anything you return in this turn's content block will be ignored`,
        };
      },
      typing: () => {
        if (!deps.typing) {
          throw new Error(
            'elpis.channel().typing() is not wired in this harness',
          );
        }
        deps.typing(channelId);
        return { ok: true, channelId, note: 'typing indicator active' };
      },
      // Killswitch self-mute: "no speaking here." Deliberately the
      // ONLY moderation member on this handle — no unmute/deafen. Release is
      // operator-only and unreachable from inside the sandbox.
      mute: (reason?: string) => {
        if (!deps.moderate) {
          throw new Error(
            'elpis.channel().mute() is not wired in this harness',
          );
        }
        const r = deps.moderate(
          channelId,
          typeof reason === 'string' ? reason : undefined,
        );
        return { ok: r.ok, channelId, note: r.note };
      },
    };
  };
  // channel.list — enumerate known channels as { id, name } objects.
  const channelFn = e.channel as ((id?: string) => unknown) & {
    list: () => { id: string; name: string | null }[];
  };
  channelFn.list = () => {
    if (deps.listChannelsWithNames) return deps.listChannelsWithNames();
    return deps.listChannels
      ? deps.listChannels().map((id) => ({ id, name: null }))
      : [];
  };

  // watch(paths, note) — deliver local image frames (jpg/png/gif/webp) as ONE
  // ephemeral multimodal message: the frames reach the model for exactly one
  // generation, then strip from live history; the transcript keeps only the text.
  // For the watch-together pipeline (episode keyframes etc).
  e.watch = (paths: string[], note: string) => {
    if (!deps.watch)
      throw new Error('elpis.watch is not wired in this harness');
    if (!Array.isArray(paths) || paths.length === 0)
      throw new Error(
        'elpis.watch(paths, note): paths must be a non-empty array of local image paths',
      );
    const res = deps.watch(paths, note ?? '');
    return {
      ...res,
      note: `queued ${res.count} frame(s) — they arrive as your next turn. describe/react in that turn; the frames are gone after it.`,
    };
  };

  // mind — dependency-aware external cortex. One authoritative MindService backs
  // this sandbox API, Discord /mind, and the console dashboard.
  const requireMind = (): NonNullable<SandboxDeps['mind']> => {
    if (!deps.mind) throw new Error('elpis.mind is not wired in this harness');
    return deps.mind;
  };
  const mindActor = () => deps.agentName?.().trim() || 'agent';
  const boundMindId = (): MindId => {
    if (!isMindId(deps.mindDefaultId))
      throw new Error('elpis.mind.bound: this sandbox has no bound Mind item');
    return deps.mindDefaultId;
  };
  e.mind = {
    add: (opts: {
      title: string;
      body?: string;
      kind?: 'task' | 'project' | 'idea' | 'question' | 'reminder';
      status?:
        | 'proposal'
        | 'inbox'
        | 'open'
        | 'in_progress'
        | 'waiting'
        | 'done'
        | 'cancelled';
      priority?: number;
      parentId?: number | string | null;
      dueAt?: unknown;
      tags?: string[];
      dependsOn?: Array<number | string>;
      remindAt?: unknown;
      channelId?: string | null;
      actor?: string;
    }) => {
      if (!opts || typeof opts !== 'object')
        throw new Error('elpis.mind.add(opts): opts is required');
      return requireMind().create({
        ...opts,
        parentId: opts.parentId == null ? null : parseMindId(opts.parentId),
        dependsOn: opts.dependsOn?.map(parseMindId),
        dueAt:
          opts.dueAt === undefined || opts.dueAt === null
            ? null
            : coerceNextRunAt(opts.dueAt),
        remindAt:
          opts.remindAt === undefined || opts.remindAt === null
            ? null
            : coerceNextRunAt(opts.remindAt),
        reminderChannelId: opts.channelId ?? deps.inbound?.channelId ?? null,
        actor: opts.actor ?? mindActor(),
      });
    },
    get: (ref: number | string) => requireMind().get(parseMindId(ref)),
    list: (filter?: {
      statuses?: Array<
        | 'proposal'
        | 'inbox'
        | 'open'
        | 'in_progress'
        | 'waiting'
        | 'done'
        | 'cancelled'
      >;
      kinds?: Array<'task' | 'project' | 'idea' | 'question' | 'reminder'>;
      tag?: string;
      query?: string;
      parentId?: number | string | null;
      ready?: boolean;
      blocked?: boolean;
      overdue?: boolean;
      includeArchived?: boolean;
      sort?:
        | 'created_asc'
        | 'created_desc'
        | 'updated_asc'
        | 'updated_desc'
        | 'last_comment_asc'
        | 'last_comment_desc';
      limit?: number;
      offset?: number;
    }) =>
      requireMind().list(
        filter
          ? {
              ...filter,
              parentId:
                filter.parentId === undefined || filter.parentId === null
                  ? filter.parentId
                  : parseMindId(filter.parentId),
            }
          : undefined,
      ),
    ready: (limit?: number) => requireMind().ready(limit),
    stats: () => requireMind().stats(),
    graph: (ref: number | string, depth?: number) =>
      requireMind().graph(parseMindId(ref), depth),
    update: (
      ref: number | string,
      patch: {
        title?: string;
        body?: string;
        kind?: 'task' | 'project' | 'idea' | 'question' | 'reminder';
        status?:
          | 'proposal'
          | 'inbox'
          | 'open'
          | 'in_progress'
          | 'waiting'
          | 'done'
          | 'cancelled';
        priority?: number;
        parentId?: number | string | null;
        dueAt?: unknown;
        tags?: string[];
      },
      actor?: string,
    ) => {
      const normalized: Parameters<
        NonNullable<SandboxDeps['mind']>['update']
      >[1] = {};
      if (patch.title !== undefined) normalized.title = patch.title;
      if (patch.body !== undefined) normalized.body = patch.body;
      if (patch.kind !== undefined) normalized.kind = patch.kind;
      if (patch.status !== undefined) normalized.status = patch.status;
      if (patch.priority !== undefined) normalized.priority = patch.priority;
      if (patch.tags !== undefined) normalized.tags = patch.tags;
      if (patch.parentId !== undefined)
        normalized.parentId =
          patch.parentId === null ? null : parseMindId(patch.parentId);
      if (patch.dueAt !== undefined)
        normalized.dueAt =
          patch.dueAt === null ? null : coerceNextRunAt(patch.dueAt);
      return requireMind().update(
        parseMindId(ref),
        normalized,
        actor ?? mindActor(),
      );
    },
    status: (
      ref: number | string,
      status:
        | 'proposal'
        | 'inbox'
        | 'open'
        | 'in_progress'
        | 'waiting'
        | 'done'
        | 'cancelled',
      actor?: string,
    ) =>
      requireMind().setStatus(parseMindId(ref), status, actor ?? mindActor()),
    done: (ref: number | string, comment?: string, actor?: string) => {
      const id = parseMindId(ref);
      const who = actor ?? mindActor();
      if (comment) requireMind().addComment(id, comment, who);
      return requireMind().setStatus(id, 'done', who);
    },
    cancel: (ref: number | string, comment?: string, actor?: string) => {
      const id = parseMindId(ref);
      const who = actor ?? mindActor();
      if (comment) requireMind().addComment(id, comment, who);
      return requireMind().setStatus(id, 'cancelled', who);
    },
    archive: (ref: number | string, actor?: string) =>
      requireMind().archive(parseMindId(ref), actor ?? mindActor()),
    restore: (ref: number | string, actor?: string) =>
      requireMind().restore(parseMindId(ref), actor ?? mindActor()),
    comment: (ref: number | string, body: string, author?: string) =>
      requireMind().addComment(parseMindId(ref), body, author ?? mindActor()),
    reply: (
      ref: number | string,
      commentId: number,
      body: string,
      author?: string,
    ) =>
      requireMind().addReply(
        parseMindId(ref),
        commentId,
        body,
        author ?? mindActor(),
      ),
    updateComment: (commentId: number, body: string, author?: string) =>
      requireMind().updateComment(commentId, body, author ?? mindActor()),
    deleteComment: (commentId: number, actor?: string) =>
      requireMind().deleteComment(commentId, actor ?? mindActor()),
    depends: (ref: number | string, on: number | string, actor?: string) =>
      requireMind().addDependency(
        parseMindId(ref),
        parseMindId(on),
        actor ?? mindActor(),
      ),
    unlinks: (ref: number | string, from: number | string, actor?: string) =>
      requireMind().removeDependency(
        parseMindId(ref),
        parseMindId(from),
        actor ?? mindActor(),
      ),
    tag: (ref: number | string, tag: string, actor?: string) =>
      requireMind().addTag(parseMindId(ref), tag, actor ?? mindActor()),
    untag: (ref: number | string, tag: string, actor?: string) =>
      requireMind().removeTag(parseMindId(ref), tag, actor ?? mindActor()),
    remind: (
      ref: number | string,
      at: unknown,
      opts?: { actor?: string; channelId?: string | null },
    ) =>
      requireMind().addReminder(
        parseMindId(ref),
        coerceNextRunAt(at),
        opts?.actor ?? mindActor(),
        opts?.channelId ?? deps.inbound?.channelId ?? null,
      ),
    snoozeReminder: (reminderId: number, until: unknown, actor?: string) =>
      requireMind().snoozeReminder(
        reminderId,
        coerceNextRunAt(until),
        actor ?? mindActor(),
      ),
    cancelReminder: (reminderId: number, actor?: string) =>
      requireMind().cancelReminder(reminderId, actor ?? mindActor()),
  };
  (e.mind as Record<string, unknown>).bound = {
    id: () => boundMindId(),
    get: () => requireMind().get(boundMindId()),
    update: (
      patch: Parameters<NonNullable<SandboxDeps['mind']>['update']>[1],
      actor?: string,
    ) => requireMind().update(boundMindId(), patch, actor ?? mindActor()),
    status: (
      status:
        | 'proposal'
        | 'inbox'
        | 'open'
        | 'in_progress'
        | 'waiting'
        | 'done'
        | 'cancelled',
      actor?: string,
    ) => requireMind().setStatus(boundMindId(), status, actor ?? mindActor()),
    done: (comment?: string, actor?: string) => {
      const id = boundMindId();
      const who = actor ?? mindActor();
      if (comment) requireMind().addComment(id, comment, who);
      return requireMind().setStatus(id, 'done', who);
    },
    cancel: (comment?: string, actor?: string) => {
      const id = boundMindId();
      const who = actor ?? mindActor();
      if (comment) requireMind().addComment(id, comment, who);
      return requireMind().setStatus(id, 'cancelled', who);
    },
    archive: (actor?: string) =>
      requireMind().archive(boundMindId(), actor ?? mindActor()),
    comment: (body: string, author?: string) =>
      requireMind().addComment(boundMindId(), body, author ?? mindActor()),
    reply: (commentId: number, body: string, author?: string) =>
      requireMind().addReply(
        boundMindId(),
        commentId,
        body,
        author ?? mindActor(),
      ),
    depends: (on: number | string, actor?: string) =>
      requireMind().addDependency(
        boundMindId(),
        parseMindId(on),
        actor ?? mindActor(),
      ),
    unlinks: (from: number | string, actor?: string) =>
      requireMind().removeDependency(
        boundMindId(),
        parseMindId(from),
        actor ?? mindActor(),
      ),
    tag: (tag: string, actor?: string) =>
      requireMind().addTag(boundMindId(), tag, actor ?? mindActor()),
    untag: (tag: string, actor?: string) =>
      requireMind().removeTag(boundMindId(), tag, actor ?? mindActor()),
    remind: (
      at: unknown,
      opts?: { actor?: string; channelId?: string | null },
    ) =>
      requireMind().addReminder(
        boundMindId(),
        coerceNextRunAt(at),
        opts?.actor ?? mindActor(),
        opts?.channelId ?? deps.inbound?.channelId ?? null,
      ),
  };

  // sleep(ms) — async delay without blocking the event loop. Useful for spacing
  // sandbox actions inside a single run. Returns a promise that resolves after
  // the requested millisecond count (or 0 if omitted/invalid).
  e.sleep = async (ms?: number) => {
    const delay =
      typeof ms === 'number' && Number.isFinite(ms)
        ? Math.max(0, Math.floor(ms))
        : 0;
    // A sleep is the agent *choosing to wait* — showing "typing…" through it
    // misrepresents what is happening. elpis.timeout stays unhooked:
    // it caps real running work, which is exactly what typing should indicate.
    deps.sleepPause?.();
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    } finally {
      deps.sleepResume?.();
    }
  };

  // wait(ms) — alias for sleep(ms). Pauses without blocking the event loop.
  e.wait = e.sleep;

  // schedule(opts) — create a persistent scheduled task that wakes the agent when due.
  // schedule.done(name) — mark a task and its nags done.
  // schedule.snooze(name, until) — snooze a task and its nags until a timestamp.
  // requireScheduler — the same optional-dependency idiom as requireSsh
  // above: throw a teachable error rather than leaving elpis.schedule/tasks
  // undefined when no scheduler was wired.
  const requireScheduler = (): NonNullable<SandboxDeps['scheduler']> => {
    if (!deps.scheduler) throw new Error('scheduler not wired');
    return deps.scheduler;
  };
  const scheduleGlobal = (opts: {
    name: string;
    kind?: string;
    channelId?: string | null;
    payload: string;
    nextRunAt: unknown;
    intervalMs?: number | null;
    nagIntervalMs?: number | null;
    parentId?: number | null;
  }) => {
    if (!opts || typeof opts.name !== 'string' || opts.name.trim() === '')
      throw new Error('elpis.schedule: { name } must be a non-empty string');
    if (typeof opts.payload !== 'string')
      throw new Error('elpis.schedule: { payload } must be a string');
    return requireScheduler().create({
      ...opts,
      nextRunAt: coerceNextRunAt(opts.nextRunAt),
    });
  };
  scheduleGlobal.done = (name: string) => {
    return requireScheduler().markDoneByName(name);
  };
  scheduleGlobal.snooze = (name: string, until: unknown) => {
    return requireScheduler().snoozeByName(name, coerceNextRunAt(until));
  };
  scheduleGlobal.update = (
    id: number,
    patch: {
      payload?: string;
      nextRunAt?: unknown;
      intervalMs?: number | null;
      nagIntervalMs?: number | null;
      snoozeUntil?: unknown;
    },
  ) => {
    const p: {
      payload?: string;
      nextRunAt?: number;
      intervalMs?: number | null;
      nagIntervalMs?: number | null;
      snoozeUntil?: number | null;
    } = {};
    if (patch.payload !== undefined) p.payload = patch.payload;
    if (patch.intervalMs !== undefined) p.intervalMs = patch.intervalMs;
    if (patch.nagIntervalMs !== undefined)
      p.nagIntervalMs = patch.nagIntervalMs;
    if (patch.nextRunAt !== undefined)
      p.nextRunAt = coerceNextRunAt(patch.nextRunAt);
    if (patch.snoozeUntil !== undefined)
      p.snoozeUntil =
        patch.snoozeUntil === null ? null : coerceNextRunAt(patch.snoozeUntil);
    return requireScheduler().update(id, p);
  };
  scheduleGlobal.remove = async (ref: number | string) => {
    const sched = requireScheduler();
    if (typeof ref === 'string') {
      const task = (sched.list() as Array<{ id: number; name: string }>).find(
        (entry) => entry.name === ref,
      );
      if (!task)
        throw new Error(`elpis.schedule.remove: no task named '${ref}'`);
      return sched.delete(task.id);
    }
    return sched.delete(ref);
  };
  scheduleGlobal.list = () => requireScheduler().list();
  e.schedule = scheduleGlobal;

  // timeout(promise, ms) — race a promise against a timer. Resolves/rejects with the
  // promise's result if it settles before the timeout, otherwise rejects with an Error
  // whose message includes the timeout duration. Useful for capping async work like
  // network requests or subprocesses. A non-finite/zero ms means no timeout (returns the
  // promise unchanged).
  // Deliberately NOT hooked into the sleep typing-indicator pause (see e.sleep,
  // above): timeout caps real running work, which is exactly what typing
  // should indicate — don't add sleepPause/sleepResume calls here.
  if (deps.worker) {
    e.worker = {
      start: (mindId: unknown, options?: unknown) =>
        deps.worker!.start(mindId, options),
      send: (ref: string, text: string) => deps.worker!.send(ref, text),
      followup: (ref: string, text?: string) =>
        deps.worker!.followup(ref, text),
      list: () => deps.worker!.list(),
      status: (ref: string) => deps.worker!.status(ref),
      artifact: (ref: string, key?: string) => deps.worker!.artifact(ref, key),
      dismiss: (ref: string) => deps.worker!.dismiss(ref),
    };
  }

  e.timeout = async <T>(promise: Promise<T>, ms?: number): Promise<T> => {
    const delay =
      typeof ms === 'number' && Number.isFinite(ms)
        ? Math.max(0, Math.floor(ms))
        : 0;
    if (delay === 0) return promise;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout after ${delay}ms`)),
        delay,
      );
    });
    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  if (deps.surface === 'core') {
    const coreElpis = new Set([
      'inbound',
      'channel',
      'memory',
      'remember',
      'focus',
      'ponder',
      'mind',
      'sandbox',
      'schedule',
      'sleep',
      'wait',
      'timeout',
      'preview',
      'fill',
    ]);
    for (const key of Object.keys(e)) if (!coreElpis.has(key)) delete e[key];
    for (const key of Object.keys(g)) if (key !== 'console') delete g[key];
  } else if (deps.surface === 'worker') {
    const workerElpis = new Set([
      'edit',
      'fill',
      'git',
      'preview',
      'read',
      'sh',
      'sleep',
      'wait',
      'timeout',
    ]);
    for (const key of Object.keys(e)) if (!workerElpis.has(key)) delete e[key];
  }

  // Deep-freeze the whole verb namespace, then hang it off `g.elpis` — the
  // ONLY way an agent script reaches a harness verb. Frozen means both the
  // namespace object itself AND every member (including the wrapped sh/sudo
  // functions and the memory/editor/channel/bg sub-objects) reject
  // reassignment; the live `inbound` getter survives because deepFreeze skips
  // accessor descriptors.
  deepFreeze(e);
  g.elpis = e;

  // Belt-and-braces: freeze the reserved globals so plain assignment (which
  // the transform does NOT rewrite) throws instead of silently clobbering a
  // helper. The transform catches re-declarations (the common path) at pre-parse.
  for (const name of Object.keys(RESERVED_GLOBALS)) protect(name);

  return g;
}

// (protect calls live at the end of buildGlobals so all globals are defined first)
