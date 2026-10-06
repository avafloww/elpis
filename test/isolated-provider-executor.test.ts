import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MaterializedConfig } from '../src/config.js';
import { createIsolatedProviderExecutor } from '../src/context/isolated-provider-executor.js';
import {
  createActiveHomeDiscordTextExecutor,
  createHomeDiscordTextExecutor,
} from '../src/context/home-discord-text-executor.js';
import {
  createActiveHomeTextOrchestrator,
  createHomeTextOrchestrator,
} from '../src/context/home-text-orchestrator.js';
import {
  HomeDiscordTextTransportError,
  type HomeDiscordTextTransport,
} from '../src/context/home-discord-text-transport.js';

import { exactMainIsolatedProviderTarget } from '../src/context/resident-isolated-provider-binding.js';
import {
  RUN_TOOL,
  type LLM,
  type StandaloneCompleteOptions,
} from '../src/llm/llm.js';
import { legacyLlmModelRegistry } from '../src/llm/model-registry.js';
import { openDatabase } from '../src/store/db.js';
import {
  ContextGraphStore,
  branchId,
  eventId,
  hashContextBytes,
  worldId,
} from '../src/store/context-graph.js';
import { makeConfig } from './helpers.js';

function provenance(suffix: string) {
  return {
    version: 1 as const,
    batchId: `resident-tool-batch:00000000-0000-4000-8000-${suffix.padStart(12, '0')}`,
    batchSha256: hashContextBytes(`batch-${suffix}`),
    callIndex: 0,
    callCount: 1,
    toolName: 'run',
    argumentsSha256: hashContextBytes(`arguments-${suffix}`),
  };
}

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
      registry: legacyLlmModelRegistry(llm, { motorEnabled: true }),
    },
  } as MaterializedConfig;
}

