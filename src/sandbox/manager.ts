import type { ChatMessage } from '../llm/llm.js';
import type { Logger } from '../lib/log.js';
import type {
  RunResult,
  SandboxDeps,
  SandboxExecutionMetadata,
} from '../types.js';
import type { MindId } from '../store/mind-id.js';
import { createSandbox, type Sandbox } from './index.js';
import { transform } from './transform.js';
import type { SandboxRegistration, SandboxRegistry } from './registry.js';
import {
  adviseWake as chooseWakeAdvice,
  snapshotWakeAdvisorState,
  WAKE_ADVISOR_TIMEOUT_MS,
  type WakeAdvice,
  type WakeAdviceTurnContext,
} from './wake-advisor.js';

const CLASSIFIER_SOURCE_LIMIT = 8_000;
const CLASSIFIER_TIMEOUT_MS = 3_000;

export interface ManagedRunRequest {
  code: string;
  sandbox?: string;
}

export interface SandboxManagerOptions {
  deps: SandboxDeps;
  registry: SandboxRegistry;
  logger: Pick<Logger, 'debug' | 'warn'>;
  create?: typeof createSandbox;
  now?: () => number;
  coldStart?: boolean;
  classifierTimeoutMs?: number;
  wakeAdvisorTimeoutMs?: number;
}

type LiveContext = { sandbox: Sandbox; generation: number };
type DetachedOwner = { alias: string; runId: string };
type FutureSettlement = { rejected: boolean };

function cloneDeps(
  base: SandboxDeps,
  overrides: Partial<SandboxDeps>,
): SandboxDeps {
  const next = Object.create(Object.getPrototypeOf(base)) as SandboxDeps;
  Object.defineProperties(next, Object.getOwnPropertyDescriptors(base));
  Object.assign(next, overrides);
  return next;
}

function hasSubstance(code: string): boolean {
  return (
    code
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .trim() !== ''
  );
}

function mindState(
  deps: SandboxDeps,
  registration: SandboxRegistration,
): { title: string; status: string; latestComment: string | null } {
  const item = deps.mind?.get(registration.mindId) as
    | { title?: string; status?: string; comments?: Array<{ body?: string }> }
    | null
    | undefined;
  const latest = item?.comments?.at(-1)?.body;
  return {
    title: item?.title ?? `Mind #${registration.mindId}`,
    status: item?.status ?? 'unknown',
    latestComment:
      typeof latest === 'string' && latest ? latest.slice(0, 240) : null,
  };
}

export class SandboxManager {
  private readonly deps: SandboxDeps;
  private readonly registry: SandboxRegistry;
  private readonly logger: Pick<Logger, 'debug' | 'warn'>;
  private readonly create: typeof createSandbox;
  private readonly now: () => number;
  private readonly classifierTimeoutMs: number;
  private readonly wakeAdvisorTimeoutMs: number;
  private readonly contexts = new Map<string, LiveContext>();
  private readonly detached = new Map<string, DetachedOwner>();
  private readonly earlySettlements = new Map<string, FutureSettlement>();
  private readonly stopFutureTerminal: () => void;

  constructor(options: SandboxManagerOptions) {
    this.deps = options.deps;
    this.registry = options.registry;
    this.logger = options.logger;
    this.create = options.create ?? createSandbox;
    this.now = options.now ?? Date.now;
    this.classifierTimeoutMs =
      options.classifierTimeoutMs ?? CLASSIFIER_TIMEOUT_MS;
    this.wakeAdvisorTimeoutMs =
      options.wakeAdvisorTimeoutMs ?? WAKE_ADVISOR_TIMEOUT_MS;
    this.stopFutureTerminal =
      this.deps.bg?.onFutureTerminal((id) => {
        if (this.detached.has(id)) this.settleDetached(id, true);
      }) ?? (() => {});
    if (options.coldStart !== false) {
      const reset = this.registry.coldResetAll();
      if (reset > 0)
        this.logger.warn(
          `sandbox manager: ${reset} persistent sandbox generation(s) reset after cold process start`,
        );
    }
  }

  ensurePersistent(mindId: MindId): SandboxRegistration {
    return this.registry.ensureForMind(mindId);
  }

  list(): SandboxRegistration[] {
    return this.registry.list();
  }

  get(id: string): SandboxRegistration {
    return this.registry.get(id);
  }

  getByMind(mindId: MindId): SandboxRegistration | null {
    return this.registry.getByMind(mindId);
  }

  async adviseWake(
    turn: WakeAdviceTurnContext,
    history: ChatMessage[] = [],
  ): Promise<WakeAdvice> {
    const state = snapshotWakeAdvisorState(this.deps, turn, this.now());
    return chooseWakeAdvice(
      this.deps,
      state,
      this.logger,
      this.wakeAdvisorTimeoutMs,
      history,
    );
  }

