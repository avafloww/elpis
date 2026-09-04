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

test('Gateway broker dispatches Codex OAuth to its pinned endpoint with one session identity', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-codex-broker-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: Request[] = [];
  let randomByte = 0x21;
  const store = openGatewayStore(directory, {
    now: () => 1000,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
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

  const deceptive = store.providers.configureModel({
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
  });
  store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'codex/deceptive',
  });
  const deceptiveModel = store.llmProxy
    .catalogForInstance(instanceId)
    .models.find((candidate) => candidate.modelRef === 'codex/deceptive');
  assert.ok(deceptiveModel);
  const deceptivePayload = Buffer.from(
    JSON.stringify({ model: 'gpt-codex-deceptive', stream: true }),
  );
  await assert.rejects(
    store.llmProxy.dispatch({
      instanceId,
      model: deceptiveModel,
      request: {
        format: LLM_PROXY_FORMATS.request,
        requestId: 'egr1.MMMMMMMMMMMMMMMMMMMMMM',
        modelRef: deceptiveModel.modelRef,
        targetGeneration: deceptive.targetGeneration,
        route: 'codex/responses',
        transport: { kind: 'codex', sessionId: 'session-deceptive' },
        byteLength: deceptivePayload.byteLength,
        sha256: createHash('sha256').update(deceptivePayload).digest('hex'),
        payload: deceptivePayload,
      },
      signal: new AbortController().signal,
    }),
    /gateway LLM dispatch refused/,
  );
  assert.equal(calls.length, 3);

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
  const store = openGatewayStore(directory, {
    now: () => 1000,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.url === 'https://auth.openai.com/oauth/token') {
        refreshCalls += 1;
        sequence.push('refresh');
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get('refresh_token'), 'codex-refresh-before');
        return new Response(
          JSON.stringify({
            access_token: 'codex-access-after',
            refresh_token: 'codex-refresh-after',
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
      sequence.push('provider-after');
      assert.equal(
        request.headers.get('authorization'),
        'Bearer codex-access-after',
      );
      assert.equal(
        request.headers.get('chatgpt-account-id'),
        'codex-account-id',
      );
      return new Response(new Uint8Array([0x6f, 0x6b]), { status: 200 });
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
});
