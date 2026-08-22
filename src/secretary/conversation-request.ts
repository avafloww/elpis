import type { ChatMessage } from "../llm/llm.js";
import type {
  SecretaryConversationCompleteReply,
  SecretaryConversationPullReply,
} from "./conversation.js";

export interface SecretaryConversationService {
  pull(token: string): SecretaryConversationPullReply;
  complete(
    token: string,
    turnId: string,
    response: ChatMessage,
  ): SecretaryConversationCompleteReply;
}

export class SecretaryConversationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretaryConversationRequestError";
  }
}

function exact(input: Record<string, unknown>, keys: string[]): void {
  const actual = Object.keys(input).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  )
    throw new SecretaryConversationRequestError(
      `request fields must be exactly ${expected.join(", ")}`,
    );
}

export function dispatchSecretaryConversationRequest(
  service: SecretaryConversationService,
  token: string,
  input: Record<string, unknown>,
): SecretaryConversationPullReply | SecretaryConversationCompleteReply {
  if (input.protocol !== 1)
    throw new SecretaryConversationRequestError("protocol must equal 1");
  if (input.operation === "pull") {
    exact(input, ["operation", "protocol"]);
    return service.pull(token);
  }
  if (input.operation === "complete") {
    exact(input, ["operation", "protocol", "response", "turnId"]);
    if (typeof input.turnId !== "string")
      throw new SecretaryConversationRequestError("turnId must be a string");
    return service.complete(token, input.turnId, input.response as ChatMessage);
  }
  throw new SecretaryConversationRequestError(
    "operation must be pull or complete",
  );
}
