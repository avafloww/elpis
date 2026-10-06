import type { InboundMessage } from '../agent.js';
import {
  configForLlmRole,
  isResolvedGatewayConfig,
  type MaterializedConfig,
} from '../config.js';
import { createBranchId, type BranchId } from '../context-graph.js';
import type { LLM } from '../llm/llm.js';
import type { ChannelDirectory } from '../store/channels.js';
import type { MuteStore } from '../store/mutes.js';

import type {
  ActiveSocialInboundRecord,
  ContextGraphStore,
  ExactIsolatedProviderTargetV1,
} from '../store/context-graph.js';
import {
  createActiveHomeTextOrchestrator,
  type ActiveHomeTextOrchestrationResult,
} from './home-text-orchestrator.js';
import { createActiveHomeDiscordTextExecutor } from './home-discord-text-executor.js';
import {
  createHomeDiscordTextTransport,
  type HomeDiscordTextTransport,
} from './home-discord-text-transport.js';
import { createIsolatedProviderExecutor } from './isolated-provider-executor.js';
import { exactMainIsolatedProviderTarget } from './resident-isolated-provider-binding.js';
import { encodeSocialInboundGraph } from './social-inbound.js';

export interface ActiveHomeRuntimeOptions {
  readonly store: ContextGraphStore;
  readonly target: ExactIsolatedProviderTargetV1;
  readonly orchestrate: () => Promise<ActiveHomeTextOrchestrationResult>;
  readonly now?: () => number;
  readonly createBranchId?: () => BranchId;
  /** Receives background drain failures. Persistence failures are still thrown. */
  readonly onDrainError?: (error: unknown) => void;
}

/**
 * Serializes active-home assembly and execution while social ingress remains a
 * synchronous durable append. A failed drain is fail-closed; a later ingress
 * or explicit drain starts a new attempt from durable state.
 */
export class ActiveHomeRuntimeController {
  private tail: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly nextBranchId: () => BranchId;

  constructor(private readonly options: ActiveHomeRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.nextBranchId = options.createBranchId ?? createBranchId;
  }

  recordInbound(message: InboundMessage): ActiveSocialInboundRecord {
    const kind = message.kind ?? 'discord';
    if (kind !== 'discord' && kind !== 'signal') {
      throw new Error('active home runtime accepts only social ingress');
    }
    const encoded = encodeSocialInboundGraph(message);
    const existingEvent = this.options.store.getWorldEvent(encoded.eventId);
    const existingAdmission = existingEvent
      ? this.options.store.getActiveHomeIngressAdmission(encoded.eventId)
      : null;
    const recordedAt = existingEvent?.recordedAt ?? this.now();
    const admittedAt = existingAdmission?.admittedAt ?? recordedAt;
    const recorded = this.options.store.recordActiveSocialInbound({
      eventId: encoded.eventId,
      worldId: encoded.worldId,
      kind: `inbound:${kind}`,
      payload: encoded.payload,
      occurredAt: encoded.occurredAt,
      recordedAt,
      admittedAt,
    });
    this.requestDrain();
    return recorded;
  }

  /** Reconcile only an already-assembled invocation before generic recovery. */
  reconcile(): Promise<void> {
    return this.request(() => this.reconcileDurableInvocation());
  }

  /** Schedule a serialized durable drain, suitable for boot recovery. */
  drain(): Promise<void> {
    return this.request(() => this.drainDurableState());
  }

  /** Observe the currently scheduled drain without scheduling another one. */
  whenIdle(): Promise<void> {
    return this.tail;
  }

  private request(taskBody: () => Promise<void>): Promise<void> {
    const task = this.tail.catch(() => undefined).then(taskBody);
    this.tail = task;
    void task.catch((error: unknown) => this.options.onDrainError?.(error));
    return task;
  }

  private requestDrain(): Promise<void> {
    return this.request(() => this.drainDurableState());
  }

  private async reconcileDurableInvocation(): Promise<void> {
    for (;;) {
      const active = this.options.store.getActiveHomeProviderTextInvocation();
      if (!active) return;
      const result = await this.options.orchestrate();
      if (result.state === 'not_authorized') {
        throw new Error('active home orchestration lost its authorization');
      }
      const remaining =
        this.options.store.getActiveHomeProviderTextInvocation();
      if (
        remaining?.invocation.invocationId === active.invocation.invocationId
      ) {
        throw new Error('active home orchestration did not settle its branch');
      }
    }
  }

