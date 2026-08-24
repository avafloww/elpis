import type { Database } from '../store/db.js';
import type {
  MindComment,
  MindDetail,
  MindItem,
  MindKind,
  MindLink,
  MindListFilter,
  MindService,
} from '../store/mind.js';
import type { MindId } from '../store/mind-id.js';
import {
  resolveSecretarySession,
  type SecretarySessionBinding,
} from './session.js';

export const SECRETARY_MIND_MAX_DEPTH = 16;
export const SECRETARY_MIND_MAX_ITEMS = 100;
export const SECRETARY_MIND_MAX_RESPONSE_CHARS = 1024 * 1024;
export const SECRETARY_MIND_MAX_LINKS = 1000;

export class SecretaryMindError extends Error {
  constructor(
    public readonly code:
      'unauthorized' | 'invalid_request' | 'not_found' | 'too_large',
    message: string,
  ) {
    super(message);
    this.name = 'SecretaryMindError';
  }
}

export interface SecretaryMindTree {
  binding: SecretarySessionBinding;
  rootId: MindId;
  items: MindDetail[];
  truncated: boolean;
}

export interface SecretaryProposalInput {
  title: string;
  body?: string;
  kind?: MindKind;
  priority?: number;
  parentId?: MindId | null;
  tags?: string[];
}

export interface SecretaryMindListItem {
  id: MindId;
  title: string;
  bodyPreview: string;
  bodyTruncated: boolean;
  kind: MindItem['kind'];
  status: MindItem['status'];
  effectiveStatus: MindItem['effectiveStatus'];
  priority: number;
  parentId: MindId | null;
  tags: string[];
  dueAt: number | null;
  archivedAt: number | null;
  updatedAt: number;
}

export interface SecretaryMindList {
  binding: SecretarySessionBinding;
  items: SecretaryMindListItem[];
}

export interface SecretaryMindWrite {
  binding: SecretarySessionBinding;
  comment: MindComment;
  item: MindDetail;
}

export class SecretaryMindBroker {
  constructor(
    private readonly db: Database,
    private readonly mind: Pick<
      MindService,
      'get' | 'list' | 'create' | 'addComment' | 'addReply'
    >,
  ) {}

  private binding(token: string): SecretarySessionBinding {
    const binding = resolveSecretarySession(this.db, token);
    if (!binding)
      throw new SecretaryMindError(
        'unauthorized',
        'secretary session is unavailable',
      );
    return binding;
  }

  private bounded<T>(value: T): T {
    if (
      Buffer.byteLength(JSON.stringify(value), 'utf8') >
      SECRETARY_MIND_MAX_RESPONSE_CHARS
    )
      throw new SecretaryMindError(
        'too_large',
        'secretary Mind response exceeds the bounded response limit',
      );
    return value;
  }

  private project(item: MindDetail, allowed: ReadonlySet<MindId>): MindDetail {
    const links = (values: MindLink[]): MindLink[] =>
      values.filter((value) => allowed.has(value.id));
    return {
      ...item,
      parent: item.parent && allowed.has(item.parent.id) ? item.parent : null,
      children: links(item.children),
      blockedBy: links(item.blockedBy),
      blocks: links(item.blocks),
      dependencies: links(item.dependencies),
      reminders: [],
      events: [],
      claim: null,
    };
  }

  private allowedLinks(item: MindDetail): ReadonlySet<MindId> {
    const linkIds = [
      item.parent?.id,
      ...item.children.map((link) => link.id),
      ...item.blockedBy.map((link) => link.id),
      ...item.blocks.map((link) => link.id),
      ...item.dependencies.map((link) => link.id),
    ].filter((value): value is MindId => value !== undefined);
    if (linkIds.length > SECRETARY_MIND_MAX_LINKS)
      throw new SecretaryMindError(
        'too_large',
        'secretary Mind item has too many links',
      );
    return new Set<MindId>([item.id, ...linkIds]);
  }

  get(
    token: string,
    id?: MindId,
  ): { binding: SecretarySessionBinding; item: MindDetail } {
    const binding = this.binding(token);
    const target = id ?? binding.hintMindId;
    if (!target)
      throw new SecretaryMindError(
        'invalid_request',
        'Mind id is required when the secretary session has no hint',
      );
    const item = this.mind.get(target);
    if (!item)
      throw new SecretaryMindError('not_found', 'Mind item does not exist');
    return this.bounded({
      binding,
      item: this.project(item, this.allowedLinks(item)),
    });
  }