function fixture(
  options: {
    activeInvocation?: boolean;
    scopeChannelId?: string;
    priorChannelId?: string;
    currentSource?: 'voice' | null;
    currentTransport?: 'signal' | null;
    currentForwarded?: {
      author: string;
      channelName: string | null;
      content: string;
    } | null;
    currentAttachments?: readonly unknown[];
    currentContent?: unknown;
  } = {},
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'isolated-provider-executor-'),
  );
  const database = openDatabase(directory);
  const store = new ContextGraphStore(database);
  const config = codexConfig();
  const target = exactMainIsolatedProviderTarget(config);
  const sourceFile = '---\nname: Aster\n---\n\n# Synthetic soul\n';
  const body = '# Synthetic soul\n';
  const soul = {
    parserGeneration: 1 as const,
    sourceFile,
    sourceFileHash: hashContextBytes(sourceFile),
    sourceFileBytes: Buffer.byteLength(sourceFile),
    body,
    bodyHash: hashContextBytes(body),
    bodyBytes: Buffer.byteLength(body),
  };
  const inspected = store.createResidentSourceInspectionCandidate({
    soul,
    provenance: provenance('601'),
    observedAt: 100,
  });
  const authorization = store.authorizeResidentSourceCandidate({
    candidateId: inspected.candidate.candidateId,
    freshSoul: soul,
    provenance: provenance('602'),
    authorizedAt: 200,
  });
  const derivation = store.deriveResidentIdentitySystemLayers({
    authorizationId: authorization.authorizationId,
    freshSoul: soul,
    provenance: provenance('603'),
    derivedAt: 300,
  });
  const guildId = '123456789012345678';
  const channelId = '234567890123456789';
  const expectedWorldId = worldId(`world:discord:guild:${guildId}`);
  const bindingIngress = store.appendWorldEvent({
    eventId: eventId('event:executor-binding-ingress'),
    worldId: expectedWorldId,
    kind: 'inbound:discord',
    payload: {
      schemaVersion: 1,
      kind: 'discord',
      source: null,
      transport: null,
      content: 'BINDING_PRIVATE_CANARY',
      channelId,
      guildId,
      attachments: [],
      forwarded: null,
    },
    occurredAt: 400,
    recordedAt: 400,
  });
  store.bindResidentCurrentWorldProfile({
    derivationId: derivation.derivationId,
    worldId: expectedWorldId,
    eventId: bindingIngress.eventId,
    sequence: bindingIngress.sequence,
    provenance: provenance('604'),
    boundAt: 500,
  });
  if (options.activeInvocation) {
    const scope = store.createHomeTextActivationScope({
      expectedSourceActivationEpoch: 0,
      expectedWorldId,
      guildId,
      channelId,
      maxOutputBytes: 1900,
      authorizedAt: 520,
    });
    store.activate(0, 530);
    const current = store.recordActiveSocialInbound({
      eventId: eventId('event:active-executor-current-ingress'),
      worldId: expectedWorldId,
      kind: 'inbound:discord',
      payload: {
        schemaVersion: 1,
        kind: 'discord',
        source: null,
        transport: null,
        originWorldId: null,
        forwarded: null,
        content: 'ACTIVE_EXECUTOR_PRIVATE_CANARY',
        attachments: [],
        bot: false,
        wakeClass: 'wake',
        guildId,
        channelId,
      },
      occurredAt: 540,
      recordedAt: 550,
      admittedAt: 560,
    });
    const invocation = store.assembleActiveHomeRequest({
      ingressEventId: current.event.eventId,
      ingressSourceSequence: current.event.sequence,
      branchId: branchId('branch:active-executor-fixture'),
      target,
      expectedActiveActivationEpoch: 1,
      expectedActivationScopeHash: scope.scopeHash,
      expectedHeadRevision: 0,
      admittedAt: 570,
    });
    return {
      database,
      store,
      config,
      target,
      expectedWorldId,
      invocationId: invocation.invocationId,
      close() {
        database.close();
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  }

  if (options.priorChannelId) {
    const prior = store.admitDarkInboundEvent({
      expectedActivationEpoch: 0,
      queueGeneration: 1,
      wakeClass: 'text_user_turn',
      messageRendererGeneration: 1,
      event: {
        eventId: eventId('event:executor-prior-ingress'),
        worldId: expectedWorldId,
        kind: 'inbound:discord',
        payload: {
          schemaVersion: 1,
          kind: 'discord',
          source: null,
          transport: null,
          channelId: options.priorChannelId,
          guildId,
          content: 'PRIOR_PRIVATE_CANARY',
          attachments: [],
          forwarded: null,
        },
        occurredAt: 550,
        recordedAt: 550,
      },
      admittedAt: 550,
    });
    store.createEventMessageProjection({
      sourceEventId: prior.event.eventId,
      sourceSequence: prior.event.sequence,
      worldId: expectedWorldId,
      rendererGeneration: 1,
      message: {
        role: 'user',
        content: '<incoming>PRIOR_PRIVATE_CANARY</incoming>',
      },
      createdAt: 550,
    });
  }
  const current = store.appendWorldEvent({
    eventId: eventId('event:executor-current-ingress'),
    worldId: expectedWorldId,
    kind: 'inbound:discord',
    payload: {
      schemaVersion: 1,
      kind: 'discord',
      source: options.currentSource ?? null,
      transport: options.currentTransport ?? null,
      channelId,
      guildId,
      content: Object.hasOwn(options, 'currentContent')
        ? options.currentContent
        : 'EXECUTOR_PRIVATE_CANARY',
      attachments: options.currentAttachments ?? [],
      forwarded: options.currentForwarded ?? null,
    },
    occurredAt: 600,
    recordedAt: 600,
  });
  store.createEventMessageProjection({
    sourceEventId: current.eventId,
    sourceSequence: current.sequence,
    worldId: expectedWorldId,
    rendererGeneration: 1,
    message: {
      role: 'user',
      content: '<incoming>EXECUTOR_PRIVATE_CANARY</incoming>',
    },
    createdAt: 600,
  });
  store.assembleResidentCurrentWorldDarkRequest({
    worldId: expectedWorldId,
    eventId: current.eventId,
    sequence: current.sequence,
    branchId: branchId('branch:executor-fixture'),
    maxEvents: 64,
    assembledAt: 700,
  });
  const binding = store.bindResidentDarkRequestToIsolatedProvider({
    worldId: expectedWorldId,
    eventId: current.eventId,
    sequence: current.sequence,
    target,
    provenance: provenance('605'),
    boundAt: 720,
  });
  const invocation = store.admitDarkIsolatedProviderInvocation({
    bindingId: binding.bindingId,
    expectedTarget: target,
    admittedAt: 730,
  });
  store.createHomeTextActivationScope({
    expectedSourceActivationEpoch: 0,
    expectedWorldId,
    guildId,
    channelId: options.scopeChannelId ?? channelId,
    maxOutputBytes: 1900,
    authorizedAt: 740,
  });
  store.activate(0, 800);
  return {
    database,
    store,
    config,
    target,
    expectedWorldId,
    invocationId: invocation.invocationId,
    close() {
      database.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

function fakeLlm(
  completeStandalone: NonNullable<LLM['completeStandalone']>,
): LLM {
  return {
    model: 'gpt-test-codex',
    runTool: RUN_TOOL,
    complete: async () => {
      throw new Error('ordinary completion must not run');
    },
    completeStandalone,
    summarize: async () => {
      throw new Error('summarization must not run');
    },
  };
}

function clock(start = 900) {
  let value = start;
  return () => ++value;
}

async function produceSpeechAttempt(value: ReturnType<typeof fixture>) {
  const execute = createIsolatedProviderExecutor({
    store: value.store,
    config: value.config,
    llm: fakeLlm(async (_messages, options = {}) => {
      options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
      options.dispatchLifecycle?.responseReceived({ attempt: 1, status: 200 });
      return {
        content: 'VISIBLE_EXECUTOR_RESULT',
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        model: value.target.model,
        providerType: value.target.providerType,
        apiSurface: value.target.apiSurface,
        apiEndpoint: value.target.apiEndpoint,
        toolContractVersion: value.target.toolContractVersion,
        reasoningEffort: value.target.reasoningEffort ?? undefined,
      };
    }),
    expectedWorldId: value.expectedWorldId,
    maxOutputBytes: 1024,
    now: clock(),
  });
  const result = await execute(value.invocationId);
  assert.equal(result.state, 'succeeded');
  const speech = value.store.getHomeTextSpeechAttempt(
    result.snapshot.attempt.attemptId,
  );
  assert.ok(speech);
  return speech;
}

async function produceActiveSpeechAttempt(value: ReturnType<typeof fixture>) {
  const execute = createIsolatedProviderExecutor({
    store: value.store,
    config: value.config,
    llm: fakeLlm(async (_messages, options = {}) => {
      options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
      options.dispatchLifecycle?.responseReceived({ attempt: 1, status: 200 });
      return {
        content: 'ACTIVE_VISIBLE_EXECUTOR_RESULT',
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        model: value.target.model,
        providerType: value.target.providerType,
        apiSurface: value.target.apiSurface,
        apiEndpoint: value.target.apiEndpoint,
        toolContractVersion: value.target.toolContractVersion,
        reasoningEffort: value.target.reasoningEffort ?? undefined,
      };
    }),
    expectedWorldId: value.expectedWorldId,
    maxOutputBytes: 1024,
    now: clock(),
  });
  const result = await execute(value.invocationId);
  assert.equal(result.state, 'succeeded');
  const speech = value.store.getActiveHomeTextSpeechAttempt(
    result.snapshot.attempt.attemptId,
  );
  assert.ok(speech);
  return speech;
}

test('isolated provider executor rejects another channel in the scoped guild before dispatch', async () => {
  const value = fixture({ scopeChannelId: '345678901234567890' });
  try {
    let calls = 0;
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async () => {
        calls += 1;
        throw new Error('provider must not run outside the scoped channel');
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now: clock(),
    });
    await assert.rejects(
      execute(value.invocationId),
      /request is outside its home text scope/,
    );
    assert.equal(calls, 0);
  } finally {
    value.close();
  }
});

test('isolated provider executor rejects non-direct or cross-channel request events before dispatch', async (t) => {
  const cases = [
    {
      name: 'forwarded terminal ingress',
      options: {
        currentForwarded: {
          author: 'Bramble',
          channelName: 'elsewhere',
          content: 'forwarded synthetic text',
        },
      },
    },
    {
      name: 'terminal ingress with an attachment',
      options: { currentAttachments: [{ id: 'synthetic-attachment' }] },
    },
    {
      name: 'voice-sourced terminal ingress',
      options: { currentSource: 'voice' as const },
    },
    {
      name: 'terminal ingress with empty content',
      options: { currentContent: '' },
    },
    {
      name: 'terminal ingress with non-text content',
      options: { currentContent: 42 },
    },
    {
      name: 'prior request event from another channel in the scoped guild',
      options: { priorChannelId: '345678901234567890' },
    },
  ];
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const value = fixture(entry.options);
      try {
        let calls = 0;
        const execute = createIsolatedProviderExecutor({
          store: value.store,
          config: value.config,
          llm: fakeLlm(async () => {
            calls += 1;
            throw new Error('provider must not run for non-direct home text');
          }),
          expectedWorldId: value.expectedWorldId,
          maxOutputBytes: 1024,
          now: clock(),
        });
        await assert.rejects(
          execute(value.invocationId),
          /request is outside its home text scope/,
        );
        assert.equal(calls, 0);
      } finally {
        value.close();
      }
    });
  }
});