  private async drainDurableState(): Promise<void> {
    await this.reconcileDurableInvocation();
    for (;;) {
      const ingress =
        this.options.store.getOldestPendingActiveHomeIngressAdmission();
      if (!ingress) return;
      const activation = this.options.store.getActivationState();
      const scope = this.options.store.getHomeTextActivationScope();
      const head = this.options.store.getContinuationHead();
      if (
        activation.mode !== 'active' ||
        !scope ||
        activation.epoch !== scope.scope.activeActivationEpoch ||
        ingress.activeActivationEpoch !== activation.epoch ||
        ingress.activationScopeHash !== scope.scopeHash
      ) {
        throw new Error('active home runtime authority is not current');
      }
      this.options.store.assembleActiveHomeRequest({
        ingressEventId: ingress.eventId,
        ingressSourceSequence: ingress.sourceSequence,
        branchId: this.nextBranchId(),
        target: this.options.target,
        expectedActiveActivationEpoch: activation.epoch,
        expectedActivationScopeHash: scope.scopeHash,
        expectedHeadRevision: head.revision,
        admittedAt: this.now(),
      });
      const result = await this.options.orchestrate();
      if (result.state === 'not_authorized') {
        throw new Error('assembled active home request was not authorized');
      }
    }
  }
}

export function createActiveHomeRuntimeController(
  options: ActiveHomeRuntimeOptions,
): ActiveHomeRuntimeController {
  return new ActiveHomeRuntimeController(options);
}

export async function recoverAndDrainActiveHomeRuntime(input: {
  readonly store: ContextGraphStore;
  readonly controller: Pick<ActiveHomeRuntimeController, 'reconcile' | 'drain'>;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}): Promise<void> {
  await input.controller.reconcile();
  const recoveredAt = (input.now ?? Date.now)();
  const recoveredBranch = input.store.recoverCoordinatedBranch(recoveredAt);
  if (recoveredBranch) {
    input.warn?.(
      `recovered crashed context branch ${recoveredBranch.branchId}; ` +
        `${recoveredBranch.uncertainEffects} effect(s) remain uncertain`,
    );
  }
  const orphanedEffects = input.store.recoverPreparedEffects(recoveredAt);
  if (orphanedEffects.length > 0) {
    input.warn?.(
      `recovered ${orphanedEffects.length} orphaned context effect(s) as uncertain`,
    );
  }
  await input.controller.drain();
}

export function createActiveHomeSendAuthorizer(options: {
  readonly mutes?: Pick<MuteStore, 'get'>;
  readonly channels?: Pick<ChannelDirectory, 'parentOf'>;
}): (channelId: string) => void {
  return (channelId) => {
    const parentId = options.channels?.parentOf(channelId) ?? null;
    if (
      options.mutes?.get(channelId) ||
      (parentId !== null && options.mutes?.get(parentId))
    ) {
      throw new Error('active home channel is muted');
    }
  };
}

export interface ConfiguredActiveHomeRuntimeOptions {
  readonly store: ContextGraphStore;
  readonly config: MaterializedConfig;
  readonly llm: LLM;
  readonly transport?: HomeDiscordTextTransport;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly mutes?: Pick<MuteStore, 'get'>;
  readonly channels?: Pick<ChannelDirectory, 'parentOf'>;
  readonly onDrainError?: (error: unknown) => void;
}

export function createConfiguredActiveHomeRuntimeController(
  options: ConfiguredActiveHomeRuntimeOptions,
): ActiveHomeRuntimeController {
  const scope = options.store.getHomeTextActivationScope();
  if (!scope)
    throw new Error('active context graph has no home text activation scope');
  if (isResolvedGatewayConfig(options.config)) {
    throw new Error('active home runtime requires a direct main provider');
  }
  const target = exactMainIsolatedProviderTarget(options.config);
  if (
    target.gateway !== null ||
    target.providerType !== 'codex-oauth' ||
    target.apiSurface !== 'codex-responses'
  ) {
    throw new Error('active home runtime requires direct Codex Responses');
  }
  const mainConfig = configForLlmRole(options.config, 'main');
  const direct = mainConfig.llm;
  if (!('callTimeoutMs' in direct)) {
    throw new Error('active home runtime has no direct provider timeout');
  }
  const authorizeSend = createActiveHomeSendAuthorizer(options);
  const transport =
    options.transport ??
    createHomeDiscordTextTransport({
      botToken: options.config.discord.botToken,
      callTimeoutMs: direct.callTimeoutMs,
      fetchImpl: options.fetchImpl,
      now: options.now,
      authorize: (request) => authorizeSend(request.channelId),
    });
  const executeProvider = createIsolatedProviderExecutor({
    store: options.store,
    config: options.config,
    llm: options.llm,
    expectedWorldId: scope.scope.worldId,
    maxOutputBytes: scope.scope.maxOutputBytes,
    now: options.now,
  });
  const executeSpeech = createActiveHomeDiscordTextExecutor({
    store: options.store,
    transport,
    now: options.now,
  });
  const orchestrate = createActiveHomeTextOrchestrator({
    store: options.store,
    executeProvider,
    executeSpeech,
    now: options.now,
  });
  return createActiveHomeRuntimeController({
    store: options.store,
    target,
    orchestrate,
    now: options.now,
    onDrainError: options.onDrainError,
  });
}
