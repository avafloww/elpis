// log.ts — leveled process logger.
//
// A small leveled logger so the harness can be quiet or verbose without code
// changes. `createLogger(level)` returns a `Logger` whose `.debug/.info/.warn/
// .error` methods are no-ops below the configured level, so calls are cheap
// and can stay in hot paths (the loop, tool dispatch).
//
// All output goes to `console.error` (stderr) with an `[harness]` prefix and an
// ISO timestamp, matching the prior behavior — journals and existing tooling
// keep working. `noopLogger` is a fully-levelled no-op for tests that want zero
// output without sprinkling `log: => {}` stubs.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Numeric rank so level comparisons are cheap. `silent` is -1 (below debug):
 * nothing prints. */
const RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: -1,
};

export interface Logger {
  debug(...a: unknown[]): void;
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

const noop = () => {};

/** Optional tee of every emitted log line to a sink (the operator console's log
 * pane relays the same lines it would find in journalctl). Set once at boot via
 * `setLogSink`; a throwing sink must never break logging, so calls are guarded.
 * The sink receives the level and the joined message text (no prefix/timestamp —
 * the sink stamps its own). */
export type LogSink = (
  level: Exclude<LogLevel, 'silent'>,
  message: string,
) => void;
let logSink: LogSink | null = null;
export function setLogSink(sink: LogSink | null): void {
  logSink = sink;
}

function stringifyArg(x: unknown): string {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || x.message;
  try {
    return typeof x === 'object' ? JSON.stringify(x) : String(x);
  } catch {
    return String(x);
  }
}

function emit(level: LogLevel, prefix: string, a: unknown[]): void {
  const ts = new Date().toISOString();
  // single console.error call so a multi-arg line stays one journal line
  console.error(`${prefix} ${ts} [${level}]`, ...a);
  if (logSink && level !== 'silent') {
    try {
      logSink(level, a.map(stringifyArg).join(' '));
    } catch {
      // a broken sink must never take down logging
    }
  }
}

export function createLogger(
  level: LogLevel = 'info',
  prefix = '[harness]',
): Logger {
  const rank = RANK[level] ?? RANK.info;
  const bind = (lvl: LogLevel) =>
    rank >= 0 && RANK[lvl] >= rank
      ? (...a: unknown[]) => emit(lvl, prefix, a)
      : noop;
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
  };
}

/** A fully-levelled logger that prints nothing. Use in tests instead of
 * `log: => {}` so every call site stays valid as the logger grows levels. */
export const noopLogger: Logger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
};

/** Parse a LOG_LEVEL env value into a LogLevel, defaulting to `info`.
 * Case-insensitive; unknown values fall back to `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? '').trim().toLowerCase();
  if (v in RANK) return v as LogLevel;
  return 'info';
}
