import type { ActorMailboxKind, ActorMailboxMessage } from "./actor-mailbox.js";
import type { ActorSessionBinding } from "./actor-session.js";

export class ActorMailboxRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActorMailboxRequestError";
  }
}

export interface ActorMailboxService {
  pullForActor(
    token: string,
    limit?: number,
  ): { binding: ActorSessionBinding; messages: ActorMailboxMessage[] };
  acknowledgeForActor(token: string, ids: number[]): number;
  postFromActor(
    token: string,
    messageKey: string,
    kind: ActorMailboxKind,
    body: string,
  ): ActorMailboxMessage;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ActorMailboxRequestError("request must be an object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new ActorMailboxRequestError(
      `unknown request field ${JSON.stringify(extra[0])}`,
    );
}

export function dispatchActorMailboxRequest(
  service: ActorMailboxService,
  token: string,
  value: unknown,
): unknown {
  const input = record(value);
  if (input.protocol !== 1)
    throw new ActorMailboxRequestError("protocol must equal 1");
  switch (input.operation) {
    case "pull": {
      exact(input, ["protocol", "operation", "limit"]);
      if (
        input.limit !== undefined &&
        (!Number.isInteger(input.limit) ||
          Number(input.limit) < 1 ||
          Number(input.limit) > 100)
      )
        throw new ActorMailboxRequestError(
          "limit must be an integer from 1 to 100",
        );
      return {
        protocol: 1,
        ...service.pullForActor(token, input.limit as number | undefined),
      };
    }
    case "ack": {
      exact(input, ["protocol", "operation", "ids"]);
      if (
        !Array.isArray(input.ids) ||
        input.ids.length < 1 ||
        input.ids.length > 100 ||
        input.ids.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0)
      )
        throw new ActorMailboxRequestError(
          "ids must contain 1 to 100 positive safe integers",
        );
      return {
        protocol: 1,
        acknowledged: service.acknowledgeForActor(token, input.ids as number[]),
      };
    }
    case "post": {
      exact(input, ["protocol", "operation", "messageKey", "kind", "body"]);
      if (input.kind !== "message" && input.kind !== "finish")
        throw new ActorMailboxRequestError("kind must be message or finish");
      if (
        typeof input.messageKey !== "string" ||
        typeof input.body !== "string"
      )
        throw new ActorMailboxRequestError(
          "messageKey and body must be strings",
        );
      return {
        protocol: 1,
        message: service.postFromActor(
          token,
          input.messageKey,
          input.kind,
          input.body,
        ),
      };
    }
    default:
      throw new ActorMailboxRequestError(
        "operation must be pull, ack, or post",
      );
  }
}
