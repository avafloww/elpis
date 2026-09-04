import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  LLM_PROXY_FORMATS,
  type LlmProxyRequest,
} from '@elpis/gateway-protocol';
import {
  createNodeCredential,
  newGatewayInstanceId,
  openGatewayStore,
} from '../src/index.js';
import { GATEWAY_LLM_WIRE_GRAMMARS } from '../src/llm-broker.js';

function codexJwt(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.signature`;
}

test('Gateway broker dispatches Codex OAuth to its pinned endpoint with one session identity', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-codex-broker-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: Request[] = [];
  let randomByte = 0x21;
  let hostileCleanup:
    { controller: AbortController; cancellation: Error } | undefined;
  let refreshStarted!: () => void;
  let releaseRefresh!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshCalls = 0;
  const store = openGatewayStore(directory, {
    now: () => 1000,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://auth.openai.com/oauth/token') {
        refreshCalls += 1;
        refreshStarted();
        await release;
        const form = new URLSearchParams(await request.text());
        assert.equal(
          form.get('refresh_token'),
          'synthetic-codex-refresh-cas-expired',
        );
        return new Response(
          JSON.stringify({
            access_token: 'synthetic-codex-access-cas-refreshed',
            refresh_token: 'synthetic-codex-refresh-cas-refreshed',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      calls.push(request);
      if (hostileCleanup) {
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel: () => {
              hostileCleanup?.controller.abort(hostileCleanup.cancellation);
              return new Promise<void>(() => undefined);
            },
          }),
          { status: 401 },
        );
      }
      return new Response(new Uint8Array([0x63, 0x6f, 0x64, 0x65, 0x78]), {
        status: 206,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const enrollment = store.credentials.createEnrollmentGrant();
  const node = createNodeCredential((size) => Buffer.alloc(size, 0x31));
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 0x32));
  store.credentials.enroll({
    grantToken: enrollment.token,
    instanceId,
    displayName: 'Aster',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const credential = store.providers.installOAuthCredential({
    providerId: 'codex',
    providerType: 'codex-oauth',
    accountRef: 'private-codex-account',
    accountIdentity: {
      accountId: 'synthetic-chatgpt-account',
      authorizedAt: 900,
    },
    accessToken: 'synthetic-codex-access',
    refreshToken: 'synthetic-codex-refresh',
    expiresAt: 1000000,
  });
  const configured = store.providers.configureModel({
    credentialId: credential.credentialId,
    modelRef: 'codex/strong',
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-codex-test',
    allowedRoutes: ['codex/models', 'codex/responses', 'models'],
    wireGrammar: {
      'codex/models': GATEWAY_LLM_WIRE_GRAMMARS.codexModels,
      'codex/responses': GATEWAY_LLM_WIRE_GRAMMARS.codexResponses,
      models: GATEWAY_LLM_WIRE_GRAMMARS.models,
    },
    contextSize: 272000,
    reasoningEffort: 'high',
    reasoningSummary: 'auto',
    reasoningContext: 'opaque',
    toolTier: 'strong',
    externalThinking: true,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 60000,
    streamIdleTimeoutMs: 60000,
  });
  store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'codex/strong',
  });
  const model = store.llmProxy.catalogForInstance(instanceId).models[0];
  const payload = Buffer.from(
    JSON.stringify({ model: 'gpt-codex-test', stream: true, input: 'hello' }),
  );
  const request: LlmProxyRequest = {
    format: LLM_PROXY_FORMATS.request,
    requestId: 'egr1.JJJJJJJJJJJJJJJJJJJJJJ',
    modelRef: model.modelRef,
    targetGeneration: configured.targetGeneration,
    route: 'codex/responses',
    transport: { kind: 'codex', sessionId: 'session-one' },
    byteLength: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
    payload,
  };

  const exchange = await store.llmProxy.dispatch({
    instanceId,
    model,
    request,
    signal: new AbortController().signal,
  });
  assert.equal(exchange.status, 206);
  assert.deepEqual(
    new Uint8Array(await new Response(exchange.body).arrayBuffer()),
    new Uint8Array([0x63, 0x6f, 0x64, 0x65, 0x78]),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(calls[0].method, 'POST');
  assert.equal(
    calls[0].headers.get('authorization'),
    'Bearer synthetic-codex-access',
  );
  assert.equal(
    calls[0].headers.get('chatgpt-account-id'),
    'synthetic-chatgpt-account',
  );
  assert.equal(calls[0].headers.get('session_id'), 'session-one');
  assert.equal(calls[0].headers.get('conversation_id'), 'session-one');
  assert.equal(calls[0].headers.get('x-client-request-id'), 'session-one');
  assert.deepEqual(
    new Uint8Array(await calls[0].arrayBuffer()),
    new Uint8Array(payload),
  );

  const emptyPayload = new Uint8Array();
  const dispatchGet = async (
    route: 'codex/models' | 'models',
    requestId: `egr1.${string}`,
  ) =>
    store.llmProxy.dispatch({
      instanceId,
      model,
      request: {
        ...request,
        requestId,
        route,
        byteLength: 0,
        sha256: createHash('sha256').update(emptyPayload).digest('hex'),
        payload: emptyPayload,
      },
      signal: new AbortController().signal,
    });
  const firstGet = await dispatchGet('models', 'egr1.KKKKKKKKKKKKKKKKKKKKKK');
  await new Response(firstGet.body).arrayBuffer();
  const secondGet = await dispatchGet(
    'codex/models',
    'egr1.LLLLLLLLLLLLLLLLLLLLLL',
  );
  await new Response(secondGet.body).arrayBuffer();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/models');
  assert.equal(calls[1].method, 'GET');
  assert.equal((await calls[1].arrayBuffer()).byteLength, 0);
  assert.equal(calls[2].url, 'https://chatgpt.com/backend-api/codex/models');
  assert.equal(calls[2].method, 'GET');
  assert.equal((await calls[2].arrayBuffer()).byteLength, 0);

  const admittedBeforeRotation = dispatchGet(
    'models',
    'egr1.SSSSSSSSSSSSSSSSSSSSSS',
  );
  store.providers.refreshOAuthCredential({
    credentialId: credential.credentialId,
    expectedSecretRevision: 0,
    accessToken: 'synthetic-codex-access-rotated',
    refreshToken: 'synthetic-codex-refresh-rotated',
    expiresAt: 2000000,
  });
  await new Response((await admittedBeforeRotation).body).arrayBuffer();
  assert.equal(
    calls[3].headers.get('authorization'),
    'Bearer synthetic-codex-access',
  );
  await new Response(
    (await dispatchGet('models', 'egr1.TTTTTTTTTTTTTTTTTTTTTT')).body,
  ).arrayBuffer();
  assert.equal(
    calls[4].headers.get('authorization'),
    'Bearer synthetic-codex-access-rotated',
  );

  store.providers.refreshOAuthCredential({
    credentialId: credential.credentialId,
    expectedSecretRevision: 1,
    accessToken: 'synthetic-codex-access-expired',
    refreshToken: 'synthetic-codex-refresh-expired',
    expiresAt: 1000,
  });
  const expiredBeforeRotation = dispatchGet(
    'models',
    'egr1.VVVVVVVVVVVVVVVVVVVVVV',
  );
  store.providers.refreshOAuthCredential({
    credentialId: credential.credentialId,
    expectedSecretRevision: 2,
    accessToken: 'synthetic-codex-access-after-revoke',
    refreshToken: 'synthetic-codex-refresh-after-revoke',
    expiresAt: 3000000,
  });
  store.providers.revokeModelFromInstance({
    instanceId,
    modelRef: model.modelRef,
  });
  await assert.rejects(
    expiredBeforeRotation,
    /gateway LLM provider dispatch failed/,
  );
  assert.equal(refreshCalls, 0);
  assert.equal(calls.length, 5);
  store.providers.grantModelToInstance({
    instanceId,
    modelRef: model.modelRef,
  });

  store.providers.refreshOAuthCredential({
    credentialId: credential.credentialId,
    expectedSecretRevision: 3,
    accessToken: 'synthetic-codex-access-cas-expired',
    refreshToken: 'synthetic-codex-refresh-cas-expired',
    expiresAt: 1000,
  });
  const losesCas = dispatchGet('models', 'egr1.WWWWWWWWWWWWWWWWWWWWWW');
  await started;
  store.providers.refreshOAuthCredential({
    credentialId: credential.credentialId,
    expectedSecretRevision: 4,
    accessToken: 'synthetic-codex-access-cas-winner',
    refreshToken: 'synthetic-codex-refresh-cas-winner',
    expiresAt: 4000000,
  });
  store.providers.revokeModelFromInstance({
    instanceId,
    modelRef: model.modelRef,
  });
  releaseRefresh();
  await assert.rejects(losesCas, /gateway LLM provider dispatch failed/);
  assert.equal(refreshCalls, 1);
  assert.equal(calls.length, 5);
  store.providers.grantModelToInstance({
    instanceId,
    modelRef: model.modelRef,
  });

  assert.throws(
    () =>
      store.providers.configureModel({
        credentialId: credential.credentialId,
        modelRef: 'codex/deceptive',
        baseUrl: 'https://upstream.example.com/',
        model: 'gpt-codex-deceptive',
        allowedRoutes: ['codex/responses'],
        wireGrammar: {
          'codex/responses': GATEWAY_LLM_WIRE_GRAMMARS.codexResponses,
        },
        contextSize: 272000,
        reasoningEffort: 'high',
        reasoningSummary: 'auto',
        reasoningContext: 'opaque',
        toolTier: null,
        externalThinking: true,
        toolContractVersion: 'elpis-tools-v1',
        callTimeoutMs: 60000,
        streamIdleTimeoutMs: 60000,
      }),
    /provider model configuration failed/,
  );
  assert.equal(
    store.llmProxy
      .catalogForInstance(instanceId)
      .models.some((candidate) => candidate.modelRef === 'codex/deceptive'),
    false,
  );
  assert.equal(calls.length, 5);

  const hostileController = new AbortController();
  const cancellation = new Error('synthetic broker cleanup cancellation');
  hostileCleanup = { controller: hostileController, cancellation };
  const hostileResult = await Promise.race([
    store.llmProxy
      .dispatch({
        instanceId,
        model,
        request: {
          ...request,
          requestId: 'egr1.UUUUUUUUUUUUUUUUUUUUUU',
        },
        signal: hostileController.signal,
      })
      .then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
    new Promise<{ kind: 'timed-out' }>((resolve) => {
      const timer = setTimeout(() => resolve({ kind: 'timed-out' }), 500);
      timer.unref();
    }),
  ]);
  assert.deepEqual(hostileResult, { kind: 'rejected', error: cancellation });
  const drainResult = await Promise.race([
    store.llmProxy.drain().then(() => 'drained' as const),
    new Promise<'timed-out'>((resolve) => {
      const timer = setTimeout(() => resolve('timed-out'), 500);
      timer.unref();
    }),
  ]);
  assert.equal(drainResult, 'drained');
  assert.equal(calls.length, 6);

  const visible = JSON.stringify({
    keys: Object.keys(store.llmProxy),
    catalog: store.llmProxy.catalogForInstance(instanceId),
    audit: store.audit(100),
  });
  for (const forbidden of [
    'synthetic-codex-access',
    'synthetic-codex-refresh',
    'synthetic-chatgpt-account',
    'private-codex-account',
  ])
    assert.equal(visible.includes(forbidden), false);
});

test('Codex 401 performs one pinned refresh, persists it, and retries once', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-codex-refresh-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sequence: string[] = [];
  let randomByte = 0x51;
  let providerCalls = 0;
  let refreshCalls = 0;
  const accessAfter = codexJwt('codex-account-id');
  const driftedAccess = codexJwt('different-account-id');
  const store = openGatewayStore(directory, {
    now: () => 1000,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://auth.openai.com/oauth/token') {
        refreshCalls += 1;
        sequence.push('refresh');
        const form = new URLSearchParams(await request.text());
        assert.equal(
          form.get('refresh_token'),
          refreshCalls === 1 ? 'codex-refresh-before' : 'codex-refresh-after',
        );
        return new Response(
          JSON.stringify({
            access_token: refreshCalls === 1 ? accessAfter : driftedAccess,
            refresh_token:
              refreshCalls === 1
                ? 'codex-refresh-after'
                : 'codex-refresh-drifted',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      assert.equal(
        request.url,
        'https://chatgpt.com/backend-api/codex/responses',
      );
      providerCalls += 1;
      if (providerCalls === 1) {
        sequence.push('provider-before');
        assert.equal(
          request.headers.get('authorization'),
          'Bearer codex-access-before',
        );
        return new Response('expired', { status: 401 });
      }
      assert.equal(
        request.headers.get('authorization'),
        `Bearer ${accessAfter}`,
      );
      assert.equal(
        request.headers.get('chatgpt-account-id'),
        'codex-account-id',
      );
      if (providerCalls === 2) {
        sequence.push('provider-after');
        return new Response(new Uint8Array([0x6f, 0x6b]), { status: 200 });
      }
      if (providerCalls === 3) {
        sequence.push('provider-before-drift');
        return new Response('expired-again', { status: 401 });
      }
      sequence.push('provider-preserved');
      return new Response(new Uint8Array([0x73, 0x61, 0x66, 0x65]), {
        status: 200,
      });
    },
  });
  const enrollment = store.credentials.createEnrollmentGrant();
  const node = createNodeCredential((size) => Buffer.alloc(size, 0x61));
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 0x62));
  store.credentials.enroll({
    grantToken: enrollment.token,
    instanceId,
    displayName: 'Aster',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const credential = store.providers.installOAuthCredential({
    providerId: 'codex',
    providerType: 'codex-oauth',
    accountRef: 'codex-refresh-account',
    accountIdentity: { accountId: 'codex-account-id', authorizedAt: 900 },
    accessToken: 'codex-access-before',
    refreshToken: 'codex-refresh-before',
    expiresAt: 1000000,
  });
  const configured = store.providers.configureModel({
    credentialId: credential.credentialId,
    modelRef: 'codex/refresh',
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-codex-refresh',
    allowedRoutes: ['codex/responses'],
    wireGrammar: {
      'codex/responses': GATEWAY_LLM_WIRE_GRAMMARS.codexResponses,
    },
    contextSize: 272000,
    reasoningEffort: 'high',
    reasoningSummary: 'auto',
    reasoningContext: 'opaque',
    toolTier: 'strong',
    externalThinking: true,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 60000,
    streamIdleTimeoutMs: 60000,
  });
  store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'codex/refresh',
  });
  const model = store.llmProxy.catalogForInstance(instanceId).models[0];
  const payload = Buffer.from(
    JSON.stringify({ model: 'gpt-codex-refresh', stream: true }),
  );
  const request: LlmProxyRequest = {
    format: LLM_PROXY_FORMATS.request,
    requestId: 'egr1.NNNNNNNNNNNNNNNNNNNNNN',
    modelRef: model.modelRef,
    targetGeneration: configured.targetGeneration,
    route: 'codex/responses',
    transport: { kind: 'codex', sessionId: 'session-refresh' },
    byteLength: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
    payload,
  };

  const exchange = await store.llmProxy.dispatch({
    instanceId,
    model,
    request,
    signal: new AbortController().signal,
  });
  assert.equal(exchange.status, 200);
  assert.deepEqual(
    new Uint8Array(await new Response(exchange.body).arrayBuffer()),
    new Uint8Array([0x6f, 0x6b]),
  );
  assert.deepEqual(sequence, ['provider-before', 'refresh', 'provider-after']);
  assert.equal(providerCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.equal(
    store
      .audit(100)
      .filter((event) => event.action === 'provider.oauth.refresh').length,
    1,
  );

  await assert.rejects(
    store.llmProxy.dispatch({
      instanceId,
      model,
      request: {
        ...request,
        requestId: 'egr1.OOOOOOOOOOOOOOOOOOOOOO',
      },
      signal: new AbortController().signal,
    }),
    /gateway LLM provider dispatch failed/,
  );
  assert.equal(providerCalls, 3);
  assert.equal(refreshCalls, 2);
  assert.equal(
    store
      .audit(100)
      .filter((event) => event.action === 'provider.oauth.refresh').length,
    1,
  );

  const preserved = await store.llmProxy.dispatch({
    instanceId,
    model,
    request: {
      ...request,
      requestId: 'egr1.PPPPPPPPPPPPPPPPPPPPPP',
    },
    signal: new AbortController().signal,
  });
  assert.deepEqual(
    new Uint8Array(await new Response(preserved.body).arrayBuffer()),
    new Uint8Array([0x73, 0x61, 0x66, 0x65]),
  );
  assert.equal(providerCalls, 4);
  assert.equal(refreshCalls, 2);
  assert.deepEqual(sequence, [
    'provider-before',
    'refresh',
    'provider-after',
    'provider-before-drift',
    'refresh',
    'provider-preserved',
  ]);
});
