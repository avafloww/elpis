import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isMindId, type MindId } from '../store/mind-id.js';

export const SANDBOX_LIFECYCLES = [
  'ready',
  'busy',
  'detached',
  'retired',
] as const;
export type SandboxLifecycle = (typeof SANDBOX_LIFECYCLES)[number];

export interface SandboxRegistration {
  id: MindId;
  mindId: MindId;
  executorId: string;
  generation: number;
  lifecycle: SandboxLifecycle;
  reminderLatched: boolean;
  retireRequested: boolean;
  retireRequestedAt: number | null;
  coldNoticePending: boolean;
  activeRunId: string | null;
  nextRunSeq: number;
  createdAt: number;
  updatedAt: number;
  retiredAt: number | null;
}

export interface SandboxRun {
  sandbox: SandboxRegistration;
  runId: string;
}

export interface CreateSandboxRegistryOptions {
  db: DatabaseSync;
  now?: () => number;
  uuid?: () => string;
}

type SandboxRow = {
  id: string;

  executor_id: string;
  generation: number;
  lifecycle: SandboxLifecycle;
  reminder_latched: number;
  retire_requested: number;
  retire_requested_at: number | null;
  cold_notice_pending: number;
  active_run_id: string | null;
  next_run_seq: number;
  created_at: number;
  updated_at: number;
  retired_at: number | null;
};

const SELECT_REGISTRATION = 'SELECT * FROM persistent_sandboxes';

function registration(row: SandboxRow): SandboxRegistration {
  return {
    id: row.id as MindId,
    mindId: row.id as MindId,
    executorId: row.executor_id,
    generation: row.generation,
    lifecycle: row.lifecycle,
    reminderLatched: row.reminder_latched === 1,
    retireRequested: row.retire_requested === 1,
    retireRequestedAt: row.retire_requested_at,
    coldNoticePending: row.cold_notice_pending === 1,
    activeRunId: row.active_run_id,
    nextRunSeq: row.next_run_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  };
}

function assertMindId(mindId: MindId): void {
  if (!isMindId(mindId))
    throw new Error('sandbox registry: mind id must be a canonical elm-* id');
}

export class SandboxRegistry {
  readonly executorId: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(options: CreateSandboxRegistryOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.executorId = this.ensureExecutorIdentity();
  }

