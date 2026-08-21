import {
  MIND_KINDS,
  MIND_STATUSES,
  type CreateMindItem,
  type MindComment,
  type MindDetail,
  type MindStatus,
} from "../store/mind.js";
import { isMindId, type MindId } from "../store/mind-id.js";
import type { ActorSessionBinding } from "./actor-session.js";

export class ActorMindRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActorMindRequestError";
  }
}

export interface ActorMindService {
  get(
    token: string,
    id?: MindId,
  ): { binding: ActorSessionBinding; item: MindDetail };
  createChild(
    token: string,
    input: Omit<CreateMindItem, "parentId" | "actor" | "dependsOn"> & {
      parentId?: MindId;
    },
  ): MindDetail;
  addComment(token: string, id: MindId, body: string): MindComment;
  setStatus(token: string, id: MindId, status: MindStatus): MindDetail;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ActorMindRequestError(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new ActorMindRequestError(
      `unknown request field ${JSON.stringify(extra[0])}`,
    );
}

function text(
  value: unknown,
  label: string,
  max: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string")
    throw new ActorMindRequestError(`${label} must be a string`);
  if (!allowEmpty && value.trim().length === 0)
    throw new ActorMindRequestError(`${label} must not be empty`);
  if (value.length > max)
    throw new ActorMindRequestError(`${label} exceeds ${max} characters`);
  return value;
}

function optionalId(value: unknown, label: string): MindId | undefined {
  if (value === undefined) return undefined;
  if (!isMindId(value))
    throw new ActorMindRequestError(`${label} must be a canonical elm-* id`);
  return value;
}

function requiredId(value: unknown, label: string): MindId {
  const id = optionalId(value, label);
  if (!id) throw new ActorMindRequestError(`${label} is required`);
  return id;
}

function createInput(
  value: unknown,
  parentId: MindId | undefined,
): Omit<CreateMindItem, "parentId" | "actor" | "dependsOn"> & {
  parentId?: MindId;
} {
  const item = record(value, "item");
  exact(item, ["title", "body", "kind", "status", "priority", "dueAt", "tags"]);
  const result: Omit<CreateMindItem, "parentId" | "actor" | "dependsOn"> & {
    parentId?: MindId;
  } = {
    title: text(item.title, "item.title", 240),
    ...(parentId ? { parentId } : {}),
  };
  if (item.body !== undefined)
    result.body = text(item.body, "item.body", 100_000, true);
  if (item.kind !== undefined) {
    if (!MIND_KINDS.includes(item.kind as never))
      throw new ActorMindRequestError("item.kind is invalid");
    result.kind = item.kind as CreateMindItem["kind"];
  }
  if (item.status !== undefined) {
    if (!MIND_STATUSES.includes(item.status as never))
      throw new ActorMindRequestError("item.status is invalid");
    result.status = item.status as MindStatus;
  }
  if (item.priority !== undefined) {
    if (
      !Number.isInteger(item.priority) ||
      Number(item.priority) < 0 ||
      Number(item.priority) > 4
    )
      throw new ActorMindRequestError(
        "item.priority must be an integer from 0 to 4",
      );
    result.priority = item.priority as number;
  }
  if (item.dueAt !== undefined) {
    if (
      item.dueAt !== null &&
      (!Number.isFinite(item.dueAt) || Number(item.dueAt) <= 0)
    )
      throw new ActorMindRequestError(
        "item.dueAt must be finite epoch-ms or null",
      );
    result.dueAt = item.dueAt as number | null;
  }
  if (item.tags !== undefined) {
    if (
      !Array.isArray(item.tags) ||
      item.tags.length > 64 ||
      item.tags.some((tag) => {
        if (typeof tag !== "string" || tag.length > 48) return true;
        const normalized = tag
          .trim()
          .toLowerCase()
          .replace(/^#/, "")
          .replace(/\s+/g, "-");
        return (
          !normalized || !/^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(normalized)
        );
      })
    )
      throw new ActorMindRequestError(
        "item.tags must be at most 64 valid bounded strings",
      );
    result.tags = [...item.tags] as string[];
  }
  return result;
}

export function dispatchActorMindRequest(
  service: ActorMindService,
  token: string,
  value: unknown,
): unknown {
  const input = record(value, "request");
  if (input.protocol !== 1)
    throw new ActorMindRequestError("protocol must equal 1");
  switch (input.operation) {
    case "get": {
      exact(input, ["protocol", "operation", "id"]);
      return { protocol: 1, ...service.get(token, optionalId(input.id, "id")) };
    }
    case "create": {
      exact(input, ["protocol", "operation", "parentId", "item"]);
      return {
        protocol: 1,
        item: service.createChild(
          token,
          createInput(input.item, optionalId(input.parentId, "parentId")),
        ),
      };
    }
    case "comment": {
      exact(input, ["protocol", "operation", "id", "body"]);
      return {
        protocol: 1,
        comment: service.addComment(
          token,
          requiredId(input.id, "id"),
          text(input.body, "body", 100_000),
        ),
      };
    }
    case "status": {
      exact(input, ["protocol", "operation", "id", "status"]);
      if (!MIND_STATUSES.includes(input.status as never))
        throw new ActorMindRequestError("status is invalid");
      return {
        protocol: 1,
        item: service.setStatus(
          token,
          requiredId(input.id, "id"),
          input.status as MindStatus,
        ),
      };
    }
    default:
      throw new ActorMindRequestError(
        "operation must be get, create, comment, or status",
      );
  }
}
