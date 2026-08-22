import * as http from "node:http";
import type { Logger } from "../lib/log.js";
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

const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface WorkerCompletionService {
  complete(
    token: string,
    messages: unknown,
    signal?: AbortSignal,
  ): Promise<WorkerCompletionReply>;
}

export interface WorkerCompletionHttpOptions {
  broker: WorkerCompletionService;
  mind?: WorkerMindService;
  mailbox?: WorkerMailboxService;
  host: string;
  port: number;
  logger: Logger;
  maxBodyBytes?: number;
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
  return http.createServer(async (req, res) => {
    const mindRequest = req.url === "/v1/mind";
    const mailboxRequest = req.url === "/v1/mailbox";
    if (req.url !== "/v1/complete" && !mindRequest && !mailboxRequest) {
      json(res, 404, { error: "not found" });
      return;
    }
    if (
      (mindRequest && !options.mind) ||
      (mailboxRequest && !options.mailbox)
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
      json(res, 401, { error: "worker session is unavailable" });
      return;
    }
    const controller = new AbortController();
    req.once("aborted", () => controller.abort());
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const body = await readBody(req, maxBodyBytes);
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new HttpInputError(400, "request must be an object");
      const input = body as Record<string, unknown>;
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
      const reply = await options.broker.complete(
        token,
        input.messages,
        controller.signal,
      );
      json(res, 200, { protocol: 1, ...reply });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      if (error instanceof HttpInputError) {
        json(res, error.status, { error: error.message });
      } else if (
        error instanceof WorkerMindRequestError ||
        error instanceof WorkerMailboxRequestError
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
      } else if (error instanceof WorkerCompletionError) {
        json(res, statusFor(error), { error: error.message, code: error.code });
      } else {
        const operation = mindRequest
          ? "Mind"
          : mailboxRequest
            ? "mailbox"
            : "completion";
        options.logger.error(`worker ${operation} request failed`, error);
        json(res, 502, {
          error:
            mindRequest || mailboxRequest
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
