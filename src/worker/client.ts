import type {
  WorkerEpisodeBroker,
  WorkerGuidance,
  WorkerMandate,
} from "../kernel/worker-episode.js";
import type { ChatMessage, CompleteResult } from "../llm/llm.js";
import { parseWorkerMessages } from "./completion.js";

const MAX_REPLY_BYTES = 8 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SESSION_RE = /^wrk-[a-z0-9]{8}$/;

export interface WorkerHttpClientOptions {
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

function brokerOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("worker broker URL must be an absolute http(s) origin");
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
      "worker broker URL must be a credential-free http(s) origin",
    );
  return url.origin;
}

export class WorkerHttpClient implements WorkerEpisodeBroker {
  private readonly origin: string;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: WorkerHttpClientOptions) {
    this.origin = brokerOrigin(options.brokerUrl);
    if (!TOKEN_RE.test(options.token))
      throw new Error("worker token is invalid");
    if (!SESSION_RE.test(options.sessionId))
      throw new Error("worker session identity is invalid");
    this.fetch = options.fetch ?? fetch;
  }

  private binding(value: unknown): Record<string, unknown> {
    const binding = record(value, "worker binding");
    if (binding.sessionId !== this.options.sessionId)
      throw new Error("worker broker returned a different session binding");
    return binding;
  }

  private async post(
    route: "/v1/complete" | "/v1/mind" | "/v1/mailbox",
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
      throw new Error("worker broker reply is too large");
    let value: Record<string, unknown>;
    try {
      value = record(JSON.parse(raw), "worker broker reply");
    } catch {
      throw new Error("worker broker returned malformed JSON");
    }
    if (!response.ok) {
      const message =
        typeof value.error === "string"
          ? value.error.slice(0, 500)
          : "request failed";
      throw new Error(`worker broker ${response.status}: ${message}`);
    }
    if (value.protocol !== 1)
      throw new Error("worker broker protocol mismatch");
    return value;
  }

  async getMandate(signal?: AbortSignal): Promise<WorkerMandate> {
    const reply = await this.post(
      "/v1/mind",
      { protocol: 1, operation: "get" },
      signal,
    );
    const binding = this.binding(reply.binding);
    const item = record(reply.item, "worker mandate");
    const id = text(item.id, "worker mandate id");
    if (id !== binding.mindId)
      throw new Error("worker mandate does not match the bound Mind root");
    return {
      id,
      title: text(item.title, "worker mandate title"),
      body: text(item.body, "worker mandate body"),
      status: text(item.status, "worker mandate status"),
      dependencies: Array.isArray(item.dependencies) ? item.dependencies : [],
      comments: Array.isArray(item.comments) ? item.comments : [],
    };
  }

  async pullGuidance(signal?: AbortSignal): Promise<WorkerGuidance[]> {
    const reply = await this.post(
      "/v1/mailbox",
      { protocol: 1, operation: "pull", limit: 100 },
      signal,
    );
    this.binding(reply.binding);
    if (!Array.isArray(reply.messages))
      throw new Error("worker mailbox messages must be an array");
    return reply.messages.map((value, index) => {
      const message = record(value, `worker guidance ${index}`);
      const id = Number(message.id);
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error(`worker guidance ${index} has invalid id`);
      if (
        message.direction !== "dispatcher_to_worker" ||
        message.kind !== "message"
      )
        throw new Error(
          `worker guidance ${index} has invalid direction or kind`,
        );
      return {
        id,
        sender: text(message.sender, `worker guidance ${index} sender`),
        body: text(message.body, `worker guidance ${index} body`),
      };
    });
  }

  async acknowledgeGuidance(
    ids: number[],
    signal?: AbortSignal,
  ): Promise<void> {
    const reply = await this.post(
      "/v1/mailbox",
      { protocol: 1, operation: "ack", ids },
      signal,
    );
    if (reply.acknowledged !== ids.length)
      throw new Error("worker mailbox acknowledgement count mismatch");
  }

  async complete(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompleteResult> {
    const reply = await this.post(
      "/v1/complete",
      { protocol: 1, messages },
      signal,
    );
    this.binding(reply.binding);
    const result = record(reply.result, "worker completion result");
    const [message] = parseWorkerMessages([result.message]);
    return { ...result, message } as unknown as CompleteResult;
  }

  async finish(key: string, body: string, signal?: AbortSignal): Promise<void> {
    const reply = await this.post(
      "/v1/mailbox",
      {
        protocol: 1,
        operation: "post",
        messageKey: key,
        kind: "finish",
        body,
      },
      signal,
    );
    const message = record(reply.message, "worker finish receipt");
    if (message.messageKey !== key || message.body !== body)
      throw new Error("worker finish receipt does not match prepared finish");
  }
}
