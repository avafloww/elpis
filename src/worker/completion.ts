import type { Config } from "../config.js";
import { WORKER_RUN_TOOL } from "../kernel/run-tool.js";
import { configForLlmRef } from "../config.js";
import {
  createLLM,
  type ChatMessage,
  type CompleteResult,
  type LLM,
} from "../llm/llm.js";
import type { Database } from "../store/db.js";
import { resolveWorkerSession, type WorkerSessionBinding } from "./session.js";

const MAX_MESSAGES = 512;
const MAX_REQUEST_CHARS = 8 * 1024 * 1024;
const MAX_FIELD_CHARS = 1024 * 1024;
const MAX_TOOL_CALLS = 16;

export class WorkerCompletionError extends Error {
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
    this.name = "WorkerCompletionError";
  }
}

export interface WorkerCompletionReply {
  binding: WorkerSessionBinding;
  result: CompleteResult;
}

export interface WorkerCompletionBrokerOptions {
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
    throw new WorkerCompletionError(
      "invalid_request",
      `${label} must be a string`,
    );
  if (value.length > MAX_FIELD_CHARS)
    throw new WorkerCompletionError(
      "invalid_request",
      `${label} exceeds ${MAX_FIELD_CHARS} characters`,
    );
  return value;
}

function cloneOpaque(value: unknown, label: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > MAX_FIELD_CHARS) {
    throw new WorkerCompletionError(
      "invalid_request",
      `${label} is not bounded JSON`,
    );
  }
  return JSON.parse(encoded);
}

export function parseWorkerMessages(value: unknown): ChatMessage[] {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new WorkerCompletionError("invalid_request", "messages must be JSON");
  }
  if (typeof encoded !== "string")
    throw new WorkerCompletionError("invalid_request", "messages must be JSON");
  if (encoded.length > MAX_REQUEST_CHARS)
    throw new WorkerCompletionError(
      "invalid_request",
      `messages exceed ${MAX_REQUEST_CHARS} characters`,
    );
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_MESSAGES
  ) {
    throw new WorkerCompletionError(
      "invalid_request",
      `messages must contain 1-${MAX_MESSAGES} entries`,
    );
  }

  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new WorkerCompletionError(
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
      throw new WorkerCompletionError(
        "invalid_request",
        `messages[${index}].role is invalid`,
      );
    }
    if (input.contentParts !== undefined) {
      throw new WorkerCompletionError(
        "unsupported",
        "worker image inputs are not supported yet",
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
          throw new WorkerCompletionError(
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
            throw new WorkerCompletionError(
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
            throw new WorkerCompletionError(
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
            throw new WorkerCompletionError(
              "unsupported",
              `worker tool ${JSON.stringify(name)} is not supported`,
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
      throw new WorkerCompletionError(
        "invalid_request",
        `messages[${index}] has tool fields for role ${role}`,
      );
    }
    return message;
  });
}

export class WorkerCompletionBroker {
  private readonly create: typeof createLLM;
  private readonly clients = new Map<string, { modelRef: string; llm: LLM }>();
  private readonly active = new Set<string>();

  constructor(private readonly options: WorkerCompletionBrokerOptions) {
    this.create = options.create ?? createLLM;
  }

  async complete(
    token: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<WorkerCompletionReply> {
    const binding = resolveWorkerSession(this.options.db, token);
    if (!binding)
      throw new WorkerCompletionError(
        "unauthorized",
        "worker session is unavailable",
      );
    const messages = parseWorkerMessages(input);
    if (this.active.has(binding.sessionId))
      throw new WorkerCompletionError(
        "busy",
        "worker session already has a completion in flight",
      );
    if (this.active.size >= this.options.config.workers.maxConcurrent)
      throw new WorkerCompletionError(
        "capacity",
        "worker completion capacity is full",
      );

    let cached = this.clients.get(binding.sessionId);
    if (cached && cached.modelRef !== binding.modelRef) {
      throw new WorkerCompletionError(
        "binding_changed",
        "worker model binding changed after client creation",
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
        result: await cached.llm.complete(messages, {
          signal,
          runTool: WORKER_RUN_TOOL,
        }),
      };
    } finally {
      this.active.delete(binding.sessionId);
    }
  }
}