test('isolated provider executor records one successful dispatch and never replays it', async () => {
  const value = fixture();
  try {
    let calls = 0;
    let seenOptions: StandaloneCompleteOptions | undefined;
    const llm = fakeLlm(async (messages, options = {}) => {
      calls += 1;
      seenOptions = options;
      assert.equal(
        messages.some((message) =>
          message.content.includes('EXECUTOR_PRIVATE_CANARY'),
        ),
        true,
      );
      options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
      options.dispatchLifecycle?.responseReceived({ attempt: 1, status: 200 });
      return {
        content: 'VISIBLE\u0000EXECUTOR_RESULT',
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        model: value.target.model,
        providerType: value.target.providerType,
        apiSurface: value.target.apiSurface,
        apiEndpoint: value.target.apiEndpoint,
        toolContractVersion: value.target.toolContractVersion,
        reasoningEffort: value.target.reasoningEffort ?? undefined,
      };
    });
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm,
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now: clock(),
    });
    const first = await execute(value.invocationId);
    assert.equal(first.state, 'succeeded');
    assert.equal(first.fresh, true);
    assert.equal(
      first.snapshot.outcome?.outcome.visibleText,
      'VISIBLE\u0000EXECUTOR_RESULT',
    );
    assert.equal(
      value.store.getHomeTextSpeechAttempt(first.snapshot.attempt.attemptId)
        ?.attempt.visibleText,
      'VISIBLE\u0000EXECUTOR_RESULT',
    );

    assert.equal(first.snapshot.effect?.status, 'observed');
    assert.equal(first.snapshot.response?.evidence.statusCode, 200);
    assert.equal(seenOptions?.retryUnauthorized, false);
    assert.equal(seenOptions?.callTimeoutMs, value.config.llm.callTimeoutMs);
    assert.equal(
      seenOptions?.streamIdleTimeoutMs,
      value.config.llm.streamIdleTimeoutMs,
    );
    assert.equal(seenOptions?.allowHistoricalToolMessages, false);
    assert.equal(seenOptions?.tools, undefined);
    const second = await execute(value.invocationId);
    assert.equal(second.state, 'succeeded');
    assert.equal(second.fresh, false);
    assert.equal(calls, 1);
  } finally {
    value.close();
  }
});

test('isolated provider executor atomically creates an active speech barrier', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    let calls = 0;
    const llm = fakeLlm(async (messages, options = {}) => {
      calls += 1;
      assert.equal(
        messages.some((message) =>
          message.content.includes('ACTIVE_EXECUTOR_PRIVATE_CANARY'),
        ),
        true,
      );
      options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
      options.dispatchLifecycle?.responseReceived({ attempt: 1, status: 200 });
      return {
        content: 'ACTIVE_EXECUTOR_RESULT',
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        model: value.target.model,
        providerType: value.target.providerType,
        apiSurface: value.target.apiSurface,
        apiEndpoint: value.target.apiEndpoint,
        toolContractVersion: value.target.toolContractVersion,
        reasoningEffort: value.target.reasoningEffort ?? undefined,
      };
    });
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm,
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now: clock(),
    });
    const first = await execute(value.invocationId);
    assert.equal(first.state, 'succeeded');
    assert.equal(first.fresh, true);
    assert.equal(
      first.snapshot.outcome?.outcome.visibleText,
      'ACTIVE_EXECUTOR_RESULT',
    );
    const speech = value.store.getActiveHomeTextSpeechAttempt(
      first.snapshot.attempt.attemptId,
    );
    assert.ok(speech);
    assert.equal(speech.attempt.visibleText, 'ACTIVE_EXECUTOR_RESULT');
    assert.equal(value.store.getEffect(speech.attempt.speechEffectId), null);
    assert.equal(first.snapshot.effect?.status, 'observed');
    assert.equal(first.snapshot.response?.evidence.statusCode, 200);
    assert.equal(
      value.store.getBranch(first.snapshot.attempt.attempt.branchId)?.status,
      'running',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
    assert.equal(
      (
        value.database
          .prepare('SELECT count(*) AS count FROM context_capsules')
          .get() as { count: number }
      ).count,
      1,
    );
    const second = await execute(value.invocationId);
    assert.equal(second.state, 'succeeded');
    assert.equal(second.fresh, false);
    assert.equal(calls, 1);
  } finally {
    value.close();
  }
});

test('legacy home Discord executor rejects active speech authority', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    const speech = await produceActiveSpeechAttempt(value);
    let sends = 0;
    const legacyDeliver = createHomeDiscordTextExecutor({
      store: value.store,
      now: clock(1_000),
      transport: {
        async send() {
          sends += 1;
          throw new Error('legacy executor must not receive active authority');
        },
      },
    });
    await assert.rejects(
      legacyDeliver(speech.attempt.speechAttemptId),
      /home text speech attempt is missing/,
    );
    assert.equal(sends, 0);
    assert.equal(value.store.getEffect(speech.attempt.speechEffectId), null);
    assert.equal(
      value.store.getActiveHomeTextSpeechReceipt(
        speech.attempt.speechAttemptId,
      ),
      null,
    );
  } finally {
    value.close();
  }
});

