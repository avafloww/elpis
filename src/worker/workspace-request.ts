import type { WorkerSessionBinding } from "./session.js";
import type {
  WorkerArtifactReceipt,
  WorkerSourceArchive,
} from "./workspace.js";

export class WorkerWorkspaceRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerWorkspaceRequestError";
  }
}

export interface WorkerWorkspaceService {
  sourceForWorker(token: string): WorkerSourceArchive | null;
  putArtifactForWorker(input: {
    token: string;
    key: string;
    kind: "unified_patch_gzip";
    sourceSha256: string;
    data: Buffer;
    sha256?: string;
  }): WorkerArtifactReceipt;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new WorkerWorkspaceRequestError("request must be an object");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0)
    throw new WorkerWorkspaceRequestError(
      `unknown request field ${JSON.stringify(extra[0])}`,
    );
}

function base64(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0)
    throw new WorkerWorkspaceRequestError("data must be non-empty base64");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new WorkerWorkspaceRequestError("data must be canonical base64");
  return decoded;
}

function binding(value: WorkerSessionBinding): WorkerSessionBinding {
  return value;
}

export function dispatchWorkerWorkspaceRequest(
  service: WorkerWorkspaceService,
  token: string,
  value: unknown,
): unknown {
  const input = record(value);
  if (input.protocol !== 1)
    throw new WorkerWorkspaceRequestError("protocol must equal 1");
  switch (input.operation) {
    case "source": {
      exact(input, ["protocol", "operation"]);
      const source = service.sourceForWorker(token);
      if (!source) return { protocol: 1, source: null };
      return {
        protocol: 1,
        binding: binding(source.binding),
        source: {
          revision: source.revision,
          sha256: source.sha256,
          sizeBytes: source.sizeBytes,
          encoding: "base64",
          data: source.data.toString("base64"),
        },
      };
    }
    case "put_artifact": {
      exact(input, [
        "protocol",
        "operation",
        "key",
        "kind",
        "sourceSha256",
        "sha256",
        "data",
      ]);
      if (
        typeof input.key !== "string" ||
        input.kind !== "unified_patch_gzip" ||
        typeof input.sourceSha256 !== "string" ||
        typeof input.sha256 !== "string"
      )
        throw new WorkerWorkspaceRequestError(
          "artifact key, kind, sourceSha256, and sha256 are invalid",
        );
      const artifact = service.putArtifactForWorker({
        token,
        key: input.key,
        kind: input.kind,
        sourceSha256: input.sourceSha256,
        sha256: input.sha256,
        data: base64(input.data),
      });
      return {
        protocol: 1,
        artifact: {
          sessionId: artifact.sessionId,
          key: artifact.key,
          kind: artifact.kind,
          sourceSha256: artifact.sourceSha256,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          createdAt: artifact.createdAt,
        },
      };
    }
    default:
      throw new WorkerWorkspaceRequestError(
        "operation must be source or put_artifact",
      );
  }
}
