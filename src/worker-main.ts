import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { BuiltinModuleRegistry } from "./builtin-modules.js";
import {
  WorkerEpisode,
  type WorkerEpisodeBroker,
} from "./kernel/worker-episode.js";
import { WorkerJournal } from "./kernel/worker-journal.js";
import { createSandbox, type Sandbox } from "./sandbox/index.js";
import type { SandboxDeps } from "./types.js";
import {
  WorkerHttpClient,
  type WorkerWorkspaceArtifactReceipt,
  type WorkerWorkspaceSource,
} from "./worker/client.js";
import {
  checkoutWorkerSource,
  createWorkerPatch,
} from "./worker/worktree.js";

const DISABLED_MODULES: BuiltinModuleRegistry = Object.freeze({
  statuses: Object.freeze([]),
  state: () => "disabled" as const,
  isSelected: () => false,
  isActive: () => false,
  reason: () => "built-in modules are disabled in worker episodes",
});

export interface WorkerEnvironment {
  token: string;
  brokerUrl: string;
  sessionId: string;
  workspace: string;
  dataDirectory: string;
}

export interface WorkerWorkspaceBroker {
  getWorkspaceSource(signal?: AbortSignal): Promise<WorkerWorkspaceSource | null>;
  putWorkspaceArtifact(
    input: {
      key: string;
      kind: "unified_patch_gzip";
      sourceSha256: string;
      data: Buffer;
    },
    signal?: AbortSignal,
  ): Promise<WorkerWorkspaceArtifactReceipt>;
}

export interface WorkerProcessOptions {
  env?: NodeJS.ProcessEnv;
  broker?: WorkerEpisodeBroker & Partial<WorkerWorkspaceBroker>;
  sandbox?: Sandbox;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function workerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): WorkerEnvironment {
  const token = required(env, "ELPIS_WORKER_TOKEN");
  const brokerUrl = required(env, "ELPIS_WORKER_BROKER_URL");
  const sessionId = required(env, "ELPIS_WORKER_SESSION_ID");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new Error("ELPIS_WORKER_TOKEN is invalid");
  if (!/^wrk-[a-z0-9]{8}$/.test(sessionId))
    throw new Error("ELPIS_WORKER_SESSION_ID is invalid");
  return {
    token,
    brokerUrl,
    sessionId,
    workspace: env.ELPIS_WORKER_WORKSPACE ?? "/workspace",
    dataDirectory: env.ELPIS_WORKER_DATA_DIR ?? "/data",
  };
}

export function createWorkerSandbox(environment: WorkerEnvironment): Sandbox {
  fs.mkdirSync(environment.workspace, { recursive: true, mode: 0o700 });
  fs.mkdirSync(environment.dataDirectory, { recursive: true, mode: 0o700 });
  const home = path.join(environment.dataDirectory, "home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  process.env.HOME = home;
  process.env.TMPDIR = "/tmp";
  process.chdir(environment.workspace);
  const deniedMemory = () => {
    throw new Error("resident memory is unavailable in worker episodes");
  };
  const deps: SandboxDeps = {
    surface: "worker",
    config: {
      sandbox: {
        syncTimeoutMs: 15_000,
        asyncDeadlineMs: 300_000,
        persistentRetirementGraceMs: 600_000,
        previewMaxBytes: 16_384,
        logMaxBytes: 16_384,
      },
      kagi: { apiKey: null },
      bluesky: null,
      modules: { enabled: [], disabled: [] },
      paths: {
        harnessRoot: "/opt/elpis",
        dataDirectory: environment.workspace,
      },
    },
    memory: {
      read: deniedMemory,
      append: deniedMemory,
      overwrite: deniedMemory,
    },
    modules: DISABLED_MODULES,
    profile: { restricted: true, source: "environment" },
    logbuf: [],
  };
  return createSandbox(deps);
}

export async function runWorkerProcess(
  options: WorkerProcessOptions = {},
): Promise<void> {
  const environment = workerEnvironment(options.env);
  const broker =
    options.broker ??
    new WorkerHttpClient({
      brokerUrl: environment.brokerUrl,
      token: environment.token,
      sessionId: environment.sessionId,
    });
  const journal = new WorkerJournal(
    path.join(environment.dataDirectory, "worker-episode.jsonl"),
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    let checkedOut: WorkerWorkspaceSource | null = null;
    if (
      typeof broker.getWorkspaceSource === "function" &&
      typeof broker.putWorkspaceArtifact === "function"
    ) {
      checkedOut = await broker.getWorkspaceSource(controller.signal);
      if (checkedOut) {
        await checkoutWorkerSource(
          checkedOut,
          environment.workspace,
          environment.dataDirectory,
        );
      }
    }
    const sandbox = options.sandbox ?? createWorkerSandbox(environment);
    const beforeFinish = checkedOut
      ? async () => {
          const current = await broker.getWorkspaceSource!(controller.signal);
          if (!current || current.sha256 !== checkedOut.sha256)
            throw new Error("worker source baseline changed before artifact export");
          const artifact = await createWorkerPatch(
            current,
            environment.workspace,
            environment.dataDirectory,
          );
          await broker.putWorkspaceArtifact!(
            {
              key: "workspace.patch.gz",
              kind: "unified_patch_gzip",
              sourceSha256: current.sha256,
              data: artifact,
            },
            controller.signal,
          );
        }
      : undefined;
    await new WorkerEpisode({
      broker,
      sandbox,
      journal,
      beforeFinish,
    }).run(controller.signal);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    journal.close();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  runWorkerProcess().catch((error) => {
    console.error(
      `[worker] fatal: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
