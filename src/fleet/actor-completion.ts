import type { Config } from "../config.js";
import { configForLlmRef } from "../config.js";
import {
  createLLM,
  type ChatMessage,
  type CompleteResult,
  type LLM,
} from "../llm/llm.js";
import type { Database } from "../store/db.js";
import {
  resolveActorSession,
  type ActorSessionBinding,
} from "./actor-session.js";

const MAX_MESSAGES = 512;
const MAX_REQUEST_CHARS = 8 * 1024 * 1024;
const MAX_FIELD_CHARS = 1024 * 1024;
const MAX_TOOL_CALLS = 16;

export class ActorCompletionError extends Error {
  constructor(
    public readonly code:
      | "unauthorized"
      | "invalid_request"
      | "busy"
      | "capacity"
      | "binding_changed"
      | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "ActorCompletionError";
  }
}

export interface ActorCompletionReply {
  binding: ActorSessionBinding;
  result: CompleteResult;
}

export interface ActorCompletionBrokerOptions {
  db: Database;
  config: Config;
  create?: typeof createLLM;
}

function boundedString(
  value: unknown,
  label: string,
  required = true,
): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string")
    throw new ActorCompletionError(
      "invalid_request",
      `${label} must be a string`,
    );
  if (value.length > MAX_FIELD_CHARS)
    throw new ActorCompletionError(
      "invalid_request",
      `${label} exceeds ${MAX_FIELD_CHARS} characters`,
    );
  return value;
}

function cloneOpaque(value: unknown, label: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > MAX_FIELD_CHARS) {
    throw new ActorCompletionError(
      "invalid_request",
      `${label} is not bounded JSON`,
    );
  }
  return JSON.parse(encoded);
}

export function parseActorMessages(value: unknown): ChatMessage[] {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ActorCompletionError("invalid_request", "messages must be JSON");
  }
  if (typeof encoded !== "string")
    throw new ActorCompletionError("invalid_request", "messages must be JSON");
  if (encoded.length > MAX_REQUEST_CHARS)
    throw new ActorCompletionError(
      "invalid_request",
      `messages exceed ${MAX_REQUEST_CHARS} characters`,
    );
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MESSAGES
  ) {
    throw new ActorCompletionError(
      "invalid_request",
      `messages must contain 1-${MAX_MESSAGES} entries`,
    );
  }

  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ActorCompletionError(
        "invalid_request",
        `messages[${index}] must be an object`,
      );
    }
    const input = raw as Record<string, unknown>;
    const role = input.role;
    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      throw new ActorCompletionError(
        "invalid_request",
        `messages[${index}].role is invalid`,
      );
    }
    if (input.contentParts !== undefined) {
      throw new ActorCompletionError(
        "unsupported",
        "actor image inputs are not supported yet",
      );
    }
    const message: ChatMessage = {
      role,
      content: boundedString(input.content, `messages[${index}].content`)!,
    };

    if (role === "assistant") {
      const reasoning = boundedString(
        input.reasoning_content,
        `messages[${index}].reasoning_content`,
        false,
      );
      if (reasoning !== undefined) message.reasoning_content = reasoning;
      if (input.reasoning_items !== undefined)
        message.reasoning_items = cloneOpaque(
          input.reasoning_items,
          `messages[${index}].reasoning_items`,
        ) as ChatMessage["reasoning_items"];
      if (input.thinking_blocks !== undefined)
        message.thinking_blocks = cloneOpaque(
          input.thinking_blocks,
          `messages[${index}].thinking_blocks`,
        ) as ChatMessage["thinking_blocks"];
      if (input.tool_calls !== undefined) {
        if (
          !Array.isArray(input.tool_calls) ||
          input.tool_calls.length === 0 ||
          input.tool_calls.length > MAX_TOOL_CALLS
        ) {
          throw new ActorCompletionError(
            "invalid_request",
            `messages[${index}].tool_calls must contain 1-${MAX_TOOL_CALLS} entries`,
          );
        }
        message.tool_calls = input.tool_calls.map((rawCall, callIndex) => {
          if (
            !rawCall ||
            typeof rawCall !== "object" ||
            Array.isArray(rawCall)
          ) {
            throw new ActorCompletionError(
              "invalid_request",
              `messages[${index}].tool_calls[${callIndex}] must be an object`,
            );
          }
          const call = rawCall as Record<string, unknown>;
          const fn = call.function;
          if (
            call.type !== "function" ||
            !fn ||
            typeof fn !== "object" ||
            Array.isArray(fn)
          ) {
            throw new ActorCompletionError(
              "invalid_request",
              `messages[${index}].tool_calls[${callIndex}] must be a function call`,
            );
          }
          const func = fn as Record<string, unknown>;
          const name = boundedString(
            func.name,
            `messages[${index}].tool_calls[${callIndex}].function.name`,
          )!;
          if (name !== "run" && name !== "think") {
            throw new ActorCompletionError(
              "unsupported",
              `actor tool ${JSON.stringify(name)} is not supported`,
            );
          }
          return {
            id: boundedString(
              call.id,
              `messages[${index}].tool_calls[${callIndex}].id`,
            )!,
            type: "function" as const,
            function: {
              name,
              arguments: boundedString(
                func.arguments,
                `messages[${index}].tool_calls[${callIndex}].function.arguments`,
              )!,
            },
          };
        });
      }
    } else if (role === "tool") {
      message.tool_call_id = boundedString(
        input.tool_call_id,
        `messages[${index}].tool_call_id`,
      )!;
    } else if (
      input.tool_calls !== undefined ||
      input.tool_call_id !== undefined
    ) {
      throw new ActorCompletionError(
        "invalid_request",
        `messages[${index}] has tool fields for role ${role}`,
      );
    }
    return message;
  });
}

export class ActorCompletionBroker {
  private readonly create: typeof createLLM;
  private readonly clients = new Map<string, { modelRef: string; llm: LLM }>();
  private readonly active = new Set<string>();

  constructor(private readonly options: ActorCompletionBrokerOptions) {
    this.create = options.create ?? createLLM;
  }

  async complete(
    token: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ActorCompletionReply> {
    const binding = resolveActorSession(this.options.db, token);
    if (!binding)
      throw new ActorCompletionError(
        "unauthorized",
        "actor session is unavailable",
      );
    const messages = parseActorMessages(input);
    if (this.active.has(binding.sessionId))
      throw new ActorCompletionError(
        "busy",
        "actor session already has a completion in flight",
      );
    if (this.active.size >= this.options.config.fleet.maxConcurrent)
      throw new ActorCompletionError(
        "capacity",
        "actor completion capacity is full",
      );

    let cached = this.clients.get(binding.sessionId);
    if (cached && cached.modelRef !== binding.modelRef) {
      throw new ActorCompletionError(
        "binding_changed",
        "actor model binding changed after client creation",
      );
    }
    if (!cached) {
      const llm = this.create(
        configForLlmRef(this.options.config, binding.modelRef),
        undefined,
        this.options.db,
      );
      cached = { modelRef: binding.modelRef, llm };
      this.clients.set(binding.sessionId, cached);
    }

    this.active.add(binding.sessionId);
    try {
      return {
        binding,
        result: await cached.llm.complete(messages, { signal }),
      };
    } finally {
      this.active.delete(binding.sessionId);
    }
  }
}
