import type { Database } from "../store/db.js";
import type {
  CreateMindItem,
  MindDetail,
  MindComment,
  MindService,
  MindStatus,
} from "../store/mind.js";
import type { MindId } from "../store/mind-id.js";
import {
  resolveActorSession,
  type ActorSessionBinding,
} from "./actor-session.js";

export class ActorMindError extends Error {
  constructor(
    public readonly code: "unauthorized" | "outside_scope" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "ActorMindError";
  }
}

export class ActorMindBroker {
  constructor(
    private readonly db: Database,
    private readonly mind: MindService,
  ) {}

  private binding(token: string): ActorSessionBinding {
    const binding = resolveActorSession(this.db, token);
    if (!binding)
      throw new ActorMindError("unauthorized", "actor session is unavailable");
    return binding;
  }

  private scoped(binding: ActorSessionBinding, id: MindId): void {
    const row = this.db
      .prepare(
        `WITH RECURSIVE scope(id) AS (
         SELECT ? UNION ALL SELECT i.id FROM mind_items i JOIN scope s ON i.parent_id = s.id
       ) SELECT 1 AS ok FROM scope WHERE id = ? LIMIT 1`,
      )
      .get(binding.mindId, id);
    if (!row)
      throw new ActorMindError(
        "outside_scope",
        "Mind item is outside actor scope",
      );
  }

  get(
    token: string,
    id?: MindId,
  ): { binding: ActorSessionBinding; item: MindDetail } {
    const binding = this.binding(token);
    const target = id ?? (binding.mindId as MindId);
    this.scoped(binding, target);
    const item = this.mind.get(target);
    if (!item)
      throw new ActorMindError("not_found", "Mind item does not exist");
    return { binding, item };
  }

  createChild(
    token: string,
    input: Omit<CreateMindItem, "parentId" | "actor" | "dependsOn"> & {
      parentId?: MindId;
    },
  ): MindDetail {
    const binding = this.binding(token);
    const parentId = input.parentId ?? (binding.mindId as MindId);
    this.scoped(binding, parentId);
    return this.mind.create({ ...input, parentId, actor: binding.actor });
  }

  addComment(token: string, id: MindId, body: string): MindComment {
    const binding = this.binding(token);
    this.scoped(binding, id);
    return this.mind.addComment(id, body, binding.actor);
  }

  setStatus(token: string, id: MindId, status: MindStatus): MindDetail {
    const binding = this.binding(token);
    this.scoped(binding, id);
    return this.mind.setStatus(id, status, binding.actor);
  }
}
