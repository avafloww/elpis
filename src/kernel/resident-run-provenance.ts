import { createHash, randomUUID } from 'node:crypto';

const BATCH_DOMAIN = 'elpis/resident-assistant-tool-batch/v1\n';
const SHA256 = /^[a-f0-9]{64}$/;
const BATCH_ID =
  /^resident-tool-batch:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_TOOL_CALLS = 64;
const MAX_TOOL_NAME_BYTES = 256;

declare const preparedBrand: unique symbol;
declare const tokenBrand: unique symbol;
declare const handleBrand: unique symbol;

export interface ResidentToolCallInput {
  toolName: string;
  arguments: string;
}

export interface RecordedResidentToolBatchV1 {
  readonly version: 1;
  readonly batchId: string;
  readonly batchSha256: string;
}

export interface ResidentToolCallSnapshotV1 extends RecordedResidentToolBatchV1 {
  readonly callIndex: number;
  readonly callCount: number;
  readonly toolName: string;
  readonly argumentsSha256: string;
}

export interface PreparedResidentToolBatch {
  readonly [preparedBrand]: true;
}

export interface ResidentRunToken {
  readonly [tokenBrand]: true;
}

export interface ResidentRunScopeHandle {
  readonly [handleBrand]: true;
}

export type ResidentRunLifecycle = 'active' | 'detached' | 'closed';

export interface PreparedResidentToolBatchResult {
  readonly prepared: PreparedResidentToolBatch;
  readonly record: RecordedResidentToolBatchV1;
}

export interface ResidentRunIssuer {
  prepare(
    calls: readonly ResidentToolCallInput[],
  ): PreparedResidentToolBatchResult;
  commit(prepared: PreparedResidentToolBatch): void;
  issue(
    prepared: PreparedResidentToolBatch,
    callIndex: number,
  ): ResidentRunToken;
}

export interface ResidentRunVerifier {
  accept(token: ResidentRunToken): ResidentRunScopeHandle;
  resolveActive(handle: ResidentRunScopeHandle): ResidentToolCallSnapshotV1;
  lifecycle(handle: ResidentRunScopeHandle): ResidentRunLifecycle;
  detach(handle: ResidentRunScopeHandle): void;
  close(handle: ResidentRunScopeHandle): void;
}

export interface ResidentRunAuthority {
  readonly issuer: ResidentRunIssuer;
  readonly verifier: ResidentRunVerifier;
}

interface PreparedState {
  readonly record: RecordedResidentToolBatchV1;
  readonly calls: readonly ResidentToolCallSnapshotV1[];
  committed: boolean;
  readonly issued: Set<number>;
}

interface TokenState {
  readonly snapshot: ResidentToolCallSnapshotV1;
  used: boolean;
}

interface HandleState {
  readonly snapshot: ResidentToolCallSnapshotV1;
  lifecycle: ResidentRunLifecycle;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function normalizeCalls(
  batchId: string,
  calls: readonly ResidentToolCallInput[],
): readonly ResidentToolCallSnapshotV1[] {
  if (
    !Array.isArray(calls) ||
    calls.length === 0 ||
    calls.length > MAX_TOOL_CALLS
  )
    throw new Error('resident run provenance: tool batch size is invalid');
  for (let callIndex = 0; callIndex < calls.length; callIndex++) {
    if (!Object.hasOwn(calls, callIndex))
      throw new Error('resident run provenance: tool batch is sparse');
  }
  const normalized = calls.map((call, callIndex) => {
    if (
      !call ||
      typeof call.toolName !== 'string' ||
      !call.toolName ||
      Buffer.byteLength(call.toolName, 'utf8') > MAX_TOOL_NAME_BYTES ||
      typeof call.arguments !== 'string'
    ) {
      throw new Error('resident run provenance: tool call is invalid');
    }
    return {
      version: 1 as const,
      batchId,
      batchSha256: '',
      callIndex,
      callCount: calls.length,
      toolName: call.toolName,
      argumentsSha256: sha256(call.arguments),
    };
  });
  const batchSha256 = computeResidentToolBatchSha256(batchId, normalized);
  return Object.freeze(
    normalized.map((call) => Object.freeze({ ...call, batchSha256 })),
  );
}

export function computeResidentToolBatchSha256(
  batchId: string,
  calls: readonly Pick<
    ResidentToolCallSnapshotV1,
    'callIndex' | 'toolName' | 'argumentsSha256'
  >[],
): string {
  if (!BATCH_ID.test(batchId))
    throw new Error('resident run provenance: batch id is invalid');
  if (
    !Array.isArray(calls) ||
    calls.length === 0 ||
    calls.length > MAX_TOOL_CALLS
  )
    throw new Error('resident run provenance: canonical batch size is invalid');
  for (let callIndex = 0; callIndex < calls.length; callIndex++) {
    if (!Object.hasOwn(calls, callIndex))
      throw new Error('resident run provenance: canonical batch is sparse');
  }
  const canonicalCalls = calls.map((call, callIndex) => {
    if (
      call.callIndex !== callIndex ||
      typeof call.toolName !== 'string' ||
      !call.toolName ||
      Buffer.byteLength(call.toolName, 'utf8') > MAX_TOOL_NAME_BYTES ||
      !SHA256.test(call.argumentsSha256)
    ) {
      throw new Error(
        'resident run provenance: canonical tool call is invalid',
      );
    }
    return {
      callIndex,
      toolName: call.toolName,
      argumentsSha256: call.argumentsSha256,
    };
  });
  return sha256(
    BATCH_DOMAIN +
      JSON.stringify({ version: 1, batchId, calls: canonicalCalls }),
  );
}

export function parseRecordedResidentToolBatch(
  value: unknown,
  calls: readonly ResidentToolCallInput[],
): RecordedResidentToolBatchV1 | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    !exactKeys(record, ['version', 'batchId', 'batchSha256']) ||
    record.version !== 1 ||
    typeof record.batchId !== 'string' ||
    !BATCH_ID.test(record.batchId) ||
    typeof record.batchSha256 !== 'string' ||
    !SHA256.test(record.batchSha256)
  ) {
    return null;
  }
  let normalized: readonly ResidentToolCallSnapshotV1[];
  try {
    normalized = normalizeCalls(record.batchId, calls);
  } catch {
    return null;
  }
  if (normalized[0]?.batchSha256 !== record.batchSha256) return null;
  return Object.freeze({
    version: 1,
    batchId: record.batchId,
    batchSha256: record.batchSha256,
  });
}

