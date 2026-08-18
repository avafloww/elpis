import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../lib/log.js';
import { aliasCandidates, loadAliasWordlists, type AliasRandomIndex } from './wordlists.js';

export const SANDBOX_LIFECYCLES = ['ready', 'busy', 'detached', 'retired'] as const;
export type SandboxLifecycle = (typeof SANDBOX_LIFECYCLES)[number];

export interface SandboxRegistration {
  id: string;
  alias: string;
  mindId: number;
  executorId: string;
  generation: number;
  lifecycle: SandboxLifecycle;
  reminderLatched: boolean;
  retireRequested: boolean;
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
  aliases?: {
    dataDirectory: string;
    logger: Pick<Logger, 'warn'>;
    chooseStart?: AliasRandomIndex;
  };
}

type SandboxRow = {
  id: string;
  alias: string;
  mind_id: number;
  executor_id: string;
  generation: number;
  lifecycle: SandboxLifecycle;
  reminder_latched: number;
  retire_requested: number;
  cold_notice_pending: number;
  active_run_id: string | null;
  next_run_seq: number;
  created_at: number;
  updated_at: number;
  retired_at: number | null;
};

const ALIAS_RE = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*){2}$/;
const SELECT_REGISTRATION = `
  SELECT s.*, a.alias
  FROM persistent_sandboxes s
  JOIN sandbox_aliases a ON a.sandbox_id = s.id
`;

function registration(row: SandboxRow): SandboxRegistration {
  return {
    id: row.id,
    alias: row.alias,
    mindId: row.mind_id,
    executorId: row.executor_id,
    generation: row.generation,
    lifecycle: row.lifecycle,
    reminderLatched: row.reminder_latched === 1,
    retireRequested: row.retire_requested === 1,
    coldNoticePending: row.cold_notice_pending === 1,
    activeRunId: row.active_run_id,
    nextRunSeq: row.next_run_seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at,
  };
}

function assertMindId(mindId: number): void {
  if (!Number.isInteger(mindId) || mindId <= 0) throw new Error('sandbox registry: mind id must be a positive integer');
}

function assertAlias(alias: string): void {
  if (!ALIAS_RE.test(alias)) throw new Error(`sandbox registry: invalid alias ${JSON.stringify(alias)} (expected adverb-adjective-noun)`);
}

export class SandboxRegistry {
  readonly executorId: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly aliases: CreateSandboxRegistryOptions['aliases'];

  constructor(options: CreateSandboxRegistryOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.aliases = options.aliases;
    this.executorId = this.ensureExecutorIdentity();
  }

