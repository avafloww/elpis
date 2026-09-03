import type { MindId } from '../store/mind-id.js';

export const RUN_OPERATION_RECEIPT_MAX_COUNT = 16;
export const RUN_OPERATION_COMMAND_MAX_BYTES = 2_048;
export const RUN_OPERATION_STREAM_MAX_BYTES = 4_096;
export const RUN_OPERATION_ERROR_MAX_BYTES = 1_024;

export interface RunOperationReceipt {
  sequence: number;
  kind: 'shell' | 'git' | 'file';
  name: string;
  command: string;
  commandBytes?: number;
  commandTruncated?: boolean;
  state: 'running' | 'completed' | 'failed';
  startedAt: number;
  durationMs?: number;
  ok?: boolean;
  code?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  error?: string;
}

export interface SandboxExecutionMetadata {
  kind: 'ephemeral' | 'persistent';
  lifecycle?: 'ephemeral' | 'ready' | 'busy' | 'detached' | 'reset' | 'retired';
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
  kind: 'after' | 'at' | 'auto';
  state: 'armed' | 'elapsed' | 'rejected' | 'preempted' | 'fired';
  requestedAt: number;
  targetAt?: number;
  taskId?: number;
  note?: string;
  advice?: {
    source: 'classifier' | 'fallback';
    delayMs: number;
    reason: string;
  };
}

export interface RunMessageMetadata {
  toolContractVersion: string;
  ok: boolean;
  detail?: string;
  failureKind?: 'preparse' | 'runtime' | 'context';
  execution?: SandboxExecutionMetadata;
  detached?: boolean;
  bgId?: string;
  wake?: RunWakeMetadata;
  operationReceipts?: RunOperationReceipt[];
  operationReceiptsDropped?: number;
}

function boundedString(value: unknown, max = 512): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    ? value
    : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : undefined;
}

function boundedUtf8String(
  value: unknown,
  maxBytes: number,
  allowEmpty = false,
): string | undefined {
  return typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value, 'utf8') <= maxBytes
    ? value
    : undefined;
}

function parseOperationReceipt(
  raw: unknown,
  expectedSequence: number,
): RunOperationReceipt | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const source = raw as Record<string, unknown>;
  if (finiteInteger(source.sequence) !== expectedSequence) return undefined;
  if (
    source.kind !== 'shell' &&
    source.kind !== 'git' &&
    source.kind !== 'file'
  )
    return undefined;
  const name = boundedUtf8String(source.name, 64);
  const command = boundedUtf8String(
    source.command,
    RUN_OPERATION_COMMAND_MAX_BYTES,
    true,
  );
  if (!name || command === undefined) return undefined;
  if (
    source.state !== 'running' &&
    source.state !== 'completed' &&
    source.state !== 'failed'
  )
    return undefined;
  const startedAt = finiteInteger(source.startedAt);
  if (startedAt === undefined || startedAt < 0) return undefined;
  const receipt: RunOperationReceipt = {
    sequence: expectedSequence,
    kind: source.kind,
    name,
    command,
    state: source.state,
    startedAt,
  };
  for (const key of [
    'commandBytes',
    'durationMs',
    'stdoutBytes',
    'stderrBytes',
  ] as const) {
    const value = finiteInteger(source[key]);
    if (value !== undefined && value >= 0) receipt[key] = value;
  }
  for (const key of [
    'commandTruncated',
    'stdoutTruncated',
    'stderrTruncated',
  ] as const) {
    if (typeof source[key] === 'boolean') receipt[key] = source[key];
  }
  if (typeof source.ok === 'boolean') receipt.ok = source.ok;
  if (source.code === null) receipt.code = null;
  else {
    const code = finiteInteger(source.code);
    if (code !== undefined) receipt.code = code;
  }
  if (source.signal === null) receipt.signal = null;
  else {
    const signal = boundedUtf8String(source.signal, 64);
    if (signal) receipt.signal = signal;
  }
  const stdout = boundedUtf8String(
    source.stdout,
    RUN_OPERATION_STREAM_MAX_BYTES,
  );
  if (stdout) receipt.stdout = stdout;
  const stderr = boundedUtf8String(
    source.stderr,
    RUN_OPERATION_STREAM_MAX_BYTES,
  );
  if (stderr) receipt.stderr = stderr;
  const error = boundedUtf8String(source.error, RUN_OPERATION_ERROR_MAX_BYTES);
  if (error) receipt.error = error;
  if (receipt.state === 'running') return receipt;
  if (receipt.durationMs === undefined || receipt.ok === undefined)
    return undefined;
  if (receipt.state === 'failed' && receipt.ok !== false) return undefined;
  return receipt;
}