test('active home Discord delivery observes one message and atomically returns the branch', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    const speech = await produceActiveSpeechAttempt(value);
    let sends = 0;
    const deliver = createActiveHomeDiscordTextExecutor({
      store: value.store,
      now: clock(1_000),
      transport: {
        async send(request, beforeDispatch) {
          sends += 1;
          beforeDispatch();
          return {
            statusCode: 200,
            messageId: '345678901234567890',
            guildId: request.guildId,
            channelId: request.channelId,
            nonce: request.nonce,
            textBytes: request.textBytes,
            textHash: request.textHash,
            observedAt: 1_010,
          };
        },
      },
    });
    const first = await deliver(speech.attempt.speechAttemptId);
    assert.equal(first.state, 'observed');
    assert.ok(first.completion);
    assert.equal(first.completion.branch.status, 'yielded');
    assert.equal(first.completion.head.revision, 1);
    assert.equal(first.receipt.evidence?.messageId, '345678901234567890');
    assert.throws(
      () =>
        value.database
          .prepare(
            `INSERT INTO context_share_grants(
               grant_id, shared_event_id, source_capsule_id, source_world_id,
               destination_world_id, canonical_text, content_hash, status,
               authority_epoch, created_at, revoked_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
          )
          .run(
            'share:forbidden-active-home-root',
            'event:forbidden-active-home-root',
            speech.attempt.rootReceiptCapsuleId,
            speech.attempt.worldId,
            'world:discord:guild:999999999999999999',
            'forbidden',
            '0'.repeat(64),
            speech.attempt.authorityEpoch,
            1_011,
          ),
      /world-private/,
    );
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(
      (await deliver(speech.attempt.speechAttemptId)).state,
      'observed',
    );
    assert.equal(sends, 1);
  } finally {
    value.close();
  }
});

test('active home Discord delivery freezes uncertain issuance without replay', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    const speech = await produceActiveSpeechAttempt(value);
    let sends = 0;
    const deliver = createActiveHomeDiscordTextExecutor({
      store: value.store,
      now: clock(1_000),
      transport: {
        async send(_request, beforeDispatch) {
          sends += 1;
          beforeDispatch();
          throw new HomeDiscordTextTransportError(
            'issuance_uncertain',
            'dispatch_uncertain',
          );
        },
      },
    });
    const first = await deliver(speech.attempt.speechAttemptId);
    assert.equal(first.state, 'issuance_uncertain');
    assert.equal(
      value.store.getEffect(speech.attempt.speechEffectId)?.status,
      'uncertain',
    );
    assert.equal(
      (await deliver(speech.attempt.speechAttemptId)).state,
      'issuance_uncertain',
    );
    assert.equal(sends, 1);
    assert.deepEqual(
      value.store.reconcileActiveHomeTextSpeechBeforeRecovery(1_020),
      [first.receipt],
    );
    assert.ok(value.store.recoverCoordinatedBranch(1_030));
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    value.close();
  }
});

test('active home Discord delivery records rejected pre-dispatch without an effect', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    const speech = await produceActiveSpeechAttempt(value);
    let sends = 0;
    const deliver = createActiveHomeDiscordTextExecutor({
      store: value.store,
      now: clock(1_000),
      transport: {
        async send() {
          sends += 1;
          throw new HomeDiscordTextTransportError(
            'pre_dispatch_rejected',
            'invalid_request',
          );
        },
      },
    });
    const first = await deliver(speech.attempt.speechAttemptId);
    assert.equal(first.state, 'pre_dispatch_rejected');
    assert.equal(value.store.getEffect(speech.attempt.speechEffectId), null);
    assert.equal(
      (await deliver(speech.attempt.speechAttemptId)).state,
      'pre_dispatch_rejected',
    );
    assert.equal(sends, 1);
    assert.ok(value.store.recoverCoordinatedBranch(1_030));
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
  } finally {
    value.close();
  }
});

test('active-home provider recovery freezes prepared issuance without speech', () => {
  const value = fixture({ activeInvocation: true });
  try {
    const attempt = value.store.beginActiveHomeProviderExecutionAttempt({
      invocationId: value.invocationId,
      expectedWorldId: value.expectedWorldId,
      expectedTarget: value.target,
      callTimeoutMs: value.config.llm.callTimeoutMs,
      streamIdleTimeoutMs: value.config.llm.streamIdleTimeoutMs,
      maxOutputBytes: 1024,
      authorizedAt: 900,
    });
    assert.equal(attempt.fresh, true);
    assert.throws(
      () => value.store.recoverCoordinatedBranch(905),
      /(?:invalid active home provider invocation transition|active home provider effect transition is invalid)/,
    );
    value.store.prepareActiveHomeProviderExecutionEffect(
      attempt.attempt.attemptId,
      910,
    );
    assert.throws(
      () => value.store.recoverCoordinatedBranch(915),
      /(?:invalid active home provider invocation transition|active home provider effect transition is invalid)/,
    );
    assert.equal(
      value.store.getEffect(attempt.attempt.attempt.effectId)?.status,
      'prepared',
    );
    const forgedOutcome = {
      schemaVersion: 1,
      attemptId: attempt.attempt.attemptId,
      effectId: attempt.attempt.attempt.effectId,
      outcomeKind: 'visible_error',
      phase: 'issuance_uncertain',
      visibleText: 'U',
      visibleBytes: 1,
      visibleHash: hashContextBytes('U'),
      completedAt: 916,
    };
    const forgedOutcomeJson = JSON.stringify(forgedOutcome);
    value.database.exec('BEGIN IMMEDIATE');
    try {
      value.database
        .prepare(
          `INSERT INTO context_active_home_provider_outcomes
             (attempt_id, effect_id, outcome_kind, phase, visible_text,
              visible_bytes, visible_hash, outcome_json, outcome_hash, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          forgedOutcome.attemptId,
          forgedOutcome.effectId,
          forgedOutcome.outcomeKind,
          forgedOutcome.phase,
          forgedOutcome.visibleText,
          forgedOutcome.visibleBytes,
          forgedOutcome.visibleHash,
          forgedOutcomeJson,
          hashContextBytes(forgedOutcomeJson),
          forgedOutcome.completedAt,
        );
      assert.throws(
        () =>
          value.database
            .prepare(
              `UPDATE context_effects
               SET status = 'uncertain', resolved_at = ?, observation_json = '{}'
               WHERE effect_id = ?`,
            )
            .run(917, forgedOutcome.effectId),
        /active home provider effect transition is invalid/,
      );
    } finally {
      value.database.exec('ROLLBACK');
    }
    assert.equal(
      value.store.getIsolatedProviderOutcome(attempt.attempt.attemptId),
      null,
    );
    const reconciled = value.store.reconcileIsolatedProviderBeforeRecovery(920);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0]?.outcome.phase, 'issuance_uncertain');
    assert.equal(
      value.store.getEffect(attempt.attempt.attempt.effectId)?.status,
      'uncertain',
    );
    assert.equal(
      value.store.getHomeTextSpeechAttempt(attempt.attempt.attemptId),
      null,
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
    const recovered = value.store.recoverCoordinatedBranch(930);
    assert.ok(recovered);
    assert.equal(
      value.store.getBranch(attempt.attempt.attempt.branchId)?.status,
      'crashed',
    );
    assert.ok(
      value.store.getActiveHomeProviderInvocationAdmission(value.invocationId),
    );
  } finally {
    value.close();
  }
});

