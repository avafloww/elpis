import type { Config } from "../config.js";
import type { Logger } from "../lib/log.js";
import { createLLM } from "../llm/llm.js";
import type { MindService } from "../store/mind.js";
import { SecretaryCompletionBroker } from "./completion.js";
import {
  SecretaryConversationBroker,
  SecretaryConversationStore,
} from "./conversation.js";
import { SecretaryMindBroker } from "./mind.js";
import type { Database } from "../store/db.js";
import {
  KubectlSecretaryRuntime,
  type KubernetesSecretaryRuntimeOptions,
} from "./kubernetes.js";
import { SecretarySpawnBroker, type SecretaryPodRuntime } from "./spawn.js";

export interface SecretarySupervisorRuntime {
  broker: SecretarySpawnBroker;
  completion: SecretaryCompletionBroker;
  conversation: SecretaryConversationStore;
  conversationTransport: SecretaryConversationBroker;
  mind: SecretaryMindBroker;
}

export interface SecretarySupervisorOptions {
  db: Database;
  config: Config;
  mind: MindService;
  logger: Logger;
  runtime?: SecretaryPodRuntime;
  create?: typeof createLLM;
}

function kubernetesOptions(config: Config): KubernetesSecretaryRuntimeOptions {
  const kubernetes = config.secretary.kubernetes;
  if (!kubernetes.brokerUrl)
    throw new Error("secretary Kubernetes broker URL is unavailable");
  return {
    namespace: kubernetes.namespace,
    template: kubernetes.template,
    container: kubernetes.container,
    brokerUrl: kubernetes.brokerUrl,
    kubectlPath: kubernetes.kubectlPath,
    context: kubernetes.context,
  };
}

export async function startSecretarySupervisor(
  options: SecretarySupervisorOptions,
): Promise<SecretarySupervisorRuntime | null> {
  if (!options.config.secretary.enabled) return null;
  const runtime =
    options.runtime ??
    new KubectlSecretaryRuntime(kubernetesOptions(options.config));
  const conversation = new SecretaryConversationStore({ db: options.db });
  const ambiguous = conversation.recoverClaimed();
  const conversationTransport = new SecretaryConversationBroker(
    options.db,
    conversation,
  );
  const broker = new SecretarySpawnBroker({
    db: options.db,
    config: options.config,
    runtime,
  });
  const sessions = await broker.recover();
  const active = sessions.filter(
    (session) => session.status === "starting" || session.status === "ready",
  ).length;
  const completion = new SecretaryCompletionBroker({
    db: options.db,
    config: options.config,
    create: options.create,
  });
  const mind = new SecretaryMindBroker(options.db, options.mind);
  options.logger.info(
    `secretary supervisor recovered ${active} active session(s); marked ${ambiguous} claimed turn(s) ambiguous`,
  );
  return { broker, completion, conversation, conversationTransport, mind };
}