  private immediate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* original error wins */
      }
      throw error;
    }
  }

  private ensureExecutorIdentity(): string {
    return this.immediate(() => {
      const existing = this.db
        .prepare(
          'SELECT executor_id FROM sandbox_executor_identity WHERE singleton = 1',
        )
        .get() as { executor_id: string } | undefined;
      if (existing) return existing.executor_id;
      const executorId = this.uuid();
      this.db
        .prepare(
          'INSERT INTO sandbox_executor_identity (singleton, executor_id, created_at) VALUES (1, ?, ?)',
        )
        .run(executorId, this.now());
      return executorId;
    });
  }

  private resolveId(ref: string): MindId {
    if (!isMindId(ref))
      throw new Error(
        `sandbox registry: expected canonical Mind id, got ${JSON.stringify(ref)}`,
      );
    return ref;
  }

  private byId(id: MindId): SandboxRegistration {
    const row = this.db
      .prepare(`${SELECT_REGISTRATION} WHERE id = ?`)
      .get(id) as SandboxRow | undefined;
    if (!row)
      throw new Error(`sandbox registry: no sandbox ${JSON.stringify(id)}`);
    return registration(row);
  }

  get(ref: string): SandboxRegistration {
    return this.byId(this.resolveId(ref));
  }

  getByMind(mindId: MindId): SandboxRegistration | null {
    assertMindId(mindId);
    const row = this.db
      .prepare(`${SELECT_REGISTRATION} WHERE id = ?`)
      .get(mindId) as SandboxRow | undefined;
    return row ? registration(row) : null;
  }

  list(): SandboxRegistration[] {
    return (
      this.db
        .prepare(`${SELECT_REGISTRATION} ORDER BY created_at, id`)
        .all() as SandboxRow[]
    ).map(registration);
  }

  defaultMindId(ref: string): MindId {
    return this.get(ref).mindId;
  }

  ensureForMind(mindId: MindId): SandboxRegistration {
    assertMindId(mindId);
    return this.immediate(() => {
      const mind = this.db
        .prepare('SELECT status, archived_at FROM mind_items WHERE id = ?')
        .get(mindId) as
        { status: string; archived_at: number | null } | undefined;
      if (!mind) throw new Error(`sandbox registry: no Mind item ${mindId}`);
      if (mind.status === 'proposal')
        throw new Error(
          `sandbox registry: Mind ${mindId} is a proposal and cannot receive a persistent sandbox`,
        );
      const existing = this.db
        .prepare(`${SELECT_REGISTRATION} WHERE id = ?`)
        .get(mindId) as SandboxRow | undefined;
      if (existing) return registration(existing);
      if (
        mind.archived_at !== null ||
        mind.status === 'done' ||
        mind.status === 'cancelled'
      )
        throw new Error(
          `sandbox registry: Mind ${mindId} is closed and cannot receive a persistent sandbox`,
        );
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO persistent_sandboxes
        (id, executor_id, generation, lifecycle, reminder_latched, retire_requested, retire_requested_at, cold_notice_pending, active_run_id, next_run_seq, created_at, updated_at, retired_at)
        VALUES (?, ?, 1, 'ready', 0, 0, NULL, 0, NULL, 1, ?, ?, NULL)`,
        )
        .run(mindId, this.executorId, now, now);
      return this.byId(mindId);
    });
  }

  beginRun(ref: string): SandboxRun {
    const id = this.resolveId(ref);
    return this.immediate(() => {
      let current = this.byId(id);
      if (current.lifecycle !== 'ready') {
        throw new Error(
          `sandbox registry: ${current.id} is ${current.lifecycle}`,
        );
      }
      const mind = this.db
        .prepare('SELECT status, archived_at FROM mind_items WHERE id = ?')
        .get(current.mindId) as { status: string; archived_at: number | null };
      if (mind.status === 'proposal')
        throw new Error(
          `sandbox registry: Mind ${current.mindId} is a proposal and cannot resume a persistent sandbox`,
        );
      if (
        !current.retireRequested &&
        (mind.status === 'done' ||
          mind.status === 'cancelled' ||
          mind.archived_at !== null)
      ) {
        this.requestRetirementInside(current);
        current = this.byId(id);
      }
      const runId = `${current.id}:g${current.generation}:r${current.nextRunSeq}`;
      const now = this.now();
      this.db
        .prepare(
          `UPDATE persistent_sandboxes SET lifecycle = 'busy', active_run_id = ?, next_run_seq = next_run_seq + 1, updated_at = ? WHERE id = ?`,
        )
        .run(runId, now, id);
      return { runId, sandbox: this.byId(id) };
    });
  }

  detachRun(ref: string, runId: string): SandboxRegistration {
    return this.transitionRun(ref, runId, 'detached');
  }

  finishRun(ref: string, runId: string): SandboxRegistration {
    const id = this.resolveId(ref);
    return this.immediate(() => {
      const current = this.byId(id);
      if (
        (current.lifecycle !== 'busy' && current.lifecycle !== 'detached') ||
        current.activeRunId !== runId
      ) {
        throw new Error(
          `sandbox registry: ${current.id} does not own active run ${JSON.stringify(runId)}`,
        );
      }
      const mind = this.db
        .prepare('SELECT status, archived_at FROM mind_items WHERE id = ?')
        .get(current.mindId) as { status: string; archived_at: number | null };
      const closed =
        mind.status === 'done' ||
        mind.status === 'cancelled' ||
        mind.archived_at !== null;
      const now = this.now();
      this.db
        .prepare(
          `
        UPDATE persistent_sandboxes
        SET lifecycle = 'ready', active_run_id = NULL,
            retire_requested = CASE WHEN ? THEN 1 ELSE retire_requested END,
            retire_requested_at = CASE WHEN ? THEN COALESCE(retire_requested_at, ?) ELSE retire_requested_at END,
            updated_at = ?
        WHERE id = ?
      `,
        )
        .run(closed ? 1 : 0, closed ? 1 : 0, now, now, id);
      return this.byId(id);
    });
  }

  private transitionRun(
    ref: string,
    runId: string,
    target: 'detached',
  ): SandboxRegistration {
    const id = this.resolveId(ref);
    return this.immediate(() => {
      const current = this.byId(id);
      if (current.lifecycle !== 'busy' || current.activeRunId !== runId) {
        throw new Error(
          `sandbox registry: ${current.id} does not own active run ${JSON.stringify(runId)}`,
        );
      }
      this.db
        .prepare(
          'UPDATE persistent_sandboxes SET lifecycle = ?, updated_at = ? WHERE id = ?',
        )
        .run(target, this.now(), id);
      return this.byId(id);
    });
  }

  markInterruptedRunsDetached(): number {
    const result = this.db
      .prepare(
        `UPDATE persistent_sandboxes SET lifecycle = 'detached', updated_at = ? WHERE lifecycle = 'busy'`,
      )
      .run(this.now());
    return Number(result.changes);
  }

  failRunAndReset(ref: string, runId: string): SandboxRegistration {
    const id = this.resolveId(ref);
    return this.immediate(() => {
      const current = this.byId(id);
      if (
        (current.lifecycle !== 'busy' && current.lifecycle !== 'detached') ||
        current.activeRunId !== runId
      ) {
        throw new Error(
          `sandbox registry: ${current.id} does not own active run ${JSON.stringify(runId)}`,
        );
      }
      this.db
        .prepare(
          `
        UPDATE persistent_sandboxes
        SET generation = generation + 1, lifecycle = 'ready', active_run_id = NULL,
            next_run_seq = 1, cold_notice_pending = 0, updated_at = ?
        WHERE id = ?
      `,
        )
        .run(this.now(), id);
      return this.byId(id);
    });
  }

  coldResetAll(): number {
    const result = this.db
      .prepare(
        `
      UPDATE persistent_sandboxes
      SET generation = generation + 1, lifecycle = 'ready', active_run_id = NULL,
          next_run_seq = 1, cold_notice_pending = 1, updated_at = ?
      WHERE lifecycle != 'retired'
    `,
      )
      .run(this.now());
    return Number(result.changes);
  }

  consumeColdNotice(ref: string): boolean {
    const id = this.resolveId(ref);
    const result = this.db
      .prepare(
        'UPDATE persistent_sandboxes SET cold_notice_pending = 0 WHERE id = ? AND cold_notice_pending = 1',
      )
      .run(id);
    return Number(result.changes) === 1;
  }

  reset(ref: string): SandboxRegistration {
    const id = this.resolveId(ref);
    return this.immediate(() => {
      const current = this.byId(id);
      if (current.lifecycle !== 'ready')
        throw new Error(
          `sandbox registry: ${current.id} must be ready to reset`,
        );
      this.db
        .prepare(
          `
        UPDATE persistent_sandboxes
        SET generation = generation + 1, next_run_seq = 1, reminder_latched = 0, updated_at = ?
        WHERE id = ?
      `,
        )
        .run(this.now(), id);
      return this.byId(id);
    });
  }

  latchReminder(ref: string): boolean {
    const id = this.resolveId(ref);
    const result = this.db
      .prepare(
        `UPDATE persistent_sandboxes SET reminder_latched = 1, updated_at = ? WHERE id = ? AND lifecycle != 'retired' AND reminder_latched = 0`,
      )
      .run(this.now(), id);
    return Number(result.changes) === 1;
  }

  clearReminder(ref: string): SandboxRegistration {
    const id = this.resolveId(ref);
    this.db
      .prepare(
        'UPDATE persistent_sandboxes SET reminder_latched = 0, updated_at = ? WHERE id = ?',
      )
      .run(this.now(), id);
    return this.byId(id);
  }

  clearReminderByMind(mindId: MindId): SandboxRegistration | null {
    const current = this.getByMind(mindId);
    return current ? this.clearReminder(current.id) : null;
  }

  retireByMind(mindId: MindId): SandboxRegistration | null {
    const current = this.getByMind(mindId);
    if (!current) return null;
    return this.immediate(() =>
      this.requestRetirementInside(this.byId(current.id)),
    );
  }

  cancelRetirement(mindId: MindId): SandboxRegistration | null {
    const current = this.getByMind(mindId);
    if (!current || current.lifecycle === 'retired' || !current.retireRequested)
      return current;
    this.db
      .prepare(
        'UPDATE persistent_sandboxes SET retire_requested = 0, retire_requested_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(this.now(), current.id);
    return this.byId(current.id);
  }

  finalizeRetirement(
    ref: string,
    options: { expired?: boolean } = {},
  ): SandboxRegistration {
    const id = this.resolveId(ref);
    return this.immediate(() => {
      const current = this.byId(id);
      if (current.lifecycle === 'retired') return current;
      if (current.lifecycle !== 'ready' || !current.retireRequested) {
        throw new Error(
          `sandbox registry: ${current.id} is not ready for retirement GC`,
        );
      }
      const mind = this.db
        .prepare('SELECT status, archived_at FROM mind_items WHERE id = ?')
        .get(current.mindId) as { status: string; archived_at: number | null };
      if (
        !options.expired &&
        mind.status !== 'done' &&
        mind.status !== 'cancelled' &&
        mind.archived_at === null
      ) {
        this.db
          .prepare(
            'UPDATE persistent_sandboxes SET retire_requested = 0, retire_requested_at = NULL, updated_at = ? WHERE id = ?',
          )
          .run(this.now(), id);
        return this.byId(id);
      }
      const now = this.now();
      this.db
        .prepare(
          `UPDATE persistent_sandboxes SET lifecycle = 'retired', retire_requested = 0, retire_requested_at = NULL, retired_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(now, now, id);
      return this.byId(id);
    });
  }

  retireClosedMinds(): number {
    const rows = this.db
      .prepare(
        `
      SELECT s.id AS mind_id FROM persistent_sandboxes s
      JOIN mind_items m ON m.id = s.id
      WHERE s.lifecycle != 'retired' AND (m.status IN ('done','cancelled') OR m.archived_at IS NOT NULL)
    `,
      )
      .all() as { mind_id: MindId }[];
    for (const row of rows) this.retireByMind(row.mind_id);
    return rows.length;
  }

  private requestRetirementInside(
    current: SandboxRegistration,
  ): SandboxRegistration {
    if (current.lifecycle === 'retired' || current.retireRequested)
      return current;
    const now = this.now();
    this.db
      .prepare(
        'UPDATE persistent_sandboxes SET retire_requested = 1, retire_requested_at = COALESCE(retire_requested_at, ?), updated_at = ? WHERE id = ?',
      )
      .run(now, now, current.id);

    return this.byId(current.id);
  }
}

export function createSandboxRegistry(
  options: CreateSandboxRegistryOptions,
): SandboxRegistry {
  return new SandboxRegistry(options);
}