test('active-home provider errors fit a one-byte output authority', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    let calls = 0;
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async () => {
        calls += 1;
        throw new Error('synthetic pre-dispatch failure');
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1,
      now: clock(),
    });
    const first = await execute(value.invocationId);
    assert.equal(first.state, 'failed');
    assert.equal(
      first.snapshot.outcome?.outcome.phase,
      'pre_dispatch_rejected',
    );
    assert.equal(first.snapshot.outcome?.outcome.visibleText, 'P');
    assert.equal(first.snapshot.outcome?.outcome.visibleBytes, 1);
    assert.equal(first.snapshot.effect, null);
    const second = await execute(value.invocationId);
    assert.equal(second.state, 'failed');
    assert.equal(calls, 1);
  } finally {
    value.close();
  }
});

test('home Discord delivery observes one message and atomically returns the branch', async () => {
  const value = fixture();
  try {
    const speech = await produceSpeechAttempt(value);
    let sends = 0;
    const transport: HomeDiscordTextTransport = {
      async send(request, beforeDispatch) {
        sends += 1;
        beforeDispatch();
        return {
          statusCode: 200,
          messageId: '345678901234567890',
          guildId: request.guildId,
          channelId: request.channelId,
          nonce: request.nonce,
          textBytes: request.textBytes,
          textHash: request.textHash,
          observedAt: 1_010,
        };
      },
    };
    const deliver = createHomeDiscordTextExecutor({
      store: value.store,
      transport,
      now: clock(1_000),
    });
    const first = await deliver(speech.attempt.speechAttemptId);
    assert.equal(first.state, 'observed');
    assert.ok(first.completion);
    assert.equal(first.completion.branch.status, 'yielded');
    assert.equal(first.completion.head.revision, 1);
    assert.equal(first.receipt.evidence?.messageId, '345678901234567890');
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    const second = await deliver(speech.attempt.speechAttemptId);
    assert.equal(second.state, 'observed');
    assert.equal(second.completion, null);
    assert.equal(sends, 1);
  } finally {
    value.close();
  }
});

test('home Discord delivery rolls back a late return failure and freezes issuance', async () => {
  const value = fixture();
  try {
    const speech = await produceSpeechAttempt(value);
    value.database.exec(`
      CREATE TRIGGER fixture_reject_home_text_root_receipt
      BEFORE INSERT ON context_capsules
      WHEN NEW.capsule_kind = 'root_receipt'
      BEGIN
        SELECT RAISE(ABORT, 'fixture late root receipt failure');
      END;
    `);
    const transport: HomeDiscordTextTransport = {
      async send(request, beforeDispatch) {
        beforeDispatch();
        return {
          statusCode: 200,
          messageId: '345678901234567890',
          guildId: request.guildId,
          channelId: request.channelId,
          nonce: request.nonce,
          textBytes: request.textBytes,
          textHash: request.textHash,
          observedAt: 1_010,
        };
      },
    };
    const deliver = createHomeDiscordTextExecutor({
      store: value.store,
      transport,
      now: clock(1_000),
    });
    const result = await deliver(speech.attempt.speechAttemptId);
    assert.equal(result.state, 'issuance_uncertain');
    assert.equal(result.receipt.receipt.phase, 'issuance_uncertain');
    assert.equal(
      value.store.getEffect(speech.attempt.speechEffectId)?.status,
      'uncertain',
    );
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'running',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
    assert.equal(
      (
        value.database
          .prepare(
            'SELECT COUNT(*) AS n FROM context_capsules WHERE capsule_id = ?',
          )
          .get(speech.attempt.rootReceiptCapsuleId) as { n: number }
      ).n,
      0,
    );
    value.database.exec('DROP TRIGGER fixture_reject_home_text_root_receipt');
    assert.ok(value.store.recoverCoordinatedBranch(1_020));
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
  } finally {
    value.close();
  }
});

test('home Discord delivery freezes uncertain issuance without replay', async () => {
  const value = fixture();
  try {
    const speech = await produceSpeechAttempt(value);
    let sends = 0;
    const transport: HomeDiscordTextTransport = {
      async send(_request, beforeDispatch) {
        sends += 1;
        beforeDispatch();
        throw new HomeDiscordTextTransportError(
          'issuance_uncertain',
          'dispatch_uncertain',
        );
      },
    };
    const deliver = createHomeDiscordTextExecutor({
      store: value.store,
      transport,
      now: clock(1_000),
    });
    const first = await deliver(speech.attempt.speechAttemptId);
    assert.equal(first.state, 'issuance_uncertain');
    assert.equal(
      value.store.getEffect(speech.attempt.speechEffectId)?.status,
      'uncertain',
    );
    const second = await deliver(speech.attempt.speechAttemptId);
    assert.equal(second.state, 'issuance_uncertain');
    assert.equal(sends, 1);
    assert.deepEqual(value.store.reconcileHomeTextSpeechBeforeRecovery(1_020), [
      first.receipt,
    ]);
    const recovery = value.store.recoverCoordinatedBranch(1_030);
    assert.ok(recovery);
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    value.close();
  }
});

test('home Discord delivery records a rejected pre-dispatch attempt without an effect', async () => {
  const value = fixture();
  try {
    const speech = await produceSpeechAttempt(value);
    let sends = 0;
    const transport: HomeDiscordTextTransport = {
      async send() {
        sends += 1;
        throw new HomeDiscordTextTransportError(
          'pre_dispatch_rejected',
          'invalid_request',
        );
      },
    };
    const deliver = createHomeDiscordTextExecutor({
      store: value.store,
      transport,
      now: clock(1_000),
    });
    const result = await deliver(speech.attempt.speechAttemptId);
    assert.equal(result.state, 'pre_dispatch_rejected');
    assert.equal(value.store.getEffect(speech.attempt.speechEffectId), null);
    assert.equal(
      (await deliver(speech.attempt.speechAttemptId)).state,
      'pre_dispatch_rejected',
    );
    assert.equal(sends, 1);
    const recovery = value.store.recoverCoordinatedBranch(1_030);
    assert.ok(recovery);
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
  } finally {
    value.close();
  }
});