export function parseRunMessageMetadata(
  raw: unknown,
): RunMessageMetadata | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const toolContractVersion = boundedString(value.toolContractVersion, 128);
  if (!toolContractVersion || typeof value.ok !== 'boolean') return undefined;
  const parsed: RunMessageMetadata = { toolContractVersion, ok: value.ok };
  const detail = boundedString(value.detail, 120);
  if (
    detail &&
    !/[\r\n]/.test(detail) &&
    detail.trim().split(/\s+/).length <= 10
  )
    parsed.detail = detail.trim();
  if (
    value.failureKind === 'preparse' ||
    value.failureKind === 'runtime' ||
    value.failureKind === 'context'
  )
    parsed.failureKind = value.failureKind;
  if (typeof value.detached === 'boolean') parsed.detached = value.detached;
  const bgId = boundedString(value.bgId, 128);
  if (bgId) parsed.bgId = bgId;

  if (
    value.execution &&
    typeof value.execution === 'object' &&
    !Array.isArray(value.execution)
  ) {
    const source = value.execution as Record<string, unknown>;
    if (source.kind === 'ephemeral' || source.kind === 'persistent') {
      const execution: SandboxExecutionMetadata = { kind: source.kind };
      if (
        source.lifecycle === 'ephemeral' ||
        source.lifecycle === 'ready' ||
        source.lifecycle === 'busy' ||
        source.lifecycle === 'detached' ||
        source.lifecycle === 'reset' ||
        source.lifecycle === 'retired'
      )
        execution.lifecycle = source.lifecycle;
      const alias = boundedString(source.alias, 256);
      if (alias) execution.alias = alias;
      const mindId = boundedString(source.mindId, 32);
      if (mindId?.startsWith('elm-')) execution.mindId = mindId as MindId;
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
        'coldStart',
        'created',
        'retiring',
        'statusReminder',
        'classifierReminder',
      ] as const) {
        if (typeof source[key] === 'boolean') execution[key] = source[key];
      }
      parsed.execution = execution;
    }
  }

  const operationReceiptsDropped = finiteInteger(
    value.operationReceiptsDropped,
  );
  if (operationReceiptsDropped !== undefined && operationReceiptsDropped > 0)
    parsed.operationReceiptsDropped = operationReceiptsDropped;

  if (Array.isArray(value.operationReceipts)) {
    const receipts: RunOperationReceipt[] = [];
    const count = Math.min(
      value.operationReceipts.length,
      RUN_OPERATION_RECEIPT_MAX_COUNT,
    );
    let valid = true;
    for (let index = 0; index < count; index++) {
      const receipt = parseOperationReceipt(
        value.operationReceipts[index],
        index,
      );
      if (!receipt) {
        valid = false;
        break;
      }
      receipts.push(receipt);
    }
    if (valid) parsed.operationReceipts = receipts;
  }

  if (
    value.wake &&
    typeof value.wake === 'object' &&
    !Array.isArray(value.wake)
  ) {
    const source = value.wake as Record<string, unknown>;
    const kind =
      source.kind === 'after' || source.kind === 'at' || source.kind === 'auto'
        ? source.kind
        : undefined;
    const states: RunWakeMetadata['state'][] = [
      'armed',
      'elapsed',
      'rejected',
      'preempted',
      'fired',
    ];
    const state = states.includes(source.state as RunWakeMetadata['state'])
      ? (source.state as RunWakeMetadata['state'])
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
        typeof source.advice === 'object' &&
        !Array.isArray(source.advice)
      ) {
        const rawAdvice = source.advice as Record<string, unknown>;
        const reason = boundedString(rawAdvice.reason, 64);
        const delayMs = finiteInteger(rawAdvice.delayMs);
        if (
          (rawAdvice.source === 'classifier' ||
            rawAdvice.source === 'fallback') &&
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
