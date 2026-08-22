import type { Database } from "../store/db.js";
import { workerControlTokenDigest, verifyWorkerControlToken } from "./auth.js";

export interface WorkerSessionBinding {
  sessionId: string;
  worker: string;
  modelRef: string;
  mindId: string;
  runtime: "trusted" | "kubernetes";
}

const ACTIVE = new Set(["spawning", "running", "idle"]);

export function resolveWorkerSession(
  db: Database,
  token: string,
): WorkerSessionBinding | null {
  let digest: string;
  try {
    digest = workerControlTokenDigest(token);
  } catch {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, slug, status, model_ref, mind_id, runtime, control_token_digest
     FROM worker_sessions WHERE control_token_digest = ?`,
    )
    .get(digest) as Record<string, unknown> | undefined;
  if (
    !row ||
    !verifyWorkerControlToken(token, String(row.control_token_digest ?? ""))
  )
    return null;
  const runtime = row.runtime;
  if (runtime !== "trusted" && runtime !== "kubernetes") return null;
  if (!ACTIVE.has(String(row.status))) return null;
  if (typeof row.model_ref !== "string" || typeof row.mind_id !== "string")
    return null;
  return {
    sessionId: String(row.id),
    worker: `worker:${String(row.slug)}`,
    modelRef: row.model_ref,
    mindId: row.mind_id,
    runtime,
  };
}