test('startup reconciliation records the speech boundary before generic branch recovery', async (t) => {
  for (const prepared of [false, true]) {
    await t.test(
      prepared
        ? 'prepared speech effect becomes uncertain'
        : 'missing speech effect is rejected',
      async () => {
        const value = fixture();
        try {
          const speech = await produceSpeechAttempt(value);
          if (prepared) {
            value.store.prepareHomeTextSpeechEffect({
              speechAttemptId: speech.attempt.speechAttemptId,
              preparedAt: 1_000,
            });
          }
          const receipts =
            value.store.reconcileHomeTextSpeechBeforeRecovery(1_010);
          assert.equal(receipts.length, 1);
          assert.equal(
            receipts[0]?.receipt.phase,
            prepared ? 'issuance_uncertain' : 'pre_dispatch_rejected',
          );
          const recovery = value.store.recoverCoordinatedBranch(1_020);
          assert.ok(recovery);
          assert.equal(
            value.store.getBranch(speech.attempt.branchId)?.status,
            'crashed',
          );
          assert.equal(value.store.getContinuationHead().revision, 0);
        } finally {
          value.close();
        }
      },
    );
  }
});

test('isolated provider executor records provable pre-dispatch rejection without an effect', async () => {
  const value = fixture();
  try {
    let calls = 0;
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async () => {
        calls += 1;
        throw new Error(
          'credential unavailable before dispatch: PRIVATE_ERROR_CANARY',
        );
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now: clock(),
    });
    const result = await execute(value.invocationId);
    assert.equal(result.state, 'failed');
    assert.equal(
      result.snapshot.outcome?.outcome.phase,
      'pre_dispatch_rejected',
    );
    assert.equal(result.snapshot.outcome?.outcome.visibleText, 'P');
    assert.doesNotMatch(
      result.snapshot.outcome?.outcome.visibleText ?? '',
      /PRIVATE_ERROR_CANARY/,
    );
    assert.equal(result.snapshot.effect, null);
    await execute(value.invocationId);
    assert.equal(calls, 1);
  } finally {
    value.close();
  }
});

test('isolated provider executor freezes after a network-boundary error without response evidence', async () => {
  const value = fixture();
  try {
    let calls = 0;
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async (_messages, options = {}) => {
        calls += 1;
        options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
        throw new Error(
          'socket vanished after dispatch boundary: PRIVATE_NETWORK_CANARY',
        );
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now: clock(),
    });
    const result = await execute(value.invocationId);
    assert.equal(result.state, 'issuance_uncertain');
    assert.equal(result.snapshot.outcome?.outcome.phase, 'issuance_uncertain');
    assert.equal(result.snapshot.effect?.status, 'uncertain');
    assert.equal(result.snapshot.outcome?.outcome.visibleText, 'U');
    assert.doesNotMatch(
      result.snapshot.outcome?.outcome.visibleText ?? '',
      /PRIVATE_NETWORK_CANARY/,
    );
    assert.equal(result.snapshot.response, null);
    const recovered = value.store.recoverCoordinatedBranch(1_000);
    assert.equal(recovered?.uncertainEffects, 0);
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal(
      value.store.getBranch(result.snapshot.attempt.attempt.branchId)?.status,
      'crashed',
    );
    assert.equal(
      value.store.getDarkPendingBranchAbandonment(
        result.snapshot.attempt.attempt.branchId,
      ),
      null,
    );
    await execute(value.invocationId);
    assert.equal(calls, 1);
  } finally {
    value.close();
  }
});

test('isolated provider executor recovers received responses without replay after config drift', async () => {
  const value = fixture();
  try {
    const started = value.store.beginIsolatedProviderExecutionAttempt({
      invocationId: value.invocationId,
      expectedWorldId: value.expectedWorldId,
      expectedTarget: value.target,
      callTimeoutMs: value.config.llm.callTimeoutMs,
      streamIdleTimeoutMs: value.config.llm.streamIdleTimeoutMs,
      maxOutputBytes: 1024,
      authorizedAt: 900,
    });
    assert.equal(started.fresh, true);
    value.store.prepareIsolatedProviderExecutionEffect(
      started.attempt.attemptId,
      901,
    );
    value.store.recordIsolatedProviderResponse({
      attemptId: started.attempt.attemptId,
      statusCode: 200,
      requestId: 'response-before-restart',
      receivedAt: 902,
    });
    const recovered = value.store.recoverCoordinatedBranch(903);
    assert.equal(recovered?.uncertainEffects, 1);

    value.config.llm.callTimeoutMs += 1;
    value.config.llm.streamIdleTimeoutMs += 1;
    let calls = 0;
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async () => {
        calls += 1;
        throw new Error('recovered attempts must not dispatch');
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 8192,
      now: clock(),
    });
    const result = await execute(value.invocationId);
    assert.equal(result.state, 'issued_outcome_unknown');
    assert.equal(result.snapshot.response?.evidence.statusCode, 200);
    assert.equal(result.snapshot.effect?.status, 'uncertain');
    assert.equal(result.snapshot.outcome, null);
    assert.equal(calls, 0);
  } finally {
    value.close();
  }
});

test('isolated provider executor treats an error after a positive HTTP response as issued', async () => {
  const value = fixture();
  try {
    let calls = 0;
    const execute = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async (_messages, options = {}) => {
        calls += 1;
        options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
        options.dispatchLifecycle?.responseReceived({
          attempt: 1,
          status: 401,
        });
        throw new Error('unauthorized response was not retried');
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now: clock(),
    });
    const result = await execute(value.invocationId);
    assert.equal(result.state, 'failed');
    assert.equal(result.snapshot.outcome?.outcome.phase, 'issued');
    assert.equal(result.snapshot.response?.evidence.statusCode, 401);
    assert.equal(result.snapshot.effect?.status, 'failed');
    await execute(value.invocationId);
    assert.equal(calls, 1);
  } finally {
    value.close();
  }
});

test('active home text orchestrator performs one exact provider and Discord lifecycle', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    const now = clock();
    let providerCalls = 0;
    const executeProvider = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async (_messages, options = {}) => {
        providerCalls += 1;
        options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
        options.dispatchLifecycle?.responseReceived({
          attempt: 1,
          status: 200,
        });
        return {
          content: 'ACTIVE_ORCHESTRATED_VISIBLE_RESULT',
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          model: value.target.model,
          providerType: value.target.providerType,
          apiSurface: value.target.apiSurface,
          apiEndpoint: value.target.apiEndpoint,
          toolContractVersion: value.target.toolContractVersion,
          reasoningEffort: value.target.reasoningEffort ?? undefined,
        };
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now,
    });
    let sends = 0;
    const executeSpeech = createActiveHomeDiscordTextExecutor({
      store: value.store,
      now,
      transport: {
        async send(request, beforeDispatch) {
          sends += 1;
          beforeDispatch();
          return {
            statusCode: 200,
            messageId: '345678901234567890',
            guildId: request.guildId,
            channelId: request.channelId,
            nonce: request.nonce,
            textBytes: request.textBytes,
            textHash: request.textHash,
            observedAt: now(),
          };
        },
      },
    });
    const run = createActiveHomeTextOrchestrator({
      store: value.store,
      executeProvider,
      executeSpeech,
      now,
    });
    assert.equal((await run()).state, 'observed');
    assert.equal(providerCalls, 1);
    assert.equal(sends, 1);
    assert.equal(value.store.getContinuationHead().revision, 1);
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal((await run()).state, 'not_authorized');
    assert.equal(providerCalls, 1);
    assert.equal(sends, 1);
  } finally {
    value.close();
  }
});

