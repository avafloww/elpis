import { MIND_KINDS, type MindDetail, type MindKind } from "../store/mind.js";
import { isMindId, type MindId } from "../store/mind-id.js";
import type { SecretarySessionBinding } from "./session.js";
import {
  SECRETARY_MIND_MAX_DEPTH,
  SECRETARY_MIND_MAX_ITEMS,
  type SecretaryMindTree,
  type SecretaryProposalInput,
} from "./mind.js";

export class SecretaryMindRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretaryMindRequestError";
  }
}

export interface SecretaryMindService {
  get(
    token: string,
    id?: MindId,
  ): { binding: SecretarySessionBinding; item: MindDetail };
  tree(
    token: string,
    id?: MindId,
    depth?: number,
    limit?: number,
  ): SecretaryMindTree;
  propose(
    token: string,
    input: SecretaryProposalInput,
  ): { binding: SecretarySessionBinding; item: MindDetail };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SecretaryMindRequestError("request must be an object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length)
    throw new SecretaryMindRequestError(
      `unknown request field ${JSON.stringify(extra[0])}`,
    );
}

function optionalId(value: unknown): MindId | undefined {
  if (value === undefined) return undefined;
  if (!isMindId(value))
    throw new SecretaryMindRequestError("id must be a canonical elm-* id");
  return value;
}

function integer(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new SecretaryMindRequestError(
      `${label} must be an integer from ${minimum} to ${maximum}`,
    );
  return Number(value);
}

function proposalText(
  value: unknown,
  label: string,
  maximum: number,
  required = false,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string")
    throw new SecretaryMindRequestError(`${label} must be a string`);
  const text = label === "title" ? value.trim() : value;
  if ((required && text.length === 0) || text.length > maximum)
    throw new SecretaryMindRequestError(
      `${label} must contain ${required ? "1" : "0"} to ${maximum} characters`,
    );
  return text;
}

function proposalKind(value: unknown): MindKind | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MIND_KINDS.includes(value as MindKind))
    throw new SecretaryMindRequestError("kind is invalid");
  return value as MindKind;
}

function proposalParent(value: unknown): MindId | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isMindId(value))
    throw new SecretaryMindRequestError(
      "parentId must be null or a canonical elm-* id",
    );
  return value;
}

function proposalTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32)
    throw new SecretaryMindRequestError(
      "tags must be an array of at most 32 strings",
    );
  return value.map((tag, index) => {
    if (typeof tag !== "string" || tag.trim().length < 1 || tag.length > 80)
      throw new SecretaryMindRequestError(
        `tag ${index} must contain 1 to 80 characters`,
      );
    return tag;
  });
}

export function dispatchSecretaryMindRequest(
  service: SecretaryMindService,
  token: string,
  value: unknown,
): unknown {
  const input = record(value);
  if (input.protocol !== 1)
    throw new SecretaryMindRequestError("protocol must equal 1");
  switch (input.operation) {
    case "get":
      exact(input, ["protocol", "operation", "id"]);
      return { protocol: 1, ...service.get(token, optionalId(input.id)) };
    case "tree":
      exact(input, ["protocol", "operation", "id", "depth", "limit"]);
      return {
        protocol: 1,
        ...service.tree(
          token,
          optionalId(input.id),
          integer(
            input.depth,
            "depth",
            0,
            SECRETARY_MIND_MAX_DEPTH,
            SECRETARY_MIND_MAX_DEPTH,
          ),
          integer(
            input.limit,
            "limit",
            1,
            SECRETARY_MIND_MAX_ITEMS,
            SECRETARY_MIND_MAX_ITEMS,
          ),
        ),
      };
    case "propose":
      exact(input, [
        "protocol",
        "operation",
        "title",
        "body",
        "kind",
        "priority",
        "parentId",
        "tags",
      ]);
      return {
        protocol: 1,
        ...service.propose(token, {
          title: proposalText(input.title, "title", 240, true)!,
          body: proposalText(input.body, "body", 100_000),
          kind: proposalKind(input.kind),
          priority: integer(input.priority, "priority", 0, 4, 2),
          parentId: proposalParent(input.parentId),
          tags: proposalTags(input.tags),
        }),
      };
    default:
      throw new SecretaryMindRequestError(
        "operation must be get, tree, or propose",
      );
  }
}
