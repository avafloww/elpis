import type { Database } from "../store/db.js";
import {
  resolveActorSession,
  type ActorSessionBinding,
} from "./actor-session.js";

export type ActorMailboxKind = "message" | "finish";
export type ActorMailboxDirection =
  "dispatcher_to_actor" | "actor_to_dispatcher";

export interface ActorMailboxMessage {
  id: number;
  sessionId: string;
  direction: ActorMailboxDirection;
  kind: ActorMailboxKind;
  messageKey: string;
  sender: string;
  body: string;
  createdAt: number;
  acknowledgedAt: number | null;
}

export class ActorMailboxError extends Error {
  constructor(
    public readonly code:
      "unauthorized" | "invalid_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ActorMailboxError";
  }
}

function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new ActorMailboxError(
      "invalid_request",
      `${label} must be a non-empty string`,
    );
  if (value.length > max)
    throw new ActorMailboxError(
      "invalid_request",
      `${label} must be at most ${max} characters`,
    );
  return value;
}

function messageKey(value: unknown): string {
  const key = boundedText(value, "messageKey", 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key))
    throw new ActorMailboxError(
      "invalid_request",
      "messageKey contains invalid characters",
    );
  return key;
}

function boundedLimit(value = 32): number {
  if (!Number.isInteger(value) || value < 1 || value > 100)
    throw new ActorMailboxError(
      "invalid_request",
      "limit must be an integer from 1 to 100",
    );
  return value;
}

function boundedIds(value: number[]): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100)
    throw new ActorMailboxError(
      "invalid_request",
      "ids must contain 1 to 100 message ids",
    );
  const ids = Array.from(new Set(value));
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
    throw new ActorMailboxError(
      "invalid_request",
      "ids must be positive safe integers",
    );
  return ids;
}

function rowMessage(row: Record<string, unknown>): ActorMailboxMessage {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    direction: row.direction as ActorMailboxDirection,
    kind: row.kind as ActorMailboxKind,
    messageKey: String(row.message_key),
    sender: String(row.sender),
    body: String(row.body),
    createdAt: Number(row.created_at),
    acknowledgedAt:
      row.acknowledged_at == null ? null : Number(row.acknowledged_at),
  };
}

export class ActorMailboxBroker {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  private actor(token: string): ActorSessionBinding {
    const binding = resolveActorSession(this.db, token);
    if (!binding)
      throw new ActorMailboxError(
        "unauthorized",
        "actor session is unavailable",
      );
    return binding;
  }

