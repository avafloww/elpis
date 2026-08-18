import { parseDuration } from '../config.js';

export const MAX_RUN_WAKE_MS = 24 * 60 * 60 * 1000;

export type RunWakeRequest = { after: unknown } | { at: unknown };
export type ParsedRunWake =
  | { kind: 'after'; delayMs: number }
  | { kind: 'at'; targetAt: number };

export interface ResolvedRunWake {
  armAt: number | null;
  elapsed: boolean;
}

export interface ParsedRunCall {
  code: string;
  sandbox?: string;
  wake?: ParsedRunWake;
}

export interface DurableRunWakePayload {
  type: 'elpis-run-wake-v3';
  kind: 'after' | 'at';
  state: 'armed' | 'preempted' | 'fired';
  requestedAt: number;
  targetAt: number;
}

export const RUN_WAKE_TASK_PREFIX = '__elpis_run_wake_v3__';

export function parseRunWake(value: unknown, dispatchAt = Date.now()): ParsedRunWake {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('run wake must be exactly { after: <duration> } or { at: <ISO timestamp> }');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || (keys[0] !== 'after' && keys[0] !== 'at')) {
    throw new Error('run wake must contain exactly one key: after or at');
  }
  if (keys[0] === 'after') {
    const delayMs = parseDuration(record.after, 'wake.after', 'run');
    if (!Number.isFinite(delayMs) || delayMs <= 0) throw new Error('run wake.after must be greater than zero');
    if (delayMs >= MAX_RUN_WAKE_MS) throw new Error('run wake.after must be less than 24h');
    return { kind: 'after', delayMs };
  }
  if (typeof record.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.at)) {
    throw new Error('run wake.at must be an ISO-8601 timestamp with timezone');
  }
  const targetAt = Date.parse(record.at);
  if (!Number.isFinite(targetAt)) throw new Error('run wake.at must be a valid ISO-8601 timestamp');
  const delayMs = targetAt - dispatchAt;
  if (delayMs <= 0) throw new Error('run wake.at must be strictly in the future');
  if (delayMs >= MAX_RUN_WAKE_MS) throw new Error('run wake.at must be less than 24h from dispatch');
  return { kind: 'at', targetAt };
}

export function resolveRunWake(wake: ParsedRunWake, completedAt = Date.now()): ResolvedRunWake {
  if (wake.kind === 'after') return { armAt: completedAt + wake.delayMs, elapsed: false };
  if (wake.targetAt <= completedAt) return { armAt: null, elapsed: true };
  return { armAt: wake.targetAt, elapsed: false };
}

export function parseRunCallArguments(raw: string, dispatchAt = Date.now()): ParsedRunCall {
  let parsed: unknown;
  try { parsed = JSON.parse(raw || '{}'); }
  catch { throw new Error('run arguments must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('run arguments must be an object');
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(['code', 'sandbox', 'wake']);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0) throw new Error(`run arguments contain unsupported key${extra.length === 1 ? '' : 's'}: ${extra.join(', ')}`);
  if (typeof record.code !== 'string') throw new Error('run.code must be a string');
  const result: ParsedRunCall = { code: record.code };
  if (record.sandbox !== undefined) {
    if (typeof record.sandbox !== 'string' || !record.sandbox.trim()) throw new Error('run.sandbox must be a non-empty exact alias');
    result.sandbox = record.sandbox;
  }
  if (record.wake !== undefined) result.wake = parseRunWake(record.wake, dispatchAt);
  return result;
}

export function encodeRunWakePayload(payload: DurableRunWakePayload): string {
  return JSON.stringify(payload);
}

export function parseRunWakePayload(raw: string): DurableRunWakePayload | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.type !== 'elpis-run-wake-v3') return null;
  if (value.kind !== 'after' && value.kind !== 'at') return null;
  if (value.state !== 'armed' && value.state !== 'preempted' && value.state !== 'fired') return null;
  if (!Number.isSafeInteger(value.requestedAt) || !Number.isSafeInteger(value.targetAt)) return null;
  return {
    type: 'elpis-run-wake-v3', kind: value.kind, state: value.state,
    requestedAt: value.requestedAt as number, targetAt: value.targetAt as number,
  };
}
