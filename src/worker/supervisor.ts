import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Logger } from '../lib/log.js';
import type { Database } from '../store/db.js';
import type { MindService } from '../store/mind.js';
import type { MindId } from '../store/mind-id.js';
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
  const mandateFor = (mindId: MindId) => {
    const item = options.mind.get(mindId);
    if (!item) throw new Error('worker mandate Mind item is unavailable');
    const bytes = Buffer.from(item.body, 'utf8');
    const marker = '\n… [mandate truncated for receipt]';
    const truncated = bytes.length > 8192;
    const limit = truncated ? 8192 - Buffer.byteLength(marker, 'utf8') : 8192;
    let end = Math.min(bytes.length, limit);
    while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    const body = bytes.subarray(0, end).toString('utf8');
    return {
      mindTitle: item.title,
      mandate: truncated ? `${body}${marker}` : body,
    };
  };
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
        ...mandateFor(session.mindId),
        messages: mailbox.pullFromWorker(session.id, 100),
        artifacts: publicArtifacts(session.id),
      };
    },
    async followup(ref, text) {
      await refresh();
      const prior = spawn.status(ref);
      if (['spawning', 'running', 'idle'].includes(prior.status))
        throw new Error(
          'worker is still active; send steering instead of starting a follow-up',
        );
      if (
        text !== undefined &&
        (typeof text !== 'string' || text.length > 16_000)
      )
        throw new Error(
          'worker follow-up text must be at most 16000 characters',
        );
      const messages = mailbox.pullFromWorker(prior.id, 100);
      const finish = [...messages]
        .reverse()
        .find((message) => message.kind === 'finish');
      const parts = [
        `Fresh worker follow-up requested after ${prior.worker} (${prior.id}). This does not resume hidden model context; continue from this Mind item and its durable record.`,
      ];
      if (finish?.body)
        parts.push(`Prior worker finish:\n${finish.body.slice(0, 8000)}`);
      if (text?.trim()) parts.push(`Follow-up instruction:\n${text.trim()}`);
      const comment = options.mind.addComment(
        prior.mindId,
        parts.join('\n\n').slice(0, 20_000),
        'dispatcher:worker-followup',
      );
      const session = await spawn.start(prior.mindId, {
        modelRef: prior.modelRef,
      });
      return {
        continuity: 'fresh_same_mind' as const,
        priorSessionId: prior.id,
        mindId: prior.mindId,
        commentId: comment.id,
        session,
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
