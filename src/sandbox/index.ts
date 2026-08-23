// sandbox/index.ts — owns exactly one long-lived vm context for the whole
// process lifetime. Exposes a single `run(code): Promise<RunResult>`.
//
// TIMEOUT SEMANTICS (documented):
// - vm's `timeout` kills synchronous V8 execution — so `while(true){}` and any
// sync loop before the first await is terminated. ✅
// - once execution hits an `await`, runInContext returns a promise and the vm
// watchdog disarms. async hangs (await new Promise(=>{})) and microtask
// floods are NOT caught by vm; Promise.race is our best-effort guard, but a
// dangling promise that never settles can still leak resources. We accept
// it; worst case the harness process restarts.

import vm from 'node:vm';
import {
  buildGlobals,
  runScope,
  type RunProcessErrorKind,
  type RunScope,
} from './globals.js';
import { transform } from './transform.js';
import { preview, capLines } from './preview.js';
import { parseFailureHints } from './parse-hints.js';
import type {
  RunResult,
  SandboxDeps,
  SandboxLateProcessError,
} from '../types.js';

export interface Sandbox {
  run(code: string, owner?: { runId?: string }): Promise<RunResult>;
}

/** `import()` inside the vm context has no dynamic-import callback wired up
 * (Node requires one to be supplied per-context, and we deliberately don't —
 * `require` covers local-module loading and auto-reflects on-disk edits).
 * Rewrite the raw VM error into an actionable one wherever a run error is
 * surfaced to `RunResult.error` (sync-catch and async/detached rejection). */
function friendlyRunError(err: unknown): string {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  if (
    /ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING/.test(msg) ||
    /dynamic import callback/i.test(msg)
  ) {
    return 'dynamic import() is not available in the sandbox — use require() for local modules. Author them as CommonJS `.cjs` files and `require("/abs/path/to/mod.cjs")`. (require() auto-reflects on-disk edits.)';
  }
  return msg;
}

/** A detach deadline that RESOLVES (not rejects) with a sentinel so the run can
 * register the still-pending promise as a future instead of killing it. */
const DETACH_SENTINEL = Symbol('detach-deadline');
const RUN_PROCESS_ERROR = Symbol('run-process-error');

type RunProcessError = {
  marker: typeof RUN_PROCESS_ERROR;
  kind: RunProcessErrorKind;
  error: unknown;
};

function createRunProcessErrorTrap(
  scope: RunScope,
  onLateError: SandboxDeps['onLateProcessError'],
): {
  promise: Promise<RunProcessError>;
  complete: () => void;
  fail: () => void;
} {
  let state: 'active' | 'completed' | 'failed' = 'active';
  let lateReported = false;
  let resolveError!: (event: RunProcessError) => void;
  const promise = new Promise<RunProcessError>((resolve) => {
    resolveError = resolve;
  });
  const handler = (kind: RunProcessErrorKind, error: unknown): boolean => {
    if (state === 'active') {
      state = 'failed';
      resolveError({ marker: RUN_PROCESS_ERROR, kind, error });
      return true;
    }
    if (state === 'failed') return true;
    if (!onLateError) return false;
    if (!lateReported) {
      lateReported = true;
      onLateError({ kind, error });
    }
    return true;
  };
  scope.processError = handler;
  return {
    promise,
    complete: () => {
      if (state !== 'active') return;
      state = 'completed';
      if (!onLateError && scope.processError === handler)
        delete scope.processError;
    },
    fail: () => {
      if (state === 'active') state = 'failed';
    },
  };
}

function processErrorFailure(event: RunProcessError): Error {
  return new Error(
    `asynchronous sandbox ${event.kind}: ${friendlyRunError(event.error)}`,
  );
}

function deadlineAfter(ms: number): {
  promise: Promise<typeof DETACH_SENTINEL>;
  clear: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<typeof DETACH_SENTINEL>((resolve) => {
    timer = setTimeout(() => resolve(DETACH_SENTINEL), ms);
  });
  const clear = () => {
    clearTimeout(timer);
  };
  return { promise, clear };
}

