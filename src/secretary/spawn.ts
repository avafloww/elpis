import type { Config } from '../config.js';
import type { Database } from '../store/db.js';
import type { MindId } from '../store/mind-id.js';
import {
  SecretarySessionError,
  SecretarySessionStore,
  type SecretarySession,
} from './session.js';

export interface SecretaryProvisionRequest {
  sessionId: string;
  hintMindId: MindId | null;
  modelRef: string;
  token: string;
}

export interface SecretaryProvisionReceipt {
  podName: string;
  podUid: string;
}

export type SecretaryProvisionState =
  | { state: 'pending' }
  | { state: 'ready'; receipt: SecretaryProvisionReceipt }
  | { state: 'failed'; error?: string }
  | { state: 'missing' };

export interface SecretaryPodRuntime {
  provision(
    request: SecretaryProvisionRequest,
  ): Promise<SecretaryProvisionReceipt>;
  inspect(session: SecretarySession): Promise<SecretaryProvisionState>;
  cleanup(session: SecretarySession): Promise<void>;
}

export class SecretarySpawnError extends Error {
  constructor(
    public readonly code:
      | 'unavailable'
      | 'conflict'
      | 'not_found'
      | 'provision_failed'
      | 'cleanup_failed',
    message: string,
  ) {
    super(message);
    this.name = 'SecretarySpawnError';
  }
}

export interface SecretarySpawnBrokerOptions {
  db: Database;
  config: Config;
  runtime: SecretaryPodRuntime;
  store?: SecretarySessionStore;
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    1000,
  );
}

function validateReceipt(receipt: SecretaryProvisionReceipt): void {
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.podName !== 'string' ||
    receipt.podName.length < 1 ||
    receipt.podName.length > 253 ||
    typeof receipt.podUid !== 'string' ||
    receipt.podUid.length < 1 ||
    receipt.podUid.length > 128
  )
    throw new Error('secretary runtime returned an invalid Pod identity');
}

export class SecretarySpawnBroker {
  private readonly store: SecretarySessionStore;
  private startTail: Promise<void> = Promise.resolve();
  private reconcileTail: Promise<SecretarySession[]> = Promise.resolve([]);

  constructor(private readonly options: SecretarySpawnBrokerOptions) {
    this.store = options.store ?? new SecretarySessionStore({ db: options.db });
  }

  list(): SecretarySession[] {
    return this.store.list();
  }

  status(sessionId: string): SecretarySession {
    const session = this.store.get(sessionId);
    if (!session)
      throw new SecretarySpawnError(
        'not_found',
        'secretary session is unavailable',
      );
    return session;
  }

  start(hintMindId: MindId | null = null): Promise<SecretarySession> {
    const run = this.startTail.then(() => this.startInside(hintMindId));
    this.startTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startInside(
    hintMindId: MindId | null,
  ): Promise<SecretarySession> {
    if (!this.options.config.secretary.enabled)
      throw new SecretarySpawnError(
        'unavailable',
        'secretary runtime is disabled',
      );
    const modelRef = this.options.config.llm.registry.roles.secretary;
    if (!modelRef)
      throw new SecretarySpawnError(
        'unavailable',
        'llm.roles.secretary is not configured',
      );
    const active = this.store
      .list()
      .filter(
        (session) =>
          session.status === 'starting' || session.status === 'ready',
      );
    if (active.length >= this.options.config.secretary.maxConcurrent)
      throw new SecretarySpawnError(
        'conflict',
        'secretary session capacity is exhausted',
      );

    const created = this.store.create(hintMindId, modelRef);
    try {
      const receipt = await this.options.runtime.provision({
        sessionId: created.session.id,
        hintMindId,
        modelRef,
        token: created.token,
      });
      validateReceipt(receipt);
      return this.store.ready(created.session.id, receipt);
    } catch (error) {
      const failed = this.store.fail(created.session.id, error);
      await this.cleanupBestEffort(failed);
      if (error instanceof SecretarySessionError) throw error;
      throw new SecretarySpawnError('provision_failed', boundedError(error));
    }
  }

  async close(sessionId: string): Promise<SecretarySession> {
    const current = this.status(sessionId);
    const closed =
      current.status === 'failed' || current.status === 'closed'
        ? current
        : this.store.close(sessionId);
    try {
      await this.options.runtime.cleanup(closed);
    } catch (error) {
      throw new SecretarySpawnError('cleanup_failed', boundedError(error));
    }
    return closed;
  }

  async recover(): Promise<SecretarySession[]> {
    return this.inspectActive(true);
  }

  reconcile(): Promise<SecretarySession[]> {
    const run = this.reconcileTail.then(() => this.inspectActive(false));
    this.reconcileTail = run.then(
      () => this.store.list(),
      () => this.store.list(),
    );
    return run;
  }

  private active(
    sessionId: string,
    includeStarting: boolean,
  ): SecretarySession | null {
    const current = this.store.get(sessionId);
    if (!current) return null;
    if (current.status === 'ready') return current;
    return includeStarting && current.status === 'starting' ? current : null;
  }

  private async inspectActive(
    includeStarting: boolean,
  ): Promise<SecretarySession[]> {
    for (const session of this.store.list()) {
      if (!this.active(session.id, includeStarting)) continue;
      let state: SecretaryProvisionState;
      try {
        state = await this.options.runtime.inspect(session);
      } catch (error) {
        const current = this.active(session.id, includeStarting);
        if (current) {
          const failed = this.store.fail(current.id, error);
          await this.cleanupBestEffort(failed);
        }
        continue;
      }
      if (state.state === 'pending') continue;
      if (state.state === 'ready') {
        try {
          validateReceipt(state.receipt);
          const current = this.active(session.id, includeStarting);
          if (!current) continue;
          if (current.status === 'starting') {
            this.store.ready(current.id, state.receipt);
            continue;
          }
          if (
            current.podName === state.receipt.podName &&
            current.podUid === state.receipt.podUid
          )
            continue;
          const failed = this.store.fail(
            current.id,
            'secretary Pod identity changed',
          );
          await this.cleanupBestEffort(failed);
        } catch (error) {
          const current = this.active(session.id, includeStarting);
          if (current) {
            const failed = this.store.fail(current.id, error);
            await this.cleanupBestEffort(failed);
          }
        }
        continue;
      }
      const current = this.active(session.id, includeStarting);
      if (!current) continue;
      const failed = this.store.fail(
        current.id,
        state.state === 'failed'
          ? (state.error ?? 'secretary Pod failed')
          : 'secretary Pod is missing',
      );
      await this.cleanupBestEffort(failed);
    }
    return this.store.list();
  }

  private async cleanupBestEffort(session: SecretarySession): Promise<void> {
    try {
      await this.options.runtime.cleanup(session);
    } catch {
      // The terminal session remains revoked; later recovery may retry cleanup.
    }
  }
}