export function createResidentRunAuthority(options?: {
  randomId?: () => string;
}): ResidentRunAuthority {
  const nextId = options?.randomId ?? randomUUID;
  const preparedStates = new WeakMap<object, PreparedState>();
  const batchIds = new Set<string>();
  const tokenStates = new WeakMap<object, TokenState>();
  const handleStates = new WeakMap<object, HandleState>();

  const requirePrepared = (
    prepared: PreparedResidentToolBatch,
  ): PreparedState => {
    const state = preparedStates.get(prepared as object);
    if (!state)
      throw new Error('resident run provenance: prepared batch is invalid');
    return state;
  };
  const requireHandle = (handle: ResidentRunScopeHandle): HandleState => {
    const state = handleStates.get(handle as object);
    if (!state)
      throw new Error('resident run provenance: scope handle is invalid');
    return state;
  };

  const issuer: ResidentRunIssuer = Object.freeze({
    prepare(calls: readonly ResidentToolCallInput[]) {
      const batchId = `resident-tool-batch:${nextId()}`;
      if (batchIds.has(batchId))
        throw new Error('resident run provenance: batch id was already used');
      const snapshots = normalizeCalls(batchId, calls);
      batchIds.add(batchId);
      const record = Object.freeze({
        version: 1 as const,
        batchId,
        batchSha256: snapshots[0].batchSha256,
      });
      const prepared = Object.freeze({}) as PreparedResidentToolBatch;
      preparedStates.set(prepared as object, {
        record,
        calls: snapshots,
        committed: false,
        issued: new Set<number>(),
      });
      return Object.freeze({ prepared, record });
    },
    commit(prepared: PreparedResidentToolBatch) {
      const state = requirePrepared(prepared);
      if (state.committed)
        throw new Error('resident run provenance: batch is already committed');
      state.committed = true;
    },
    issue(prepared: PreparedResidentToolBatch, callIndex: number) {
      const state = requirePrepared(prepared);
      if (!state.committed)
        throw new Error('resident run provenance: batch is not committed');
      if (!Number.isSafeInteger(callIndex) || !state.calls[callIndex])
        throw new Error('resident run provenance: call index is invalid');
      if (state.issued.has(callIndex))
        throw new Error(
          'resident run provenance: call token was already issued',
        );
      state.issued.add(callIndex);
      const token = Object.freeze({}) as ResidentRunToken;
      tokenStates.set(token as object, {
        snapshot: state.calls[callIndex],
        used: false,
      });
      return token;
    },
  });

  const verifier: ResidentRunVerifier = Object.freeze({
    accept(token: ResidentRunToken) {
      const tokenState = tokenStates.get(token as object);
      if (!tokenState)
        throw new Error('resident run provenance: run token is invalid');
      if (tokenState.used)
        throw new Error(
          'resident run provenance: run token was already accepted',
        );
      tokenState.used = true;
      const handle = Object.freeze({}) as ResidentRunScopeHandle;
      handleStates.set(handle as object, {
        snapshot: tokenState.snapshot,
        lifecycle: 'active',
      });
      return handle;
    },
    resolveActive(handle: ResidentRunScopeHandle) {
      const state = requireHandle(handle);
      if (state.lifecycle !== 'active')
        throw new Error(`resident run provenance: scope is ${state.lifecycle}`);
      return state.snapshot;
    },
    lifecycle(handle: ResidentRunScopeHandle) {
      return requireHandle(handle).lifecycle;
    },
    detach(handle: ResidentRunScopeHandle) {
      const state = requireHandle(handle);
      if (state.lifecycle !== 'active')
        throw new Error(
          `resident run provenance: cannot detach ${state.lifecycle} scope`,
        );
      state.lifecycle = 'detached';
    },
    close(handle: ResidentRunScopeHandle) {
      const state = requireHandle(handle);
      if (state.lifecycle === 'closed') return;
      state.lifecycle = 'closed';
    },
  });

  return Object.freeze({ issuer, verifier });
}
