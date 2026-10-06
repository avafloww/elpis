import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MaterializedConfig } from '../src/config.js';
import { createIsolatedProviderExecutor } from '../src/context/isolated-provider-executor.js';
import { createHomeDiscordTextExecutor } from '../src/context/home-discord-text-executor.js';
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
    assert.equal(
      result.snapshot.outcome?.outcome.visibleText,
      'provider request rejected before dispatch',
    );
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
    assert.equal(
      result.snapshot.outcome?.outcome.visibleText,
      'provider request outcome is uncertain',
    );
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