  private dispatcherSession(
    sessionId: string,
    activeOnly: boolean,
  ): ActorSessionBinding {
    const row = this.db
      .prepare(
        `SELECT id, name, status, model_ref, mind_id, runtime
         FROM fleet_sessions WHERE id = ?`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    const runtime = row?.runtime;
    const active =
      row && ["spawning", "running", "idle"].includes(String(row.status));
    if (
      !row ||
      (activeOnly && !active) ||
      (runtime !== "trusted" && runtime !== "kubernetes") ||
      typeof row.model_ref !== "string" ||
      typeof row.mind_id !== "string"
    )
      throw new ActorMailboxError("not_found", "actor session is unavailable");
    return {
      sessionId: String(row.id),
      actor: `fleet:${String(row.name)}`,
      modelRef: row.model_ref,
      mindId: row.mind_id,
      runtime,
    };
  }

  private existing(
    sessionId: string,
    direction: ActorMailboxDirection,
    key: string,
  ): ActorMailboxMessage | null {
    const row = this.db
      .prepare(
        `SELECT * FROM fleet_mailbox_messages
         WHERE session_id = ? AND direction = ? AND message_key = ?`,
      )
      .get(sessionId, direction, key) as Record<string, unknown> | undefined;
    return row ? rowMessage(row) : null;
  }

  private insert(
    sessionId: string,
    direction: ActorMailboxDirection,
    kind: ActorMailboxKind,
    key: string,
    sender: string,
    body: string,
  ): ActorMailboxMessage {
    const prior = this.existing(sessionId, direction, key);
    if (prior) {
      if (prior.kind === kind && prior.sender === sender && prior.body === body)
        return prior;
      throw new ActorMailboxError(
        "conflict",
        "messageKey was already used with different content",
      );
    }
    const finish = this.db
      .prepare(
        `SELECT id FROM fleet_mailbox_messages
         WHERE session_id = ? AND direction = 'actor_to_dispatcher' AND kind = 'finish'`,
      )
      .get(sessionId);
    if (finish)
      throw new ActorMailboxError(
        "conflict",
        "actor session mailbox is already finished",
      );
    try {
      const result = this.db
        .prepare(
          `INSERT INTO fleet_mailbox_messages
           (session_id, direction, kind, message_key, sender, body, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(sessionId, direction, kind, key, sender, body, this.now());
      const row = this.db
        .prepare("SELECT * FROM fleet_mailbox_messages WHERE id = ?")
        .get(Number(result.lastInsertRowid)) as Record<string, unknown>;
      return rowMessage(row);
    } catch (error) {
      const raced = this.existing(sessionId, direction, key);
      if (
        raced &&
        raced.kind === kind &&
        raced.sender === sender &&
        raced.body === body
      )
        return raced;
      if (kind === "finish")
        throw new ActorMailboxError(
          "conflict",
          "actor session already has a finish message",
        );
      throw error;
    }
  }

  private pending(
    sessionId: string,
    direction: ActorMailboxDirection,
    limit: number,
  ): ActorMailboxMessage[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM fleet_mailbox_messages
           WHERE session_id = ? AND direction = ? AND acknowledged_at IS NULL
           ORDER BY id LIMIT ?`,
        )
        .all(sessionId, direction, boundedLimit(limit)) as Record<
        string,
        unknown
      >[]
    ).map(rowMessage);
  }

  private acknowledge(
    sessionId: string,
    direction: ActorMailboxDirection,
    idsValue: number[],
  ): number {
    const ids = boundedIds(idsValue);
    const placeholders = ids.map(() => "?").join(",");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM fleet_mailbox_messages
           WHERE session_id = ? AND direction = ? AND id IN (${placeholders})`,
        )
        .get(sessionId, direction, ...ids) as { n: number };
      if (row.n !== ids.length)
        throw new ActorMailboxError(
          "not_found",
          "one or more mailbox messages are unavailable",
        );
      this.db
        .prepare(
          `UPDATE fleet_mailbox_messages SET acknowledged_at = COALESCE(acknowledged_at, ?)
           WHERE session_id = ? AND direction = ? AND id IN (${placeholders})`,
        )
        .run(this.now(), sessionId, direction, ...ids);
      this.db.exec("COMMIT");
      return ids.length;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  sendToActor(
    sessionId: string,
    keyValue: string,
    bodyValue: string,
    sender = "dispatcher",
  ): ActorMailboxMessage {
    const binding = this.dispatcherSession(sessionId, true);
    return this.insert(
      binding.sessionId,
      "dispatcher_to_actor",
      "message",
      messageKey(keyValue),
      boundedText(sender, "sender", 80),
      boundedText(bodyValue, "body", 100_000),
    );
  }

  pullForActor(
    token: string,
    limit = 32,
  ): { binding: ActorSessionBinding; messages: ActorMailboxMessage[] } {
    const binding = this.actor(token);
    return {
      binding,
      messages: this.pending(binding.sessionId, "dispatcher_to_actor", limit),
    };
  }

  acknowledgeForActor(token: string, ids: number[]): number {
    const binding = this.actor(token);
    return this.acknowledge(binding.sessionId, "dispatcher_to_actor", ids);
  }

  postFromActor(
    token: string,
    keyValue: string,
    kind: ActorMailboxKind,
    bodyValue: string,
  ): ActorMailboxMessage {
    const binding = this.actor(token);
    if (kind !== "message" && kind !== "finish")
      throw new ActorMailboxError(
        "invalid_request",
        "kind must be message or finish",
      );
    return this.insert(
      binding.sessionId,
      "actor_to_dispatcher",
      kind,
      messageKey(keyValue),
      binding.actor,
      boundedText(bodyValue, "body", 100_000),
    );
  }

  pullFromActor(sessionId: string, limit = 32): ActorMailboxMessage[] {
    const binding = this.dispatcherSession(sessionId, false);
    return this.pending(binding.sessionId, "actor_to_dispatcher", limit);
  }

  acknowledgeFromActor(sessionId: string, ids: number[]): number {
    const binding = this.dispatcherSession(sessionId, false);
    return this.acknowledge(binding.sessionId, "actor_to_dispatcher", ids);
  }
}
