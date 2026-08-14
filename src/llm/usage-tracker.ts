// usage-tracker.ts — provider subscription-usage poller for the operator
// surfaces (Elpis Console rail widget + the /usage slash command).
//
// The provider is AUTO-DETECTED from llm.base_url via a small registry; when
// nothing matches (or usage_tracker.enabled is false) the factory returns null
// and the feature simply does not exist for this boot. The only provider today
// is Kimi Coding Plan: GET {base_url}/usages (→ /usage on 404) with the
// harness's own llm.api_key and a KimiCLI user-agent. The adapter normalizes the
// provider response into a generic usage snapshot.
//
// INVARIANTS:
// - This is operator plumbing: it never throws into the caller, never touches
// the agent loop / history / transcript, never routes to error_channel_id.
// Failures keep the last snapshot, set `error`, and log at warn.
// - Polling is a chained setTimeout (the Scheduler pattern), started/stopped
// explicitly by index.ts; onUpdate fires after EVERY poll (success or
// failure) so the console re-broadcasts.
// - fetch is injected for tests (fetchFn); default is the global fetch.

import type { Config } from '../config.js';

/** One rate-limit window as the UI renders it. */
export interface UsageWindow {
  id: string;
  /** Display label synthesized from the window duration ('5h', '7d', '1mo'). */
  label: string;
  /** 0–100 (may exceed 100 if the API reports overage; the UI clamps). */
  usedPct: number;
  /** ISO timestamp of the window reset, when the API provides one. */
  resetAt: string | null;
}

/** Normalized, provider-agnostic snapshot pushed to the console + /usage. */
export interface ProviderUsageSnapshot {
  provider: string;
  label: string;
  /** ISO timestamp of the last SUCCESSFUL fetch ('' before the first). */
  fetchedAt: string;
  windows: UsageWindow[];
  /** Set when the most recent poll failed (windows are then stale). */
  error: string | null;
}

export interface UsageTracker {
  start(): void;
  stop(): void;
  snapshot(): ProviderUsageSnapshot | null;
  /** Immediate poll (for /usage). Resolves to the updated snapshot; on failure
 * resolves to the stale snapshot with `error` set. Never rejects. */
  fetchNow(): Promise<ProviderUsageSnapshot | null>;
}

interface UsageProvider {
  id: string;
  label: string;
  matches(baseUrl: string): boolean;
  fetch(llm: Config['llm'], fetchFn: typeof fetch): Promise<UsageWindow[]>;
}

// ---------------------------------------------------------------------------
// Kimi (Coding Plan)
// ---------------------------------------------------------------------------

const UNIT_SECONDS: Record<string, number> = {
  TIME_UNIT_SECOND: 1,
  TIME_UNIT_MINUTE: 60,
  TIME_UNIT_HOUR: 3600,
  TIME_UNIT_DAY: 86400,
  TIME_UNIT_WEEK: 604800,
  TIME_UNIT_MONTH: 2592000,
};

/** '5h' from (300, TIME_UNIT_MINUTE); '7d', '1mo', '90m' likewise. Exported
 * for unit tests. Falls back to raw minutes/seconds when not a round hour. */
