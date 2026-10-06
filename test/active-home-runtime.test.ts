import assert from 'node:assert/strict';
import test from 'node:test';

import type { InboundMessage } from '../src/agent.js';
import type { MaterializedConfig } from '../src/config.js';
import { legacyLlmModelRegistry } from '../src/llm/model-registry.js';

import { activeHomeIngressContent } from '../src/context/active-home-ingress.js';
import {
  ActiveHomeRuntimeController,
  createActiveHomeRuntimeController,
  createActiveHomeSendAuthorizer,
  createConfiguredActiveHomeRuntimeController,
  recoverAndDrainActiveHomeRuntime,
} from '../src/context/active-home-runtime.js';

import type { ActiveHomeTextOrchestrationResult } from '../src/context/home-text-orchestrator.js';
import {
  branchId,
  type ActiveHomeIngressAdmissionRecord,
  type ContextGraphStore,
  type ExactIsolatedProviderTargetV1,
} from '../src/store/context-graph.js';
import { makeConfig, makeStubLLM } from './helpers.js';

const target: ExactIsolatedProviderTargetV1 = {
  schemaVersion: 1,
  role: 'main',
  targetRef: 'codex/test',
  providerType: 'codex-oauth',
  model: 'test',
  apiSurface: 'codex-responses',
  apiEndpoint: 'https://example.invalid/responses',
  gateway: null,
  reasoningEffort: null,
  reasoningSummary: null,
  reasoningContext: null,
  externalThinking: false,
  toolContractVersion: 'test-v1',
  wireContractGeneration: 1,
};

test('active home send authority inherits a known thread parent mute', () => {
  const authorize = createActiveHomeSendAuthorizer({
    mutes: {
      get: (channelId) =>
        channelId === 'parent-channel'
          ? {
              channelId,
              type: 'deafen',
              setBy: 'operator',
              reason: null,
              createdAt: '2026-01-02T03:04:05.000Z',
            }
          : null,
    },
    channels: {
      parentOf: (channelId) =>
        channelId === 'thread-channel' ? 'parent-channel' : null,
    },
  });

  assert.throws(
    () => authorize('thread-channel'),
    /active home channel is muted/,
  );
  assert.doesNotThrow(() => authorize('ordinary-channel'));
});

function codexConfig(): MaterializedConfig {
  const base = makeConfig();
  const llm = {
    ...base.llm,
    providerType: 'codex-oauth' as const,
    apiKey: '',
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-test-codex',
    api: 'responses' as const,
  };
  return {
    ...base,
    llm: {
      ...llm,
      registrySource: 'legacy',
      registry: legacyLlmModelRegistry(llm, { motorEnabled: false }),
    },
  } as MaterializedConfig;
}

function inbound(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'message-home',
    channelId: 'channel-home',
    channelName: 'home',
    guildId: 'guild-home',
    author: 'Bramble',
    authorId: 'person-1',
    content: 'hello',
    createdAt: '2026-01-02T03:04:05.000Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    kind: 'discord',
    ...overrides,
  };
}