export function createSandbox(deps: SandboxDeps): Sandbox {
  // deps.logbuf is only a fallback holder for logs emitted OUTSIDE a run (should
  // never happen). Each run(code) gets its OWN buffer via runScope, so
  // there is no per-run global swap and concurrent runs never share a buffer.
  if (!deps.logbuf) deps.logbuf = [];
  const globals = buildGlobals(deps);
  // globals object IS the sandbox global
  const ctx = vm.createContext(globals);

  function run(code: string, owner?: { runId?: string }): Promise<RunResult> {
    // Per-run scope: the run's own log buffer + live child-pid set,
    // carried through every await AND every post-detach continuation via
    // AsyncLocalStorage. No global buffer swap → reentrant, and a detached run's
    // late console.log lands in ITS buffer (delivered with the settle notice).
    const scope: RunScope = { logbuf: [], childPids: new Set(), sends: [] };
    return runScope.run(scope, () => runInScope(code, scope, owner));
  }

  async function runInScope(
    code: string,
    scope: RunScope,
    owner?: { runId?: string },
  ): Promise<RunResult> {
    const runLogbuf = scope.logbuf;
    // A no-op run (empty string, whitespace, or comments only) executes
    // nothing — say so instead of returning a bare `ok: true` that reads as
    // progress. Observed feeding a flail loop of run("") / run("// …")
    // attempts while the agent tried to force an "empty" turn.
    const substance = code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .trim();
    if (substance === '') {
      return {
        ok: true,
        preview:
          'empty program — nothing executed (previous _ preserved). Add wake to this run only when you deliberately mean to yield.',
        logs: '',
      };
    }
    const transformResult = transform(code);
    const { code: transformed, parsed } = transformResult;

    // If acorn failed to parse, surface ITS error directly — it points at the
    // agent's own source with a precise line:column. Running the raw code so
    // V8 surfaces a "real" syntax error is backwards in practice: by the time
    // the transformed code would have errored it is one long generated line, so
    // V8's error loses the position and names a symptom (e.g. "await is only
    // valid in async functions") rather than the cause (a stray `as` cast that
    // acorn flagged exactly).
    if (!parsed) {
      // Frame lines come from transformResult.code — the (possibly heredoc-
      // expanded) source acorn actually parsed, so line:col line up even when
      // a heredoc shifted positions. Identical to `code` when no heredocs.
      const lines = transformResult.code.split('\n');
      // acorn errors look like "Unexpected token (3:14)"
      const m = /\((\d+):(\d+)\)/.exec(transformResult.error ?? '');
      let frame = '';
      if (m) {
        const ln = Number(m[1]);
        const col = Number(m[2]);
        const start = Math.max(0, ln - 2);
        const slice = lines.slice(start, ln + 1);
        frame = slice
          .map(
            (l, i) =>
              `${String(start + 1 + i).padStart(String(ln).length)}: ${l}`,
          )
          .join('\n');
        // acorn columns are 0-based; the caret sits at prefix width + col.
        frame += '\n' + ' '.repeat(String(ln).length + 2 + col) + '^';
      }
      const hints = parseFailureHints(
        transformResult.code,
        code,
        transformResult.error ?? '',
      )
        .map((h) => '\nHint: ' + h)
        .join('');
      // A pre-parse failure is all-or-nothing: state is clean, so the fix is to
      // re-run the WHOLE program, not to guess which half landed.
      const nothingRan =
        '\nNothing in this program executed — no files written, no messages sent. Fix and re-run the whole batch.';
      return {
        ok: false,
        failureKind: 'preparse',
        error: `SyntaxError (pre-parse): ${transformResult.error}${frame ? '\n' + frame : ''}${hints}${nothingRan}`,
        logs: capLines(runLogbuf.join('\n'), deps.config.sandbox.logMaxBytes),
      };
    }
    const toRun = transformed;

    let value: unknown;
    let detached = false;
    let bgId: string | undefined;
    const lateReporter = deps.onLateProcessError
      ? (event: SandboxLateProcessError) =>
          deps.onLateProcessError!({
            kind: event.kind,
            error: event.error,
            ...(owner?.runId ? { runId: owner.runId } : {}),
          })
      : undefined;
    const processErrorTrap = createRunProcessErrorTrap(scope, lateReporter);

    let guardedPromise: Promise<unknown> | undefined;
    try {
      // Sync portion (incl. any sync runaway up to first await) is bounded by
      // sandbox.sync_timeout_ms — a tight runaway-JS backstop now that nothing
      // legitimate blocks the event loop (sh/sudo are async).
      const maybePromise = vm.runInContext(toRun, ctx, {
        timeout: deps.config.sandbox.syncTimeoutMs,
        filename: 'agent.js',
      }) as Promise<unknown>;
      guardedPromise = Promise.race([
        maybePromise,
        processErrorTrap.promise.then((event) => {
          throw processErrorFailure(event);
        }),
      ]);
      guardedPromise.then(processErrorTrap.complete, processErrorTrap.fail);

      // we always wrap in an async IIFE (see transform), so this is a promise.
      // The async deadline DETACHES (not kills) the run when sandbox.async_deadline_ms
      // elapses — the still-pending promise registers as a future in bg.
      const { promise: deadlinePromise, clear: clearDeadline } = deadlineAfter(
        deps.config.sandbox.asyncDeadlineMs,
      );
      try {
        const raced = await Promise.race([guardedPromise, deadlinePromise]);
        if (raced === DETACH_SENTINEL) {
          // Detach: the run's promise is still pending. Register it as a future
          // so bg.list shows it and the agent can bg.get(id) / bg.cancel(id).
          detached = true;
          //: one history, so no origin routing — the settle notice enqueues
          // into the single stream (B3).
          if (deps.bg) {
            bgId = deps.bg.registerFuture(code.slice(0, 200), guardedPromise, {
              childPids: scope.childPids, // adopt the run's live children
            });
            // Post-detach logs + sends (review S2): everything written
            // after detach lands in runLogbuf/scope.sends via runScope; deliver
            // the deltas with the settle notice (the pre-detach ones already went
            // out in the detached RunResult below).
            const postDetachStart = runLogbuf.length;
            const postDetachSends = scope.sends.length;
            const lateLogs = () =>
              capLines(
                runLogbuf.slice(postDetachStart).join('\n'),
                deps.config.sandbox.logMaxBytes,
              );
            const lateSends = () => scope.sends.slice(postDetachSends);
            guardedPromise.then(
              (v) => {
                if (deps.bg!.settleFuture(bgId!, v, false)) {
                  deps.onFutureSettled?.(
                    bgId!,
                    v,
                    false,
                    lateLogs(),
                    lateSends(),
                  );
                }
              },
              (e) => {
                const msg = friendlyRunError(e);
                if (deps.bg!.settleFuture(bgId!, msg, true)) {
                  deps.onFutureSettled?.(
                    bgId!,
                    msg,
                    true,
                    lateLogs(),
                    lateSends(),
                  );
                }
              },
            );
          } else {
            processErrorTrap.fail();
          }
        } else {
          value = raced;
        }
      } finally {
        clearDeadline();
      }
    } catch (err) {
      if (!guardedPromise) processErrorTrap.fail();
      return {
        ok: false,
        failureKind: 'runtime',
        error: friendlyRunError(err),
        logs: capLines(runLogbuf.join('\n'), deps.config.sandbox.logMaxBytes),
      };
    }

    if (detached) {
      return {
        ok: true,
        detached: true,
        bgId,
        preview: bgId
          ? `detached — still running; result will be delivered as [bg <${bgId}>] when it settles. Check bg.list() / bg.get('${bgId}').`
          : 'detached (no bg registry — result lost on settle)',
        note: 'still running — result delivered as a bg future',
        logs: capLines(runLogbuf.join('\n'), deps.config.sandbox.logMaxBytes),
        sends: scope.sends.length > 0 ? scope.sends.slice() : undefined,
      };
    }

    // Only reassign `_` when the completion value is not undefined. A run that
    // ends in console.log(...) or an assignment-only statement leaves `_`
    // holding its prior value (the agent can keep using it). Without this, a
    // log-final run overwrites `_` with a meaningless number and downstream code
    // that trusts `_` breaks with TypeErrors.
    const stored = value !== undefined;
    if (stored && deps.surface !== 'core')
      (ctx as unknown as { _: unknown })._ = value;
    return {
      ok: true,
      preview: stored
        ? preview(value, deps.config.sandbox.previewMaxBytes)
        : 'undefined (previous _ preserved)',
      savedAs: stored && deps.surface !== 'core' ? '_' : undefined,
      logs: capLines(runLogbuf.join('\n'), deps.config.sandbox.logMaxBytes),
      sends: scope.sends.length > 0 ? scope.sends.slice() : undefined,
    };
  }

  return { run };
}
