import type { Config } from '../config.js';
import { resolveLlmModelTarget } from '../llm/model-registry.js';
import type { Database } from '../store/db.js';
import { isMindId, type MindId } from '../store/mind-id.js';
import type { MindDetail, MindService } from '../store/mind.js';
import {
  createWorkerControlCredential,
  type WorkerControlCredential,
} from './auth.js';
import { generateWorkerSlug, newWorkerId } from './names.js';
import type { WorkerSourceReceipt, WorkerWorkspaceStore } from './workspace.js';

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
  provision(request: WorkerProvisionRequest): Promise<WorkerProvisionReceipt>;
  inspect(session: WorkerSession): Promise<WorkerProvisionState>;
  cleanup(session: WorkerSession): Promise<void>;
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

export interface WorkerSpawnBrokerOptions {
  db: Database;
  config: Config;
  mind: MindService;
  runtime: WorkerPodRuntime;
  workspace?: Pick<WorkerWorkspaceStore, 'prepareSource' | 'discardSource'>;
  now?: () => number;
  credential?: () => WorkerControlCredential;
  id?: () => string;
  slug?: (taken: Set<string>) => string;
}

const ACTIVE: WorkerSessionStatus[] = ['spawning', 'running', 'idle'];
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
  private readonly credential: () => WorkerControlCredential;
  private readonly id: () => string;
  private readonly slug: (taken: Set<string>) => string;

  constructor(private readonly options: WorkerSpawnBrokerOptions) {
    this.now = options.now ?? Date.now;
    this.credential = options.credential ?? createWorkerControlCredential;
    this.id = options.id ?? newWorkerId;
    this.slug = options.slug ?? generateWorkerSlug;
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

  async start(mindId: unknown, value?: unknown): Promise<WorkerSession> {
    this.requireEnabled();
    const item = validateMind(this.options.mind, mindId);
    const input = parseStartOptions(value);
    const modelRef =
      input.modelRef ?? this.options.config.llm.registry.roles.main;
    try {
      resolveLlmModelTarget(
        this.options.config.llm.registry,
        modelRef,
        'worker model',
      );
    } catch (error) {
      throw new WorkerSpawnError('invalid_request', boundedError(error));
    }

    await this.recover();
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

    let source: WorkerSourceReceipt | null = null;
    if (this.options.workspace) {
      try {
        source = await this.options.workspace.prepareSource(id);
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
        const detail = boundedError(error);
        this.options.db
          .prepare(
            `UPDATE worker_sessions
             SET status = 'failed', updated_at = ?, last_error = ?
             WHERE id = ? AND status = 'spawning'`,
          )
          .run(this.now(), detail, id);
        if (error instanceof WorkerSpawnError) throw error;
        throw new WorkerSpawnError(
          'workspace_failed',
          'worker source preparation failed',
        );
      }
    }

    let receipt: WorkerProvisionReceipt;
    try {
      receipt = await this.options.runtime.provision({
        sessionId: id,
        slug,
        token: credential.token,
      });
    } catch (error) {
      const failed = this.byId(id)!;
      let cleanupError: string | null = null;
      try {
        await this.options.runtime.cleanup(failed);
      } catch (cleanup) {
        cleanupError = boundedError(cleanup);
      }
      const message = `${boundedError(error)}${cleanupError ? `; cleanup: ${cleanupError}` : ''}`;
      this.options.db
        .prepare(
          "UPDATE worker_sessions SET status = 'failed', updated_at = ?, last_error = ? WHERE id = ? AND status = 'spawning'",
        )
        .run(this.now(), message.slice(0, 1000), id);
      throw new WorkerSpawnError(
        'provision_failed',
        'worker provisioning failed',
      );
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
      await this.options.runtime.cleanup(this.byId(id)!);
      throw new WorkerSpawnError(
        'conflict',
        'worker was revoked during provisioning',
      );
    }
    return this.byId(id)!;
  }

  async dismiss(ref: string): Promise<WorkerSession> {
    const session = this.resolve(ref);
    const changed = this.options.db
      .prepare(
        `UPDATE worker_sessions
         SET status = 'dismissed', updated_at = ?
         WHERE id = ? AND status IN ('spawning','running','idle')`,
      )
      .run(this.now(), session.id);
    const revoked = this.byId(session.id)!;
    if (Number(changed.changes) === 0) return revoked;
    try {
      await this.options.runtime.cleanup(revoked);
    } catch (error) {
      this.options.db
        .prepare(
          'UPDATE worker_sessions SET last_error = ?, updated_at = ? WHERE id = ?',
        )
        .run(boundedError(error), this.now(), session.id);
      throw new WorkerSpawnError('cleanup_failed', 'worker cleanup failed');
    }
    return this.byId(session.id)!;
  }

  async recover(): Promise<WorkerSession[]> {
    const active = this.list().filter((session) =>
      ACTIVE.includes(session.status),
    );
    for (const session of active) {
      let state: WorkerProvisionState;
      try {
        state = await this.options.runtime.inspect(session);
      } catch {
        continue;
      }
      if (state.state === 'pending') continue;
      if (state.state === 'ready') {
        this.options.db
          .prepare(
            `UPDATE worker_sessions
             SET status = 'running', pod_name = ?, pod_uid = ?, workspace_ref = ?, updated_at = ?, last_error = NULL
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
      const status = state.state === 'succeeded' ? 'finished' : 'failed';
      const error =
        state.state === 'failed'
          ? boundedError(state.error)
          : state.state === 'missing'
            ? 'worker Pod is missing'
            : null;
      this.options.db
        .prepare(
          "UPDATE worker_sessions SET status = ?, updated_at = ?, last_error = ? WHERE id = ? AND status IN ('spawning','running','idle')",
        )
        .run(status, this.now(), error, session.id);
      try {
        await this.options.runtime.cleanup(this.byId(session.id)!);
      } catch (cleanup) {
        this.options.db
          .prepare(
            'UPDATE worker_sessions SET last_error = ?, updated_at = ? WHERE id = ?',
          )
          .run(
            `${error ? `${error}; ` : ''}cleanup: ${boundedError(cleanup)}`.slice(
              0,
              1000,
            ),
            this.now(),
            session.id,
          );
      }
    }
    return this.list();
  }
}