export function windowLabel(duration: number, timeUnit: string): string {
  const secs = (UNIT_SECONDS[timeUnit] ?? 0) * duration;
  if (secs <= 0) return `${duration}?`;
  if (secs >= 2592000 && secs % 2592000 === 0) return `${secs / 2592000}mo`;
  if (secs >= 86400 && secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

const WEEK_SECONDS = 604800;

/** Parse the Kimi /usages payload into normalized windows, shortest first.
 * Top-level `usage` is the weekly (7d) summary; each `limits[]` row is a
 * window labeled from its duration+timeUnit. Numeric fields arrive as
 * STRINGS; `limit` is the percent base (verified 100 ⇒ percent points).
 * Rows with a missing/zero limit are skipped. Tolerant of any shape. */
export function parseKimiUsages(payload: unknown): UsageWindow[] {
  const p = (payload ?? {}) as Record<string, unknown>;
  const out: { win: UsageWindow; secs: number }[] = [];

  const toWindow = (detail: unknown, label: string, secs: number): UsageWindow | null => {
    if (detail === null || typeof detail !== 'object') return null;
    const d = detail as Record<string, unknown>;
    const limit = Number(d.limit);
    const used = Number(d.used);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
    return {
      id: label,
      label,
      usedPct: (used / limit) * 100,
      resetAt: typeof d.resetTime === 'string' ? d.resetTime : null,
    };
  };

  if (Array.isArray(p.limits)) {
    for (const row of p.limits) {
      if (row === null || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      const w = (r.window ?? {}) as Record<string, unknown>;
      const duration = Number(w.duration);
      const unit = typeof w.timeUnit === 'string' ? w.timeUnit : '';
      const secs = (UNIT_SECONDS[unit] ?? 0) * (Number.isFinite(duration) ? duration : 0);
      const label = windowLabel(Number.isFinite(duration) ? duration : 0, unit);
      const win = toWindow(r.detail, label, secs);
      if (win) out.push({ win, secs });
    }
  }

 // The top-level summary is the weekly window; skip it if a limits[] row
 // already covers the same 7d span (avoids a duplicate bar).
  if (!out.some((o) => o.secs === WEEK_SECONDS)) {
    const weekly = toWindow(p.usage, '7d', WEEK_SECONDS);
    if (weekly) out.push({ win: weekly, secs: WEEK_SECONDS });
  }

  out.sort((a, b) => a.secs - b.secs);
  return out.map((o) => o.win);
}

const kimiProvider: UsageProvider = {
  id: 'kimi',
  label: 'Kimi',
  matches(baseUrl: string): boolean {
    try {
      const u = new URL(baseUrl);
      return u.hostname === 'api.kimi.com' && u.pathname.startsWith('/coding');
    } catch {
      return false;
    }
  },
  async fetch(llm, fetchFn) {
    const base = llm.baseUrl.replace(/\/+$/, '');
    const headers = { Authorization: `Bearer ${llm.apiKey}`, 'User-Agent': 'KimiCLI/1.6' };
 // Bounded so a hung connection can't stall the poll chain (or a /usage
 // interaction) for undici's much longer default body timeout.
    const opts = () => ({ headers, signal: AbortSignal.timeout(15_000) });
    let res = await fetchFn(`${base}/usages`, opts());
    if (res.status === 404) res = await fetchFn(`${base}/usage`, opts());
    if (!res.ok) throw new Error(`usage fetch failed: HTTP ${res.status}`);
    return parseKimiUsages(await res.json());
  },
};

const PROVIDERS: UsageProvider[] = [kimiProvider];

/** The registry scan, exported for tests. Returns the matching provider's
 * {id,label} or null. */
export function detectProvider(baseUrl: string): { id: string; label: string } | null {
  const p = PROVIDERS.find((pr) => pr.matches(baseUrl));
  return p ? { id: p.id, label: p.label } : null;
}

// ---------------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------------

const FIRST_POLL_DELAY_MS = 5000;
/** Reschedule floor — a mis-set poll_interval_ms can't turn into a hot loop. */
const MIN_POLL_INTERVAL_MS = 60_000;

/** Build the tracker, or null when the feature is inactive for this boot
 * (no provider matches llm.base_url, or usage_tracker.enabled is false). */
export function createUsageTracker(
  config: Config,
  onUpdate: () => void,
  fetchFn: typeof fetch = fetch,
): UsageTracker | null {
  if (!config.usageTracker.enabled) return null;
  const provider = PROVIDERS.find((p) => p.matches(config.llm.baseUrl));
  if (!provider) return null;

  const logger = config.logger;
  let current: ProviderUsageSnapshot | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  async function poll(): Promise<ProviderUsageSnapshot | null> {
 // Non-null: `provider` is guaranteed defined here (early return above),
 // but TS's control-flow narrowing doesn't cross this closure boundary.
    try {
      const windows = await provider!.fetch(config.llm, fetchFn);
      current = {
        provider: provider!.id,
        label: provider!.label,
        fetchedAt: new Date().toISOString(),
        windows,
        error: null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`usage-tracker: ${provider!.id} poll failed: ${msg}`);
      current = {
        provider: provider!.id,
        label: provider!.label,
        fetchedAt: current?.fetchedAt ?? '',
        windows: current?.windows ?? [],
        error: msg,
      };
    }
    try { onUpdate(); } catch { /* a broken observer must never break polling */ }
    return current;
  }

  function schedule(delayMs: number): void {
    if (stopped) return;
    timer = setTimeout(() => {
 // Floored so a mis-set poll_interval_ms (e.g. 0) can't hammer the API.
      void poll().finally(() => schedule(Math.max(MIN_POLL_INTERVAL_MS, config.usageTracker.pollIntervalMs)));
    }, delayMs);
  }

  return {
    start(): void {
      if (stopped || timer) return;
      schedule(FIRST_POLL_DELAY_MS);
    },
    stop(): void {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
    },
    snapshot(): ProviderUsageSnapshot | null {
      return current;
    },
    fetchNow(): Promise<ProviderUsageSnapshot | null> {
      return poll();
    },
  };
}