  private immediate<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* original error wins */ }
      throw error;
    }
  }

  private ensureExecutorIdentity(): string {
    return this.immediate(() => {
      const existing = this.db.prepare('SELECT executor_id FROM sandbox_executor_identity WHERE singleton = 1').get() as { executor_id: string } | undefined;
      if (existing) return existing.executor_id;
      const executorId = this.uuid();
      this.db.prepare('INSERT INTO sandbox_executor_identity (singleton, executor_id, created_at) VALUES (1, ?, ?)').run(executorId, this.now());
      return executorId;
    });
  }

  private resolveId(idOrAlias: string): string {
    if (typeof idOrAlias !== 'string' || !idOrAlias) throw new Error('sandbox registry: sandbox id or alias is required');
    const direct = this.db.prepare('SELECT id FROM persistent_sandboxes WHERE id = ?').get(idOrAlias) as { id: string } | undefined;
    if (direct) return direct.id;
    const alias = this.db.prepare('SELECT sandbox_id FROM sandbox_aliases WHERE alias = ?').get(idOrAlias) as { sandbox_id: string } | undefined;
    if (alias) return alias.sandbox_id;
    throw new Error(`sandbox registry: no sandbox ${JSON.stringify(idOrAlias)}`);
  }

  private byId(id: string): SandboxRegistration {
    const row = this.db.prepare(`${SELECT_REGISTRATION} WHERE s.id = ?`).get(id) as SandboxRow | undefined;
    if (!row) throw new Error(`sandbox registry: no sandbox ${JSON.stringify(id)}`);
    return registration(row);
  }

  get(idOrAlias: string): SandboxRegistration {
    return this.byId(this.resolveId(idOrAlias));
  }

  getByMind(mindId: number): SandboxRegistration | null {
    assertMindId(mindId);
    const row = this.db.prepare(`${SELECT_REGISTRATION} WHERE s.mind_id = ?`).get(mindId) as SandboxRow | undefined;
    return row ? registration(row) : null;
  }

  list(): SandboxRegistration[] {
    return (this.db.prepare(`${SELECT_REGISTRATION} ORDER BY s.created_at, s.id`).all() as SandboxRow[]).map(registration);
  }

  defaultMindId(idOrAlias: string): number {
    return this.get(idOrAlias).mindId;
  }

  registerNamed(mindId: number): SandboxRegistration {
    if (!this.aliases) throw new Error('sandbox registry: named allocation is not configured');
    const lists = loadAliasWordlists(this.aliases.dataDirectory, this.aliases.logger);
    return this.register(mindId, aliasCandidates(lists, this.aliases.chooseStart));
  }

  register(mindId: number, aliases: Iterable<string>): SandboxRegistration {
    assertMindId(mindId);
    return this.immediate(() => {
      const mind = this.db.prepare('SELECT status, archived_at FROM mind_items WHERE id = ?').get(mindId) as { status: string; archived_at: number | null } | undefined;
      if (!mind) throw new Error(`sandbox registry: no Mind item #${mindId}`);
      const existing = this.db.prepare(`${SELECT_REGISTRATION} WHERE s.mind_id = ?`).get(mindId) as SandboxRow | undefined;
      if (existing) return registration(existing);
      if (mind.archived_at !== null || mind.status === 'done' || mind.status === 'cancelled') {
        throw new Error(`sandbox registry: Mind #${mindId} is closed and cannot receive a persistent sandbox`);
      }

      let alias: string | null = null;
      const seen = new Set<string>();
      const reserved = new Set((this.db.prepare('SELECT alias FROM sandbox_aliases').all() as { alias: string }[]).map((row) => row.alias));
      for (const candidate of aliases) {
        assertAlias(candidate);
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        if (!reserved.has(candidate)) { alias = candidate; break; }
      }
      if (!alias) throw new Error('sandbox registry: alias space exhausted');

      const id = this.uuid();
      const now = this.now();
      this.db.prepare(`
        INSERT INTO persistent_sandboxes
          (id, mind_id, executor_id, generation, lifecycle, reminder_latched, retire_requested, active_run_id, next_run_seq, created_at, updated_at, retired_at)
        VALUES (?, ?, ?, 1, 'ready', 0, 0, NULL, 1, ?, ?, NULL)
      `).run(id, mindId, this.executorId, now, now);
      this.db.prepare('INSERT INTO sandbox_aliases (alias, sandbox_id, reserved_at, retired_at) VALUES (?, ?, ?, NULL)').run(alias, id, now);
      return this.byId(id);
    });
  }

  beginRun(idOrAlias: string): SandboxRun {
    const id = this.resolveId(idOrAlias);
    return this.immediate(() => {
      let current = this.byId(id);
      if (current.lifecycle !== 'ready') {
        throw new Error(`sandbox registry: ${current.alias} is ${current.lifecycle}`);
      }
      const mind = this.db.prepare('SELECT status, archived_at FROM mind_items WHERE id = ?').get(current.mindId) as { status: string; archived_at: number | null };
      if (!current.retireRequested && (mind.status === 'done' || mind.status === 'cancelled' || mind.archived_at !== null)) {
        this.requestRetirementInside(current);
        current = this.byId(id);
      }
      const runId = `${current.id}:g${current.generation}:r${current.nextRunSeq}`;
      const now = this.now();
      this.db.prepare(`UPDATE persistent_sandboxes SET lifecycle = 'busy', active_run_id = ?, next_run_seq = next_run_seq + 1, updated_at = ? WHERE id = ?`).run(runId, now, id);
      return { runId, sandbox: this.byId(id) };
    });
  }

  detachRun(idOrAlias: string, runId: string): SandboxRegistration {
    return this.transitionRun(idOrAlias, runId, 'detached');
  }

  finishRun(idOrAlias: string, runId: string): SandboxRegistration {
    const id = this.resolveId(idOrAlias);
    return this.immediate(() => {
      const current = this.byId(id);
      if ((current.lifecycle !== 'busy' && current.lifecycle !== 'detached') || current.activeRunId !== runId) {
        throw new Error(`sandbox registry: ${current.alias} does not own active run ${JSON.stringify(runId)}`);
      }
      const mind = this.db.prepare('SELECT status, archived_at FROM mind_items WHERE id = ?').get(current.mindId) as { status: string; archived_at: number | null };
      const closed = mind.status === 'done' || mind.status === 'cancelled' || mind.archived_at !== null;
      const now = this.now();
      this.db.prepare(`
        UPDATE persistent_sandboxes
        SET lifecycle = 'ready', active_run_id = NULL,
            retire_requested = CASE WHEN ? THEN 1 ELSE retire_requested END,
            updated_at = ?
        WHERE id = ?
      `).run(closed ? 1 : 0, now, id);
      return this.byId(id);
    });
  }

  private transitionRun(idOrAlias: string, runId: string, target: 'detached'): SandboxRegistration {
    const id = this.resolveId(idOrAlias);
    return this.immediate(() => {
      const current = this.byId(id);
      if (current.lifecycle !== 'busy' || current.activeRunId !== runId) {
        throw new Error(`sandbox registry: ${current.alias} does not own active run ${JSON.stringify(runId)}`);
      }
      this.db.prepare('UPDATE persistent_sandboxes SET lifecycle = ?, updated_at = ? WHERE id = ?').run(target, this.now(), id);
      return this.byId(id);
    });
  }

  markInterruptedRunsDetached(): number {
    const result = this.db.prepare(`UPDATE persistent_sandboxes SET lifecycle = 'detached', updated_at = ? WHERE lifecycle = 'busy'`).run(this.now());
    return Number(result.changes);
  }

  failRunAndReset(idOrAlias: string, runId: string): SandboxRegistration {
    const id = this.resolveId(idOrAlias);
    return this.immediate(() => {
      const current = this.byId(id);
      if ((current.lifecycle !== 'busy' && current.lifecycle !== 'detached') || current.activeRunId !== runId) {
        throw new Error(`sandbox registry: ${current.alias} does not own active run ${JSON.stringify(runId)}`);
      }
      this.db.prepare(`
        UPDATE persistent_sandboxes
        SET generation = generation + 1, lifecycle = 'ready', active_run_id = NULL,
            next_run_seq = 1, cold_notice_pending = 0, updated_at = ?
        WHERE id = ?
      `).run(this.now(), id);
      return this.byId(id);
    });
  }

  coldResetAll(): number {
    const result = this.db.prepare(`
      UPDATE persistent_sandboxes
      SET generation = generation + 1, lifecycle = 'ready', active_run_id = NULL,
          next_run_seq = 1, cold_notice_pending = 1, updated_at = ?
      WHERE lifecycle != 'retired'
    `).run(this.now());
    return Number(result.changes);
  }

  consumeColdNotice(idOrAlias: string): boolean {
    const id = this.resolveId(idOrAlias);
    const result = this.db.prepare('UPDATE persistent_sandboxes SET cold_notice_pending = 0 WHERE id = ? AND cold_notice_pending = 1').run(id);
    return Number(result.changes) === 1;
  }

  reset(idOrAlias: string): SandboxRegistration {
    const id = this.resolveId(idOrAlias);
    return this.immediate(() => {
      const current = this.byId(id);
      if (current.lifecycle !== 'ready') throw new Error(`sandbox registry: ${current.alias} must be ready to reset`);
      this.db.prepare(`
        UPDATE persistent_sandboxes
        SET generation = generation + 1, next_run_seq = 1, reminder_latched = 0, updated_at = ?
        WHERE id = ?
      `).run(this.now(), id);
      return this.byId(id);
    });
  }

  latchReminder(idOrAlias: string): boolean {
    const id = this.resolveId(idOrAlias);
    const result = this.db.prepare(`UPDATE persistent_sandboxes SET reminder_latched = 1, updated_at = ? WHERE id = ? AND lifecycle != 'retired' AND reminder_latched = 0`).run(this.now(), id);
    return Number(result.changes) === 1;
  }

  clearReminder(idOrAlias: string): SandboxRegistration {
    const id = this.resolveId(idOrAlias);
    this.db.prepare('UPDATE persistent_sandboxes SET reminder_latched = 0, updated_at = ? WHERE id = ?').run(this.now(), id);
    return this.byId(id);
  }

  clearReminderByMind(mindId: number): SandboxRegistration | null {
    const current = this.getByMind(mindId);
    return current ? this.clearReminder(current.id) : null;
  }

  retireByMind(mindId: number): SandboxRegistration | null {
    const current = this.getByMind(mindId);
    if (!current) return null;
    return this.immediate(() => this.requestRetirementInside(this.byId(current.id)));
  }

  cancelRetirement(mindId: number): SandboxRegistration | null {
    const current = this.getByMind(mindId);
    if (!current || current.lifecycle === 'retired' || !current.retireRequested) return current;
    this.db.prepare('UPDATE persistent_sandboxes SET retire_requested = 0, updated_at = ? WHERE id = ?').run(this.now(), current.id);
    return this.byId(current.id);
  }

  finalizeRetirement(idOrAlias: string): SandboxRegistration {
    const id = this.resolveId(idOrAlias);
    return this.immediate(() => {
      const current = this.byId(id);
      if (current.lifecycle === 'retired') return current;
      if (current.lifecycle !== 'ready' || !current.retireRequested) {
        throw new Error(`sandbox registry: ${current.alias} is not ready for retirement GC`);
      }
      const mind = this.db.prepare('SELECT status, archived_at FROM mind_items WHERE id = ?').get(current.mindId) as { status: string; archived_at: number | null };
      if (mind.status !== 'done' && mind.status !== 'cancelled' && mind.archived_at === null) {
        this.db.prepare('UPDATE persistent_sandboxes SET retire_requested = 0, updated_at = ? WHERE id = ?').run(this.now(), id);
        return this.byId(id);
      }
      const now = this.now();
      this.db.prepare(`UPDATE persistent_sandboxes SET lifecycle = 'retired', retire_requested = 0, retired_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
      this.db.prepare('UPDATE sandbox_aliases SET retired_at = ? WHERE sandbox_id = ?').run(now, id);
      return this.byId(id);
    });
  }

  retireClosedMinds(): number {
    const rows = this.db.prepare(`
      SELECT s.mind_id FROM persistent_sandboxes s
      JOIN mind_items m ON m.id = s.mind_id
      WHERE s.lifecycle != 'retired' AND (m.status IN ('done','cancelled') OR m.archived_at IS NOT NULL)
    `).all() as { mind_id: number }[];
    for (const row of rows) this.retireByMind(row.mind_id);
    return rows.length;
  }

  private requestRetirementInside(current: SandboxRegistration): SandboxRegistration {
    if (current.lifecycle === 'retired' || current.retireRequested) return current;
    this.db.prepare('UPDATE persistent_sandboxes SET retire_requested = 1, updated_at = ? WHERE id = ?').run(this.now(), current.id);
    return this.byId(current.id);
  }
}

export function createSandboxRegistry(options: CreateSandboxRegistryOptions): SandboxRegistry {
  return new SandboxRegistry(options);
}