function runtimeFixture() {
  let sequence = 0;
  let revision = 0;
  let active: any = null;
  const events: any[] = [];
  const admissions: ActiveHomeIngressAdmissionRecord[] = [];
  const admissionByEvent = new Map<string, ActiveHomeIngressAdmissionRecord>();
  const assembled: string[] = [];
  const scope = {
    scope: {
      schemaVersion: 1,
      scopeKind: 'home_discord_text',
      sourceActivationEpoch: 0,
      activeActivationEpoch: 1,
      worldId: 'world:discord:guild:guild-home',
      guildId: 'guild-home',
      channelId: 'channel-home',
      transport: 'discord',
      maxOutputBytes: 1900,
      authorizedAt: 1,
    },
    scopeJson: '{}',
    scopeHash: 'a'.repeat(64),
  } as const;
  const fake = {
    getWorldEvent(id: string) {
      return events.find((event) => event.eventId === id) ?? null;
    },
    getActiveHomeIngressAdmission(id: string) {
      return admissionByEvent.get(id) ?? null;
    },
    recordActiveSocialInbound(input: any) {
      const prior = this.getWorldEvent(input.eventId);
      if (prior) {
        return {
          event: prior,
          projection: admissionByEvent.has(input.eventId) ? {} : null,
          admission: admissionByEvent.get(input.eventId) ?? null,
        };
      }
      const event = {
        eventId: input.eventId,
        worldId: input.worldId,
        sequence: ++sequence,
        kind: input.kind,
        payloadJson: JSON.stringify(input.payload),
        payloadHash: 'b'.repeat(64),
        occurredAt: input.occurredAt,
        recordedAt: input.recordedAt,
      };
      events.push(event);
      const content = activeHomeIngressContent({
        eventKind: input.kind,
        eventWorldId: input.worldId,
        payload: input.payload,
        scope: scope.scope,
      });
      if (content === null) {
        return { event, projection: null, admission: null };
      }
      const admission = {
        eventId: input.eventId,
        worldId: input.worldId,
        sourceSequence: event.sequence,
        activeActivationEpoch: 1,
        activationScopeHash: scope.scopeHash,
        projectionId: `event-message:test-${event.sequence}`,
        rendererGeneration: 1,
        admittedAt: input.admittedAt,
      } as ActiveHomeIngressAdmissionRecord;
      admissions.push(admission);
      admissionByEvent.set(input.eventId, admission);
      return { event, projection: {}, admission };
    },
    getOldestPendingActiveHomeIngressAdmission() {
      return (
        admissions.find((item) => !assembled.includes(item.eventId)) ?? null
      );
    },
    getActivationState() {
      return { mode: 'active', epoch: 1, updatedAt: 1 };
    },
    getHomeTextActivationScope() {
      return scope;
    },
    getContinuationHead() {
      return { branchId: null, worldId: null, revision, updatedAt: 1 };
    },
    assembleActiveHomeRequest(input: any) {
      assembled.push(input.ingressEventId);
      active = {
        invocation: {
          invocationId: `active-home-provider-invocation:test-${assembled.length}`,
          admission: { ingressEventId: input.ingressEventId },
        },
      };
      return active.invocation;
    },
    getActiveHomeProviderTextInvocation() {
      return active;
    },
  };
  return {
    store: fake as unknown as ContextGraphStore,
    events,
    admissions,
    assembled,
    seedPending(eventIdentity = 'event:pending-before-crash') {
      const admission = {
        eventId: eventIdentity,
        worldId: scope.scope.worldId,
        sourceSequence: ++sequence,
        activeActivationEpoch: 1,
        activationScopeHash: scope.scopeHash,
        projectionId: `event-message:test-${sequence}`,
        rendererGeneration: 1,
        admittedAt: 2,
      } as ActiveHomeIngressAdmissionRecord;
      admissions.push(admission);
      admissionByEvent.set(eventIdentity, admission);
      return admission;
    },
    installCrashedInvocation() {
      active = {
        invocation: {
          invocationId: 'active-home-provider-invocation:crashed',
          admission: { ingressEventId: 'event:crashed' },
        },
      };
    },
    settle() {
      active = null;
      revision += 1;
    },
  };
}

test('configured active runtime requires direct Codex and binds the exact home scope', () => {
  const fixture = runtimeFixture();
  assert.throws(
    () =>
      createConfiguredActiveHomeRuntimeController({
        store: fixture.store,
        config: makeConfig() as MaterializedConfig,
        llm: makeStubLLM(),
      }),
    /requires direct Codex Responses/,
  );

  const config = codexConfig();
  const controller = createConfiguredActiveHomeRuntimeController({
    store: fixture.store,
    config,
    llm: makeStubLLM({ model: config.llm.model }),
    transport: {
      async send() {
        throw new Error('transport must remain idle during construction');
      },
    },
  });
  assert.ok(controller instanceof ActiveHomeRuntimeController);
});

