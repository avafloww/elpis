import type { Server } from "node:http";
import type { Config } from "../config.js";
import { createLLM } from "../llm/llm.js";
import type { Logger } from "../lib/log.js";
import type { Database } from "../store/db.js";
import type { MindService } from "../store/mind.js";
import { ActorCompletionBroker } from "./actor-completion.js";
import {
  createActorCompletionHttpServer,
  listenActorCompletionHttpServer,
} from "./actor-http.js";
import { ActorMailboxBroker } from "./actor-mailbox.js";
import { ActorMindBroker } from "./actor-mind.js";

export interface ScopedActorServerRuntime {
  server: Server;
  completion: ActorCompletionBroker;
  mind: ActorMindBroker;
  mailbox: ActorMailboxBroker;
  stop(): void;
}

export interface ScopedActorServerOptions {
  db: Database;
  config: Config;
  mind: MindService;
  logger: Logger;
  create?: typeof createLLM;
}

export async function startScopedActorServer(
  options: ScopedActorServerOptions,
): Promise<ScopedActorServerRuntime | null> {
  const bind = options.config.fleet.actorServer;
  if (!options.config.fleet.enabled || !bind.enabled) return null;

  const completion = new ActorCompletionBroker({
    db: options.db,
    config: options.config,
    create: options.create,
  });
  const mind = new ActorMindBroker(options.db, options.mind);
  const mailbox = new ActorMailboxBroker(options.db);
  const server = createActorCompletionHttpServer({
    broker: completion,
    mind,
    mailbox,
    host: bind.host,
    port: bind.port,
    logger: options.logger,
  });
  await listenActorCompletionHttpServer(server, bind.host, bind.port);
  options.logger.info(
    `scoped actor server listening on ${bind.host}:${bind.port}`,
  );

  let stopped = false;
  return {
    server,
    completion,
    mind,
    mailbox,
    stop() {
      if (stopped) return;
      stopped = true;
      server.close();
      server.closeAllConnections?.();
    },
  };
}
