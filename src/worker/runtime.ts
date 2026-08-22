import type { Server } from "node:http";
import * as path from "node:path";
import type { Config } from "../config.js";
import { createLLM } from "../llm/llm.js";
import type { Logger } from "../lib/log.js";
import type { Database } from "../store/db.js";
import type { MindService } from "../store/mind.js";
import { WorkerCompletionBroker } from "./completion.js";
import {
  createWorkerCompletionHttpServer,
  listenWorkerCompletionHttpServer,
} from "./http.js";
import { WorkerMailboxBroker } from "./mailbox.js";
import { WorkerMindBroker } from "./mind.js";
import { WorkerWorkspaceStore } from "./workspace.js";

export interface ScopedWorkerServerRuntime {
  server: Server;
  completion: WorkerCompletionBroker;
  mind: WorkerMindBroker;
  mailbox: WorkerMailboxBroker;
  workspace: WorkerWorkspaceStore;
  stop(): void;
}

export interface ScopedWorkerServerOptions {
  db: Database;
  config: Config;
  mind: MindService;
  logger: Logger;
  create?: typeof createLLM;
}

export async function startScopedWorkerServer(
  options: ScopedWorkerServerOptions,
): Promise<ScopedWorkerServerRuntime | null> {
  const bind = options.config.workers.server;
  if (!options.config.workers.enabled || !bind.enabled) return null;

  const completion = new WorkerCompletionBroker({
    db: options.db,
    config: options.config,
    create: options.create,
  });
  const mind = new WorkerMindBroker(options.db, options.mind);
  const mailbox = new WorkerMailboxBroker(options.db);
  const workspace = new WorkerWorkspaceStore({
    db: options.db,
    storageRoot: path.join(
      options.config.paths.dataDirectory,
      "elpis-data",
      "workers",
    ),
    sourceRoot: options.config.workers.workspace.sourceRoot,
    maxSourceBytes: options.config.workers.workspace.maxSourceBytes,
    maxArtifactBytes: options.config.workers.workspace.maxArtifactBytes,
  });
  const server = createWorkerCompletionHttpServer({
    broker: completion,
    mind,
    mailbox,
    workspace,
    host: bind.host,
    port: bind.port,
    logger: options.logger,
    workspaceMaxBodyBytes:
      Math.ceil((options.config.workers.workspace.maxArtifactBytes * 4) / 3) +
      16 * 1024,
  });
  await listenWorkerCompletionHttpServer(server, bind.host, bind.port);
  options.logger.info(
    `scoped worker server listening on ${bind.host}:${bind.port}`,
  );

  let stopped = false;
  return {
    server,
    completion,
    mind,
    mailbox,
    workspace,
    stop() {
      if (stopped) return;
      stopped = true;
      server.close();
      server.closeAllConnections?.();
    },
  };
}
