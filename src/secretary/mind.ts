import type { Database } from "../store/db.js";
import type { MindDetail, MindLink, MindService } from "../store/mind.js";
import type { MindId } from "../store/mind-id.js";
import {
  resolveSecretarySession,
  type SecretarySessionBinding,
} from "./session.js";

export const SECRETARY_MIND_MAX_DEPTH = 16;
export const SECRETARY_MIND_MAX_ITEMS = 100;
export const SECRETARY_MIND_MAX_RESPONSE_CHARS = 1024 * 1024;
export const SECRETARY_MIND_MAX_LINKS = 1000;

export class SecretaryMindError extends Error {
  constructor(
    public readonly code:
      "unauthorized" | "outside_scope" | "not_found" | "too_large",
    message: string,
  ) {
    super(message);
    this.name = "SecretaryMindError";
  }
}

export interface SecretaryMindTree {
  binding: SecretarySessionBinding;
  rootId: MindId;
  items: MindDetail[];
  truncated: boolean;
}

export class SecretaryMindBroker {
  constructor(
    private readonly db: Database,
    private readonly mind: Pick<MindService, "get">,
  ) {}

  private binding(token: string): SecretarySessionBinding {
    const binding = resolveSecretarySession(this.db, token);
    if (!binding)
      throw new SecretaryMindError(
        "unauthorized",
        "secretary session is unavailable",
      );
    return binding;
  }

  private scoped(binding: SecretarySessionBinding, id: MindId): void {
    const row = this.db
      .prepare(
        `WITH RECURSIVE ancestry(id, parent_id, depth) AS (
           SELECT id, parent_id, 0 FROM mind_items WHERE id = ?
           UNION ALL
           SELECT i.id, i.parent_id, a.depth + 1
           FROM mind_items i JOIN ancestry a ON i.id = a.parent_id
           WHERE a.depth < 64
         ) SELECT 1 AS ok FROM ancestry WHERE id = ? LIMIT 1`,
      )
      .get(id, binding.rootMindId);
    if (!row)
      throw new SecretaryMindError(
        "outside_scope",
        "Mind item is outside secretary scope",
      );
  }

  private bounded<T>(value: T): T {
    if (
      Buffer.byteLength(JSON.stringify(value), "utf8") >
      SECRETARY_MIND_MAX_RESPONSE_CHARS
    )
      throw new SecretaryMindError(
        "too_large",
        "secretary Mind response exceeds the bounded response limit",
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

  private allowedLinks(
    binding: SecretarySessionBinding,
    item: MindDetail,
  ): ReadonlySet<MindId> {
    const linkIds = [
      item.parent?.id,
      ...item.children.map((link) => link.id),
      ...item.blockedBy.map((link) => link.id),
      ...item.blocks.map((link) => link.id),
      ...item.dependencies.map((link) => link.id),
    ].filter((value): value is MindId => value !== undefined);
    if (linkIds.length > SECRETARY_MIND_MAX_LINKS)
      throw new SecretaryMindError(
        "too_large",
        "secretary Mind item has too many links",
      );
    const allowed = new Set<MindId>([item.id]);
    for (const linkId of linkIds) {
      try {
        this.scoped(binding, linkId);
        allowed.add(linkId);
      } catch (error) {
        if (
          !(error instanceof SecretaryMindError) ||
          error.code !== "outside_scope"
        )
          throw error;
      }
    }
    return allowed;
  }

  get(
    token: string,
    id?: MindId,
  ): { binding: SecretarySessionBinding; item: MindDetail } {
    const binding = this.binding(token);
    const target = id ?? binding.rootMindId;
    this.scoped(binding, target);
    const item = this.mind.get(target);
    if (!item)
      throw new SecretaryMindError("not_found", "Mind item does not exist");
    return this.bounded({
      binding,
      item: this.project(item, this.allowedLinks(binding, item)),
    });
  }

  tree(
    token: string,
    id?: MindId,
    depth = SECRETARY_MIND_MAX_DEPTH,
    limit = SECRETARY_MIND_MAX_ITEMS,
  ): SecretaryMindTree {
    const binding = this.binding(token);
    const rootId = id ?? binding.rootMindId;
    this.scoped(binding, rootId);
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
      throw new SecretaryMindError("not_found", "Mind item does not exist");
    return this.bounded({
      binding,
      rootId,
      items: items.map((item) => this.project(item!, allowed)),
      truncated: rows.length > limit,
    });
  }
}
