import { randomUUID } from 'node:crypto';
import type { MaterializedConfig as Config } from '../config.js';
import type { Logger } from '../lib/log.js';
import type { Database } from '../store/db.js';
import type { MindService } from '../store/mind.js';
import type { MindId } from '../store/mind-id.js';
import type { SandboxDeps } from '../types.js';
import { KubectlWorkerRuntime } from './kubernetes.js';
import type { WorkerMailboxBroker } from './mailbox.js';
import {
  WorkerSpawnBroker,
  type WorkerPodRuntime,
  type WorkerSession,
} from './spawn.js';
import type { WorkerWorkspaceStore } from './workspace.js';

export interface WorkerSupervisorOptions {
  db: Database;
  config: Config;
  mind: MindService;
  mailbox: WorkerMailboxBroker | null;
  workspace?: WorkerWorkspaceStore | null;
  logger: Logger;
  runtime?: WorkerPodRuntime;
  pollIntervalMs?: number;
}

export interface WorkerTerminalNotice {
  session: Pick<
    WorkerSession,
    'id' | 'worker' | 'mindId' | 'status' | 'updatedAt'
  >;
  finish: { id: number } | null;
  delivered(): void;
  dropped(): void;
}

export interface WorkerSupervisorRuntime {
  api: NonNullable<SandboxDeps['worker']>;
  spawn: WorkerSpawnBroker;
  activate(deliver: (notice: WorkerTerminalNotice) => void): Promise<void>;
  reconcile(): Promise<void>;
  dispose(): void;
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
  const mailbox = options.mailbox;
  const workspace = options.workspace ?? null;
  const publicArtifacts = (sessionId: string) =>
    workspace
      ?.listArtifacts(sessionId)
      .map(({ relativePath: _, ...receipt }) => receipt) ?? [];
  const publicMessages = (sessionId: string) => {
    const messages = mailbox.pullFromWorker(sessionId, 100);
    const finish = mailbox.finishFromWorker(sessionId);
    if (!finish || messages.some((message) => message.id === finish.id))
      return messages;
    if (messages.length >= 100) messages.pop();
    messages.push(finish);
    return messages;
  };
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

  let disposed = false;
  let generation = 0;
  const operationAbort = new AbortController();
  let deliverer: ((notice: WorkerTerminalNotice) => void) | null = null;
  let finishUnsubscribe: (() => void) | null = null;
  let provisioningUnsubscribe: (() => void) | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let reconcileCurrent: Promise<void> | null = null;
  let reconcileAbort: AbortController | null = null;
  let reconcileDirty = false;
  let cleanupCurrent: Promise<void> | null = null;
  let cleanupAbort: AbortController | null = null;
  let cleanupDirty = false;
  const claimed = new Set<string>();

  const deliverPending = (): void => {
    if (disposed || !deliverer) return;
    const pending = options.db
      .prepare(
        `SELECT id FROM worker_sessions
         WHERE status IN ('finished','failed') AND completion_notified_at IS NULL
         ORDER BY updated_at, id`,
      )
      .all() as { id: string }[];
    for (const row of pending) {
      if (claimed.has(row.id)) continue;
      const record = spawn.status(row.id);
      const session: WorkerTerminalNotice['session'] = {
        id: record.id,
        worker: record.worker,
        mindId: record.mindId,
        status: record.status,
        updatedAt: record.updatedAt,
      };
      const finishMessage = mailbox.finishFromWorker(session.id);
      const finish = finishMessage ? { id: finishMessage.id } : null;
      claimed.add(session.id);
      const notice: WorkerTerminalNotice = {
        session,
        finish,
        delivered() {
          if (!claimed.delete(session.id)) return;
          options.db
            .prepare(
              `UPDATE worker_sessions
               SET completion_notified_at = COALESCE(
                 completion_notified_at,
                 MAX(created_at, updated_at, ?)
               )
               WHERE id = ? AND status IN ('finished','failed')`,
            )
            .run(Date.now(), session.id);
        },
        dropped() {
          claimed.delete(session.id);
        },
      };
      try {
        deliverer(notice);
      } catch (error) {
        claimed.delete(session.id);
        options.logger.warn(
          `worker completion delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  };

  const kickCleanup = (): void => {
    if (disposed) return;
    cleanupDirty = true;
    if (cleanupCurrent) return;
    const passGeneration = generation;
    const abort = new AbortController();
    cleanupAbort = abort;
    const isCurrent = () => !disposed && generation === passGeneration;
    const run = async () => {
      do {
        cleanupDirty = false;
        if (!isCurrent()) return;
        await spawn.cleanupPending(isCurrent, abort.signal);
      } while (cleanupDirty);
    };
    const current = run()
      .catch((error) => {
        if (isCurrent())
          options.logger.warn(
            `worker runtime cleanup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
      })
      .finally(() => {
        if (cleanupAbort === abort) cleanupAbort = null;
        if (cleanupCurrent === current) cleanupCurrent = null;
      });
    cleanupCurrent = current;
  };

  const reconcile = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    reconcileDirty = true;
    if (reconcileCurrent) return reconcileCurrent;
    const passGeneration = generation;
    const abort = new AbortController();
    reconcileAbort = abort;
    const isCurrent = () => !disposed && generation === passGeneration;
    const run = async () => {
      do {
        reconcileDirty = false;
        if (!isCurrent()) return;
        await spawn.recoverState(isCurrent, abort.signal);
        if (!isCurrent()) return;
        deliverPending();
        kickCleanup();
      } while (reconcileDirty);
    };
    const current = run().finally(() => {
      if (reconcileAbort === abort) reconcileAbort = null;
      if (reconcileCurrent === current) reconcileCurrent = null;
    });
    reconcileCurrent = current;
    return current;
  };

