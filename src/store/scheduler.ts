// scheduler.ts — persistent, restart-safe task queue for waking the agent.
// Tasks are stored in agent.db and polled by a background timer. When a task is
// due, the scheduler calls onTaskWake so the agent can enqueue a synthetic inbound
// message with the task's payload as the prompt.

import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../lib/log.js';

export type TaskKind = 'reminder' | 'reminder-nag' | 'heartbeat' | 'custom';

export interface ScheduledTask {
  id: number;
  name: string;
  kind: TaskKind;
  channelId: string | null;
  payload: string;
  nextRunAt: number;
  intervalMs: number | null;
  nagIntervalMs: number | null;
  parentId: number | null;
  nagCount: number;
  snoozeUntil: number | null;
  doneAt: number | null;
  createdAt: number;
}

export interface CreateTaskOpts {
  name: string;
  kind?: TaskKind;
  channelId?: string | null;
  payload: string;
  nextRunAt: number;
  intervalMs?: number | null;
  nagIntervalMs?: number | null;
  parentId?: number | null;
}

export interface SchedulerDeps {
  db: DatabaseSync;
  logger: Logger;
  onTaskWake: (task: ScheduledTask) => void;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

 // Prepared once at construction (channels.ts:61-68 idiom) rather than
 // per-call — listDue alone would otherwise recompile every 60s poll.
  private readonly stmtInsert;
  private readonly stmtGetById;
  private readonly stmtGetByName;
  private readonly stmtList;
  private readonly stmtListByParent;
  private readonly stmtListDue;
  private readonly stmtDelete;
  private readonly stmtMarkDone;
  private readonly stmtSnooze;
  private readonly stmtUpdateNextRun;
  private readonly stmtIncrementNagCount;

