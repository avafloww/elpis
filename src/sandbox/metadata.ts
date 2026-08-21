import type { MindId } from "../store/mind-id.js";

export interface SandboxExecutionMetadata {
  kind: "ephemeral" | "persistent";
  lifecycle?: "ephemeral" | "ready" | "busy" | "detached" | "reset" | "retired";
  alias?: string;
  mindId?: MindId;
  mindTitle?: string;
  mindStatus?: string;
  latestComment?: string | null;
  executorId?: string;
  generation?: number;
  resetGeneration?: number;
  runId?: string;
  coldStart?: boolean;
  created?: boolean;
  retiring?: boolean;
  retirementDeadlineAt?: number;
  retirementWarning?: string;
  statusReminder?: boolean;
  classifierReminder?: boolean;
}

export interface RunWakeMetadata {
  kind: "after" | "at" | "auto";
  state: "armed" | "elapsed" | "rejected" | "preempted" | "fired";
  requestedAt: number;
  targetAt?: number;
  taskId?: number;
  note?: string;
  advice?: {
    source: "classifier" | "fallback";
    delayMs: number;
    reason: string;
  };
}

export interface RunMessageMetadata {
  toolContractVersion: string;
  ok: boolean;
  detail?: string;
  failureKind?: "preparse" | "runtime";
  execution?: SandboxExecutionMetadata;
  detached?: boolean;
  bgId?: string;
  wake?: RunWakeMetadata;
}

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : undefined;
}

export function parseRunMessageMetadata(
  raw: unknown,
): RunMessageMetadata | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const toolContractVersion = boundedString(value.toolContractVersion, 128);
  if (!toolContractVersion || typeof value.ok !== "boolean") return undefined;
  const parsed: RunMessageMetadata = { toolContractVersion, ok: value.ok };
  const detail = boundedString(value.detail, 120);
  if (
    detail &&
    !/[\r\n]/.test(detail) &&
    detail.trim().split(/\s+/).length <= 10
  )
    parsed.detail = detail.trim();
  if (value.failureKind === "preparse" || value.failureKind === "runtime")
    parsed.failureKind = value.failureKind;
  if (typeof value.detached === "boolean") parsed.detached = value.detached;
  const bgId = boundedString(value.bgId, 128);
  if (bgId) parsed.bgId = bgId;

  if (
    value.execution &&
    typeof value.execution === "object" &&
    !Array.isArray(value.execution)
  ) {
    const source = value.execution as Record<string, unknown>;
    if (source.kind === "ephemeral" || source.kind === "persistent") {
      const execution: SandboxExecutionMetadata = { kind: source.kind };
      if (
        source.lifecycle === "ephemeral" ||
        source.lifecycle === "ready" ||
        source.lifecycle === "busy" ||
        source.lifecycle === "detached" ||
        source.lifecycle === "reset" ||
        source.lifecycle === "retired"
      )
        execution.lifecycle = source.lifecycle;
      const alias = boundedString(source.alias, 256);
      if (alias) execution.alias = alias;
      const mindId = boundedString(source.mindId, 32);
      if (mindId?.startsWith("elm-")) execution.mindId = mindId as MindId;
      const mindTitle = boundedString(source.mindTitle, 512);
      if (mindTitle) execution.mindTitle = mindTitle;
      const mindStatus = boundedString(source.mindStatus, 64);
      if (mindStatus) execution.mindStatus = mindStatus;
      if (source.latestComment === null) execution.latestComment = null;
      else {
        const comment = boundedString(source.latestComment, 512);
        if (comment) execution.latestComment = comment;
      }
      const executorId = boundedString(source.executorId, 128);
      if (executorId) execution.executorId = executorId;
      const generation = finiteInteger(source.generation);
      if (generation !== undefined) execution.generation = generation;
      const resetGeneration = finiteInteger(source.resetGeneration);
      if (resetGeneration !== undefined)
        execution.resetGeneration = resetGeneration;
      const runId = boundedString(source.runId, 256);
      if (runId) execution.runId = runId;
      const retirementDeadlineAt = finiteInteger(source.retirementDeadlineAt);
      if (retirementDeadlineAt !== undefined)
        execution.retirementDeadlineAt = retirementDeadlineAt;
      const retirementWarning = boundedString(source.retirementWarning, 512);
      if (retirementWarning) execution.retirementWarning = retirementWarning;
      for (const key of [
        "coldStart",
        "created",
        "retiring",
        "statusReminder",
        "classifierReminder",
      ] as const) {
        if (typeof source[key] === "boolean") execution[key] = source[key];
      }
      parsed.execution = execution;
    }
  }

  if (
    value.wake &&
    typeof value.wake === "object" &&
    !Array.isArray(value.wake)
  ) {
    const source = value.wake as Record<string, unknown>;
    const kind =
      source.kind === "after" || source.kind === "at" || source.kind === "auto"
        ? source.kind
        : undefined;
    const states: RunWakeMetadata["state"][] = [
      "armed",
      "elapsed",
      "rejected",
      "preempted",
      "fired",
    ];
    const state = states.includes(source.state as RunWakeMetadata["state"])
      ? (source.state as RunWakeMetadata["state"])
      : undefined;
    const requestedAt = finiteInteger(source.requestedAt);
    if (kind && state && requestedAt !== undefined) {
      const wake: RunWakeMetadata = { kind, state, requestedAt };
      const targetAt = finiteInteger(source.targetAt);
      if (targetAt !== undefined) wake.targetAt = targetAt;
      const taskId = finiteInteger(source.taskId);
      if (taskId !== undefined) wake.taskId = taskId;
      const note = boundedString(source.note, 512);
      if (note) wake.note = note;
      if (
        source.advice &&
        typeof source.advice === "object" &&
        !Array.isArray(source.advice)
      ) {
        const rawAdvice = source.advice as Record<string, unknown>;
        const reason = boundedString(rawAdvice.reason, 64);
        const delayMs = finiteInteger(rawAdvice.delayMs);
        if (
          (rawAdvice.source === "classifier" ||
            rawAdvice.source === "fallback") &&
          reason &&
          delayMs !== undefined &&
          delayMs > 0 &&
          delayMs <= 60 * 60_000
        ) {
          wake.advice = { source: rawAdvice.source, delayMs, reason };
        }
      }
      parsed.wake = wake;
    }
  }
  return parsed;
}
