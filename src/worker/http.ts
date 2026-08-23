import * as http from "node:http";
import type { Logger } from "../lib/log.js";
import { SecretaryConversationError } from "../secretary/conversation.js";
import {
  SecretaryConversationRequestError,
  dispatchSecretaryConversationRequest,
  type SecretaryConversationService,
} from "../secretary/conversation-request.js";
import {
  SecretaryCompletionError,
  type SecretaryCompletionReply,
} from "../secretary/completion.js";
import { SecretaryMindError } from "../secretary/mind.js";
import {
  SecretaryMindRequestError,
  dispatchSecretaryMindRequest,
  type SecretaryMindService,
} from "../secretary/mind-request.js";
import {
  WorkerCompletionError,
  type WorkerCompletionReply,
} from "./completion.js";
import { WorkerMailboxError } from "./mailbox.js";
import {
  WorkerMailboxRequestError,
  dispatchWorkerMailboxRequest,
  type WorkerMailboxService,
} from "./mailbox-request.js";
import { WorkerMindError } from "./mind.js";
import {
  WorkerMindRequestError,
  dispatchWorkerMindRequest,
  type WorkerMindService,
} from "./mind-request.js";
import { WorkerWorkspaceError } from "./workspace.js";
import {
  WorkerWorkspaceRequestError,
  dispatchWorkerWorkspaceRequest,
  type WorkerWorkspaceService,
} from "./workspace-request.js";

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface WorkerCompletionService {
  complete(
    token: string,
    messages: unknown,
    signal?: AbortSignal,
  ): Promise<WorkerCompletionReply>;
}

export interface SecretaryCompletionService {
  complete(
    token: string,
    messages: unknown,
    signal?: AbortSignal,
  ): Promise<SecretaryCompletionReply>;
}

export interface WorkerCompletionHttpOptions {
  broker: WorkerCompletionService;
  mind?: WorkerMindService;
  secretaryCompletion?: SecretaryCompletionService;
  secretaryConversation?: SecretaryConversationService;
  secretaryMind?: SecretaryMindService;
  mailbox?: WorkerMailboxService;
  workspace?: WorkerWorkspaceService;
  host: string;
  port: number;
  logger: Logger;
  maxBodyBytes?: number;
  workspaceMaxBodyBytes?: number;
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new HttpInputError(413, "request body is too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes)
      throw new HttpInputError(413, "request body is too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpInputError(400, "request body must be JSON");
  }
}

class HttpInputError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function statusFor(error: WorkerCompletionError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    case "unsupported":
      return 422;
    case "busy":
      return 409;
    case "capacity":
      return 429;
    case "binding_changed":
      return 409;
  }
}

function statusForSecretaryCompletion(error: SecretaryCompletionError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    case "unsupported":
      return 422;
    case "busy":
    case "binding_changed":
      return 409;
    case "capacity":
      return 429;
  }
}

function statusForSecretaryMind(error: SecretaryMindError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    case "not_found":
      return 404;
    case "too_large":
      return 413;
  }
}

function statusForMind(error: WorkerMindError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "outside_scope":
      return 403;
    case "not_found":
      return 404;
  }
}

function statusForMailbox(error: WorkerMailboxError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
  }
}

function statusForWorkspace(error: WorkerWorkspaceError): number {
  switch (error.code) {
    case "unauthorized":
      return 401;
    case "invalid_request":
      return 400;
    case "unavailable":
      return 404;
    case "conflict":
      return 409;
    case "corrupt":
      return 502;
  }
}

function bearer(req: http.IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (typeof value !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1] ?? null;
}

