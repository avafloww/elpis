import {
  configForLlmRef,
  type MaterializedConfig as Config,
} from '../config.js';
import type { Database } from '../store/db.js';
import { isMindId, type MindId } from '../store/mind-id.js';
import type { MindDetail, MindService } from '../store/mind.js';
import {
  createWorkerControlCredential,
  type WorkerControlCredential,
} from './auth.js';
import { generateWorkerSlug, newWorkerId } from './names.js';
import {
  WorkerWorkspaceError,
  type WorkerSourceReceipt,
  type WorkerWorkspaceStore,
} from './workspace.js';

export type WorkerSessionStatus =
  'spawning' | 'running' | 'idle' | 'finished' | 'failed' | 'dismissed';

export interface WorkerSession {
  id: string;
  slug: string;
  worker: string;
  status: WorkerSessionStatus;
  modelRef: string;
  mindId: MindId;
  runtime: 'trusted' | 'kubernetes';
  podName: string | null;
  podUid: string | null;
  workspaceRef: string | null;
  sourceRevision: string | null;
  sourceSha256: string | null;
  sourceBytes: number | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  runtimeCleanupCompletedAt: number | null;
  runtimeCleanupError: string | null;
}

export interface WorkerProvisionRequest {
  sessionId: string;
  slug: string;
  token: string;
}

export interface WorkerProvisionReceipt {
  podName: string;
  podUid: string | null;
  workspaceRef: string;
}

export type WorkerProvisionState =
  | { state: 'pending'; receipt?: WorkerProvisionReceipt }
  | { state: 'ready'; receipt: WorkerProvisionReceipt }
  | { state: 'succeeded'; receipt?: WorkerProvisionReceipt }
  | { state: 'failed'; error: string; receipt?: WorkerProvisionReceipt }
  | { state: 'missing' };

export interface WorkerPodRuntime {
  provision(
    request: WorkerProvisionRequest,
    signal?: AbortSignal,
  ): Promise<WorkerProvisionReceipt>;
  inspect(
    session: WorkerSession,
    signal?: AbortSignal,
  ): Promise<WorkerProvisionState>;
  cleanup(session: WorkerSession, signal?: AbortSignal): Promise<void>;
}

export class WorkerSpawnError extends Error {
  constructor(
    public readonly code:
      | 'disabled'
      | 'invalid_request'
      | 'not_found'
      | 'unavailable'
      | 'blocked'
      | 'conflict'
      | 'capacity'
      | 'workspace_failed'
      | 'provision_failed'
      | 'cleanup_failed',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerSpawnError';
  }
}

interface WorkerOperationScope {
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}

export interface WorkerSpawnBrokerOptions {
  db: Database;
  config: Config;
  mind: MindService;
  runtime: WorkerPodRuntime;
  workspace?: Pick<WorkerWorkspaceStore, 'prepareSource' | 'discardSource'>;
  now?: () => number;
  monotonicNow?: () => number;
  credential?: () => WorkerControlCredential;
  id?: () => string;
  slug?: (taken: Set<string>) => string;
}

const ACTIVE: WorkerSessionStatus[] = ['spawning', 'running', 'idle'];
const FINISH_CLEANUP_GRACE_MS = 30_000;
const CLOSED_MIND = new Set(['done', 'cancelled']);

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000) || 'worker operation failed';
}

function rowSession(row: Record<string, unknown>): WorkerSession {
  const mindId = String(row.mind_id);
  if (!isMindId(mindId))
    throw new Error('worker session has invalid Mind identity');
  return {
    id: String(row.id),
    slug: String(row.slug),
    worker: `worker:${String(row.slug)}`,
    status: row.status as WorkerSessionStatus,
    modelRef: String(row.model_ref),
    mindId,
    runtime: row.runtime as 'trusted' | 'kubernetes',
    podName: row.pod_name == null ? null : String(row.pod_name),
    podUid: row.pod_uid == null ? null : String(row.pod_uid),
    workspaceRef: row.workspace_ref == null ? null : String(row.workspace_ref),
    sourceRevision:
      row.source_revision == null ? null : String(row.source_revision),
    sourceSha256: row.source_sha256 == null ? null : String(row.source_sha256),
    sourceBytes: row.source_bytes == null ? null : Number(row.source_bytes),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastError: row.last_error == null ? null : String(row.last_error),
    runtimeCleanupCompletedAt:
      row.runtime_cleanup_completed_at == null
        ? null
        : Number(row.runtime_cleanup_completed_at),
    runtimeCleanupError:
      row.runtime_cleanup_error == null
        ? null
        : String(row.runtime_cleanup_error),
  };
}

