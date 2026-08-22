import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parseLlmModelRef } from "../llm/model-registry.js";
import type { Database } from "../store/db.js";
import { isMindId, type MindId } from "../store/mind-id.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SESSION_ID_RE = /^sec-[A-Za-z0-9_-]{22}$/;
const ACTIVE_STATUSES = new Set<SecretarySessionStatus>(["starting", "ready"]);
const ROOT_STATUSES = new Set(["inbox", "open", "in_progress", "waiting"]);

export type SecretarySessionStatus = "starting" | "ready" | "closed" | "failed";

export interface SecretarySession {
  id: string;
  rootMindId: MindId;
  status: SecretarySessionStatus;
  modelRef: string;
  runtime: "kubernetes";
  podName: string | null;
  podUid: string | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

/** The capability scope returned after a raw token has been authenticated. */
export interface SecretarySessionBinding {
  sessionId: string;
  rootMindId: MindId;
  modelRef: string;
  runtime: "kubernetes";
}

export interface SecretaryControlCredential {
  token: string;
  digest: string;
}

export interface CreatedSecretarySession {
  session: SecretarySession;
  /** Returned once. Only its SHA-256 digest is persisted. */
  token: string;
}

export interface SecretaryPodIdentity {
  podName?: string | null;
  podUid?: string | null;
}

export interface SecretarySessionStoreOptions {
  db: Database;
  now?: () => number;
  credential?: () => SecretaryControlCredential;
  id?: () => string;
}

export class SecretarySessionError extends Error {
  constructor(
    public readonly code:
      "invalid_request" | "not_found" | "unavailable" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "SecretarySessionError";
  }
}

export function isSecretarySessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

export function newSecretarySessionId(
  bytes: (size: number) => Buffer = randomBytes,
): string {
  const id = `sec-${bytes(16).toString("base64url")}`;
  if (!isSecretarySessionId(id))
    throw new Error("secretary session id source did not return 128 bits");
  return id;
}

export function secretaryControlTokenDigest(token: string): string {
  if (typeof token !== "string" || !TOKEN_RE.test(token))
    throw new Error("secretary control token is malformed");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createSecretaryControlCredential(): SecretaryControlCredential {
  const token = randomBytes(32).toString("base64url");
  return { token, digest: secretaryControlTokenDigest(token) };
}

export function verifySecretaryControlToken(
  token: string,
  expectedDigest: string,
): boolean {
  if (typeof expectedDigest !== "string" || !DIGEST_RE.test(expectedDigest))
    return false;
  let actual: Buffer;
  try {
    actual = Buffer.from(secretaryControlTokenDigest(token), "hex");
  } catch {
    return false;
  }
  const expected = Buffer.from(expectedDigest, "hex");
  return timingSafeEqual(actual, expected);
}

function rowSession(row: Record<string, unknown>): SecretarySession {
  const id = row.id;
  const rootMindId = row.root_mind_id;
  const status = row.status;
  const modelRef = row.model_ref;
  if (!isSecretarySessionId(id))
    throw new Error("secretary session has invalid identity");
  if (!isMindId(rootMindId))
    throw new Error("secretary session has invalid root Mind identity");
  if (
    status !== "starting" &&
    status !== "ready" &&
    status !== "closed" &&
    status !== "failed"
  )
    throw new Error("secretary session has invalid status");
  if (typeof modelRef !== "string")
    throw new Error("secretary session has invalid model reference");
  parseLlmModelRef(modelRef, "secretary session model ref");
  if (row.runtime !== "kubernetes")
    throw new Error("secretary session has invalid runtime");
  const createdAt = Number(row.created_at);
  const updatedAt = Number(row.updated_at);
  if (!Number.isSafeInteger(createdAt) || !Number.isSafeInteger(updatedAt))
    throw new Error("secretary session has invalid timestamps");
  return {
    id,
    rootMindId,
    status,
    modelRef,
    runtime: "kubernetes",
    podName: row.pod_name == null ? null : String(row.pod_name),
    podUid: row.pod_uid == null ? null : String(row.pod_uid),
    createdAt,
    updatedAt,
    lastError: row.last_error == null ? null : String(row.last_error),
  };
}

/** Resolve only live, token-bound secretary capabilities. */
export function resolveSecretarySession(
  db: Database,
  token: string,
): SecretarySessionBinding | null {
  let digest: string;
  try {
    digest = secretaryControlTokenDigest(token);
  } catch {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, root_mind_id, status, model_ref, runtime,
              control_token_digest, pod_name, pod_uid, created_at, updated_at, last_error
       FROM secretary_sessions WHERE control_token_digest = ?`,
    )
    .get(digest) as Record<string, unknown> | undefined;
  if (
    !row ||
    typeof row.control_token_digest !== "string" ||
    !verifySecretaryControlToken(token, row.control_token_digest)
  )
    return null;
  try {
    const session = rowSession(row);
    if (!ACTIVE_STATUSES.has(session.status)) return null;
    return {
      sessionId: session.id,
      rootMindId: session.rootMindId,
      modelRef: session.modelRef,
      runtime: session.runtime,
    };
  } catch {
    // Corrupt or legacy rows never broaden a token's authority.
    return null;
  }
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1000) || "secretary session failed";
}

function validateModelRef(modelRef: string): void {
  try {
    parseLlmModelRef(modelRef, "secretary model ref");
  } catch (error) {
    throw new SecretarySessionError("invalid_request", boundedError(error));
  }
}

function validatePodIdentity(value: SecretaryPodIdentity): {
  podName: string | null;
  podUid: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new SecretarySessionError(
      "invalid_request",
      "pod identity must be an object",
    );
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).find(
    (key) => key !== "podName" && key !== "podUid",
  );
  if (unknown)
    throw new SecretarySessionError(
      "invalid_request",
      `unknown pod identity field ${JSON.stringify(unknown)}`,
    );
  const podName = input.podName ?? null;
  const podUid = input.podUid ?? null;
  if (
    (podName !== null &&
      (typeof podName !== "string" ||
        podName.length < 1 ||
        podName.length > 253)) ||
    (podUid !== null &&
      (typeof podUid !== "string" || podUid.length < 1 || podUid.length > 128))
  )
    throw new SecretarySessionError(
      "invalid_request",
      "pod identity is invalid",
    );
  return { podName, podUid };
}

/**
 * Host-side custody for secretary identities. Creation accepts only the exact,
 * already-resolved root and canonical model reference; deployment policy stays
 * outside this store.
 */
export class SecretarySessionStore {
  private readonly now: () => number;
  private readonly credential: () => SecretaryControlCredential;
  private readonly id: () => string;

  constructor(private readonly options: SecretarySessionStoreOptions) {
    this.now = options.now ?? Date.now;
    this.credential = options.credential ?? createSecretaryControlCredential;
    this.id = options.id ?? newSecretarySessionId;
  }

  get(sessionId: string): SecretarySession | null {
    if (!isSecretarySessionId(sessionId)) return null;
    const row = this.options.db
      .prepare("SELECT * FROM secretary_sessions WHERE id = ?")
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? rowSession(row) : null;
  }

  list(): SecretarySession[] {
    return (
      this.options.db
        .prepare(
          "SELECT * FROM secretary_sessions ORDER BY created_at DESC, id DESC",
        )
        .all() as Record<string, unknown>[]
    ).map(rowSession);
  }

  create(rootMindId: MindId, modelRef: string): CreatedSecretarySession {
    if (!isMindId(rootMindId))
      throw new SecretarySessionError(
        "invalid_request",
        "rootMindId must be an exact canonical elm- identity",
      );
    validateModelRef(modelRef);
    const credential = this.credential();
    let computedDigest: string;
    try {
      computedDigest = secretaryControlTokenDigest(credential.token);
    } catch (error) {
      throw new SecretarySessionError("invalid_request", boundedError(error));
    }
    if (
      !DIGEST_RE.test(credential.digest) ||
      !verifySecretaryControlToken(credential.token, credential.digest) ||
      credential.digest !== computedDigest
    )
      throw new SecretarySessionError(
        "invalid_request",
        "secretary credential is inconsistent",
      );
    const now = this.now();
    if (!Number.isSafeInteger(now))
      throw new SecretarySessionError(
        "invalid_request",
        "session time is invalid",
      );

    let sessionId = "";
    this.options.db.exec("BEGIN IMMEDIATE");
    try {
      const root = this.options.db
        .prepare("SELECT id, status, archived_at FROM mind_items WHERE id = ?")
        .get(rootMindId) as
        { id: unknown; status: unknown; archived_at: unknown } | undefined;
      if (!root || root.id !== rootMindId)
        throw new SecretarySessionError(
          "not_found",
          "root Mind item is unavailable",
        );
      if (root.archived_at !== null || !ROOT_STATUSES.has(String(root.status)))
        throw new SecretarySessionError(
          "unavailable",
          "root Mind item is not active committed work",
        );
      const active = this.options.db
        .prepare(
          `SELECT id FROM secretary_sessions
           WHERE root_mind_id = ? AND status IN ('starting','ready')`,
        )
        .get(rootMindId);
      if (active)
        throw new SecretarySessionError(
          "conflict",
          "root Mind item already has an active secretary session",
        );
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = this.id();
        if (!isSecretarySessionId(candidate))
          throw new SecretarySessionError(
            "invalid_request",
            "secretary session id source returned a non-canonical identity",
          );
        const exists = this.options.db
          .prepare("SELECT 1 FROM secretary_sessions WHERE id = ?")
          .get(candidate);
        if (!exists) {
          sessionId = candidate;
          break;
        }
      }
      if (!sessionId)
        throw new SecretarySessionError(
          "conflict",
          "secretary session id space is exhausted",
        );
      this.options.db
        .prepare(
          `INSERT INTO secretary_sessions
             (id, root_mind_id, status, model_ref, runtime,
              control_token_digest, created_at, updated_at)
           VALUES (?, ?, 'starting', ?, 'kubernetes', ?, ?, ?)`,
        )
        .run(sessionId, rootMindId, modelRef, credential.digest, now, now);
      this.options.db.exec("COMMIT");
    } catch (error) {
      this.options.db.exec("ROLLBACK");
      if (error instanceof SecretarySessionError) throw error;
      throw new SecretarySessionError("conflict", boundedError(error));
    }
    const session = this.get(sessionId);
    if (!session) throw new Error("created secretary session is unavailable");
    return { session, token: credential.token };
  }

  ready(sessionId: string, pod: SecretaryPodIdentity = {}): SecretarySession {
    const current = this.requireSession(sessionId);
    if (current.status !== "starting")
      throw new SecretarySessionError(
        "conflict",
        "secretary session is not starting",
      );
    const identity = validatePodIdentity(pod);
    const updatedAt = Math.max(this.now(), current.updatedAt);
    const result = this.options.db
      .prepare(
        `UPDATE secretary_sessions
         SET status = 'ready', pod_name = ?, pod_uid = ?, updated_at = ?
         WHERE id = ? AND status = 'starting'`,
      )
      .run(identity.podName, identity.podUid, updatedAt, sessionId);
    if (Number(result.changes) !== 1)
      throw new SecretarySessionError(
        "conflict",
        "secretary session changed during transition",
      );
    return this.requireSession(sessionId);
  }

  markReady(
    sessionId: string,
    pod: SecretaryPodIdentity = {},
  ): SecretarySession {
    return this.ready(sessionId, pod);
  }

  close(sessionId: string): SecretarySession {
    const current = this.requireSession(sessionId);
    if (current.status === "closed") return current;
    if (current.status === "failed")
      throw new SecretarySessionError(
        "conflict",
        "secretary session has failed",
      );
    return this.finish(sessionId, "closed", null, current.updatedAt);
  }

  fail(sessionId: string, error: unknown): SecretarySession {
    const current = this.requireSession(sessionId);
    if (current.status === "failed") return current;
    if (current.status === "closed")
      throw new SecretarySessionError(
        "conflict",
        "secretary session is closed",
      );
    return this.finish(
      sessionId,
      "failed",
      boundedError(error),
      current.updatedAt,
    );
  }

  private requireSession(sessionId: string): SecretarySession {
    const session = this.get(sessionId);
    if (!session)
      throw new SecretarySessionError(
        "not_found",
        "secretary session is unavailable",
      );
    return session;
  }

  private finish(
    sessionId: string,
    status: "closed" | "failed",
    lastError: string | null,
    previousUpdatedAt: number,
  ): SecretarySession {
    const updatedAt = Math.max(this.now(), previousUpdatedAt);
    const result = this.options.db
      .prepare(
        `UPDATE secretary_sessions
         SET status = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND status IN ('starting','ready')`,
      )
      .run(status, lastError, updatedAt, sessionId);
    if (Number(result.changes) !== 1)
      throw new SecretarySessionError(
        "conflict",
        "secretary session changed during transition",
      );
    return this.requireSession(sessionId);
  }
}

export { SecretarySessionStore as SecretarySessionBroker };
