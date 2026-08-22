import type { MindDetail } from "../store/mind.js";
import { isMindId, type MindId } from "../store/mind-id.js";
import type { SecretarySessionBinding } from "./session.js";
import {
  SECRETARY_MIND_MAX_DEPTH,
  SECRETARY_MIND_MAX_ITEMS,
  type SecretaryMindTree,
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
    default:
      throw new SecretaryMindRequestError("operation must be get or tree");
  }
}
