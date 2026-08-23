import type { ChatMessage, CompleteResult } from "../llm/llm.js";
import { isMindId } from "../store/mind-id.js";
import { parseWorkerMessages } from "../worker/completion.js";
import type {
  SecretaryConversationCompleteReply,
  SecretaryConversationMessage,
  SecretaryConversationPullReply,
} from "./conversation.js";
import type { SecretarySessionBinding } from "./session.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^sec-[A-Za-z0-9_-]{22}$/;
const TURN_RE = /^stn-[A-Za-z0-9_-]{22}$/;
const MAX_REPLY_BYTES = 2 * 1024 * 1024;
const SECRETARY_TOOLS = new Set(["mind", "think"]);

type Route =
  | "/v1/secretary/conversation"
  | "/v1/secretary/complete"
  | "/v1/secretary/mind";

export interface SecretaryHttpClientOptions {
  brokerUrl: string;
  token: string;
  sessionId: string;
  fetch?: typeof fetch;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function conversationMessages(value: unknown): SecretaryConversationMessage[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(
      "secretary conversation transcript must be a non-empty array",
    );
  return value.map((raw, index) => {
    const message = record(raw, `secretary conversation message ${index}`);
    const keys = Object.keys(message).sort();
    if (keys.length !== 2 || keys[0] !== "content" || keys[1] !== "role")
      throw new Error(
        `secretary conversation message ${index} has extra fields`,
      );
    if (message.role !== "user" && message.role !== "assistant")
      throw new Error(
        `secretary conversation message ${index} has an invalid role`,
      );
    return {
      role: message.role,
      content: text(
        message.content,
        `secretary conversation message ${index} content`,
      ),
    };
  });
}

function brokerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("secretary broker URL must be an absolute http(s) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  )
    throw new Error(
      "secretary broker URL must be a credential-free http(s) origin",
    );
  return url.origin;
}

export class SecretaryHttpClient {
  private readonly origin: string;
  private readonly fetch: typeof fetch;
  private bindingValue: SecretarySessionBinding | null = null;

  constructor(private readonly options: SecretaryHttpClientOptions) {
    this.origin = brokerOrigin(options.brokerUrl);
    if (!TOKEN_RE.test(options.token))
      throw new Error("secretary token is invalid");
    if (!SESSION_RE.test(options.sessionId))
      throw new Error("secretary session identity is invalid");
    this.fetch = options.fetch ?? fetch;
  }

  async pull(
    signal?: AbortSignal,
  ): Promise<SecretaryConversationPullReply["turn"]> {
    const reply = await this.post(
      "/v1/secretary/conversation",
      { protocol: 1, operation: "pull" },
      signal,
    );
    this.binding(reply.binding);
    if (reply.turn === null) return null;
    const turn = record(reply.turn, "secretary conversation turn");
    const id = text(turn.id, "secretary conversation turn id");
    const sequence = Number(turn.sequence);
    if (!TURN_RE.test(id) || !Number.isSafeInteger(sequence) || sequence < 1)
      throw new Error("secretary conversation turn receipt is invalid");
    const messages = conversationMessages(turn.messages);
    return { id, sequence, messages };
  }

  async complete(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompleteResult> {
    const reply = await this.post(
      "/v1/secretary/complete",
      { protocol: 1, messages },
      signal,
    );
    this.binding(reply.binding);
    const result = record(reply.result, "secretary completion result");
    const [message] = parseWorkerMessages([result.message], SECRETARY_TOOLS);
    return { ...result, message } as unknown as CompleteResult;
  }

  async mind(
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const reply = await this.post(
      "/v1/secretary/mind",
      { protocol: 1, ...input },
      signal,
    );
    this.binding(reply.binding);
    return reply;
  }

  async finish(
    turnId: string,
    response: SecretaryConversationMessage & { role: "assistant" },
    signal?: AbortSignal,
  ): Promise<SecretaryConversationCompleteReply["turn"]> {
    if (!TURN_RE.test(turnId))
      throw new Error("secretary turn identity is invalid");
    const reply = await this.post(
      "/v1/secretary/conversation",
      { protocol: 1, operation: "complete", turnId, response },
      signal,
    );
    this.binding(reply.binding);
    const turn = record(reply.turn, "secretary completion receipt");
    if (turn.id !== turnId || turn.status !== "completed")
      throw new Error("secretary completion receipt does not match the turn");
    const sequence = Number(turn.sequence);
    const completedAt = Number(turn.completedAt);
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      !Number.isSafeInteger(completedAt)
    )
      throw new Error("secretary completion receipt is invalid");
    return { id: turnId, sequence, status: "completed", completedAt };
  }

  private binding(value: unknown): SecretarySessionBinding {
    const input = record(value, "secretary binding");
    const keys = Object.keys(input).sort();
    if (
      keys.length !== 4 ||
      keys[0] !== "hintMindId" ||
      keys[1] !== "modelRef" ||
      keys[2] !== "runtime" ||
      keys[3] !== "sessionId"
    )
      throw new Error("secretary broker binding shape is invalid");
    const hintMindId =
      input.hintMindId === null
        ? null
        : (text(
            input.hintMindId,
            "secretary binding hint",
          ) as SecretarySessionBinding["hintMindId"]);
    const binding: SecretarySessionBinding = {
      sessionId: text(input.sessionId, "secretary binding session"),
      hintMindId,
      modelRef: text(input.modelRef, "secretary binding model"),
      runtime: input.runtime as "kubernetes",
    };
    if (
      binding.sessionId !== this.options.sessionId ||
      binding.runtime !== "kubernetes" ||
      (binding.hintMindId !== null && !isMindId(binding.hintMindId)) ||
      !/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._-]*$/.test(binding.modelRef)
    )
      throw new Error("secretary broker returned a different session binding");
    if (
      this.bindingValue &&
      JSON.stringify(binding) !== JSON.stringify(this.bindingValue)
    )
      throw new Error("secretary broker binding changed during the session");
    this.bindingValue ??= binding;
    return binding;
  }

  private async post(
    route: Route,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetch(`${this.origin}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    });
    const raw = await response.text();
    if (Buffer.byteLength(raw) > MAX_REPLY_BYTES)
      throw new Error("secretary broker reply is too large");
    let value: Record<string, unknown>;
    try {
      value = record(JSON.parse(raw), "secretary broker reply");
    } catch {
      throw new Error("secretary broker returned malformed JSON");
    }
    if (!response.ok) {
      const message =
        typeof value.error === "string"
          ? value.error.slice(0, 500)
          : "request failed";
      throw new Error(`secretary broker ${response.status}: ${message}`);
    }
    if (value.protocol !== 1)
      throw new Error("secretary broker protocol mismatch");
    return value;
  }
}
