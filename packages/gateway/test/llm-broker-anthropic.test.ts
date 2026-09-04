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

test('Gateway broker dispatches Anthropic OAuth through a dispatch-local credential source', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-anthropic-broker-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: Request[] = [];
  let randomByte = 0x61;
  let unauthorizedMode = false;
  let unauthorizedAttempts = 0;
  let unauthorizedRefreshes = 0;
  const store = openGatewayStore(directory, {
    now: () => 1000,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      if (request.url === 'https://api.anthropic.com/v1/oauth/token') {
        unauthorizedRefreshes += 1;
        return new Response(
          JSON.stringify({
            access_token: 'synthetic-anthropic-access-after-401',
            refresh_token: 'synthetic-anthropic-refresh-after-401',
            expires_in: 3600,
            account: {
              uuid: 'private-anthropic-id',
              email_address: 'aster@example.com',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (unauthorizedMode) {
        unauthorizedAttempts += 1;
        if (unauthorizedAttempts === 1)
          return new Response(new Uint8Array([0x66, 0x69, 0x72, 0x73, 0x74]), {
            status: 401,
          });
        assert.equal(
          request.headers.get('authorization'),
          'Bearer synthetic-anthropic-access-after-401',
        );
        return new Response(
          new Uint8Array([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64]),
          {
            status: 401,
            headers: { 'x-request-id': 'second-401' },
          },
        );
      }
      return new Response(new Uint8Array([0x61, 0x6e, 0x74, 0x68]), {
        status: 202,
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const enrollment = store.credentials.createEnrollmentGrant();
  const node = createNodeCredential((size) => Buffer.alloc(size, 0x71));
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 0x72));
  store.credentials.enroll({
    grantToken: enrollment.token,
    instanceId,
    displayName: 'Aster',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const credential = store.providers.installOAuthCredential({
    providerId: 'anthropic',
    providerType: 'anthropic-oauth',
    accountRef: 'private-anthropic-account',
    accountIdentity: { accountId: 'private-anthropic-id', authorizedAt: 900 },
    accessToken: 'synthetic-anthropic-access',
    refreshToken: 'synthetic-anthropic-refresh',
    expiresAt: 1000000,
  });
  const configured = store.providers.configureModel({
    credentialId: credential.credentialId,
    modelRef: 'anthropic/strong',
    baseUrl: 'https://anthropic-provider.example.com/',
    model: 'claude-test',
    allowedRoutes: ['messages'],
    wireGrammar: { messages: GATEWAY_LLM_WIRE_GRAMMARS.messages },
    contextSize: 200000,
    reasoningEffort: null,
    reasoningSummary: null,
    reasoningContext: null,
    toolTier: 'strong',
    externalThinking: false,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 60000,
    streamIdleTimeoutMs: 60000,
  });
  store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'anthropic/strong',
  });
  const model = store.llmProxy.catalogForInstance(instanceId).models[0];
  const payload = Buffer.from(
    JSON.stringify({ model: 'claude-test', stream: true, messages: [] }),
  );
  const request: LlmProxyRequest = {
    format: LLM_PROXY_FORMATS.request,
    requestId: 'egr1.FFFFFFFFFFFFFFFFFFFFFF',
    modelRef: model.modelRef,
    targetGeneration: configured.targetGeneration,
    route: 'messages',
    transport: { kind: 'none' },
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
  assert.equal(exchange.status, 202);
  assert.deepEqual(
    new Uint8Array(await new Response(exchange.body).arrayBuffer()),
    new Uint8Array([0x61, 0x6e, 0x74, 0x68]),
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://anthropic-provider.example.com/v1/messages?beta=true',
  );
  assert.equal(calls[0].method, 'POST');
  assert.equal(
    calls[0].headers.get('authorization'),
    'Bearer synthetic-anthropic-access',
  );
  assert.equal(calls[0].headers.get('accept'), 'text/event-stream');
  assert.deepEqual(
    new Uint8Array(await calls[0].arrayBuffer()),
    new Uint8Array(payload),
  );

  unauthorizedMode = true;
  const unauthorizedRequest = {
    ...request,
    requestId: 'egr1.RRRRRRRRRRRRRRRRRRRRRR',
  } as LlmProxyRequest;
  const unauthorized = await store.llmProxy.dispatch({
    instanceId,
    model,
    request: unauthorizedRequest,
    signal: new AbortController().signal,
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(
    new Uint8Array(await new Response(unauthorized.body).arrayBuffer()),
    new Uint8Array([0x73, 0x65, 0x63, 0x6f, 0x6e, 0x64]),
  );
  assert.equal(unauthorizedAttempts, 2);
  assert.equal(unauthorizedRefreshes, 1);

  const visible = JSON.stringify({
    keys: Object.keys(store.llmProxy),
    catalog: store.llmProxy.catalogForInstance(instanceId),
    audit: store.audit(100),
  });
  for (const forbidden of [
    'synthetic-anthropic-access',
    'synthetic-anthropic-refresh',
    'anthropic-provider.example.com',
    'private-anthropic-account',
    'private-anthropic-id',
  ]) {
    assert.equal(visible.includes(forbidden), false);
  }
});

test('Anthropic OAuth refresh is single-flight, revision-CAS persisted, and reused after reopen', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-anthropic-refresh-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  let randomByte = 0x31;
  let tokenCalls = 0;
  let messageCalls = 0;
  let refreshStarted!: () => void;
  let releaseRefresh!: () => void;
  const started = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === 'https://api.anthropic.com/v1/oauth/token') {
      tokenCalls += 1;
      refreshStarted();
      await release;
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      assert.equal(body.refresh_token, 'expired-anthropic-refresh');
      return new Response(
        JSON.stringify({
          access_token: 'rotated-anthropic-access',
          refresh_token: 'rotated-anthropic-refresh',
          expires_in: 3600,
          account: {
            uuid: 'rotated-account-id',
            email_address: 'aster@example.com',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    assert.equal(
      request.url,
      'https://anthropic-refresh.example.com/v1/messages?beta=true',
    );
    assert.equal(
      request.headers.get('authorization'),
      'Bearer rotated-anthropic-access',
    );
    messageCalls += 1;
    return new Response(new Uint8Array([messageCalls]), { status: 200 });
  };
  let store = openGatewayStore(directory, {
    now: () => now,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: fetch,
  });
  const enrollment = store.credentials.createEnrollmentGrant();
  const node = createNodeCredential((size) => Buffer.alloc(size, 0x41));
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 0x42));
  store.credentials.enroll({
    grantToken: enrollment.token,
    instanceId,
    displayName: 'Aster',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const credential = store.providers.installOAuthCredential({
    providerId: 'anthropic',
    providerType: 'anthropic-oauth',
    accountRef: 'refresh-account',
    accountIdentity: { accountId: 'installed-account-id', authorizedAt: 900 },
    accessToken: 'expired-anthropic-access',
    refreshToken: 'expired-anthropic-refresh',
    expiresAt: now,
  });
  const configured = store.providers.configureModel({
    credentialId: credential.credentialId,
    modelRef: 'anthropic/refresh',
    baseUrl: 'https://anthropic-refresh.example.com/',
    model: 'claude-refresh',
    allowedRoutes: ['messages'],
    wireGrammar: { messages: GATEWAY_LLM_WIRE_GRAMMARS.messages },
    contextSize: 200000,
    reasoningEffort: null,
    reasoningSummary: null,
    reasoningContext: null,
    toolTier: 'strong',
    externalThinking: false,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 60000,
    streamIdleTimeoutMs: 60000,
  });
  store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'anthropic/refresh',
  });
  const model = store.llmProxy.catalogForInstance(instanceId).models[0];
  const payload = Buffer.from(
    JSON.stringify({ model: 'claude-refresh', stream: false, messages: [] }),
  );
  const makeRequest = (requestId: `egr1.${string}`): LlmProxyRequest => ({
    format: LLM_PROXY_FORMATS.request,
    requestId,
    modelRef: model.modelRef,
    targetGeneration: configured.targetGeneration,
    route: 'messages',
    transport: { kind: 'none' },
    byteLength: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
    payload,
  });
  const firstController = new AbortController();
  const first = store.llmProxy.dispatch({
    instanceId,
    model,
    request: makeRequest('egr1.GGGGGGGGGGGGGGGGGGGGGG'),
    signal: firstController.signal,
  });
  await started;
  const second = store.llmProxy.dispatch({
    instanceId,
    model,
    request: makeRequest('egr1.HHHHHHHHHHHHHHHHHHHHHH'),
    signal: new AbortController().signal,
  });
  const cancellation = new Error('synthetic refresh waiter cancelled');
  firstController.abort(cancellation);
  await assert.rejects(first, (error) => error === cancellation);
  let drained = false;
  const draining = store.llmProxy.drain().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  releaseRefresh();
  const exchange = await second;
  await new Response(exchange.body).arrayBuffer();
  await draining;
  assert.equal(drained, true);
  assert.equal(tokenCalls, 1);
  assert.equal(messageCalls, 1);
  assert.equal(
    store
      .audit(100)
      .filter((event) => event.action === 'provider.oauth.refresh').length,
    1,
  );

  store.close();
  now = 2000;
  store = openGatewayStore(directory, { now: () => now, llmFetch: fetch });
  const reopenedModel = store.llmProxy.catalogForInstance(instanceId).models[0];
  const reopened = await store.llmProxy.dispatch({
    instanceId,
    model: reopenedModel,
    request: makeRequest('egr1.IIIIIIIIIIIIIIIIIIIIII'),
    signal: new AbortController().signal,
  });
  await new Response(reopened.body).arrayBuffer();
  assert.equal(tokenCalls, 1);
  assert.equal(messageCalls, 2);
  store.close();
});