  const assertActive = (): void => {
    if (disposed) throw new Error('worker supervisor is disposed');
  };

  const operationScope = () => {
    const passGeneration = generation;
    return {
      signal: operationAbort.signal,
      isCurrent: () => !disposed && generation === passGeneration,
    };
  };

  const api: NonNullable<SandboxDeps['worker']> = {
    async start(mindId, value) {
      assertActive();
      await reconcile();
      assertActive();
      return spawn.start(mindId, value, operationScope());
    },
    async send(ref, text) {
      assertActive();
      await reconcile();
      assertActive();
      const session = spawn.status(ref);
      return mailbox.sendToWorker(
        session.id,
        `dispatcher:${randomUUID()}`,
        text,
      );
    },
    async list() {
      assertActive();
      await reconcile();
      assertActive();
      return spawn.list();
    },
    async status(ref) {
      assertActive();
      await reconcile();
      assertActive();
      const session = spawn.status(ref);
      return {
        session,
        ...mandateFor(session.mindId),
        messages: publicMessages(session.id),
        artifacts: publicArtifacts(session.id),
      };
    },
    async followup(ref, text) {
      assertActive();
      await reconcile();
      assertActive();
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
      const finish = mailbox.finishFromWorker(prior.id);
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
      assertActive();
      const session = await spawn.start(
        prior.mindId,
        { modelRef: prior.modelRef },
        operationScope(),
      );
      return {
        continuity: 'fresh_same_mind' as const,
        priorSessionId: prior.id,
        mindId: prior.mindId,
        commentId: comment.id,
        session,
      };
    },
    async artifact(ref, key = 'workspace.patch.gz') {
      assertActive();
      await reconcile();
      assertActive();
      const session = spawn.status(ref);
      if (!workspace) throw new Error('worker artifact custody is unavailable');
      return workspace.artifactFile(session.id, key);
    },
    async dismiss(ref) {
      assertActive();
      return spawn.dismiss(ref, operationScope());
    },
  };

  const activate = async (
    deliver: (notice: WorkerTerminalNotice) => void,
  ): Promise<void> => {
    if (disposed) throw new Error('worker supervisor is disposed');
    if (deliverer) throw new Error('worker supervisor is already active');
    deliverer = deliver;
    provisioningUnsubscribe = spawn.onProvisioningSettled(() => {
      setImmediate(() => {
        void reconcile().catch((error) =>
          options.logger.warn(
            `worker provisioning reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    });
    finishUnsubscribe = mailbox.onFinish(() => {
      setImmediate(() => {
        if (disposed) return;
        try {
          deliverPending();
        } catch (error) {
          options.logger.warn(
            `worker completion delivery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        void reconcile().catch((error) =>
          options.logger.warn(
            `worker completion reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      });
    });
    try {
      deliverPending();
    } catch (error) {
      finishUnsubscribe();
      finishUnsubscribe = null;
      provisioningUnsubscribe();
      provisioningUnsubscribe = null;
      deliverer = null;
      throw error;
    }
    void reconcile().catch((error) =>
      options.logger.warn(
        `worker activation reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    if (disposed) return;
    const pollIntervalMs = options.pollIntervalMs ?? 5000;
    const armPoll = () => {
      if (disposed || pollIntervalMs <= 0) return;
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void reconcile()
          .catch((error) =>
            options.logger.warn(
              `worker completion reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
          .finally(armPoll);
      }, pollIntervalMs);
      pollTimer.unref();
    };
    armPoll();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    let revocationError: unknown;
    try {
      spawn.revokeProvisioning();
    } catch (error) {
      revocationError = error;
    } finally {
      operationAbort.abort(new Error('worker supervisor disposed'));
    }
    reconcileAbort?.abort(new Error('worker supervisor disposed'));
    reconcileAbort = null;
    cleanupAbort?.abort(new Error('worker supervisor disposed'));
    cleanupAbort = null;
    generation++;
    reconcileDirty = false;
    cleanupDirty = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    finishUnsubscribe?.();
    finishUnsubscribe = null;
    provisioningUnsubscribe?.();
    provisioningUnsubscribe = null;
    deliverer = null;
    claimed.clear();
    if (revocationError) throw revocationError;
  };

  options.logger.info('fixed-template Kubernetes worker supervisor ready');
  return { api, spawn, activate, reconcile, dispose };
}
