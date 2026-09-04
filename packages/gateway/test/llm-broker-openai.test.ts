import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
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

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-gateway-llm-broker-'));
}

test('Gateway store dispatches an authorized OpenAI-compatible request without exposing custody', async (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls: Request[] = [];
  let randomByte = 0x41;
  let holdForAbort = false;
  let observedAbortReason: unknown;
  let markAbortFetchStarted!: () => void;
  const abortFetchStarted = new Promise<void>((resolve) => {
    markAbortFetchStarted = resolve;
  });
  const store = openGatewayStore(directory, {
    now: () => 1000,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: async (input, init) => {
      const witness = new DatabaseSync(path.join(directory, 'gateway.db'));
      try {
        witness.exec('BEGIN IMMEDIATE; ROLLBACK');
      } finally {
        witness.close();
      }
      const request = new Request(input, init);
      calls.push(request);
      if (holdForAbort) {
        markAbortFetchStarted();
        return new Promise<Response>((_resolve, reject) => {
          const onAbort = () => {
            observedAbortReason = request.signal.reason;
            reject(request.signal.reason);
          };
          request.signal.addEventListener('abort', onAbort, { once: true });
          if (request.signal.aborted) onAbort();
        });
      }
      return new Response(new Uint8Array([0x72, 0x61, 0x77]), {
        status: 207,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const enrollment = store.credentials.createEnrollmentGrant();
  const node = createNodeCredential((size) => Buffer.alloc(size, 0x51));
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 0x52));
  store.credentials.enroll({
    grantToken: enrollment.token,
    instanceId,
    displayName: 'Aster',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const credential = store.providers.installApiKeyCredential({
    providerId: 'ananke',
    accountRef: 'private-account-marker',
    apiKey: 'synthetic-secret-api-key',
  });
  const configured = store.providers.configureModel({
    credentialId: credential.credentialId,
    modelRef: 'ananke/weak',
    baseUrl: 'https://provider.example.com/v1',
    model: 'upstream-weak',
    allowedRoutes: ['responses'],
    wireGrammar: { responses: GATEWAY_LLM_WIRE_GRAMMARS.responses },
    contextSize: 32768,
    reasoningEffort: null,
    reasoningSummary: null,
    reasoningContext: null,
    toolTier: 'weak',
    externalThinking: false,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 60000,
    streamIdleTimeoutMs: 60000,
  });
  store.providers.grantModelToInstance({ instanceId, modelRef: 'ananke/weak' });
  const model = store.llmProxy.catalogForInstance(instanceId).models[0];
  const payload = Buffer.from(
    JSON.stringify({ model: 'upstream-weak', input: 'hello' }),
  );
  const request: LlmProxyRequest = {
    format: LLM_PROXY_FORMATS.request,
    requestId: 'egr1.DDDDDDDDDDDDDDDDDDDDDD',
    modelRef: model.modelRef,
    targetGeneration: configured.targetGeneration,
    route: 'responses',
    transport: { kind: 'none' },
    byteLength: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
    payload,
  };

  assert.deepEqual(store.llmProxy.authenticateNode(node.token), {
    instanceId,
    credentialId: node.id,
  });
  const exchange = await store.llmProxy.dispatch({
    instanceId,
    model,
    request,
    signal: new AbortController().signal,
  });
  assert.equal(exchange.status, 207);
  assert.deepEqual(
    new Uint8Array(await new Response(exchange.body).arrayBuffer()),
    new Uint8Array([0x72, 0x61, 0x77]),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://provider.example.com/v1/responses');
  assert.equal(calls[0].method, 'POST');
  assert.equal(
    calls[0].headers.get('authorization'),
    'Bearer synthetic-secret-api-key',
  );
  assert.deepEqual(
    new Uint8Array(await calls[0].arrayBuffer()),
    new Uint8Array(payload),
  );

  const rejectWithoutNetwork = async (
    input: Parameters<typeof store.llmProxy.dispatch>[0],
  ) => {
    const before = calls.length;
    await assert.rejects(store.llmProxy.dispatch(input));
    assert.equal(calls.length, before);
  };
  const dispatchInput = {
    instanceId,
    model,
    request,
    signal: new AbortController().signal,
  };
  holdForAbort = true;
  const controller = new AbortController();
  const cancellation = new Error('synthetic provider cancellation');
  const pending = store.llmProxy.dispatch({
    ...dispatchInput,
    signal: controller.signal,
  });
  await abortFetchStarted;
  controller.abort(cancellation);
  await assert.rejects(pending, (error) => error === cancellation);
  assert.equal(observedAbortReason, cancellation);
  holdForAbort = false;

  await rejectWithoutNetwork({
    ...dispatchInput,
    request: {
      ...request,
      targetGeneration: 'egt1.ZZZZZZZZZZZZZZZZZZZZZZ',
    },
  });
  await rejectWithoutNetwork({
    ...dispatchInput,
    request: { ...request, route: 'chat/completions' },
  });
  await rejectWithoutNetwork({
    ...dispatchInput,
    model: { ...model, toolContractVersion: 'changed-tools-v1' },
  });
  const aborted = new AbortController();
  aborted.abort();
  await rejectWithoutNetwork({ ...dispatchInput, signal: aborted.signal });

  assert.throws(
    () =>
      store.providers.configureModel({
        credentialId: credential.credentialId,
        modelRef: 'ananke/bad',
        baseUrl: 'https://provider.example.com/v1',
        model: 'upstream-bad',
        allowedRoutes: ['responses'],
        wireGrammar: { responses: 'unknown-openai-responses-v1' },
        contextSize: 32768,
        reasoningEffort: null,
        reasoningSummary: null,
        reasoningContext: null,
        toolTier: null,
        externalThinking: false,
        toolContractVersion: 'elpis-tools-v1',
        callTimeoutMs: 60000,
        streamIdleTimeoutMs: 60000,
      }),
    /provider model configuration failed/,
  );
  assert.equal(
    store.llmProxy
      .catalogForInstance(instanceId)
      .models.some((candidate) => candidate.modelRef === 'ananke/bad'),
    false,
  );

  store.providers.revokeModelFromInstance({
    instanceId,
    modelRef: 'ananke/weak',
  });
  await rejectWithoutNetwork(dispatchInput);
  store.providers.grantModelToInstance({ instanceId, modelRef: 'ananke/weak' });
  store.providers.disableModel({ modelRef: 'ananke/weak' });
  await rejectWithoutNetwork(dispatchInput);

  const publicText = JSON.stringify({
    keys: Object.keys(store.llmProxy),
    catalog: store.llmProxy.catalogForInstance(instanceId),
    audit: store.audit(100),
  });
  for (const forbidden of [
    'synthetic-secret-api-key',
    'provider.example.com',
    'private-account-marker',
  ])
    assert.equal(publicText.includes(forbidden), false);
});