  list(token: string, filter: MindListFilter): SecretaryMindList {
    const binding = this.binding(token);
    const items = this.mind.list(filter).map((item) => {
      const bodyPreview = item.body.slice(0, 500);
      return {
        id: item.id,
        title: item.title,
        bodyPreview,
        bodyTruncated: bodyPreview.length < item.body.length,
        kind: item.kind,
        status: item.status,
        effectiveStatus: item.effectiveStatus,
        priority: item.priority,
        parentId: item.parentId,
        tags: item.tags,
        dueAt: item.dueAt,
        archivedAt: item.archivedAt,
        updatedAt: item.updatedAt,
      };
    });
    return this.bounded({ binding, items });
  }

  comment(token: string, id: MindId, body: string): SecretaryMindWrite {
    const binding = this.binding(token);
    if (!this.mind.get(id))
      throw new SecretaryMindError('not_found', 'Mind item does not exist');
    const author = `secretary:${binding.sessionId}`;
    const comment = this.mind.addComment(id, body, author);
    const item = this.mind.get(id)!;
    return this.bounded({
      binding,
      comment,
      item: this.project(item, this.allowedLinks(item)),
    });
  }

  reply(
    token: string,
    id: MindId,
    commentId: number,
    body: string,
  ): SecretaryMindWrite {
    const binding = this.binding(token);
    if (!this.mind.get(id))
      throw new SecretaryMindError('not_found', 'Mind item does not exist');
    const author = `secretary:${binding.sessionId}`;
    let comment: MindComment;
    try {
      comment = this.mind.addReply(id, commentId, body, author);
    } catch (error) {
      throw new SecretaryMindError(
        'invalid_request',
        error instanceof Error ? error.message : String(error),
      );
    }
    const item = this.mind.get(id)!;
    return this.bounded({
      binding,
      comment,
      item: this.project(item, this.allowedLinks(item)),
    });
  }

  propose(
    token: string,
    input: SecretaryProposalInput,
  ): { binding: SecretarySessionBinding; item: MindDetail } {
    const binding = this.binding(token);
    const item = this.mind.create({
      ...input,
      status: 'proposal',
      actor: `secretary:${binding.sessionId}`,
      proposalIntake: {
        requester: 'conversation-user',
        source: 'secretary',
        sessionId: binding.sessionId,
      },
    });
    return this.bounded({
      binding,
      item: this.project(item, this.allowedLinks(item)),
    });
  }

  tree(
    token: string,
    id?: MindId,
    depth = SECRETARY_MIND_MAX_DEPTH,
    limit = SECRETARY_MIND_MAX_ITEMS,
  ): SecretaryMindTree {
    const binding = this.binding(token);
    const rootId = id ?? binding.hintMindId;
    if (!rootId)
      throw new SecretaryMindError(
        'invalid_request',
        'Mind id is required when the secretary session has no hint',
      );
    depth = Number.isSafeInteger(depth)
      ? Math.max(0, Math.min(depth, SECRETARY_MIND_MAX_DEPTH))
      : SECRETARY_MIND_MAX_DEPTH;
    limit = Number.isSafeInteger(limit)
      ? Math.max(1, Math.min(limit, SECRETARY_MIND_MAX_ITEMS))
      : SECRETARY_MIND_MAX_ITEMS;
    const rows = this.db
      .prepare(
        `WITH RECURSIVE scope(id, depth) AS (
           SELECT ?, 0 UNION ALL
           SELECT i.id, s.depth + 1
           FROM mind_items i JOIN scope s ON i.parent_id = s.id
           WHERE s.depth < ?
         )
         SELECT id FROM scope ORDER BY depth, id LIMIT ?`,
      )
      .all(rootId, depth, limit + 1) as { id: MindId }[];
    const selected = rows.slice(0, limit);
    const allowed = new Set(selected.map((row) => row.id));
    const items = selected.map((row) => this.mind.get(row.id));
    if (items.some((item) => !item))
      throw new SecretaryMindError('not_found', 'Mind item does not exist');
    return this.bounded({
      binding,
      rootId,
      items: items.map((item) => this.project(item!, allowed)),
      truncated: rows.length > limit,
    });
  }
}
