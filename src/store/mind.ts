import type { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../lib/log.js';
import type { ScheduledTask } from './scheduler.js';
import { isMindId, newMindId, resolveMindRef, type MindId } from './mind-id.js';

export const MIND_STATUSES = [
  'proposal',
  'inbox',
  'open',
  'in_progress',
  'waiting',
  'done',
  'cancelled',
] as const;
export const MIND_KINDS = [
  'task',
  'project',
  'idea',
  'question',
  'reminder',
] as const;
export const MIND_SORTS = [
  'created_asc',
  'created_desc',
  'updated_asc',
  'updated_desc',
  'last_comment_asc',
  'last_comment_desc',
] as const;
export const MIND_LOG_KINDS = [
  'progress',
  'decision',
  'result',
  'verification',
  'omission',
] as const;
export const MIND_GRAPH_RELATIONS = [
  'dependencies',
  'dependents',
  'parent',
  'children',
] as const;
export type MindSort = (typeof MIND_SORTS)[number];
export type MindStatus = (typeof MIND_STATUSES)[number];
export type MindKind = (typeof MIND_KINDS)[number];
export type MindLogKind = (typeof MIND_LOG_KINDS)[number];
export type MindGraphRelation = (typeof MIND_GRAPH_RELATIONS)[number];
export type MindEffectiveStatus = MindStatus | 'blocked';

export interface MindItem {
  id: MindId;
  title: string;
  body: string;
  kind: MindKind;
  status: MindStatus;
  effectiveStatus: MindEffectiveStatus;
  priority: number;
  parentId: MindId | null;
  dueAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  lastCommentAt: number | null;
  closedAt: number | null;
  archivedAt: number | null;
  tags: string[];
  blockedBy: MindLink[];
  blocks: MindLink[];
  childCount: number;
  totalChildCount: number;
  commentCount: number;
  reminderCount: number;
  claim: MindClaim | null;
}

export interface MindClaim {
  itemId: MindId;
  owner: string;
  claimedAt: number;
  renewedAt: number;
  expiresAt: number;
  expired: boolean;
}

export interface MindClaimOptions {
  owner: string;
  principal: string;
  ttlMs?: number;
  note?: string;
}

export interface MindDiscoverOptions {
  tags?: string[];
  boostTags?: string[];
  filterTags?: string[];
  filterMode?: 'all' | 'any';
  parentId?: MindId | null;
  limit?: number;
}

export interface MindWorkMatch {
  score: number;
  matched: string[];
  item: MindItem;
}

export interface MindLink {
  id: MindId;
  title: string;
  status: MindStatus;
  effectiveStatus: MindEffectiveStatus;
}

export interface MindComment {
  id: number;
  itemId: MindId;
  author: string;
  body: string;
  replyToId: number | null;
  createdAt: number;
  updatedAt: number | null;
}

export interface MindEvent {
  id: number;
  itemId: MindId;
  type: string;
  actor: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface SecretaryMindActivity {
  eventId: number;
  itemId: MindId;
  title: string;
  status: MindStatus;
  type: 'comment.added' | 'item.created';
  actor: string;
  commentId: number | null;
  replyToId: number | null;
  body: string | null;
  createdAt: number;
}

export interface SecretaryMindActivityBatch {
  events: SecretaryMindActivity[];
  latestEventId: number;
  truncated: boolean;
}

export interface MindReminder {
  id: number;
  itemId: MindId;
  scheduledTaskId: number;
  fireAt: number;
  channelId: string | null;
  createdBy: string;
  createdAt: number;
  firedAt: number | null;
  cancelledAt: number | null;
}

export interface MindDetail extends MindItem {
  parent: MindLink | null;
  children: MindLink[];
  dependencies: MindLink[];
  comments: MindComment[];
  events: MindEvent[];
  reminders: MindReminder[];
}

export interface MindListFilter {
  statuses?: MindStatus[];
  kinds?: MindKind[];
  tag?: string;
  query?: string;
  parentId?: MindId | null;
  ready?: boolean;
  blocked?: boolean;
  overdue?: boolean;
  includeArchived?: boolean;
  sort?: MindSort;
  limit?: number;
  offset?: number;
}

export interface MindProposalIntake {
  requester: 'conversation-user';
  source: 'secretary';
  sessionId: string;
}

export interface CreateMindItem {
  title: string;
  body?: string;
  kind?: MindKind;
  status?: MindStatus;
  priority?: number;
  parentId?: MindId | null;
  dueAt?: number | null;
  tags?: string[];
  dependsOn?: MindId[];
  actor?: string;
  proposalIntake?: MindProposalIntake;
}

export interface UpdateMindItem {
  title?: string;
  body?: string;
  kind?: MindKind;
  status?: MindStatus;
  priority?: number;
  parentId?: MindId | null;
  dueAt?: number | null;
  tags?: string[];
}

export interface MindStats {
  active: number;
  ready: number;
  blocked: number;
  waiting: number;
  overdue: number;
  done: number;
  inbox: number;
}

export interface MindGraph {
  rootId: MindId;
  nodes: MindItem[];
  edges: { from: MindId; to: MindId; type: 'depends_on' | 'parent' }[];
}

interface SchedulerLike {
  create(opts: {
    name: string;
    kind?: 'custom';
    channelId?: string | null;
    payload: string;
    nextRunAt: number;
  }): ScheduledTask;
  delete(id: number): boolean;
  update(
    id: number,
    patch: {
      nextRunAt?: number;
      payload?: string;
      snoozeUntil?: number | null;
    },
  ): ScheduledTask | null;
}

export interface CreateMindServiceDeps {
  db: DatabaseSync;
  scheduler: SchedulerLike;
  logger: Logger;
  onChanged?: () => void;
  onItemStateChanged?: (
    id: MindId,
    status: MindStatus,
    archived: boolean,
  ) => void;
}

const ACTIVE_STATUSES: MindStatus[] = [
  'inbox',
  'open',
  'in_progress',
  'waiting',
];
const READY_STATUSES: MindStatus[] = ['inbox', 'open'];

function assertStatus(value: unknown): asserts value is MindStatus {
  if (!MIND_STATUSES.includes(value as MindStatus))
    throw new Error(
      `mind: invalid status ${JSON.stringify(value)} (expected ${MIND_STATUSES.join('|')})`,
    );
}

function assertStatusTransition(current: MindStatus, next: MindStatus): void {
  if (current === 'proposal') {
    if (!['proposal', 'inbox', 'open', 'cancelled'].includes(next))
      throw new Error(
        `mind: proposal items can transition only to inbox, open, or cancelled (got ${next})`,
      );
    return;
  }
  if (next === 'proposal')
    throw new Error('mind: normal items cannot transition to proposal');
}

function assertKind(value: unknown): asserts value is MindKind {
  if (!MIND_KINDS.includes(value as MindKind))
    throw new Error(
      `mind: invalid kind ${JSON.stringify(value)} (expected ${MIND_KINDS.join('|')})`,
    );
}

function assertSort(value: unknown): asserts value is MindSort {
  if (!MIND_SORTS.includes(value as MindSort))
    throw new Error(
      `mind: invalid sort ${JSON.stringify(value)} (expected ${MIND_SORTS.join('|')})`,
    );
}

function assertPriority(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 4)
    throw new Error('mind: priority must be an integer from 0 to 4');
}

function assertText(
  value: unknown,
  field: string,
  max: number,
  allowEmpty = false,
): asserts value is string {
  if (typeof value !== 'string')
    throw new Error(`mind: ${field} must be a string`);
  const text = value.trim();
  if (!allowEmpty && text.length === 0)
    throw new Error(`mind: ${field} must not be empty`);
  if (value.length > max)
    throw new Error(`mind: ${field} must be at most ${max} characters`);
}

function normalizeTag(value: string): string {
  const tag = value.trim().toLowerCase().replace(/^#/, '').replace(/\s+/g, '-');
  if (!tag || tag.length > 48 || !/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(tag))
    throw new Error(`mind: invalid tag ${JSON.stringify(value)}`);
  return tag;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function claimTtl(value = 30 * 60_000): number {
  if (!Number.isFinite(value) || value < 60_000 || value > 4 * 60 * 60_000)
    throw new Error('mind: claim ttlMs must be between 1 minute and 4 hours');
  return Math.floor(value);
}

const DISCOVERY_STOP = new Set([
  'about',
  'after',
  'again',
  'also',
  'and',
  'are',
  'been',
  'before',
  'being',
  'but',
  'can',
  'code',
  'could',
  'from',
  'have',
  'into',
  'just',
  'more',
  'not',
  'only',
  'our',
  'should',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'they',
  'this',
  'through',
  'use',
  'using',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'with',
  'work',
  'would',
  'your',
]);
function discoveryTerms(context: string): string[] {
  const raw = context.toLowerCase().match(/[a-z0-9][a-z0-9._/-]{2,}/g) ?? [];
  const expanded = raw.flatMap((token) => [token, ...token.split(/[._/-]+/)]);
  return uniq(
    expanded.filter(
      (token) =>
        token.length >= 3 && !DISCOVERY_STOP.has(token) && !/^\d+$/.test(token),
    ),
  ).slice(0, 60);
}

function parseData(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function rowBase(
  row: Record<string, unknown>,
): Omit<
  MindItem,
  | 'effectiveStatus'
  | 'tags'
  | 'blockedBy'
  | 'blocks'
  | 'childCount'
  | 'totalChildCount'
  | 'commentCount'
  | 'reminderCount'
  | 'claim'
> {
  return {
    id: String(row.id) as MindId,
    title: String(row.title),
    body: String(row.body ?? ''),
    kind: row.kind as MindKind,
    status: row.status as MindStatus,
    priority: Number(row.priority),
    parentId: row.parent_id == null ? null : (String(row.parent_id) as MindId),
    dueAt: row.due_at == null ? null : Number(row.due_at),
    createdBy: String(row.created_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastCommentAt:
      row.last_comment_at == null ? null : Number(row.last_comment_at),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
  };
}

export class MindStore {
  constructor(private readonly db: DatabaseSync) {}

  private transaction<T>(fn: () => T): T {
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

  private requireId(id: MindId): void {
    if (!isMindId(id))
      throw new Error(`mind: invalid item id ${JSON.stringify(id)}`);
    if (!this.db.prepare('SELECT 1 FROM mind_items WHERE id = ?').get(id))
      throw new Error(`mind: no item ${id}`);
  }

  private event(
    itemId: MindId,
    type: string,
    actor: string,
    data: Record<string, unknown>,
    at = Date.now(),
  ): void {
    this.db
      .prepare(
        'INSERT INTO mind_events (item_id, type, actor, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(itemId, type, actor, JSON.stringify(data), at);
  }

  secretaryActivity(afterEventId = 0, limit = 6): SecretaryMindActivityBatch {
    const after = Number.isSafeInteger(afterEventId)
      ? Math.max(0, afterEventId)
      : 0;
    const boundedLimit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(20, limit))
      : 6;
    const rows = (
      this.db
        .prepare(
          `SELECT e.id AS event_id, e.item_id, e.type, e.actor, e.data_json,
                  e.created_at, i.title, i.status
           FROM mind_events e
           JOIN mind_items i ON i.id = e.item_id
           WHERE e.id > ? AND e.actor LIKE 'secretary:%'
             AND e.type IN ('comment.added', 'item.created')
           ORDER BY e.id DESC LIMIT ?`,
        )
        .all(after, boundedLimit + 1) as Array<Record<string, unknown>>
    ).reverse();
    const truncated = rows.length > boundedLimit;
    const selected = rows.slice(Math.max(0, rows.length - boundedLimit));
    const events = selected.map((row): SecretaryMindActivity => {
      let data: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(String(row.data_json));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
          data = parsed as Record<string, unknown>;
      } catch {
        data = {};
      }
      const rawCommentId = Number(data.commentId);
      const commentId =
        Number.isSafeInteger(rawCommentId) && rawCommentId > 0
          ? rawCommentId
          : null;
      const comment = commentId
        ? (this.db
            .prepare(
              'SELECT body, reply_to_id FROM mind_comments WHERE id = ? AND deleted_at IS NULL',
            )
            .get(commentId) as
            { body: string; reply_to_id: number | null } | undefined)
        : undefined;
      return {
        eventId: Number(row.event_id),
        itemId: String(row.item_id) as MindId,
        title: String(row.title),
        status: String(row.status) as MindStatus,
        type: String(row.type) as SecretaryMindActivity['type'],
        actor: String(row.actor),
        commentId,
        replyToId: comment?.reply_to_id ?? null,
        body: comment?.body ?? null,
        createdAt: Number(row.created_at),
      };
    });
    return {
      events,
      latestEventId: events.at(-1)?.eventId ?? after,
      truncated,
    };
  }

  private tagsFor(id: MindId): string[] {
    return (
      this.db
        .prepare('SELECT tag FROM mind_tags WHERE item_id = ? ORDER BY tag')
        .all(id) as { tag: string }[]
    ).map((r) => r.tag);
  }

  private unresolvedDependencies(id: MindId): MindLink[] {
    const rows = this.db
      .prepare(
        `
      SELECT i.* FROM mind_dependencies d JOIN mind_items i ON i.id = d.depends_on_id
      WHERE d.item_id = ? AND i.status != 'done' ORDER BY i.priority DESC, i.id
    `,
      )
      .all(id) as Record<string, unknown>[];
    return rows.map((row) => this.toLink(row));
  }

  private allDependencies(id: MindId): MindLink[] {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM mind_dependencies d JOIN mind_items i ON i.id = d.depends_on_id WHERE d.item_id = ? ORDER BY i.id`,
      )
      .all(id) as Record<string, unknown>[];
    return rows.map((row) => this.toLink(row));
  }

  private dependents(id: MindId): MindLink[] {
    const rows = this.db
      .prepare(
        `SELECT i.* FROM mind_dependencies d JOIN mind_items i ON i.id = d.item_id WHERE d.depends_on_id = ? ORDER BY i.id`,
      )
      .all(id) as Record<string, unknown>[];
    return rows.map((row) => this.toLink(row));
  }

  private toLink(row: Record<string, unknown>): MindLink {
    const id = String(row.id) as MindId;
    const status = row.status as MindStatus;
    return {
      id,
      title: String(row.title),
      status,
      effectiveStatus:
        ACTIVE_STATUSES.includes(status) &&
        this.unresolvedDependencyCount(id) > 0
          ? 'blocked'
          : status,
    };
  }

  private unresolvedDependencyCount(id: MindId): number {
    const row = this.db
      .prepare(
        `
      SELECT count(*) AS n FROM mind_dependencies d JOIN mind_items i ON i.id = d.depends_on_id
      WHERE d.item_id = ? AND i.status != 'done'
    `,
      )
      .get(id) as { n: number };
    return Number(row.n);
  }

  private claimFor(id: MindId): MindClaim | null {
    const row = this.db
      .prepare('SELECT * FROM mind_claims WHERE item_id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? claimFromRow(row) : null;
  }

  private requireExecutableTask(id: MindId): Record<string, unknown> {
    const item = this.db
      .prepare('SELECT * FROM mind_items WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!item) throw new Error(`mind: no item #${id}`);
    if (item.archived_at != null)
      throw new Error(`mind: item #${id} is archived`);
    if (item.kind !== 'task')
      throw new Error(
        `mind: item #${id} is a ${String(item.kind)}, not an executable task`,
      );
    return item;
  }

  private hydrate(row: Record<string, unknown>): MindItem {
    if (!Object.hasOwn(row, 'last_comment_at')) {
      const latest = this.db
        .prepare(
          'SELECT max(COALESCE(updated_at, created_at)) AS at FROM mind_comments WHERE item_id = ? AND deleted_at IS NULL',
        )
        .get(String(row.id)) as { at: number | null };
      row = { ...row, last_comment_at: latest.at };
    }
    const base = rowBase(row);
    const blockedBy = this.unresolvedDependencies(base.id);
    const count = (sql: string) =>
      Number((this.db.prepare(sql).get(base.id) as { n: number }).n);
    return {
      ...base,
      effectiveStatus:
        ACTIVE_STATUSES.includes(base.status) && blockedBy.length > 0
          ? 'blocked'
          : base.status,
      tags: this.tagsFor(base.id),
      blockedBy,
      blocks: this.dependents(base.id),
      childCount: count(
        'SELECT count(*) AS n FROM mind_items WHERE parent_id = ? AND archived_at IS NULL',
      ),
      totalChildCount: count(
        'SELECT count(*) AS n FROM mind_items WHERE parent_id = ?',
      ),
      commentCount: count(
        'SELECT count(*) AS n FROM mind_comments WHERE item_id = ? AND deleted_at IS NULL',
      ),
      reminderCount: count(
        'SELECT count(*) AS n FROM mind_reminders WHERE item_id = ? AND cancelled_at IS NULL AND fired_at IS NULL',
      ),
      claim: this.claimFor(base.id),
    };
  }

  create(opts: CreateMindItem): MindDetail {
    assertText(opts.title, 'title', 240);
    const kind = opts.kind ?? 'task';
    assertKind(kind);
    const status = opts.status ?? 'open';
    assertStatus(status);
    const priority = opts.priority ?? 2;
    assertPriority(priority);
    const body = opts.body ?? '';
    assertText(body, 'body', 100_000, true);
    const actor = opts.actor?.trim() || 'agent';
    const dueAt = opts.dueAt ?? null;
    if (dueAt != null && (!Number.isFinite(dueAt) || dueAt <= 0))
      throw new Error('mind: dueAt must be finite epoch-ms or null');
    const parentId = opts.parentId ?? null;
    if (parentId != null) this.requireId(parentId);
    const dependsOn = uniq(opts.dependsOn ?? []);
    for (const id of dependsOn) this.requireId(id);
    if (status === 'proposal' && dueAt != null)
      throw new Error('mind: proposal items cannot have a due date');
    if (status === 'proposal' && dependsOn.length > 0)
      throw new Error(
        'mind: proposal items cannot have readiness dependencies',
      );
    const proposalIntake = opts.proposalIntake;
    if (
      proposalIntake !== undefined &&
      (status !== 'proposal' ||
        proposalIntake.requester !== 'conversation-user' ||
        proposalIntake.source !== 'secretary' ||
        !/^sec-[A-Za-z0-9_-]{22}$/.test(proposalIntake.sessionId))
    )
      throw new Error('mind: proposal intake metadata is invalid');
    const tags = uniq((opts.tags ?? []).map(normalizeTag));
    const now = Date.now();
    const id = this.transaction(() => {
      let newId: MindId;
      do newId = newMindId();
      while (
        this.db.prepare('SELECT 1 FROM mind_items WHERE id = ?').get(newId)
      );
      this.db
        .prepare(
          `
        INSERT INTO mind_items (id, title, body, kind, status, priority, parent_id, due_at, created_by, created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          newId,
          opts.title.trim(),
          body,
          kind,
          status,
          priority,
          parentId,
          dueAt,
          actor,
          now,
          now,
          status === 'done' || status === 'cancelled' ? now : null,
        );
      for (const tag of tags)
        this.db
          .prepare('INSERT INTO mind_tags (item_id, tag) VALUES (?, ?)')
          .run(newId, tag);
      for (const dep of dependsOn)
        this.addDependencyInternal(newId, dep, actor, now);
      this.event(
        newId,
        'item.created',
        actor,
        {
          title: opts.title.trim(),
          ...(status === 'proposal'
            ? { body, ...(proposalIntake ? { proposalIntake } : {}) }
            : {}),
          kind,
          status,
          priority,
          parentId,
          dueAt,
          tags,
          dependsOn,
        },
        now,
      );
      return newId;
    });
    return this.get(id)!;
  }

  resolve(ref: unknown): MindId {
    const legacyId =
      typeof ref === 'number' && Number.isSafeInteger(ref)
        ? ref
        : typeof ref === 'string' && /^#?\d+$/.test(ref.trim())
          ? Number(ref.trim().replace(/^#/, ''))
          : null;
    if (legacyId !== null) {
      const migrated = this.db
        .prepare(
          'SELECT mind_id FROM mind_id_migration_map WHERE legacy_id = ?',
        )
        .get(legacyId) as { mind_id: MindId } | undefined;
      if (migrated) {
        throw new Error(
          `mind: legacy item ${JSON.stringify(ref)} migrated to ${migrated.mind_id}; use that canonical elm-* id instead`,
        );
      }
    }
    const rows = this.db
      .prepare('SELECT id, title FROM mind_items ORDER BY id')
      .all() as { id: MindId; title: string }[];
    return resolveMindRef(rows, ref).id;
  }

  get(id: MindId): MindDetail | null {
    const row = this.db
      .prepare('SELECT * FROM mind_items WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    const item = this.hydrate(row);
    const parentRow =
      item.parentId == null
        ? null
        : (this.db
            .prepare('SELECT * FROM mind_items WHERE id = ?')
            .get(item.parentId) as Record<string, unknown> | undefined);
    const childRows = this.db
      .prepare(
        'SELECT * FROM mind_items WHERE parent_id = ? AND archived_at IS NULL ORDER BY priority DESC, id',
      )
      .all(id) as Record<string, unknown>[];
    const comments = (
      this.db
        .prepare(
          'SELECT * FROM mind_comments WHERE item_id = ? AND deleted_at IS NULL ORDER BY created_at, id',
        )
        .all(id) as Record<string, unknown>[]
    ).map((r) => ({
      id: Number(r.id),
      itemId: String(r.item_id) as MindId,
      author: String(r.author),
      body: String(r.body),
      replyToId: r.reply_to_id == null ? null : Number(r.reply_to_id),
      createdAt: Number(r.created_at),
      updatedAt: r.updated_at == null ? null : Number(r.updated_at),
    }));
    const events = (
      this.db
        .prepare(
          'SELECT * FROM mind_events WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 200',
        )
        .all(id) as Record<string, unknown>[]
    ).map((r) => ({
      id: Number(r.id),
      itemId: String(r.item_id) as MindId,
      type: String(r.type),
      actor: String(r.actor),
      data: parseData(r.data_json),
      createdAt: Number(r.created_at),
    }));
    const reminders = (
      this.db
        .prepare(
          'SELECT * FROM mind_reminders WHERE item_id = ? ORDER BY fire_at, id',
        )
        .all(id) as Record<string, unknown>[]
    ).map(reminderFromRow);
    return {
      ...item,
      parent: parentRow ? this.toLink(parentRow) : null,
      children: childRows.map((r) => this.toLink(r)),
      dependencies: this.allDependencies(id),
      comments,
      events,
      reminders,
    };
  }

  list(filter: MindListFilter = {}): MindItem[] {
    const where: string[] = [];
    const values: (string | number | null)[] = [];
    if (!filter.includeArchived) where.push('i.archived_at IS NULL');
    if (filter.statuses?.length) {
      for (const status of filter.statuses) assertStatus(status);
      where.push(`i.status IN (${filter.statuses.map(() => '?').join(',')})`);
      values.push(...filter.statuses);
    }
    if (filter.kinds?.length) {
      for (const kind of filter.kinds) assertKind(kind);
      where.push(`i.kind IN (${filter.kinds.map(() => '?').join(',')})`);
      values.push(...filter.kinds);
    }
    if (filter.parentId !== undefined) {
      where.push('i.parent_id IS ?');
      values.push(filter.parentId);
    }
    if (filter.tag) {
      where.push(
        'EXISTS (SELECT 1 FROM mind_tags mt WHERE mt.item_id = i.id AND mt.tag = ?)',
      );
      values.push(normalizeTag(filter.tag));
    }
    if (filter.query?.trim()) {
      const q = `%${filter.query.trim().toLowerCase()}%`;
      where.push(
        `(lower(i.title) LIKE ? OR lower(i.body) LIKE ? OR EXISTS (SELECT 1 FROM mind_comments mc WHERE mc.item_id = i.id AND mc.deleted_at IS NULL AND lower(mc.body) LIKE ?))`,
      );
      values.push(q, q, q);
    }
    if (filter.overdue) {
      where.push(
        `i.due_at IS NOT NULL AND i.due_at < ? AND i.status NOT IN ('done','cancelled')`,
      );
      values.push(Date.now());
    }
    const limit = Math.max(1, Math.min(500, filter.limit ?? 100));
    const offset = Math.max(0, filter.offset ?? 0);
    const sort = filter.sort ?? 'updated_desc';
    assertSort(sort);
    const orderBy: Record<MindSort, string> = {
      created_asc: 'i.created_at ASC, i.id ASC',
      created_desc: 'i.created_at DESC, i.id DESC',
      updated_asc: 'i.updated_at ASC, i.id ASC',
      updated_desc: 'i.updated_at DESC, i.id DESC',
      last_comment_asc:
        'last_comment_at IS NULL, last_comment_at ASC, i.id ASC',
      last_comment_desc:
        'last_comment_at IS NULL, last_comment_at DESC, i.id DESC',
    };
    const rows = this.db
      .prepare(
        `SELECT i.*, (SELECT max(COALESCE(mc.updated_at, mc.created_at)) FROM mind_comments mc WHERE mc.item_id = i.id AND mc.deleted_at IS NULL) AS last_comment_at FROM mind_items i ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy[sort]} LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset) as Record<string, unknown>[];
    let items = rows.map((row) => this.hydrate(row));
    if (filter.ready)
      items = items.filter(
        (item) =>
          item.kind === 'task' &&
          item.status === 'open' &&
          item.blockedBy.length === 0,
      );
    if (filter.blocked)
      items = items.filter((item) => item.effectiveStatus === 'blocked');
    return items;
  }

  ready(limit = 100): MindItem[] {
    return this.list({
      statuses: ['open'],
      kinds: ['task'],
      ready: true,
      limit,
    });
  }

  discover(context: string, opts: MindDiscoverOptions = {}): MindWorkMatch[] {
    assertText(context, 'discovery context', 50_000, true);
    const terms = discoveryTerms(context);
    const tagHints = uniq(
      [...(opts.tags ?? []), ...(opts.boostTags ?? [])].map(normalizeTag),
    );
    const filterTags = uniq((opts.filterTags ?? []).map(normalizeTag));
    const filterMode = opts.filterMode ?? 'all';
    const candidates = this.list({
      statuses: ['open'],
      kinds: ['task'],
      ready: true,
      parentId: opts.parentId,
      limit: 500,
      sort: 'updated_desc',
    }).filter(
      (item) =>
        filterTags.length === 0 ||
        (filterMode === 'all'
          ? filterTags.every((tag) => item.tags.includes(tag))
          : filterTags.some((tag) => item.tags.includes(tag))),
    );
    const matches: MindWorkMatch[] = [];
    for (const item of candidates) {
      const detail = this.get(item.id)!;
      const title = item.title.toLowerCase();
      const body = item.body.toLowerCase();
      const tags = item.tags.map((tag) => tag.toLowerCase());
      const comments = detail.comments
        .slice(-30)
        .map((comment) => comment.body.toLowerCase())
        .join('\n');
      let score = 0;
      const matched: string[] = [];
      for (const term of terms) {
        let termScore = 0;
        if (title.includes(term)) termScore += 8;
        if (tags.some((tag) => tag.includes(term))) termScore += 6;
        if (body.includes(term)) termScore += 3;
        if (comments.includes(term)) termScore += 2;
        if (termScore) {
          score += termScore;
          matched.push(term);
        }
      }
      for (const tag of tagHints)
        if (tags.includes(tag)) {
          score += 10;
          matched.push(`#${tag}`);
        }
      if (terms.length === 0 && tagHints.length === 0) score = 1;
      if (score > 0) matches.push({ score, matched: uniq(matched), item });
    }
    const limit = Math.max(1, Math.min(50, opts.limit ?? 10));
    return matches
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.item.priority - a.item.priority ||
          b.item.updatedAt - a.item.updatedAt,
      )
      .slice(0, limit);
  }

  claim(id: MindId, opts: MindClaimOptions): MindDetail {
    assertText(opts.owner, 'claim owner', 120);
    assertText(opts.principal, 'claim principal', 200);
    if (opts.note !== undefined)
      assertText(opts.note, 'claim note', 20_000, true);
    const ttl = claimTtl(opts.ttlMs);
    const now = Date.now();
    this.transaction(() => {
      const item = this.db
        .prepare('SELECT * FROM mind_items WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!item) throw new Error(`mind: no item #${id}`);
      if (item.archived_at != null)
        throw new Error(`mind: item #${id} is archived`);
      const status = item.status as MindStatus;
      if (item.kind !== 'task')
        throw new Error(
          `mind: item #${id} is a ${String(item.kind)}, not an executable task`,
        );
      if (
        status === 'proposal' ||
        status === 'done' ||
        status === 'cancelled' ||
        status === 'waiting' ||
        status === 'inbox'
      )
        throw new Error(`mind: item #${id} is ${status}, not open work`);
      if (this.unresolvedDependencyCount(id) > 0)
        throw new Error(`mind: item #${id} is blocked by dependencies`);

      const existing = this.db
        .prepare('SELECT * FROM mind_claims WHERE item_id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (existing && Number(existing.expires_at) > now) {
        if (String(existing.principal) !== opts.principal)
          throw new Error(
            `mind: item #${id} is claimed by ${String(existing.owner)} until ${new Date(Number(existing.expires_at)).toISOString()}`,
          );
        const expiresAt = now + ttl;
        this.db
          .prepare(
            'UPDATE mind_claims SET owner = ?, renewed_at = ?, expires_at = ? WHERE item_id = ?',
          )
          .run(opts.owner.trim(), now, expiresAt, id);
        this.event(id, 'claim.renewed', opts.owner.trim(), { expiresAt }, now);
        return;
      }
      if (status === 'in_progress' && !existing)
        throw new Error(
          `mind: item #${id} is already in progress outside an MCP claim`,
        );

      let previousExpiredOwner: string | null = null;
      if (existing) {
        previousExpiredOwner = String(existing.owner);
        this.db.prepare('DELETE FROM mind_claims WHERE item_id = ?').run(id);
        this.addCommentInternal(
          id,
          `MCP claim by ${previousExpiredOwner} expired; item became reclaimable.`,
          'system',
          now,
        );
        this.event(
          id,
          'claim.expired',
          'system',
          {
            owner: previousExpiredOwner,
            expiredAt: Number(existing.expires_at),
          },
          now,
        );
      }
      const expiresAt = now + ttl;
      this.db
        .prepare(
          'INSERT INTO mind_claims (item_id, owner, principal, claimed_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, opts.owner.trim(), opts.principal.trim(), now, now, expiresAt);
      this.db
        .prepare(
          "UPDATE mind_items SET status = 'in_progress', closed_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      const note = opts.note?.trim();
      this.addCommentInternal(
        id,
        `Work claimed through MCP.${note ? `\n\n${note}` : ''}`,
        opts.owner.trim(),
        now,
      );
      this.event(
        id,
        'claim.started',
        opts.owner.trim(),
        { expiresAt, previousExpiredOwner },
        now,
      );
    });
    return this.get(id)!;
  }

  resumeClaim(id: MindId, opts: MindClaimOptions): MindDetail {
    assertText(opts.owner, 'claim owner', 120);
    assertText(opts.principal, 'claim principal', 200);
    assertText(opts.note ?? '', 'resume note', 20_000);
    const ttl = claimTtl(opts.ttlMs);
    const now = Date.now();
    this.transaction(() => {
      const item = this.db
        .prepare('SELECT * FROM mind_items WHERE id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!item) throw new Error(`mind: no item #${id}`);
      if (item.archived_at != null)
        throw new Error(`mind: item #${id} is archived`);
      if (item.kind !== 'task')
        throw new Error(
          `mind: item #${id} is a ${String(item.kind)}, not an executable task`,
        );
      if (item.status !== 'waiting')
        throw new Error(
          `mind: item #${id} is ${String(item.status)}, not waiting`,
        );
      if (this.unresolvedDependencyCount(id) > 0)
        throw new Error(`mind: item #${id} is blocked by dependencies`);
      const existing = this.db
        .prepare('SELECT * FROM mind_claims WHERE item_id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (existing && Number(existing.expires_at) > now)
        throw new Error(
          `mind: item #${id} is claimed by ${String(existing.owner)}`,
        );
      if (existing)
        this.db.prepare('DELETE FROM mind_claims WHERE item_id = ?').run(id);
      const expiresAt = now + ttl;
      this.db
        .prepare(
          'INSERT INTO mind_claims (item_id, owner, principal, claimed_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, opts.owner.trim(), opts.principal.trim(), now, now, expiresAt);
      this.db
        .prepare(
          "UPDATE mind_items SET status = 'in_progress', closed_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, id);
      const comment = this.addCommentInternal(
        id,
        `Resumed and claimed through MCP.\n\n${opts.note!.trim()}`,
        opts.owner.trim(),
        now,
      );
      this.event(
        id,
        'claim.resumed',
        opts.owner.trim(),
        { expiresAt, commentId: comment.id },
        now,
      );
    });
    return this.get(id)!;
  }

  renewClaim(id: MindId, principal: string, ttlMs?: number): MindDetail {
    assertText(principal, 'claim principal', 200);
    const ttl = claimTtl(ttlMs);
    const now = Date.now();
    this.transaction(() => {
      this.requireExecutableTask(id);
      const row = this.db
        .prepare('SELECT * FROM mind_claims WHERE item_id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row || Number(row.expires_at) <= now)
        throw new Error(`mind: item #${id} has no active claim`);
      if (String(row.principal) !== principal.trim())
        throw new Error(`mind: item #${id} is claimed by another collaborator`);
      const expiresAt = now + ttl;
      this.db
        .prepare(
          'UPDATE mind_claims SET renewed_at = ?, expires_at = ? WHERE item_id = ?',
        )
        .run(now, expiresAt, id);
      this.db
        .prepare('UPDATE mind_items SET updated_at = ? WHERE id = ?')
        .run(now, id);
      this.event(id, 'claim.renewed', String(row.owner), { expiresAt }, now);
    });
    return this.get(id)!;
  }

  releaseClaim(
    id: MindId,
    principal: string,
    status: 'open' | 'waiting',
    note: string,
  ): MindDetail {
    assertText(principal, 'claim principal', 200);
    assertText(note, 'release note', 20_000);
    const now = Date.now();
    this.transaction(() => {
      this.requireExecutableTask(id);
      const row = this.db
        .prepare('SELECT * FROM mind_claims WHERE item_id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row) throw new Error(`mind: item #${id} has no active claim`);
      if (String(row.principal) !== principal.trim())
        throw new Error(`mind: item #${id} is claimed by another collaborator`);
      const owner = String(row.owner);
      this.db.prepare('DELETE FROM mind_claims WHERE item_id = ?').run(id);
      this.db
        .prepare(
          'UPDATE mind_items SET status = ?, closed_at = NULL, updated_at = ? WHERE id = ?',
        )
        .run(status, now, id);
      this.addCommentInternal(
        id,
        `${status === 'waiting' ? 'Blocked' : 'Released'}: ${note.trim()}`,
        owner,
        now,
      );
      this.event(
        id,
        status === 'waiting' ? 'claim.blocked' : 'claim.released',
        owner,
        { status },
        now,
      );
    });
    return this.get(id)!;
  }

  logClaim(
    id: MindId,
    principal: string,
    owner: string,
    kind: MindLogKind,
    body: string,
    ttlMs?: number,
  ): MindDetail {
    assertText(principal, 'claim principal', 200);
    assertText(owner, 'claim owner', 120);
    assertText(body, 'claim log', 20_000);
    if (!MIND_LOG_KINDS.includes(kind))
      throw new Error(`mind: invalid log kind ${JSON.stringify(kind)}`);
    const ttl = claimTtl(ttlMs);
    const now = Date.now();
    this.transaction(() => {
      this.requireExecutableTask(id);
      const row = this.db
        .prepare('SELECT * FROM mind_claims WHERE item_id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row || Number(row.expires_at) <= now)
        throw new Error(`mind: item #${id} has no active claim`);
      if (String(row.principal) !== principal.trim())
        throw new Error(`mind: item #${id} is claimed by another collaborator`);
      const labels: Record<MindLogKind, string> = {
        progress: 'Progress',
        decision: 'Decision',
        result: 'Result',
        verification: 'Verification',
        omission: 'Omission',
      };
      this.addCommentInternal(
        id,
        `${labels[kind]}: ${body.trim()}`,
        owner.trim(),
        now,
      );
      const expiresAt = now + ttl;
      this.db
        .prepare(
          'UPDATE mind_claims SET owner = ?, renewed_at = ?, expires_at = ? WHERE item_id = ?',
        )
        .run(owner.trim(), now, expiresAt, id);
      this.event(id, 'claim.logged', owner.trim(), { kind, expiresAt }, now);
    });
    return this.get(id)!;
  }

  finishClaim(
    id: MindId,
    principal: string,
    owner: string,
    result: string,
    verification: string,
    omissions: string,
  ): MindDetail {
    assertText(principal, 'claim principal', 200);
    assertText(owner, 'claim owner', 120);
    assertText(result, 'result', 10_000);
    assertText(verification, 'verification', 10_000);
    assertText(omissions, 'omissions', 10_000);
    const body = `Result:\n${result.trim()}\n\nVerification:\n${verification.trim()}\n\nOmissions:\n${omissions.trim()}`;
    assertText(body, 'completion record', 20_000);
    const now = Date.now();
    this.transaction(() => {
      this.requireExecutableTask(id);
      const row = this.db
        .prepare('SELECT * FROM mind_claims WHERE item_id = ?')
        .get(id) as Record<string, unknown> | undefined;
      if (!row || Number(row.expires_at) <= now)
        throw new Error(`mind: item #${id} has no active claim`);
      if (String(row.principal) !== principal.trim())
        throw new Error(`mind: item #${id} is claimed by another collaborator`);
      if (this.unresolvedDependencyCount(id) > 0)
        throw new Error(`mind: item #${id} became blocked by dependencies`);
      const comment = this.addCommentInternal(id, body, owner.trim(), now);
      this.db.prepare('DELETE FROM mind_claims WHERE item_id = ?').run(id);
      this.db
        .prepare(
          "UPDATE mind_items SET status = 'done', closed_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(now, now, id);
      this.event(
        id,
        'claim.completed',
        owner.trim(),
        { commentId: comment.id },
        now,
      );
    });
    return this.get(id)!;
  }

  expireClaims(now = Date.now()): MindId[] {
    return this.transaction(() => {
      const expired = this.db
        .prepare(
          'SELECT * FROM mind_claims WHERE expires_at <= ? ORDER BY item_id',
        )
        .all(now) as Record<string, unknown>[];
      const ids: MindId[] = [];
      for (const row of expired) {
        const id = String(row.item_id) as MindId;
        ids.push(id);
        this.db.prepare('DELETE FROM mind_claims WHERE item_id = ?').run(id);
        this.db
          .prepare(
            "UPDATE mind_items SET status = CASE WHEN status = 'in_progress' THEN 'open' ELSE status END, updated_at = ? WHERE id = ?",
          )
          .run(now, id);
        this.addCommentInternal(
          id,
          `MCP claim by ${String(row.owner)} expired; item returned to open work.`,
          'system',
          now,
        );
        this.event(
          id,
          'claim.expired',
          'system',
          { owner: String(row.owner), expiredAt: Number(row.expires_at) },
          now,
        );
      }
      return ids;
    });
  }

  update(id: MindId, patch: UpdateMindItem, actor = 'agent'): MindDetail {
    this.requireId(id);
    const current = this.get(id)!;
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    const changed: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      assertText(patch.title, 'title', 240);
      sets.push('title = ?');
      values.push(patch.title.trim());
      changed.title = patch.title.trim();
    }
    if (patch.body !== undefined) {
      assertText(patch.body, 'body', 100_000, true);
      sets.push('body = ?');
      values.push(patch.body);
      changed.body = patch.body;
    }
    if (patch.kind !== undefined) {
      assertKind(patch.kind);
      sets.push('kind = ?');
      values.push(patch.kind);
      changed.kind = patch.kind;
    }
    if (patch.status !== undefined) {
      assertStatus(patch.status);
      assertStatusTransition(current.status, patch.status);
      sets.push('status = ?');
      values.push(patch.status);
      changed.status = patch.status;
      const closed = patch.status === 'done' || patch.status === 'cancelled';
      sets.push('closed_at = ?');
      values.push(closed ? Date.now() : null);
    }
    if (patch.priority !== undefined) {
      assertPriority(patch.priority);
      sets.push('priority = ?');
      values.push(patch.priority);
      changed.priority = patch.priority;
    }
    if (patch.dueAt !== undefined) {
      const resultingStatus = patch.status ?? current.status;
      if (resultingStatus === 'proposal' && patch.dueAt != null)
        throw new Error('mind: proposal items cannot have a due date');
      if (
        patch.dueAt != null &&
        (!Number.isFinite(patch.dueAt) || patch.dueAt <= 0)
      )
        throw new Error('mind: dueAt must be finite epoch-ms or null');
      sets.push('due_at = ?');
      values.push(patch.dueAt);
      changed.dueAt = patch.dueAt;
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId != null) {
        this.requireId(patch.parentId);
        this.assertNoParentCycle(id, patch.parentId);
      }
      sets.push('parent_id = ?');
      values.push(patch.parentId);
      changed.parentId = patch.parentId;
    }
    const tags = patch.tags?.map(normalizeTag);
    const now = Date.now();
    this.transaction(() => {
      if (sets.length) {
        sets.push('updated_at = ?');
        values.push(now, id);
        this.db
          .prepare(`UPDATE mind_items SET ${sets.join(', ')} WHERE id = ?`)
          .run(...values);
      }
      if (tags) {
        this.db.prepare('DELETE FROM mind_tags WHERE item_id = ?').run(id);
        for (const tag of uniq(tags))
          this.db
            .prepare('INSERT INTO mind_tags (item_id, tag) VALUES (?, ?)')
            .run(id, tag);
        this.db
          .prepare('UPDATE mind_items SET updated_at = ? WHERE id = ?')
          .run(now, id);
        changed.tags = uniq(tags);
      }
      if (
        (patch.status !== undefined && patch.status !== 'in_progress') ||
        (patch.kind !== undefined && patch.kind !== 'task')
      ) {
        const claim = this.db
          .prepare('SELECT owner FROM mind_claims WHERE item_id = ?')
          .get(id) as { owner: string } | undefined;
        if (claim) {
          this.db.prepare('DELETE FROM mind_claims WHERE item_id = ?').run(id);
          this.event(
            id,
            'claim.revoked',
            actor,
            {
              owner: claim.owner,
              status: patch.status ?? current.status,
              kind: patch.kind ?? current.kind,
            },
            now,
          );
        }
      }
      if (Object.keys(changed).length)
        this.event(
          id,
          patch.status !== undefined && Object.keys(changed).length === 1
            ? 'item.status'
            : 'item.updated',
          actor,
          { before: pickItemSnapshot(current), patch: changed },
          now,
        );
    });
    return this.get(id)!;
  }

  setStatus(id: MindId, status: MindStatus, actor = 'agent'): MindDetail {
    return this.update(id, { status }, actor);
  }
  archive(id: MindId, actor = 'agent'): MindDetail {
    this.requireId(id);
    const at = Date.now();
    this.transaction(() => {
      const claim = this.db
        .prepare('SELECT owner FROM mind_claims WHERE item_id = ?')
        .get(id) as { owner: string } | undefined;
      this.db
        .prepare(
          'UPDATE mind_items SET archived_at = ?, updated_at = ? WHERE id = ?',
        )
        .run(at, at, id);
      if (claim) {
        this.db.prepare('DELETE FROM mind_claims WHERE item_id = ?').run(id);
        this.event(
          id,
          'claim.revoked',
          actor,
          { owner: claim.owner, archived: true },
          at,
        );
      }
      this.event(id, 'item.archived', actor, {}, at);
    });
    return this.get(id)!;
  }
  restore(id: MindId, actor = 'agent'): MindDetail {
    this.requireId(id);
    const at = Date.now();
    this.db
      .prepare(
        'UPDATE mind_items SET archived_at = NULL, updated_at = ? WHERE id = ?',
      )
      .run(at, id);
    this.event(id, 'item.restored', actor, {}, at);
    return this.get(id)!;
  }

  addDependency(id: MindId, dependsOnId: MindId, actor = 'agent'): MindDetail {
    this.requireId(id);
    this.requireId(dependsOnId);
    const at = Date.now();
    this.transaction(() => {
      this.addDependencyInternal(id, dependsOnId, actor, at);
      this.db
        .prepare('UPDATE mind_items SET updated_at = ? WHERE id = ?')
        .run(at, id);
    });
    return this.get(id)!;
  }

  private addDependencyInternal(
    id: MindId,
    dependsOnId: MindId,
    actor: string,
    at: number,
  ): void {
    const proposal = this.db
      .prepare(
        "SELECT id FROM mind_items WHERE id IN (?, ?) AND status = 'proposal' LIMIT 1",
      )
      .get(id, dependsOnId);
    if (proposal)
      throw new Error(
        'mind: proposal items cannot have readiness dependencies',
      );
    if (id === dependsOnId)
      throw new Error('mind: an item cannot depend on itself');
    const cycle = this.db
      .prepare(
        `WITH RECURSIVE deps(id) AS (SELECT depends_on_id FROM mind_dependencies WHERE item_id = ? UNION SELECT d.depends_on_id FROM mind_dependencies d JOIN deps x ON d.item_id = x.id) SELECT 1 FROM deps WHERE id = ? LIMIT 1`,
      )
      .get(dependsOnId, id);
    if (cycle)
      throw new Error(
        `mind: dependency #${id} → #${dependsOnId} would create a cycle`,
      );
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO mind_dependencies (item_id, depends_on_id, created_by, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, dependsOnId, actor, at);
    if ((r.changes ?? 0) > 0)
      this.event(id, 'dependency.added', actor, { dependsOnId }, at);
  }

  removeDependency(
    id: MindId,
    dependsOnId: MindId,
    actor = 'agent',
  ): MindDetail {
    this.requireId(id);
    const at = Date.now();
    const r = this.db
      .prepare(
        'DELETE FROM mind_dependencies WHERE item_id = ? AND depends_on_id = ?',
      )
      .run(id, dependsOnId);
    if ((r.changes ?? 0) > 0) {
      this.db
        .prepare('UPDATE mind_items SET updated_at = ? WHERE id = ?')
        .run(at, id);
      this.event(id, 'dependency.removed', actor, { dependsOnId }, at);
    }
    return this.get(id)!;
  }

  private addCommentInternal(
    id: MindId,
    body: string,
    author: string,
    at: number,
    replyToId: number | null = null,
  ): MindComment {
    const result = this.db
      .prepare(
        'INSERT INTO mind_comments (item_id, author, body, reply_to_id, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, author, body.trim(), replyToId, at);
    this.db
      .prepare('UPDATE mind_items SET updated_at = ? WHERE id = ?')
      .run(at, id);
    this.event(
      id,
      'comment.added',
      author,
      { commentId: Number(result.lastInsertRowid), replyToId },
      at,
    );
    return {
      id: Number(result.lastInsertRowid),
      itemId: id,
      author,
      body: body.trim(),
      replyToId,
      createdAt: at,
      updatedAt: null,
    };
  }

  addComment(id: MindId, body: string, author = 'agent'): MindComment {
    this.requireId(id);
    assertText(body, 'comment', 20_000);
    return this.addCommentInternal(id, body, author, Date.now());
  }

  addReply(
    id: MindId,
    replyToId: number,
    body: string,
    author = 'agent',
  ): MindComment {
    this.requireId(id);
    assertText(body, 'comment', 20_000);
    const target = this.db
      .prepare(
        'SELECT item_id FROM mind_comments WHERE id = ? AND deleted_at IS NULL',
      )
      .get(replyToId) as { item_id: string } | undefined;
    if (!target) throw new Error(`mind: no comment #${replyToId}`);
    if (target.item_id !== id)
      throw new Error(
        `mind: comment #${replyToId} does not belong to item ${id}`,
      );
    return this.addCommentInternal(id, body, author, Date.now(), replyToId);
  }

  updateComment(
    commentId: number,
    body: string,
    author = 'agent',
  ): MindComment {
    assertText(body, 'comment', 20_000);
    const row = this.db
      .prepare(
        'SELECT * FROM mind_comments WHERE id = ? AND deleted_at IS NULL',
      )
      .get(commentId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`mind: no comment #${commentId}`);
    const at = Date.now();
    this.db
      .prepare('UPDATE mind_comments SET body = ?, updated_at = ? WHERE id = ?')
      .run(body.trim(), at, commentId);
    this.db
      .prepare('UPDATE mind_items SET updated_at = ? WHERE id = ?')
      .run(at, String(row.item_id) as MindId);
    this.event(
      String(row.item_id) as MindId,
      'comment.updated',
      author,
      { commentId },
      at,
    );
    return {
      id: commentId,
      itemId: String(row.item_id) as MindId,
      author: String(row.author),
      body: body.trim(),
      replyToId: row.reply_to_id == null ? null : Number(row.reply_to_id),
      createdAt: Number(row.created_at),
      updatedAt: at,
    };
  }

  deleteComment(commentId: number, actor = 'agent'): boolean {
    const row = this.db
      .prepare(
        'SELECT item_id FROM mind_comments WHERE id = ? AND deleted_at IS NULL',
      )
      .get(commentId) as { item_id: string } | undefined;
    if (!row) return false;
    const at = Date.now();
    this.db
      .prepare('UPDATE mind_comments SET deleted_at = ? WHERE id = ?')
      .run(at, commentId);
    this.db
      .prepare('UPDATE mind_items SET updated_at = ? WHERE id = ?')
      .run(at, String(row.item_id) as MindId);
    this.event(
      String(row.item_id) as MindId,
      'comment.deleted',
      actor,
      { commentId },
      at,
    );
    return true;
  }

  addTag(id: MindId, tag: string, actor = 'agent'): MindDetail {
    this.requireId(id);
    const normalized = normalizeTag(tag);
    const r = this.db
      .prepare('INSERT OR IGNORE INTO mind_tags (item_id, tag) VALUES (?, ?)')
      .run(id, normalized);
    if ((r.changes ?? 0) > 0)
      this.event(id, 'tag.added', actor, { tag: normalized });
    return this.get(id)!;
  }
  removeTag(id: MindId, tag: string, actor = 'agent'): MindDetail {
    this.requireId(id);
    const normalized = normalizeTag(tag);
    const r = this.db
      .prepare('DELETE FROM mind_tags WHERE item_id = ? AND tag = ?')
      .run(id, normalized);
    if ((r.changes ?? 0) > 0)
      this.event(id, 'tag.removed', actor, { tag: normalized });
    return this.get(id)!;
  }

  stats(): MindStats {
    const items = this.list({ limit: 500 });
    const now = Date.now();
    return {
      active: items.filter((x) => ACTIVE_STATUSES.includes(x.status)).length,
      ready: items.filter(
        (x) =>
          x.kind === 'task' && x.status === 'open' && x.blockedBy.length === 0,
      ).length,
      blocked: items.filter((x) => x.effectiveStatus === 'blocked').length,
      waiting: items.filter((x) => x.status === 'waiting').length,
      overdue: items.filter(
        (x) =>
          x.dueAt != null &&
          x.dueAt < now &&
          ACTIVE_STATUSES.includes(x.status),
      ).length,
      done: items.filter((x) => x.status === 'done').length,
      inbox: items.filter((x) => x.status === 'inbox').length,
    };
  }

  graph(
    rootId: MindId,
    depth = 4,
    relations: MindGraphRelation[] = [...MIND_GRAPH_RELATIONS],
  ): MindGraph {
    this.requireId(rootId);
    const maxDepth = Math.max(0, Math.min(12, Math.floor(depth)));
    const relationSet = new Set(relations);
    for (const relation of relationSet)
      if (!MIND_GRAPH_RELATIONS.includes(relation))
        throw new Error(
          `mind: invalid graph relation ${JSON.stringify(relation)}`,
        );
    const seen = new Set<MindId>([rootId]);
    const queue = [{ id: rootId, depth: 0 }];
    const edges: MindGraph['edges'] = [];
    const visit = (
      from: MindId,
      to: MindId,
      type: 'depends_on' | 'parent',
      nextId: MindId,
      nextDepth: number,
    ) => {
      edges.push({ from, to, type });
      if (!seen.has(nextId)) {
        seen.add(nextId);
        queue.push({ id: nextId, depth: nextDepth });
      }
    };
    while (queue.length) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;
      const nextDepth = current.depth + 1;
      const detail = this.get(current.id)!;
      if (relationSet.has('dependencies'))
        for (const dep of this.allDependencies(current.id))
          visit(current.id, dep.id, 'depends_on', dep.id, nextDepth);
      if (relationSet.has('dependents'))
        for (const dependent of this.dependents(current.id))
          visit(
            dependent.id,
            current.id,
            'depends_on',
            dependent.id,
            nextDepth,
          );
      if (relationSet.has('parent') && detail.parent)
        visit(
          current.id,
          detail.parent.id,
          'parent',
          detail.parent.id,
          nextDepth,
        );
      if (relationSet.has('children'))
        for (const child of detail.children)
          visit(child.id, current.id, 'parent', child.id, nextDepth);
    }
    const nodes = Array.from(seen)
      .map((id) => this.get(id)!)
      .filter(Boolean);
    const uniqueEdges = Array.from(
      new Map(
        edges.map((edge) => [`${edge.type}:${edge.from}:${edge.to}`, edge]),
      ).values(),
    );
    return { rootId, nodes, edges: uniqueEdges };
  }

  createReminderRecord(
    itemId: MindId,
    scheduledTaskId: number,
    fireAt: number,
    channelId: string | null,
    createdBy: string,
  ): MindReminder {
    const item = this.db
      .prepare('SELECT status FROM mind_items WHERE id = ?')
      .get(itemId) as { status: MindStatus } | undefined;
    if (!item) throw new Error(`mind: no item #${itemId}`);
    if (item.status === 'proposal')
      throw new Error('mind: proposal items cannot have reminders');
    const at = Date.now();
    const r = this.db
      .prepare(
        'INSERT INTO mind_reminders (item_id, scheduled_task_id, fire_at, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(itemId, scheduledTaskId, fireAt, channelId, createdBy, at);
    this.event(
      itemId,
      'reminder.added',
      createdBy,
      {
        reminderId: Number(r.lastInsertRowid),
        scheduledTaskId,
        fireAt,
        channelId,
      },
      at,
    );
    return this.reminderById(Number(r.lastInsertRowid))!;
  }
  reminderById(id: number): MindReminder | null {
    const row = this.db
      .prepare('SELECT * FROM mind_reminders WHERE id = ?')
      .get(id) as Record<string, unknown> | undefined;
    return row ? reminderFromRow(row) : null;
  }
  pendingReminders(itemId: MindId): MindReminder[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM mind_reminders WHERE item_id = ? AND fired_at IS NULL AND cancelled_at IS NULL ORDER BY fire_at',
        )
        .all(itemId) as Record<string, unknown>[]
    ).map(reminderFromRow);
  }
  markReminderFiredByTask(scheduledTaskId: number): void {
    const row = this.db
      .prepare(
        'SELECT * FROM mind_reminders WHERE scheduled_task_id = ? AND fired_at IS NULL AND cancelled_at IS NULL',
      )
      .get(scheduledTaskId) as Record<string, unknown> | undefined;
    if (!row) return;
    const at = Date.now();
    this.db
      .prepare('UPDATE mind_reminders SET fired_at = ? WHERE id = ?')
      .run(at, Number(row.id));
    this.event(
      String(row.item_id) as MindId,
      'reminder.fired',
      'scheduler',
      { reminderId: Number(row.id), scheduledTaskId },
      at,
    );
  }
  cancelReminderRecord(id: number, actor: string): MindReminder | null {
    const row = this.reminderById(id);
    if (!row || row.cancelledAt != null || row.firedAt != null) return row;
    const at = Date.now();
    this.db
      .prepare('UPDATE mind_reminders SET cancelled_at = ? WHERE id = ?')
      .run(at, id);
    this.event(
      row.itemId,
      'reminder.cancelled',
      actor,
      { reminderId: id, scheduledTaskId: row.scheduledTaskId },
      at,
    );
    return this.reminderById(id);
  }
  updateReminderRecord(
    id: number,
    fireAt: number,
    actor: string,
  ): MindReminder {
    const row = this.reminderById(id);
    if (!row) throw new Error(`mind: no reminder #${id}`);
    this.db
      .prepare('UPDATE mind_reminders SET fire_at = ? WHERE id = ?')
      .run(fireAt, id);
    this.event(row.itemId, 'reminder.snoozed', actor, {
      reminderId: id,
      fireAt,
    });
    return this.reminderById(id)!;
  }

  private assertNoParentCycle(id: MindId, parentId: MindId): void {
    if (id === parentId)
      throw new Error('mind: an item cannot be its own parent');
    const cycle = this.db
      .prepare(
        `WITH RECURSIVE parents(id) AS (SELECT parent_id FROM mind_items WHERE id = ? AND parent_id IS NOT NULL UNION SELECT i.parent_id FROM mind_items i JOIN parents p ON i.id = p.id WHERE i.parent_id IS NOT NULL) SELECT 1 FROM parents WHERE id = ? LIMIT 1`,
      )
      .get(parentId, id);
    if (cycle)
      throw new Error(`mind: parent #${parentId} would create a cycle`);
  }
}

export class MindService {
  readonly store: MindStore;
  private changeDepth = 0;
  private changePending = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly deps: CreateMindServiceDeps) {
    this.store = new MindStore(deps.db);
  }
  private notifyChanged(): void {
    try {
      this.deps.onChanged?.();
    } catch (error) {
      this.deps.logger.warn(
        `mind onChanged: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        this.deps.logger.warn(
          `mind listener: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  private changed<T>(value: T): T {
    if (this.changeDepth > 0) this.changePending = true;
    else this.notifyChanged();
    return value;
  }
  private itemStateChanged(item: MindItem): void {
    try {
      this.deps.onItemStateChanged?.(
        item.id,
        item.status,
        item.archivedAt !== null,
      );
    } catch (error) {
      this.deps.logger.warn(
        `mind onItemStateChanged: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  private batch<T>(fn: () => T): T {
    this.changeDepth++;
    try {
      return fn();
    } finally {
      this.changeDepth--;
      if (this.changeDepth === 0 && this.changePending) {
        this.changePending = false;
        this.notifyChanged();
      }
    }
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  create(
    opts: CreateMindItem & {
      remindAt?: number | null;
      reminderChannelId?: string | null;
    },
  ): MindDetail {
    return this.batch(() => {
      const item = this.store.create(opts);
      if (opts.remindAt != null)
        this.addReminder(
          item.id,
          opts.remindAt,
          opts.actor ?? 'agent',
          opts.reminderChannelId ?? null,
        );
      return this.changed(this.store.get(item.id)!);
    });
  }
  resolve(ref: unknown): MindId {
    return this.store.resolve(ref);
  }
  get(id: MindId): MindDetail | null {
    return this.store.get(id);
  }
  list(filter?: MindListFilter): MindItem[] {
    return this.store.list(filter);
  }
  count(filter: MindListFilter = {}): number {
    const base = { ...filter };
    delete base.limit;
    delete base.offset;
    let count = 0;
    for (;;) {
      const page = this.store.list({ ...base, limit: 500, offset: count });
      count += page.length;
      if (page.length < 500) return count;
    }
  }
  ready(limit?: number): MindItem[] {
    return this.store.ready(limit);
  }
  discover(context: string, opts?: MindDiscoverOptions): MindWorkMatch[] {
    return this.store.discover(context, opts);
  }
  claim(id: MindId, opts: MindClaimOptions): MindDetail {
    return this.changed(this.store.claim(id, opts));
  }
  resumeClaim(id: MindId, opts: MindClaimOptions): MindDetail {
    return this.changed(this.store.resumeClaim(id, opts));
  }
  renewClaim(id: MindId, principal: string, ttlMs?: number): MindDetail {
    return this.changed(this.store.renewClaim(id, principal, ttlMs));
  }
  releaseClaim(
    id: MindId,
    principal: string,
    status: 'open' | 'waiting',
    note: string,
  ): MindDetail {
    return this.changed(this.store.releaseClaim(id, principal, status, note));
  }
  logClaim(
    id: MindId,
    principal: string,
    owner: string,
    kind: MindLogKind,
    body: string,
    ttlMs?: number,
  ): MindDetail {
    return this.changed(
      this.store.logClaim(id, principal, owner, kind, body, ttlMs),
    );
  }
  finishClaim(
    id: MindId,
    principal: string,
    owner: string,
    result: string,
    verification: string,
    omissions: string,
  ): MindDetail {
    return this.batch(() => {
      const item = this.store.finishClaim(
        id,
        principal,
        owner,
        result,
        verification,
        omissions,
      );
      this.cancelPendingReminders(id, owner);
      const current = this.store.get(item.id)!;
      this.itemStateChanged(current);
      return this.changed(current);
    });
  }
  expireClaims(now?: number): MindId[] {
    const ids = this.store.expireClaims(now);
    if (ids.length) this.changed(undefined);
    return ids;
  }
  secretaryActivity(afterEventId = 0, limit = 6): SecretaryMindActivityBatch {
    return this.store.secretaryActivity(afterEventId, limit);
  }
  stats(): MindStats {
    return this.store.stats();
  }
  graph(
    id: MindId,
    depth?: number,
    relations?: MindGraphRelation[],
  ): MindGraph {
    return this.store.graph(id, depth, relations);
  }
  update(id: MindId, patch: UpdateMindItem, actor = 'agent'): MindDetail {
    return this.batch(() => {
      const item = this.store.update(id, patch, actor);
      if (item.status === 'done' || item.status === 'cancelled')
        this.cancelPendingReminders(id, actor);
      const current = this.store.get(id)!;
      if (patch.status !== undefined) this.itemStateChanged(current);
      return this.changed(current);
    });
  }
  setStatus(id: MindId, status: MindStatus, actor = 'agent'): MindDetail {
    return this.update(id, { status }, actor);
  }
  archive(id: MindId, actor = 'agent'): MindDetail {
    const item = this.store.archive(id, actor);
    this.itemStateChanged(item);
    return this.changed(item);
  }
  restore(id: MindId, actor = 'agent'): MindDetail {
    const item = this.store.restore(id, actor);
    this.itemStateChanged(item);
    return this.changed(item);
  }
  addDependency(id: MindId, dep: MindId, actor = 'agent'): MindDetail {
    return this.changed(this.store.addDependency(id, dep, actor));
  }
  removeDependency(id: MindId, dep: MindId, actor = 'agent'): MindDetail {
    return this.changed(this.store.removeDependency(id, dep, actor));
  }
  addComment(id: MindId, body: string, author = 'agent'): MindComment {
    return this.changed(this.store.addComment(id, body, author));
  }
  addReply(
    id: MindId,
    replyToId: number,
    body: string,
    author = 'agent',
  ): MindComment {
    return this.changed(this.store.addReply(id, replyToId, body, author));
  }
  updateComment(id: number, body: string, author = 'agent'): MindComment {
    return this.changed(this.store.updateComment(id, body, author));
  }
  deleteComment(id: number, actor = 'agent'): boolean {
    return this.changed(this.store.deleteComment(id, actor));
  }
  addTag(id: MindId, tag: string, actor = 'agent'): MindDetail {
    return this.changed(this.store.addTag(id, tag, actor));
  }
  removeTag(id: MindId, tag: string, actor = 'agent'): MindDetail {
    return this.changed(this.store.removeTag(id, tag, actor));
  }
  addReminder(
    itemId: MindId,
    fireAt: number,
    actor = 'agent',
    channelId: string | null = null,
  ): MindReminder {
    const item = this.store.get(itemId);
    if (!item) throw new Error(`mind: no item #${itemId}`);
    if (item.status === 'proposal')
      throw new Error('mind: proposal items cannot have reminders');
    if (!Number.isFinite(fireAt) || fireAt <= Date.now())
      throw new Error('mind: reminder time must be a future epoch-ms');
    const task = this.deps.scheduler.create({
      name: `mind-${itemId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'custom',
      channelId,
      payload: `[mind reminder #${itemId}] ${item.title}\n\n${item.body || 'Open the item and decide the next true action.'}`,
      nextRunAt: fireAt,
    });
    try {
      return this.changed(
        this.store.createReminderRecord(
          itemId,
          task.id,
          fireAt,
          channelId,
          actor,
        ),
      );
    } catch (error) {
      this.deps.scheduler.delete(task.id);
      throw error;
    }
  }
  snoozeReminder(
    reminderId: number,
    fireAt: number,
    actor = 'agent',
  ): MindReminder {
    if (!Number.isFinite(fireAt) || fireAt <= Date.now())
      throw new Error('mind: reminder time must be in the future');
    const row = this.store.reminderById(reminderId);
    if (!row) throw new Error(`mind: no reminder #${reminderId}`);
    if (row.firedAt != null || row.cancelledAt != null)
      throw new Error(`mind: reminder #${reminderId} is no longer active`);
    if (
      !this.deps.scheduler.update(row.scheduledTaskId, {
        nextRunAt: fireAt,
        snoozeUntil: null,
      })
    )
      throw new Error(`mind: scheduler task ${row.scheduledTaskId} is missing`);
    return this.changed(
      this.store.updateReminderRecord(reminderId, fireAt, actor),
    );
  }
  cancelReminder(reminderId: number, actor = 'agent'): MindReminder | null {
    const row = this.store.reminderById(reminderId);
    if (!row) return null;
    this.deps.scheduler.delete(row.scheduledTaskId);
    return this.changed(this.store.cancelReminderRecord(reminderId, actor));
  }
  cancelPendingReminders(itemId: MindId, actor = 'agent'): void {
    for (const row of this.store.pendingReminders(itemId))
      this.cancelReminder(row.id, actor);
  }
  onScheduledTaskWake(task: ScheduledTask): void {
    this.store.markReminderFiredByTask(task.id);
    if (task.name.startsWith('mind-')) this.changed(undefined);
  }
}

export function parseMindId(value: unknown): MindId {
  if (isMindId(value)) return value;
  throw new Error(
    `mind: expected a full elm-* item id (got ${JSON.stringify(value)})`,
  );
}

export function formatMindLine(item: MindItem): string {
  const status =
    item.effectiveStatus === 'blocked'
      ? `blocked by ${item.blockedBy.map((x) => `#${x.id}`).join(',')}`
      : item.effectiveStatus.replace('_', ' ');
  const priority =
    ['·', 'low', 'normal', 'high', 'urgent'][item.priority] ??
    String(item.priority);
  const due =
    item.dueAt == null ? '' : ` · due ${new Date(item.dueAt).toISOString()}`;
  const tags = item.tags.length
    ? ` · ${item.tags.map((x) => `#${x}`).join(' ')}`
    : '';
  const claim = item.claim
    ? ` · claimed by ${item.claim.owner}${item.claim.expired ? ' (expired)' : ''}`
    : '';
  return `#${item.id} [${status}] [${priority}] ${item.title}${due}${tags}${claim}`;
}

export function formatMindDetail(item: MindDetail): string {
  const lines = [
    formatMindLine(item),
    `${item.kind} · created by ${item.createdBy} · updated ${new Date(item.updatedAt).toISOString()}`,
  ];
  if (item.body) lines.push('', item.body);
  if (item.parent)
    lines.push('', `parent: #${item.parent.id} ${item.parent.title}`);
  if (item.dependencies.length)
    lines.push(
      `depends on: ${item.dependencies.map((x) => `#${x.id} ${x.title} [${x.effectiveStatus}]`).join('; ')}`,
    );
  if (item.blocks.length)
    lines.push(
      `blocks: ${item.blocks.map((x) => `#${x.id} ${x.title}`).join('; ')}`,
    );
  if (item.children.length)
    lines.push(
      `children: ${item.children.map((x) => `#${x.id} ${x.title}`).join('; ')}`,
    );
  if (
    item.reminders.filter((x) => x.firedAt == null && x.cancelledAt == null)
      .length
  )
    lines.push(
      `reminders: ${item.reminders
        .filter((x) => x.firedAt == null && x.cancelledAt == null)
        .map((x) => `r#${x.id} ${new Date(x.fireAt).toISOString()}`)
        .join('; ')}`,
    );
  if (item.comments.length) {
    lines.push('', 'comments:');
    for (const c of item.comments.slice(-10))
      lines.push(
        `- c#${c.id}${c.replyToId == null ? '' : ` ↩ c#${c.replyToId}`} ${c.author}: ${c.body}`,
      );
  }
  return lines.join('\n');
}

function pickItemSnapshot(item: MindItem): Record<string, unknown> {
  return {
    title: item.title,
    body: item.body,
    kind: item.kind,
    status: item.status,
    priority: item.priority,
    parentId: item.parentId,
    dueAt: item.dueAt,
    tags: item.tags,
  };
}
function reminderFromRow(r: Record<string, unknown>): MindReminder {
  return {
    id: Number(r.id),
    itemId: String(r.item_id) as MindId,
    scheduledTaskId: Number(r.scheduled_task_id),
    fireAt: Number(r.fire_at),
    channelId: r.channel_id == null ? null : String(r.channel_id),
    createdBy: String(r.created_by),
    createdAt: Number(r.created_at),
    firedAt: r.fired_at == null ? null : Number(r.fired_at),
    cancelledAt: r.cancelled_at == null ? null : Number(r.cancelled_at),
  };
}
function claimFromRow(r: Record<string, unknown>): MindClaim {
  const expiresAt = Number(r.expires_at);
  return {
    itemId: String(r.item_id) as MindId,
    owner: String(r.owner),
    claimedAt: Number(r.claimed_at),
    renewedAt: Number(r.renewed_at),
    expiresAt,
    expired: expiresAt <= Date.now(),
  };
}