test('active boot reconciles provider and speech before generic recovery and admission drain', async () => {
  const order: string[] = [];
  const warnings: string[] = [];
  const store = {
    recoverCoordinatedBranch(recoveredAt: number) {
      order.push(`branch:${recoveredAt}`);
      return { branchId: 'branch:crashed', uncertainEffects: 1 };
    },
    recoverPreparedEffects(recoveredAt: number) {
      order.push(`effects:${recoveredAt}`);
      return ['effect:orphaned'];
    },
  } as unknown as ContextGraphStore;
  await recoverAndDrainActiveHomeRuntime({
    store,
    controller: {
      async reconcile() {
        order.push('reconcile');
      },
      async drain() {
        order.push('drain');
      },
    },
    now: () => 44,
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(order, ['reconcile', 'branch:44', 'effects:44', 'drain']);
  assert.equal(warnings.length, 2);
});

function observed(): ActiveHomeTextOrchestrationResult {
  return {
    state: 'observed',
    invocationId: 'active-home-provider-invocation:test',
    attemptId: 'isolated-provider-attempt:test',
    speechAttemptId: 'home-text-speech:test',
  } as ActiveHomeTextOrchestrationResult;
}

test('active runtime admits only home Discord while durably queueing foreign and Signal ingress', async () => {
  const fixture = runtimeFixture();
  const controller = createActiveHomeRuntimeController({
    store: fixture.store,
    target,
    now: () => Date.parse('2026-01-02T03:04:06.000Z'),
    createBranchId: () => branchId('branch:runtime-home'),
    orchestrate: async () => {
      fixture.settle();
      return observed();
    },
  });

  const home = controller.recordInbound(inbound());
  const foreign = controller.recordInbound(
    inbound({ id: 'message-foreign', guildId: 'guild-foreign' }),
  );
  const signal = controller.recordInbound(
    inbound({
      id: 'message-signal',
      kind: 'signal',
      transport: 'signal',
      channelId: 'signal:contact:1',
      guildId: null,
    }),
  );
  await controller.whenIdle();

  assert.ok(home.admission);
  assert.equal(foreign.admission, null);
  assert.equal(signal.admission, null);
  assert.equal(fixture.events.length, 3);
  assert.deepEqual(fixture.assembled, [home.event.eventId]);
});

test('active runtime drains oldest-first with no concurrent orchestration', async () => {
  const fixture = runtimeFixture();
  let running = 0;
  let maximumRunning = 0;
  const controller = createActiveHomeRuntimeController({
    store: fixture.store,
    target,
    now: () => Date.parse('2026-01-02T03:04:06.000Z'),
    createBranchId: (() => {
      let id = 0;
      return () => branchId(`branch:runtime-${++id}`);
    })(),
    orchestrate: async () => {
      running += 1;
      maximumRunning = Math.max(maximumRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      fixture.settle();
      running -= 1;
      return observed();
    },
  });
  const first = controller.recordInbound(inbound({ id: 'message-first' }));
  const second = controller.recordInbound(inbound({ id: 'message-second' }));
  await controller.whenIdle();

  assert.deepEqual(fixture.assembled, [
    first.event.eventId,
    second.event.eventId,
  ]);
  assert.equal(maximumRunning, 1);
});

test('active runtime reconciles a crash-resumed invocation before pending admission', async () => {
  const fixture = runtimeFixture();
  fixture.installCrashedInvocation();
  const pending = fixture.seedPending();
  const order: string[] = [];
  const controller = createActiveHomeRuntimeController({
    store: fixture.store,
    target,
    now: () => Date.parse('2026-01-02T03:04:06.000Z'),
    createBranchId: () => branchId('branch:runtime-resumed'),
    orchestrate: async () => {
      order.push(fixture.assembled.length === 0 ? 'reconcile' : 'execute');
      fixture.settle();
      return observed();
    },
  });
  await controller.reconcile();
  assert.deepEqual(order, ['reconcile']);
  assert.deepEqual(fixture.assembled, []);
  await controller.drain();
  assert.deepEqual(order, ['reconcile', 'execute']);
  assert.deepEqual(fixture.assembled, [pending.eventId]);
});