  handleMindStateChange(
    mindId: MindId,
    status: string,
    archived: boolean,
  ): void {
    if (archived || status === 'done' || status === 'cancelled') {
      const registration = this.registry.retireByMind(mindId);
      if (registration) this.finalizeExpired(registration);
      this.registry.clearReminderByMind(mindId);
      return;
    }
    const registration = this.registry.getByMind(mindId);
    if (registration?.retireRequested) {
      const deadline = this.retirementDeadline(registration);
      if (deadline !== null && deadline <= this.now()) {
        this.finalizeExpired(registration);
        return;
      }
    }
    this.registry.cancelRetirement(mindId);
    if (status !== 'in_progress') this.registry.clearReminderByMind(mindId);
  }

  private retirementDeadline(registration: SandboxRegistration): number | null {
    if (!registration.retireRequested) return null;
    if (registration.retireRequestedAt === null) {
      throw new Error(
        `sandbox manager: retiring sandbox ${registration.id} has no retirement timestamp`,
      );
    }
    return (
      registration.retireRequestedAt +
      this.deps.config.sandbox.persistentRetirementGraceMs
    );
  }

  private finalizeExpired(registration: SandboxRegistration): boolean {
    const deadline = this.retirementDeadline(registration);
    if (
      registration.lifecycle !== 'ready' ||
      deadline === null ||
      deadline > this.now()
    )
      return false;
    const retired = this.registry.finalizeRetirement(registration.id, {
      expired: true,
    });
    if (retired.lifecycle !== 'retired') return false;
    this.contexts.delete(registration.id);
    return true;
  }

  collectGarbage(): string[] {
    const collected: string[] = [];
    for (const registration of this.registry.list()) {
      if (!this.finalizeExpired(registration)) continue;
      collected.push(registration.id);
    }
    return collected;
  }

  dispose(): void {
    this.stopFutureTerminal();
    this.contexts.clear();
    this.detached.clear();
    this.earlySettlements.clear();
  }

