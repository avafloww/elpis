import { parseDuration } from "../config.js";

export const MAX_RUN_WAKE_MS = 60 * 60 * 1000;
export const MAX_RUN_DETAIL_CHARS = 120;
export const MAX_RUN_DETAIL_WORDS = 10;

export type RunWakeRequest =
  { after: unknown } | { at: unknown } | { auto: unknown };
export type ParsedRunWake =
  | { kind: "after"; delayMs: number }
  | { kind: "at"; targetAt: number }
  | { kind: "auto" };

export interface ResolvedRunWake {
  armAt: number | null;
  elapsed: boolean;
}

export interface ParsedRunCall {
  code: string;
  detail: string;
  sandbox?: string;
  wake?: ParsedRunWake;
}

export interface DurableRunWakePayload {
  type: "elpis-run-wake-v3";
  kind: "after" | "at" | "auto";
  state: "armed" | "preempted" | "fired";
  requestedAt: number;
  targetAt: number;
  advice?: {
    source: "classifier" | "fallback";
    delayMs: number;
    reason: string;
  };
}

export const RUN_WAKE_TASK_PREFIX = "__elpis_run_wake_v3__";

export function parseRunWake(
  value: unknown,
  dispatchAt = Date.now(),
): ParsedRunWake {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "run wake must be exactly { after: <duration> }, { at: <ISO timestamp> }, or { auto: true }",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 1 ||
    (keys[0] !== "after" && keys[0] !== "at" && keys[0] !== "auto")
  ) {
    throw new Error(
      "run wake must contain exactly one key: after, at, or auto",
    );
  }
  if (keys[0] === "auto") {
    if (record.auto !== true)
      throw new Error("run wake.auto must be exactly true");
    return { kind: "auto" };
  }
  if (keys[0] === "after") {
    const delayMs = parseDuration(record.after, "wake.after", "run");
    if (!Number.isFinite(delayMs) || delayMs <= 0)
      throw new Error("run wake.after must be greater than zero");
    if (delayMs > MAX_RUN_WAKE_MS)
      throw new Error("run wake.after must be at most 1h");
    return { kind: "after", delayMs };
  }
  if (
    typeof record.at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      record.at,
    )
  ) {
    throw new Error("run wake.at must be an ISO-8601 timestamp with timezone");
  }
  const targetAt = Date.parse(record.at);
  if (!Number.isFinite(targetAt))
    throw new Error("run wake.at must be a valid ISO-8601 timestamp");
  const delayMs = targetAt - dispatchAt;
  if (delayMs <= 0)
    throw new Error("run wake.at must be strictly in the future");
  if (delayMs > MAX_RUN_WAKE_MS)
    throw new Error("run wake.at must be at most 1h from dispatch");
  return { kind: "at", targetAt };
}

export function resolveRunWake(
  wake: Exclude<ParsedRunWake, { kind: "auto" }>,
  completedAt = Date.now(),
): ResolvedRunWake {
  if (wake.kind === "after")
    return { armAt: completedAt + wake.delayMs, elapsed: false };
  if (wake.targetAt <= completedAt) return { armAt: null, elapsed: true };
  return { armAt: wake.targetAt, elapsed: false };
}

export function parseRunCallArguments(
  raw: string,
  dispatchAt = Date.now(),
): ParsedRunCall {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    throw new Error("run arguments must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("run arguments must be an object");
  const record = parsed as Record<string, unknown>;
  const allowed = new Set(["code", "detail", "sandbox", "wake"]);
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length > 0)
    throw new Error(
      `run arguments contain unsupported key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}`,
    );
  if (typeof record.code !== "string")
    throw new Error("run.code must be a string");
  if (typeof record.detail !== "string")
    throw new Error("run.detail must be a string");
  const detail = record.detail.trim();
  if (!detail) throw new Error("run.detail must not be empty");
  if (/\r|\n/.test(detail)) throw new Error("run.detail must be a single line");
  if (detail.length > MAX_RUN_DETAIL_CHARS)
    throw new Error(
      `run.detail must be at most ${MAX_RUN_DETAIL_CHARS} characters`,
    );
  if (detail.split(/\s+/).length > MAX_RUN_DETAIL_WORDS)
    throw new Error(`run.detail must be at most ${MAX_RUN_DETAIL_WORDS} words`);
  const result: ParsedRunCall = { code: record.code, detail };
  if (record.sandbox !== undefined) {
    if (typeof record.sandbox !== "string" || !record.sandbox.trim())
      throw new Error(
        "run.sandbox must be a non-empty Mind id, unique prefix, or exact title",
      );
    result.sandbox = record.sandbox;
  }
  if (record.wake !== undefined)
    result.wake = parseRunWake(record.wake, dispatchAt);
  return result;
}

export function encodeRunWakePayload(payload: DurableRunWakePayload): string {
  return JSON.stringify(payload);
}

export function parseRunWakePayload(raw: string): DurableRunWakePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const value = parsed as Record<string, unknown>;
  if (value.type !== "elpis-run-wake-v3") return null;
  if (value.kind !== "after" && value.kind !== "at" && value.kind !== "auto")
    return null;
  if (
    value.state !== "armed" &&
    value.state !== "preempted" &&
    value.state !== "fired"
  )
    return null;
  if (
    !Number.isSafeInteger(value.requestedAt) ||
    !Number.isSafeInteger(value.targetAt)
  )
    return null;
  const result: DurableRunWakePayload = {
    type: "elpis-run-wake-v3",
    kind: value.kind,
    state: value.state,
    requestedAt: value.requestedAt as number,
    targetAt: value.targetAt as number,
  };
  if (
    value.advice &&
    typeof value.advice === "object" &&
    !Array.isArray(value.advice)
  ) {
    const advice = value.advice as Record<string, unknown>;
    if (
      (advice.source === "classifier" || advice.source === "fallback") &&
      Number.isSafeInteger(advice.delayMs) &&
      (advice.delayMs as number) > 0 &&
      (advice.delayMs as number) <= MAX_RUN_WAKE_MS &&
      typeof advice.reason === "string" &&
      advice.reason.length > 0 &&
      advice.reason.length <= 64
    ) {
      result.advice = {
        source: advice.source,
        delayMs: advice.delayMs as number,
        reason: advice.reason,
      };
    }
  }
  return result;
}