function parseStartOptions(value: unknown): { modelRef?: string } {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkerSpawnError(
      'invalid_request',
      'worker options must be an object',
    );
  const input = value as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => key !== 'modelRef');
  if (extra.length > 0)
    throw new WorkerSpawnError(
      'invalid_request',
      `unknown worker option ${JSON.stringify(extra[0])}`,
    );
  if (input.modelRef !== undefined && typeof input.modelRef !== 'string')
    throw new WorkerSpawnError('invalid_request', 'modelRef must be a string');
  return input.modelRef === undefined ? {} : { modelRef: input.modelRef };
}

function validateMind(mind: MindService, value: unknown): MindDetail {
  if (typeof value !== 'string' || !isMindId(value))
    throw new WorkerSpawnError(
      'invalid_request',
      'mindId must be a canonical elm- Mind identity',
    );
  const item = mind.get(value);
  if (!item)
    throw new WorkerSpawnError('not_found', 'Mind item is unavailable');
  if (item.archivedAt !== null || CLOSED_MIND.has(item.status))
    throw new WorkerSpawnError('unavailable', 'Mind item is closed');
  if (item.status === 'proposal')
    throw new WorkerSpawnError(
      'blocked',
      'Mind proposal is not committed work',
    );
  if (
    item.status === 'inbox' ||
    item.status === 'waiting' ||
    item.effectiveStatus === 'blocked'
  )
    throw new WorkerSpawnError(
      'blocked',
      'Mind item is not ready for a worker',
    );
  return item;
}

export class WorkerSpawnBroker {
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly credential: () => WorkerControlCredential;
  private readonly id: () => string;
  private readonly slug: (taken: Set<string>) => string;
  /** In-process start ownership closes before recovery may interpret a missing Pod.
   * A process restart drops this set, so abandoned spawning rows stay recoverable. */
  private readonly provisioning = new Map<string, Promise<void>>();
  private readonly cleaning = new Map<string, Promise<void>>();
  private readonly provisioningSettledListeners = new Set<
    (sessionId: string) => void
  >();
  private readonly finishCleanupObservedAt = new Map<string, number>();