  async run(request: ManagedRunRequest): Promise<RunResult> {
    try {
      this.collectGarbage();
      if (!request || typeof request.code !== 'string')
        throw new Error('sandbox manager: run requires string code');
      if (request.sandbox === undefined)
        return await this.runEphemeral(request.code);
      return await this.runPersistent(request.sandbox, request.code);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async runEphemeral(code: string): Promise<RunResult> {
    const classification = hasSubstance(code)
      ? this.classify(code)
      : Promise.resolve(false);
    const sandbox = this.create(
      cloneDeps(this.deps, {
        surface: 'core',
        mindDefaultId: undefined,
      }),
    );
    const result = await sandbox.run(code);
    const remind = await classification;
    result.execution = {
      kind: 'ephemeral',
      lifecycle: 'ephemeral',
      classifierReminder: remind,
    };
    return result;
  }

  private async runPersistent(
    selector: string,
    code: string,
  ): Promise<RunResult> {
    if (typeof selector !== 'string' || !selector.trim())
      throw new Error(
        'sandbox manager: persistent selector must be a Mind id, unique prefix, or exact title',
      );
    const parsed = transform(code);
    if (!parsed.parsed)
      return {
        ok: false,
        failureKind: 'preparse',
        error: `SyntaxError (pre-parse): ${parsed.error}\nNothing in this program executed — no sandbox was created. Fix and re-run the whole batch.`,
      };
    if (!this.deps.mind)
      throw new Error('sandbox manager: Mind service is unavailable');
    const mindId = this.deps.mind.resolve(selector);
    const existing = this.registry.getByMind(mindId);
    const before = existing ?? this.registry.ensureForMind(mindId);
    const created = existing === null;
    if (before.lifecycle === 'detached') {
      const future = Array.from(this.detached.entries()).find(
        ([, owner]) => owner.alias === mindId,
      )?.[0];
      throw new Error(
        `sandbox manager: ${mindId} is detached${future ? ` as bg future ${future}` : ''}`,
      );
    }
    const mind = mindState(this.deps, before);
    const run = this.registry.beginRun(mindId);
    const alias = mindId;
    const retirementDeadlineAt =
      this.retirementDeadline(run.sandbox) ?? undefined;
    if (
      retirementDeadlineAt !== undefined &&
      retirementDeadlineAt <= this.now()
    ) {
      const ready = this.registry.finishRun(alias, run.runId);
      this.finalizeExpired(ready);
      throw new Error(
        `sandbox manager: ${alias} retired after its closed Mind grace period`,
      );
    }
    const coldStart =
      run.sandbox.coldNoticePending && this.registry.consumeColdNotice(alias);
    const statusReminder =
      mind.status === 'open' &&
      !run.sandbox.reminderLatched &&
      this.registry.latchReminder(alias);
    const execution: SandboxExecutionMetadata = {
      kind: 'persistent',
      alias,
      mindId: run.sandbox.mindId,
      mindTitle: mind.title,
      mindStatus: mind.status,
      latestComment: mind.latestComment,
      executorId: run.sandbox.executorId,
      generation: run.sandbox.generation,
      runId: run.runId,
      coldStart,
      created,
      retiring: run.sandbox.retireRequested,
      retirementDeadlineAt,
      retirementWarning:
        retirementDeadlineAt === undefined
          ? undefined
          : `Mind #${run.sandbox.mindId} is closed; sandbox ${alias} retires at ${new Date(retirementDeadlineAt).toISOString()}. Select or create a sandbox bound to active work.`,
      statusReminder,
      lifecycle: 'busy',
    };

    let result: RunResult;
    try {
      result = await this.context(alias, run.sandbox).run(code, {
        runId: run.runId,
      });
    } catch (error) {
      const reset = this.registry.failRunAndReset(alias, run.runId);
      this.contexts.delete(alias);
      execution.resetGeneration = reset.generation;
      execution.lifecycle = this.finalizeExpired(reset) ? 'retired' : 'reset';
      return {
        ok: false,
        failureKind: 'runtime',
        error: error instanceof Error ? error.message : String(error),
        execution,
      };
    }

    if (result.detached) {
      if (!result.bgId) {
        const reset = this.registry.failRunAndReset(alias, run.runId);
        this.contexts.delete(alias);
        execution.resetGeneration = reset.generation;
        execution.lifecycle = this.finalizeExpired(reset) ? 'retired' : 'reset';
        result.ok = false;
        result.detached = false;
        result.failureKind = 'runtime';
        result.error =
          'persistent sandbox detached without a background-future registry; generation reset';
        delete result.note;
      } else {
        this.registry.detachRun(alias, run.runId);
        execution.lifecycle = 'detached';
        this.detached.set(result.bgId, { alias, runId: run.runId });
        const early = this.earlySettlements.get(result.bgId);
        if (early) {
          this.earlySettlements.delete(result.bgId);
          this.settleDetached(result.bgId, early.rejected);
        }
      }
    } else if (!result.ok && result.failureKind === 'runtime') {
      const reset = this.registry.failRunAndReset(alias, run.runId);
      this.contexts.delete(alias);
      execution.resetGeneration = reset.generation;
      execution.lifecycle = this.finalizeExpired(reset) ? 'retired' : 'reset';
    } else {
      const finished = this.registry.finishRun(alias, run.runId);
      execution.lifecycle = this.finalizeExpired(finished)
        ? 'retired'
        : 'ready';
    }

    result.execution = execution;
    return result;
  }

  private context(alias: string, registration: SandboxRegistration): Sandbox {
    const existing = this.contexts.get(alias);
    if (existing?.generation === registration.generation)
      return existing.sandbox;
    const notify = this.deps.onFutureSettled;
    const notifyLate = this.deps.onLateProcessError;
    const sandbox = this.create(
      cloneDeps(this.deps, {
        surface: 'full',
        mindDefaultId: registration.mindId,
        onFutureSettled: (id, value, rejected, logs, sends) => {
          if (this.detached.has(id)) this.settleDetached(id, rejected);
          else this.earlySettlements.set(id, { rejected });
          notify?.(id, value, rejected, logs, sends);
        },
        onLateProcessError: notifyLate
          ? (event) =>
              notifyLate({
                ...event,
                alias,
                generation: registration.generation,
              })
          : undefined,
      }),
    );
    this.contexts.set(alias, { sandbox, generation: registration.generation });
    return sandbox;
  }

  private settleDetached(bgId: string, rejected: boolean): void {
    const owner = this.detached.get(bgId);
    if (!owner) return;
    this.detached.delete(bgId);
    if (rejected) {
      const reset = this.registry.failRunAndReset(owner.alias, owner.runId);
      this.contexts.delete(owner.alias);
      this.finalizeExpired(reset);
    } else {
      this.finalizeExpired(this.registry.finishRun(owner.alias, owner.runId));
    }
  }

  private async classify(code: string): Promise<boolean> {
    if (!this.deps.completeStandalone) return false;
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new Error(`classifier timeout after ${this.classifierTimeoutMs}ms`),
        );
      }, this.classifierTimeoutMs);
    });
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'Decide whether this JavaScript likely needs persistent cross-run JS state or host-local tools unavailable in a core ephemeral sandbox. Answer exactly YES or NO. Do not explain.',
      },
      { role: 'user', content: code.slice(0, CLASSIFIER_SOURCE_LIMIT) },
    ];
    try {
      const completion = await Promise.race([
        this.deps.completeStandalone(messages, { signal: controller.signal }),
        timeout,
      ]);
      const answer = completion.content.trim();
      if (answer === 'YES') return true;
      if (answer === 'NO') return false;
      this.logger.warn(
        `sandbox classifier: ignored nonconforming ${answer.length}-character response`,
      );
      return false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.debug(
        `sandbox classifier unavailable: ${message.slice(0, 200)}`,
      );
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function createSandboxManager(
  options: SandboxManagerOptions,
): SandboxManager {
  return new SandboxManager(options);
}