test('active home text orchestrator never delays a preexisting speech barrier', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    const speech = await produceActiveSpeechAttempt(value);
    let providerCalls = 0;
    let sends = 0;
    const run = createActiveHomeTextOrchestrator({
      store: value.store,
      executeProvider: async () => {
        providerCalls += 1;
        throw new Error('preexisting provider attempts must not replay');
      },
      executeSpeech: async () => {
        sends += 1;
        throw new Error('preexisting speech barriers must not send later');
      },
      now: clock(1_000),
    });
    const result = await run();
    assert.equal(result.state, 'speech_pre_dispatch_rejected');
    assert.equal(providerCalls, 0);
    assert.equal(sends, 0);
    assert.equal(value.store.getEffect(speech.attempt.speechEffectId), null);
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    value.close();
  }
});

test('active home text orchestrator rejects a provider attempt won during its await', async () => {
  const value = fixture({ activeInvocation: true });
  try {
    const now = clock(1_000);
    const providerExecutor = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async (_messages, options = {}) => {
        options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
        options.dispatchLifecycle?.responseReceived({
          attempt: 1,
          status: 200,
        });
        return {
          content: 'RACED_ACTIVE_RESULT',
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          model: value.target.model,
          providerType: value.target.providerType,
          apiSurface: value.target.apiSurface,
          apiEndpoint: value.target.apiEndpoint,
          toolContractVersion: value.target.toolContractVersion,
          reasoningEffort: value.target.reasoningEffort ?? undefined,
        };
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now,
    });
    let racedResult: Awaited<ReturnType<typeof providerExecutor>> | null = null;
    let sends = 0;
    const run = createActiveHomeTextOrchestrator({
      store: value.store,
      executeProvider: async (invocationId) => {
        const winner = await providerExecutor(invocationId);
        assert.equal(winner.fresh, true);
        racedResult = await providerExecutor(invocationId);
        return racedResult;
      },
      executeSpeech: async () => {
        sends += 1;
        throw new Error('a raced speech barrier must not be delivered');
      },
      now,
    });
    await assert.rejects(
      run(),
      /active provider attempt was not created by this orchestration/,
    );
    assert.ok(racedResult);
    assert.equal(racedResult.fresh, false);
    const speech = value.store.getActiveHomeTextSpeechAttempt(
      racedResult.snapshot.attempt.attemptId,
    );
    assert.ok(speech);
    assert.equal(sends, 0);
    assert.equal(
      value.store.getActiveHomeTextSpeechReceipt(speech.attempt.speechAttemptId)
        ?.receipt.phase,
      'pre_dispatch_rejected',
    );
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
  } finally {
    value.close();
  }
});

test('home text orchestrator performs one exact provider and Discord lifecycle', async () => {
  const value = fixture();
  try {
    const now = clock();
    let providerCalls = 0;
    const executeProvider = createIsolatedProviderExecutor({
      store: value.store,
      config: value.config,
      llm: fakeLlm(async (_messages, options = {}) => {
        providerCalls += 1;
        options.dispatchLifecycle?.beforeNetwork({ attempt: 1 });
        options.dispatchLifecycle?.responseReceived({
          attempt: 1,
          status: 200,
        });
        return {
          content: 'ORCHESTRATED_VISIBLE_RESULT',
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
          model: value.target.model,
          providerType: value.target.providerType,
          apiSurface: value.target.apiSurface,
          apiEndpoint: value.target.apiEndpoint,
          toolContractVersion: value.target.toolContractVersion,
          reasoningEffort: value.target.reasoningEffort ?? undefined,
        };
      }),
      expectedWorldId: value.expectedWorldId,
      maxOutputBytes: 1024,
      now,
    });
    let sends = 0;
    const executeSpeech = createHomeDiscordTextExecutor({
      store: value.store,
      now,
      transport: {
        async send(request, beforeDispatch) {
          sends += 1;
          beforeDispatch();
          return {
            statusCode: 200,
            messageId: '345678901234567890',
            guildId: request.guildId,
            channelId: request.channelId,
            nonce: request.nonce,
            textBytes: request.textBytes,
            textHash: request.textHash,
            observedAt: now(),
          };
        },
      },
    });
    const run = createHomeTextOrchestrator({
      store: value.store,
      executeProvider,
      executeSpeech,
      now,
    });

    const result = await run();
    assert.equal(result.state, 'observed');
    assert.equal(providerCalls, 1);
    assert.equal(sends, 1);
    assert.equal(value.store.getContinuationHead().revision, 1);
    assert.equal(value.store.getRootCoordinatorState().activeBranchId, null);
    assert.equal((await run()).state, 'not_authorized');
    assert.equal(providerCalls, 1);
    assert.equal(sends, 1);
  } finally {
    value.close();
  }
});

test('home text orchestrator never turns a preexisting provider success into a delayed send', async () => {
  const value = fixture();
  try {
    const speech = await produceSpeechAttempt(value);
    let providerCalls = 0;
    let sends = 0;
    const run = createHomeTextOrchestrator({
      store: value.store,
      executeProvider: async () => {
        providerCalls += 1;
        throw new Error('preexisting provider attempts must not replay');
      },
      executeSpeech: async () => {
        sends += 1;
        throw new Error('preexisting success must not become a delayed send');
      },
      now: clock(1_000),
    });

    const result = await run();
    assert.equal(result.state, 'speech_pre_dispatch_rejected');
    assert.equal(providerCalls, 0);
    assert.equal(sends, 0);
    assert.equal(
      value.store.getHomeTextSpeechReceipt(speech.attempt.speechAttemptId)
        ?.receipt.phase,
      'pre_dispatch_rejected',
    );
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'crashed',
    );
    assert.equal(value.store.getContinuationHead().revision, 0);
  } finally {
    value.close();
  }
});