  constructor(private readonly options: WorkerSpawnBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.monotonicNow =
      options.monotonicNow ??
      (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.credential = options.credential ?? createWorkerControlCredential;
    this.id = options.id ?? newWorkerId;
    this.slug = options.slug ?? generateWorkerSlug;
  }

  onProvisioningSettled(listener: (sessionId: string) => void): () => void {
    this.provisioningSettledListeners.add(listener);
    return () => this.provisioningSettledListeners.delete(listener);
  }

  revokeProvisioning(): WorkerSession[] {
    const ids = [...this.provisioning.keys()];
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    this.options.db
      .prepare(
        `UPDATE worker_sessions
         SET status = 'failed',
             updated_at = MAX(created_at, updated_at, ?),
             last_error = 'worker supervisor stopped during provisioning',
             completion_notified_at = NULL,
             runtime_cleanup_completed_at = NULL,
             runtime_cleanup_error = NULL
         WHERE id IN (${placeholders}) AND status = 'spawning'`,
      )
      .run(this.now(), ...ids);
    return ids
      .map((id) => this.byId(id))
      .filter((session): session is WorkerSession => session != null);
  }

  private operationCurrent(scope: WorkerOperationScope): boolean {
    return scope.isCurrent?.() ?? true;
  }

  private requireOperationCurrent(scope: WorkerOperationScope): void {
    if (!this.operationCurrent(scope))
      throw new WorkerSpawnError(
        'unavailable',
        'worker supervisor is disposed',
      );
  }

  private requireEnabled(): void {
    if (!this.options.config.workers.enabled)
      throw new WorkerSpawnError('disabled', 'workers are disabled');
  }

  private byId(id: string): WorkerSession | null {
    const row = this.options.db
      .prepare('SELECT * FROM worker_sessions WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? rowSession(row) : null;
  }

  private cleanupCompleted(sessionId: string): boolean {
    const row = this.options.db
      .prepare(
        'SELECT runtime_cleanup_completed_at FROM worker_sessions WHERE id = ?',
      )
      .get(sessionId) as
      { runtime_cleanup_completed_at: number | null } | undefined;
    return row?.runtime_cleanup_completed_at != null;
  }

  private cleanupRuntime(
    session: WorkerSession,
    signal?: AbortSignal,
    canPersist: () => boolean = () => true,
  ): Promise<void> {
    if (this.cleanupCompleted(session.id)) return Promise.resolve();
    const existing = this.cleaning.get(session.id);
    if (existing) return existing;

    const ownership = Promise.withResolvers<void>();
    this.cleaning.set(session.id, ownership.promise);
    void (async () => {
      const current = this.byId(session.id) ?? session;
      if (this.cleanupCompleted(session.id)) return;
      try {
        await this.options.runtime.cleanup(current, signal);
      } catch (error) {
        if (canPersist()) {
          this.options.db
            .prepare(
              `UPDATE worker_sessions
               SET runtime_cleanup_error = ?
               WHERE id = ? AND status IN ('finished','failed','dismissed')
                 AND runtime_cleanup_completed_at IS NULL`,
            )
            .run(boundedError(error), session.id);
        }
        throw error;
      }
      if (!canPersist()) return;
      this.options.db
        .prepare(
          `UPDATE worker_sessions
           SET runtime_cleanup_completed_at = MAX(created_at, updated_at, ?),
               runtime_cleanup_error = NULL
           WHERE id = ? AND status IN ('finished','failed','dismissed')
             AND runtime_cleanup_completed_at IS NULL`,
        )
        .run(this.now(), session.id);
    })().then(
      () => {
        if (this.cleaning.get(session.id) === ownership.promise)
          this.cleaning.delete(session.id);
        ownership.resolve();
      },
      (error: unknown) => {
        if (this.cleaning.get(session.id) === ownership.promise)
          this.cleaning.delete(session.id);
        ownership.reject(error);
      },
    );
    return ownership.promise;
  }

  private resolve(ref: string): WorkerSession {
    if (typeof ref !== 'string' || ref.trim().length === 0)
      throw new WorkerSpawnError(
        'invalid_request',
        'worker ref must be a string',
      );
    const clean = ref.startsWith('worker:') ? ref.slice(7) : ref;
    const rows = this.options.db
      .prepare(
        `SELECT * FROM worker_sessions
         WHERE id = ? OR slug = ? OR id LIKE ?
         ORDER BY created_at DESC`,
      )
      .all(clean, clean, `${clean}%`) as Record<string, unknown>[];
    if (rows.length === 0)
      throw new WorkerSpawnError('not_found', 'worker session is unavailable');
    if (rows.length > 1)
      throw new WorkerSpawnError('conflict', 'worker ref is ambiguous');
    return rowSession(rows[0]);
  }

  list(): WorkerSession[] {
    return (
      this.options.db
        .prepare(
          'SELECT * FROM worker_sessions ORDER BY created_at DESC, id DESC',
        )
        .all() as Record<string, unknown>[]
    ).map(rowSession);
  }

  status(ref: string): WorkerSession {
    return this.resolve(ref);
  }

  async start(
    mindId: unknown,
    value?: unknown,
    scope: WorkerOperationScope = {},
  ): Promise<WorkerSession> {
    this.requireOperationCurrent(scope);
    this.requireEnabled();
    const item = validateMind(this.options.mind, mindId);
    const input = parseStartOptions(value);
    const modelRef =
      input.modelRef ?? this.options.config.llm.registry.roles.main;
    try {
      configForLlmRef(this.options.config, modelRef);
    } catch (error) {
      throw new WorkerSpawnError('invalid_request', boundedError(error));
    }

    const credential = this.credential();
    const now = this.now();
    let id = '';
    let slug = '';
    this.options.db.exec('BEGIN IMMEDIATE');
    try {
      const active = this.options.db
        .prepare(
          `SELECT COUNT(*) AS n FROM worker_sessions
           WHERE status IN ('spawning','running','idle')`,
        )
        .get() as { n: number };
      if (active.n >= this.options.config.workers.maxConcurrent)
        throw new WorkerSpawnError('capacity', 'worker capacity is full');
      const claimed = this.options.db
        .prepare(
          `SELECT id FROM worker_sessions
           WHERE mind_id = ? AND status IN ('spawning','running','idle')`,
        )
        .get(item.id);
      if (claimed)
        throw new WorkerSpawnError(
          'conflict',
          'Mind item already has an active worker',
        );
      const ids = new Set(
        (
          this.options.db.prepare('SELECT id FROM worker_sessions').all() as {
            id: string;
          }[]
        ).map((row) => row.id),
      );
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = this.id();
        if (!ids.has(candidate)) {
          id = candidate;
          break;
        }
      }
      if (!id)
        throw new WorkerSpawnError('conflict', 'worker id space is exhausted');
      const slugs = new Set(
        (
          this.options.db.prepare('SELECT slug FROM worker_sessions').all() as {
            slug: string;
          }[]
        ).map((row) => row.slug),
      );
      slug = this.slug(slugs);
      this.options.db
        .prepare(
          `INSERT INTO worker_sessions
           (id, slug, status, model_ref, mind_id, runtime, control_token_digest, created_at, updated_at)
           VALUES (?, ?, 'spawning', ?, ?, 'kubernetes', ?, ?, ?)`,
        )
        .run(id, slug, modelRef, item.id, credential.digest, now, now);
      this.options.db.exec('COMMIT');
    } catch (error) {
      this.options.db.exec('ROLLBACK');
      if (error instanceof WorkerSpawnError) throw error;
      throw new WorkerSpawnError('conflict', boundedError(error));
    }

    const cleanupSession = this.byId(id)!;
    const provisioning = Promise.withResolvers<void>();
    this.provisioning.set(id, provisioning.promise);
    let provisioningSettled = false;
    const settleProvisioning = () => {
      if (provisioningSettled) return;
      provisioningSettled = true;
      provisioning.resolve();
    };

    try {
      let source: WorkerSourceReceipt | null = null;
      if (this.options.workspace) {
        try {
          source = await this.options.workspace.prepareSource(id);
          this.requireOperationCurrent(scope);
          if (source) {
            const bound = this.options.db
              .prepare(
                `UPDATE worker_sessions
               SET source_revision = ?, source_sha256 = ?, source_bytes = ?, updated_at = ?
               WHERE id = ? AND status = 'spawning'
                 AND source_revision IS NULL AND source_sha256 IS NULL AND source_bytes IS NULL`,
              )
              .run(
                source.revision,
                source.sha256,
                source.sizeBytes,
                this.now(),
                id,
              );
            if (Number(bound.changes) !== 1) {
              this.options.workspace.discardSource(id);
              throw new WorkerSpawnError(
                'conflict',
                'worker was revoked during source preparation',
              );
            }
          }
        } catch (error) {
          this.options.workspace.discardSource(id);
          this.requireOperationCurrent(scope);
          const detail = boundedError(error);
          const failedAt = this.now();
          this.options.db
            .prepare(
              `UPDATE worker_sessions
             SET status = 'failed',
                 updated_at = MAX(created_at, updated_at, ?),
                 last_error = ?, completion_notified_at = NULL,
                 runtime_cleanup_completed_at = MAX(created_at, updated_at, ?),
                 runtime_cleanup_error = NULL
             WHERE id = ? AND status = 'spawning'`,
            )
            .run(failedAt, detail, failedAt, id);
          if (error instanceof WorkerSpawnError) throw error;
          const summary =
            error instanceof WorkerWorkspaceError &&
            error.reason === 'dirty_source'
              ? 'worker source repository must be clean; checkpoint changes before starting a worker'
              : 'worker source preparation failed';
          throw new WorkerSpawnError(
            'workspace_failed',
            `${summary}; inspect elpis.worker.status("${id}") for details`,
          );
        }
      }

      let receipt: WorkerProvisionReceipt;
      try {
        receipt = await this.options.runtime.provision(
          {
            sessionId: id,
            slug,
            token: credential.token,
          },
          scope.signal,
        );
      } catch (error) {
        settleProvisioning();
        if (!this.operationCurrent(scope)) {
          try {
            await this.options.runtime.cleanup(cleanupSession);
          } catch {}
          this.requireOperationCurrent(scope);
        }
        const failedAt = this.now();
        const changed = this.options.db
          .prepare(
            `UPDATE worker_sessions
             SET status = 'failed', updated_at = ?, last_error = ?, completion_notified_at = NULL
             WHERE id = ? AND status = 'spawning'`,
          )
          .run(failedAt, boundedError(error), id);
        const current = this.byId(id)!;
        if (current.status === 'finished') return current;
        try {
          await this.cleanupRuntime(current);
        } catch {}
        if (Number(changed.changes) !== 1) {
          throw new WorkerSpawnError(
            'conflict',
            'worker was revoked during provisioning',
          );
        }
        throw new WorkerSpawnError(
          'provision_failed',
          'worker provisioning failed',
        );
      }

      settleProvisioning();
      if (!this.operationCurrent(scope)) {
        try {
          await this.options.runtime.cleanup(cleanupSession);
        } catch {}
        this.requireOperationCurrent(scope);
      }
      const result = this.options.db
        .prepare(
          `UPDATE worker_sessions
         SET status = 'running', pod_name = ?, pod_uid = ?, workspace_ref = ?, updated_at = ?, last_error = NULL
         WHERE id = ? AND status = 'spawning'`,
        )
        .run(
          receipt.podName,
          receipt.podUid,
          receipt.workspaceRef,
          this.now(),
          id,
        );
      if (Number(result.changes) !== 1) {
        const current = this.byId(id)!;
        if (current.status === 'finished') return current;
        try {
          await this.cleanupRuntime(current);
        } catch {}
        throw new WorkerSpawnError(
          'conflict',
          'worker was revoked during provisioning',
        );
      }
      return this.byId(id)!;
    } finally {
      settleProvisioning();
      if (this.provisioning.get(id) === provisioning.promise) {
        this.provisioning.delete(id);
        for (const listener of this.provisioningSettledListeners) {
          try {
            listener(id);
          } catch {}
        }
      }
    }
  }

  async dismiss(
    ref: string,
    scope: WorkerOperationScope = {},
  ): Promise<WorkerSession> {
    this.requireOperationCurrent(scope);
    const session = this.resolve(ref);
    const changed = this.options.db
      .prepare(
        `UPDATE worker_sessions
         SET status = 'dismissed', updated_at = ?
         WHERE id = ? AND status IN ('spawning','running','idle')`,
      )
      .run(this.now(), session.id);
    const revoked = this.byId(session.id)!;
    if (
      Number(changed.changes) === 0 &&
      (revoked.status !== 'dismissed' ||
        revoked.runtimeCleanupCompletedAt != null)
    )
      return revoked;

    const provisioning = this.provisioning.get(session.id);
    if (provisioning) await provisioning;
    this.requireOperationCurrent(scope);
    try {
      await this.cleanupRuntime(this.byId(session.id)!, scope.signal, () =>
        this.operationCurrent(scope),
      );
    } catch {
      this.requireOperationCurrent(scope);
      throw new WorkerSpawnError('cleanup_failed', 'worker cleanup failed');
    }
    this.requireOperationCurrent(scope);
    return this.byId(session.id)!;
  }

  private hasDurableFinish(sessionId: string): boolean {
    return Boolean(
      this.options.db
        .prepare(
          `SELECT 1 FROM worker_mailbox_messages
           WHERE session_id = ? AND direction = 'worker_to_dispatcher' AND kind = 'finish'`,
        )
        .get(sessionId),
    );
  }

  async recoverState(
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<WorkerSession[]> {
    if (!isCurrent()) return [];
    this.options.db
      .prepare(
        `UPDATE worker_sessions
         SET status = 'finished',
             updated_at = MAX(
               updated_at,
               (SELECT MAX(message.created_at)
                FROM worker_mailbox_messages message
                WHERE message.session_id = worker_sessions.id
                  AND message.direction = 'worker_to_dispatcher'
                  AND message.kind = 'finish')
             ),
             last_error = NULL
         WHERE status = 'failed'
           AND EXISTS (
             SELECT 1 FROM worker_mailbox_messages message
             WHERE message.session_id = worker_sessions.id
               AND message.direction = 'worker_to_dispatcher'
               AND message.kind = 'finish'
           )`,
      )
      .run();
    const active = this.list().filter(
      (session) =>
        ACTIVE.includes(session.status) && !this.provisioning.has(session.id),
    );
    for (const session of active) {
      if (!isCurrent()) return [];
      if (this.hasDurableFinish(session.id)) {
        this.options.db
          .prepare(
            `UPDATE worker_sessions
             SET status = 'finished',
                 updated_at = MAX(
                   updated_at,
                   COALESCE(
                     (SELECT MAX(message.created_at)
                      FROM worker_mailbox_messages message
                      WHERE message.session_id = worker_sessions.id
                        AND message.direction = 'worker_to_dispatcher'
                        AND message.kind = 'finish'),
                     updated_at
                   )
                 ),
                 last_error = NULL
             WHERE id = ? AND status IN ('spawning','running','idle')`,
          )
          .run(session.id);
        continue;
      }
      let state: WorkerProvisionState;
      try {
        state = await this.options.runtime.inspect(session, signal);
      } catch {
        if (!isCurrent()) return [];
        if (!this.hasDurableFinish(session.id)) continue;
        this.options.db
          .prepare(
            `UPDATE worker_sessions
             SET status = 'finished',
                 updated_at = MAX(
                   updated_at,
                   COALESCE(
                     (SELECT MAX(message.created_at)
                      FROM worker_mailbox_messages message
                      WHERE message.session_id = worker_sessions.id
                        AND message.direction = 'worker_to_dispatcher'
                        AND message.kind = 'finish'),
                     updated_at
                   )
                 ),
                 last_error = NULL
             WHERE id = ? AND status IN ('spawning','running','idle')`,
          )
          .run(session.id);
        continue;
      }
      if (!isCurrent()) return [];
      if (this.hasDurableFinish(session.id)) {
        this.options.db
          .prepare(
            `UPDATE worker_sessions
             SET status = 'finished',
                 updated_at = MAX(
                   updated_at,
                   COALESCE(
                     (SELECT MAX(message.created_at)
                      FROM worker_mailbox_messages message
                      WHERE message.session_id = worker_sessions.id
                        AND message.direction = 'worker_to_dispatcher'
                        AND message.kind = 'finish'),
                     updated_at
                   )
                 ),
                 last_error = NULL
             WHERE id = ? AND status IN ('spawning','running','idle')`,
          )
          .run(session.id);
        continue;
      }
      if (state.state === 'pending') continue;
      if (state.state === 'ready') {
        this.options.db
          .prepare(
            `UPDATE worker_sessions
             SET status = 'running', pod_name = ?, pod_uid = ?, workspace_ref = ?,
                 updated_at = ?, last_error = NULL
             WHERE id = ? AND status IN ('spawning','running','idle')`,
          )
          .run(
            state.receipt.podName,
            state.receipt.podUid,
            state.receipt.workspaceRef,
            this.now(),
            session.id,
          );
        continue;
      }
      const error =
        state.state === 'succeeded'
          ? 'worker Pod exited successfully without a durable finish'
          : state.state === 'failed'
            ? boundedError(state.error)
            : 'worker Pod is missing';
      this.options.db
        .prepare(
          `UPDATE worker_sessions
           SET status = 'failed', updated_at = ?, last_error = ?,
               completion_notified_at = NULL
           WHERE id = ? AND status IN ('spawning','running','idle')`,
        )
        .run(this.now(), error, session.id);
    }

    if (!isCurrent()) return [];
    return this.list();
  }

  async cleanupPending(
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<WorkerSession[]> {
    if (!isCurrent()) return [];
    const cleanup = this.options.db
      .prepare(
        `SELECT * FROM worker_sessions
         WHERE status IN ('finished','failed','dismissed')
           AND runtime_cleanup_completed_at IS NULL
         ORDER BY updated_at, id`,
      )
      .all() as Record<string, unknown>[];
    for (const row of cleanup) {
      if (!isCurrent()) return [];
      const session = rowSession(row);
      if (this.provisioning.has(session.id)) continue;
      if (session.status === 'finished') {
        const monotonicNow = this.monotonicNow();
        const firstObserved =
          this.finishCleanupObservedAt.get(session.id) ?? monotonicNow;
        this.finishCleanupObservedAt.set(session.id, firstObserved);
        const monotonicAge = Math.max(0, monotonicNow - firstObserved);
        const graceExpired = monotonicAge >= FINISH_CLEANUP_GRACE_MS;
        let state: WorkerProvisionState;
        try {
          state = await this.options.runtime.inspect(session, signal);
        } catch {
          if (!isCurrent()) return [];
          if (!graceExpired) continue;
          state = { state: 'missing' };
        }
        if (!isCurrent()) return [];
        if (
          (state.state === 'pending' || state.state === 'ready') &&
          !graceExpired
        ) {
          continue;
        }
      }
      try {
        await this.cleanupRuntime(session, signal, isCurrent);
      } catch {}
      if (!isCurrent()) return [];
      if (this.cleanupCompleted(session.id))
        this.finishCleanupObservedAt.delete(session.id);
    }
    if (!isCurrent()) return [];
    return this.list();
  }

  async recover(
    isCurrent: () => boolean = () => true,
    signal?: AbortSignal,
  ): Promise<WorkerSession[]> {
    await this.recoverState(isCurrent, signal);
    if (!isCurrent()) return [];
    await this.cleanupPending(isCurrent, signal);
    if (!isCurrent()) return [];
    return this.list();
  }
}