export function createWorkerCompletionHttpServer(
  options: WorkerCompletionHttpOptions,
): http.Server {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const workspaceMaxBodyBytes =
    options.workspaceMaxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return http.createServer(async (req, res) => {
    const mindRequest = req.url === "/v1/mind";
    const mailboxRequest = req.url === "/v1/mailbox";
    const workspaceRequest = req.url === "/v1/workspace";
    const secretaryCompletionRequest = req.url === "/v1/secretary/complete";
    const secretaryConversationRequest =
      req.url === "/v1/secretary/conversation";
    const secretaryMindRequest = req.url === "/v1/secretary/mind";
    if (
      req.url !== "/v1/complete" &&
      !mindRequest &&
      !mailboxRequest &&
      !workspaceRequest &&
      !secretaryCompletionRequest &&
      !secretaryConversationRequest &&
      !secretaryMindRequest
    ) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (
      (mindRequest && !options.mind) ||
      (mailboxRequest && !options.mailbox) ||
      (workspaceRequest && !options.workspace) ||
      (secretaryCompletionRequest && !options.secretaryCompletion) ||
      (secretaryConversationRequest && !options.secretaryConversation) ||
      (secretaryMindRequest && !options.secretaryMind)
    ) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      json(res, 405, { error: "method not allowed" });
      return;
    }
    const token = bearer(req);
    if (!token) {
      json(res, 401, {
        error:
          secretaryCompletionRequest ||
          secretaryConversationRequest ||
          secretaryMindRequest
            ? "secretary session is unavailable"
            : "worker session is unavailable",
      });
      return;
    }
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const body = await readBody(
        req,
        workspaceRequest ? workspaceMaxBodyBytes : maxBodyBytes,
      );
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new HttpInputError(400, "request must be an object");
      const input = body as Record<string, unknown>;
      if (secretaryConversationRequest) {
        json(res, 200, {
          protocol: 1,
          ...dispatchSecretaryConversationRequest(
            options.secretaryConversation!,
            token,
            input,
          ),
        });
        return;
      }
      if (secretaryMindRequest) {
        json(
          res,
          200,
          dispatchSecretaryMindRequest(options.secretaryMind!, token, input),
        );
        return;
      }
      if (mindRequest) {
        json(res, 200, dispatchWorkerMindRequest(options.mind!, token, input));
        return;
      }
      if (mailboxRequest) {
        json(
          res,
          200,
          dispatchWorkerMailboxRequest(options.mailbox!, token, input),
        );
        return;
      }
      if (workspaceRequest) {
        json(
          res,
          200,
          dispatchWorkerWorkspaceRequest(options.workspace!, token, input),
        );
        return;
      }
      if (input.protocol !== 1)
        throw new HttpInputError(400, "protocol must equal 1");
      const unknown = Object.keys(input).filter(
        (key) => key !== "protocol" && key !== "messages",
      );
      if (unknown.length > 0)
        throw new HttpInputError(
          400,
          `unknown request field ${JSON.stringify(unknown[0])}`,
        );
      const reply = await (
        secretaryCompletionRequest
          ? options.secretaryCompletion!
          : options.broker
      ).complete(token, input.messages, controller.signal);
      json(res, 200, { protocol: 1, ...reply });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (error instanceof HttpInputError) {
        json(res, error.status, { error: error.message });
      } else if (error instanceof SecretaryConversationRequestError) {
        json(res, 400, { error: error.message, code: "invalid_request" });
      } else if (error instanceof SecretaryConversationError) {
        const status =
          error.code === "unauthorized"
            ? 401
            : error.code === "invalid_request"
              ? 400
              : error.code === "not_found"
                ? 404
                : 409;
        json(res, status, { error: error.message, code: error.code });
      } else if (error instanceof SecretaryMindRequestError) {
        json(res, 400, { error: error.message, code: "invalid_request" });
      } else if (error instanceof SecretaryMindError) {
        json(res, statusForSecretaryMind(error), {
          error: error.message,
          code: error.code,
        });
      } else if (error instanceof SecretaryCompletionError) {
        json(res, statusForSecretaryCompletion(error), {
          error: error.message,
          code: error.code,
        });
      } else if (
        error instanceof WorkerMindRequestError ||
        error instanceof WorkerMailboxRequestError ||
        error instanceof WorkerWorkspaceRequestError
      ) {
        json(res, 400, { error: error.message, code: "invalid_request" });
      } else if (error instanceof WorkerMindError) {
        json(res, statusForMind(error), {
          error: error.message,
          code: error.code,
        });
      } else if (error instanceof WorkerMailboxError) {
        json(res, statusForMailbox(error), {
          error: error.message,
          code: error.code,
        });
      } else if (error instanceof WorkerWorkspaceError) {
        json(res, statusForWorkspace(error), {
          error: error.message,
          code: error.code,
        });
      } else if (error instanceof WorkerCompletionError) {
        json(res, statusFor(error), { error: error.message, code: error.code });
      } else {
        if (
          secretaryCompletionRequest ||
          secretaryConversationRequest ||
          secretaryMindRequest
        ) {
          const operation = secretaryMindRequest
            ? "Mind"
            : secretaryConversationRequest
              ? "conversation"
              : "completion";
          options.logger.error(`secretary ${operation} request failed`, error);
          json(res, 502, {
            error: `secretary ${operation} request failed`,
          });
          return;
        }
        const operation = mindRequest
          ? "Mind"
          : mailboxRequest
            ? "mailbox"
            : workspaceRequest
              ? "workspace"
              : "completion";
        options.logger.error(`worker ${operation} request failed`, error);
        json(res, 502, {
          error:
            mindRequest || mailboxRequest || workspaceRequest
              ? `worker ${operation} request failed`
              : "worker completion failed",
        });
      }
    }
  });
}

export async function listenWorkerCompletionHttpServer(
  server: http.Server,
  host: string,
  port: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
