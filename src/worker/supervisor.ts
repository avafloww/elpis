import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../lib/log.js';
import type { Database } from '../store/db.js';
import type { MindService } from '../store/mind.js';
import type { SandboxDeps } from '../types.js';
import { KubectlWorkerRuntime } from './kubernetes.js';
import type { WorkerMailboxBroker } from './mailbox.js';
import { WorkerSpawnBroker, type WorkerPodRuntime } from './spawn.js';
import type { WorkerWorkspaceStore } from './workspace.js';

export interface WorkerSupervisorOptions {
  db: Database;
  config: Config;
  mind: MindService;
  mailbox: WorkerMailboxBroker | null;
  workspace?: WorkerWorkspaceStore | null;
  logger: Logger;
  runtime?: WorkerPodRuntime;
}

export interface WorkerSupervisorRuntime {
  api: NonNullable<SandboxDeps['worker']>;
  spawn: WorkerSpawnBroker;
}

export async function startWorkerSupervisor(
  options: WorkerSupervisorOptions,
): Promise<WorkerSupervisorRuntime | null> {
  const kubernetes = options.config.workers.kubernetes;
  if (!kubernetes.enabled) return null;
  if (!options.mailbox || !kubernetes.brokerUrl)
    throw new Error(
      'Kubernetes workers require the token-bound worker server and broker URL',
    );
  const runtime =
    options.runtime ??
    new KubectlWorkerRuntime({
      namespace: kubernetes.namespace,
      template: kubernetes.template,
      container: kubernetes.container,
      brokerUrl: kubernetes.brokerUrl,
      kubectlPath: kubernetes.kubectlPath,
      context: kubernetes.context,
    });
  const spawn = new WorkerSpawnBroker({
    db: options.db,
    config: options.config,
    mind: options.mind,
    runtime,
    workspace: options.workspace ?? undefined,
  });
  await spawn.recover();
  const mailbox = options.mailbox;
  const workspace = options.workspace ?? null;
  const publicArtifacts = (sessionId: string) =>
    workspace
      ?.listArtifacts(sessionId)
      .map(({ relativePath: _, ...receipt }) => receipt) ?? [];
  const refresh = async () => {
    await spawn.recover();
  };
  const api: NonNullable<SandboxDeps['worker']> = {
    start: (mindId, value) => spawn.start(mindId, value),
    async send(ref, text) {
      await refresh();
      const session = spawn.status(ref);
      return mailbox.sendToWorker(
        session.id,
        `dispatcher:${randomUUID()}`,
        text,
      );
    },
    async list() {
      await refresh();
      return spawn.list();
    },
    async status(ref) {
      await refresh();
      const session = spawn.status(ref);
      return {
        session,
        messages: mailbox.pullFromWorker(session.id, 100),
        artifacts: publicArtifacts(session.id),
      };
    },
    async artifact(ref, key = 'workspace.patch.gz') {
      await refresh();
      const session = spawn.status(ref);
      if (!workspace) throw new Error('worker artifact custody is unavailable');
      return workspace.artifactFile(session.id, key);
    },
    dismiss: (ref) => spawn.dismiss(ref),
  };
  options.logger.info('fixed-template Kubernetes worker supervisor ready');
  return { api, spawn };
}
