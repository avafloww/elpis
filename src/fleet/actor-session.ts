import type { Database } from "../store/db.js";
import {
  actorControlTokenDigest,
  verifyActorControlToken,
} from "./actor-auth.js";

export interface ActorSessionBinding {
  sessionId: string;
  actor: string;
  modelRef: string;
  mindId: string;
  runtime: "trusted" | "kubernetes";
}

const ACTIVE = new Set(["spawning", "running", "idle"]);

export function resolveActorSession(
  db: Database,
  token: string,
): ActorSessionBinding | null {
  let digest: string;
  try {
    digest = actorControlTokenDigest(token);
  } catch {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, name, status, model_ref, mind_id, runtime, control_token_digest
     FROM fleet_sessions WHERE control_token_digest = ?`,
    )
    .get(digest) as Record<string, unknown> | undefined;
  if (
    !row ||
    !verifyActorControlToken(token, String(row.control_token_digest ?? ""))
  )
    return null;
  const runtime = row.runtime;
  if (runtime !== "trusted" && runtime !== "kubernetes") return null;
  if (!ACTIVE.has(String(row.status))) return null;
  if (typeof row.model_ref !== "string" || typeof row.mind_id !== "string")
    return null;
  return {
    sessionId: String(row.id),
    actor: `fleet:${String(row.name)}`,
    modelRef: row.model_ref,
    mindId: row.mind_id,
    runtime,
  };
}