test('home text orchestrator records provider evidence before generic recovery', async (t) => {
  const cases = [
    {
      name: 'attempt without effect',
      effect: false,
      response: false,
      phase: 'pre_dispatch_rejected',
    },
    {
      name: 'prepared effect without response',
      effect: true,
      response: false,
      phase: 'issuance_uncertain',
    },
    {
      name: 'received response without outcome',
      effect: true,
      response: true,
      phase: 'issued',
    },
  ] as const;
  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const value = fixture();
      try {
        const started = value.store.beginIsolatedProviderExecutionAttempt({
          invocationId: value.invocationId,
          expectedWorldId: value.expectedWorldId,
          expectedTarget: value.target,
          callTimeoutMs: value.config.llm.callTimeoutMs,
          streamIdleTimeoutMs: value.config.llm.streamIdleTimeoutMs,
          maxOutputBytes: 1024,
          authorizedAt: 900,
        });
        if (entry.effect) {
          value.store.prepareIsolatedProviderExecutionEffect(
            started.attempt.attemptId,
            901,
          );
        }
        if (entry.response) {
          value.store.recordIsolatedProviderResponse({
            attemptId: started.attempt.attemptId,
            statusCode: 200,
            receivedAt: 902,
          });
        }
        let providerCalls = 0;
        let sends = 0;
        const run = createHomeTextOrchestrator({
          store: value.store,
          executeProvider: async () => {
            providerCalls += 1;
            throw new Error('recovery must not dispatch provider');
          },
          executeSpeech: async () => {
            sends += 1;
            throw new Error('provider recovery must not send speech');
          },
          now: clock(1_000),
        });

        const result = await run();
        assert.equal(result.state, 'provider_failed');
        if (result.state === 'provider_failed') {
          assert.equal(result.phase, entry.phase);
        }
        assert.equal(providerCalls, 0);
        assert.equal(sends, 0);
        assert.equal(
          value.store.getIsolatedProviderOutcome(started.attempt.attemptId)
            ?.outcome.phase,
          entry.phase,
        );
        assert.equal(
          value.store.getBranch(started.attempt.attempt.branchId)?.status,
          'crashed',
        );
      } finally {
        value.close();
      }
    });
  }
});

test('home text orchestrator reuses one reconciliation timestamp for recovery', async () => {
  const value = fixture();
  try {
    const speech = await produceSpeechAttempt(value);
    const times = [1_000, 950];
    let clockCalls = 0;
    const run = createHomeTextOrchestrator({
      store: value.store,
      executeProvider: async () => {
        throw new Error('preexisting provider attempts must not replay');
      },
      executeSpeech: async () => {
        throw new Error('preexisting success must not become a delayed send');
      },
      now: () => {
        clockCalls += 1;
        const value = times.shift();
        if (value === undefined) throw new Error('unexpected clock read');
        return value;
      },
    });

    const result = await run();
    assert.equal(result.state, 'speech_pre_dispatch_rejected');
    assert.equal(clockCalls, 1);
    assert.equal(
      value.store.getHomeTextSpeechReceipt(speech.attempt.speechAttemptId)
        ?.receipt.resolvedAt,
      1_000,
    );
    assert.equal(
      (
        value.database
          .prepare(
            'SELECT recovered_at FROM context_branch_recoveries WHERE branch_id = ?',
          )
          .get(speech.attempt.branchId) as { recovered_at: number }
      ).recovered_at,
      1_000,
    );
  } finally {
    value.close();
  }
});

test('home text orchestrator rejects recovery before durable terminal evidence', async () => {
  const value = fixture();
  try {
    const speech = await produceSpeechAttempt(value);
    value.store.recordHomeTextSpeechFailure({
      speechAttemptId: speech.attempt.speechAttemptId,
      phase: 'pre_dispatch_rejected',
      resolvedAt: 1_100,
    });
    const run = createHomeTextOrchestrator({
      store: value.store,
      executeProvider: async () => {
        throw new Error('preexisting provider attempts must not replay');
      },
      executeSpeech: async () => {
        throw new Error('preexisting success must not become a delayed send');
      },
      now: () => 1_050,
    });

    await assert.rejects(run(), /recovery timestamp precedes durable state/);
    assert.equal(
      value.store.getBranch(speech.attempt.branchId)?.status,
      'running',
    );
    assert.equal(
      value.store.getRootCoordinatorState().activeBranchId,
      speech.attempt.branchId,
    );
    assert.equal(
      (
        value.database
          .prepare(
            'SELECT COUNT(*) AS n FROM context_branch_recoveries WHERE branch_id = ?',
          )
          .get(speech.attempt.branchId) as { n: number }
      ).n,
      0,
    );
  } finally {
    value.close();
  }
});

test('home text recovery preflights a future prepared provider effect before mutation', async () => {
  const value = fixture();
  try {
    const started = value.store.beginIsolatedProviderExecutionAttempt({
      invocationId: value.invocationId,
      expectedWorldId: value.expectedWorldId,
      expectedTarget: value.target,
      callTimeoutMs: value.config.llm.callTimeoutMs,
      streamIdleTimeoutMs: value.config.llm.streamIdleTimeoutMs,
      maxOutputBytes: 1024,
      authorizedAt: 900,
    });
    value.store.prepareIsolatedProviderExecutionEffect(
      started.attempt.attemptId,
      1_100,
    );
    assert.throws(
      () =>
        value.store.recordIsolatedProviderOutcome({
          attemptId: started.attempt.attemptId,
          outcomeKind: 'visible_error',
          phase: 'issuance_uncertain',
          visibleText: 'provider request outcome is uncertain',
          completedAt: 1_050,
        }),
      /outcome predates its prepared effect/,
    );

    const run = createHomeTextOrchestrator({
      store: value.store,
      executeProvider: async () => {
        throw new Error('preexisting provider attempts must not replay');
      },
      executeSpeech: async () => {
        throw new Error('provider recovery must not send speech');
      },
      now: () => 1_050,
    });
    await assert.rejects(run(), /recovery timestamp precedes durable state/);
    assert.equal(
      value.store.getIsolatedProviderOutcome(started.attempt.attemptId),
      null,
    );
    assert.equal(
      value.store.getEffect(started.attempt.attempt.effectId)?.status,
      'prepared',
    );
    assert.equal(
      value.store.getEffect(started.attempt.attempt.effectId)?.resolvedAt,
      null,
    );
    assert.equal(
      value.store.getBranch(started.attempt.attempt.branchId)?.status,
      'running',
    );
  } finally {
    value.close();
  }
});