  constructor(private deps: SchedulerDeps) {
    this.stmtInsert = this.deps.db.prepare(`
      INSERT INTO scheduled_tasks (name, kind, channel_id, payload, next_run_at, interval_ms, nag_interval_ms, parent_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    this.stmtGetById = this.deps.db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?');
    this.stmtGetByName = this.deps.db.prepare('SELECT * FROM scheduled_tasks WHERE name = ?');
    this.stmtList = this.deps.db.prepare('SELECT * FROM scheduled_tasks ORDER BY next_run_at');
    this.stmtListByParent = this.deps.db.prepare('SELECT * FROM scheduled_tasks WHERE parent_id = ?');
    this.stmtListDue = this.deps.db.prepare(
      'SELECT * FROM scheduled_tasks WHERE done_at IS NULL AND next_run_at <= ? AND (snooze_until IS NULL OR snooze_until <= ?) ORDER BY next_run_at'
    );
    this.stmtDelete = this.deps.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?');
    this.stmtMarkDone = this.deps.db.prepare('UPDATE scheduled_tasks SET done_at = ? WHERE id = ? RETURNING *');
    this.stmtSnooze = this.deps.db.prepare('UPDATE scheduled_tasks SET snooze_until = ? WHERE id = ? RETURNING *');
    this.stmtUpdateNextRun = this.deps.db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ? RETURNING *');
    this.stmtIncrementNagCount = this.deps.db.prepare('UPDATE scheduled_tasks SET nag_count = nag_count + 1 WHERE id = ?');
  }

  start(): void {
    if (this.stopped) return;
    this.stop();
    this.schedulePoll(5_000);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => { void this.poll(); }, delayMs);
  }

  poll(): void {
    if (this.stopped) return;
    const now = Date.now();
    const due = this.listDue(now);
    for (const task of due) {
      this.handleDue(task, now);
    }
    this.schedulePoll(60_000);
  }

  private handleDue(task: ScheduledTask, now: number): void {
    this.deps.onTaskWake(task);
    this.deps.logger.info(`[scheduler] task due | id=${task.id} name=${task.name}`);

    if (task.kind === 'reminder') {
 // Send initial nudge, reschedule main cadence, and spawn first nag.
      const next = Math.max(now, task.nextRunAt + (task.intervalMs ?? 0));
      this.updateNextRun(task.id, next);
      this.incrementNagCount(task.id);
      if (task.nagIntervalMs && task.nagIntervalMs > 0) {
        this.spawnNag(task, now + task.nagIntervalMs);
      }
    } else if (task.kind === 'reminder-nag') {
 // Send nag, then chain another nag unless parent is done.
      const parent = task.parentId ? this.getById(task.parentId) : null;
      if (parent && parent.doneAt != null) {
        this.markDone(task.id, now);
      } else {
        this.markDone(task.id, now); // this nag consumed
        if (parent && task.nagIntervalMs && task.nagIntervalMs > 0) {
          this.spawnNag(parent, now + task.nagIntervalMs);
          this.incrementNagCount(parent.id);
        }
      }
    } else if (task.intervalMs && task.intervalMs > 0) {
      const next = Math.max(now, task.nextRunAt + task.intervalMs);
      this.updateNextRun(task.id, next);
    } else {
      this.markDone(task.id, now);
    }
  }

  private spawnNag(parent: ScheduledTask, at: number): void {
    const payload = `${parent.payload}\n\n(nag #${parent.nagCount + 1})`;
    this.create({
      name: `${parent.name}-nag-${Date.now()}`,
      kind: 'reminder-nag',
      channelId: parent.channelId ?? undefined,
      payload,
      nextRunAt: at,
      nagIntervalMs: parent.nagIntervalMs,
      parentId: parent.id,
    });
  }

  create(opts: CreateTaskOpts): ScheduledTask {
    const raw = this.stmtInsert.get(
      opts.name,
      opts.kind ?? 'custom',
      opts.channelId ?? null,
      opts.payload,
      opts.nextRunAt,
      opts.intervalMs ?? null,
      opts.nagIntervalMs ?? null,
      opts.parentId ?? null,
    );
    const result = fromRow(raw);
    this.deps.logger.info(`[scheduler] created task | id=${result.id} name=${result.name}`);
    return result;
  }

  update(id: number, patch: Partial<Pick<ScheduledTask, 'payload' | 'nextRunAt' | 'intervalMs' | 'nagIntervalMs' | 'snoozeUntil'>>): ScheduledTask | null {
 // Snooze cascades to nag children the same way snoozeByName does — a
 // parent-level snooze that leaves a pending nag unsnoozed fires at the
 // old time anyway ( midnight-nag papercut). Only the snooze
 // field cascades; the rest of the patch stays parent-local.
    if (patch.snoozeUntil !== undefined && patch.snoozeUntil != null) {
      for (const child of this.listByParent(id)) {
        if (child.doneAt == null) this.snooze(child.id, patch.snoozeUntil);
      }
    }
 // NOT prepare-once: the SET clause's shape depends on which patch fields
 // are present, so there's no single statement to prepare ahead of time
 // (unlike every other method here, whose SQL text is fixed).
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (patch.payload !== undefined) { sets.push('payload = ?'); values.push(patch.payload); }
    if (patch.nextRunAt !== undefined) { sets.push('next_run_at = ?'); values.push(patch.nextRunAt); }
    if (patch.intervalMs !== undefined) { sets.push('interval_ms = ?'); values.push(patch.intervalMs); }
    if (patch.nagIntervalMs !== undefined) { sets.push('nag_interval_ms = ?'); values.push(patch.nagIntervalMs); }
    if (patch.snoozeUntil !== undefined) { sets.push('snooze_until = ?'); values.push(patch.snoozeUntil); }
    if (sets.length === 0) return this.getById(id);
    values.push(id);
    const raw = this.deps.db.prepare(`
      UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ? RETURNING *
    `).get(...values);
    return raw ? fromRow(raw) : null;
  }

  delete(id: number): boolean {
    const info = this.stmtDelete.run(id);
    return (info.changes ?? 0) > 0;
  }

  getById(id: number): ScheduledTask | null {
    const raw = this.stmtGetById.get(id);
    return raw ? fromRow(raw) : null;
  }

  getByName(name: string): ScheduledTask | null {
    const raw = this.stmtGetByName.get(name);
    return raw ? fromRow(raw) : null;
  }

  list(): ScheduledTask[] {
    const rows = this.stmtList.all();
    return rows.map(fromRow);
  }

  listByParent(parentId: number): ScheduledTask[] {
    const rows = this.stmtListByParent.all(parentId);
    return rows.map(fromRow);
  }

  listDue(now: number): ScheduledTask[] {
    const rows = this.stmtListDue.all(now, now);
    return rows.map(fromRow);
  }

  markDone(id: number, at = Date.now()): ScheduledTask | null {
    const raw = this.stmtMarkDone.get(at, id);
    return raw ? fromRow(raw) : null;
  }

  markDoneByName(name: string, at = Date.now()): boolean {
    const task = this.getByName(name);
    if (!task) return false;
    if (task.intervalMs && task.intervalMs > 0 && task.doneAt == null) {
 // recurring reminder: "done" means this occurrence is handled — re-arm
 // the next slot and quiet the nags rather than killing the cadence.
      let next = task.nextRunAt;
      while (next <= at) next += task.intervalMs;
      this.updateNextRun(task.id, next);
    } else {
      this.markDone(task.id, at);
    }
    for (const child of this.listByParent(task.id)) {
      if (child.doneAt == null) this.markDone(child.id, at);
    }
    return true;
  }

  snooze(id: number, until: number): ScheduledTask | null {
    const raw = this.stmtSnooze.get(until, id);
    return raw ? fromRow(raw) : null;
  }

  snoozeByName(name: string, until: number): boolean {
    const task = this.getByName(name);
    if (!task) return false;
    this.snooze(task.id, until);
    for (const child of this.listByParent(task.id)) {
      if (child.doneAt == null) this.snooze(child.id, until);
    }
    return true;
  }

  private updateNextRun(id: number, nextRunAt: number): ScheduledTask | null {
    const raw = this.stmtUpdateNextRun.get(nextRunAt, id);
    return raw ? fromRow(raw) : null;
  }

  private incrementNagCount(id: number): void {
    this.stmtIncrementNagCount.run(id);
  }
}

function fromRow(row: unknown): ScheduledTask {
  const r = row as Record<string, unknown>;
  return {
    id: Number(r.id),
    name: String(r.name),
    kind: String(r.kind) as TaskKind,
    channelId: r.channel_id == null ? null : String(r.channel_id),
    payload: String(r.payload),
    nextRunAt: Number(r.next_run_at),
    intervalMs: r.interval_ms == null ? null : Number(r.interval_ms),
    nagIntervalMs: r.nag_interval_ms == null ? null : Number(r.nag_interval_ms),
    parentId: r.parent_id == null ? null : Number(r.parent_id),
    nagCount: Number(r.nag_count ?? 0),
    snoozeUntil: r.snooze_until == null ? null : Number(r.snooze_until),
    doneAt: r.done_at == null ? null : Number(r.done_at),
    createdAt: Number(r.created_at),
  };
}
