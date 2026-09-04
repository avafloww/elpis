import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_PATHS,
  decodeLlmProxyCatalog,
  serializeLlmProxyRequest,
  type LlmProxyRequest,
} from '@elpis/gateway-protocol';
import { createGatewayApplication } from '../src/main-app.js';
import { createNodeCredential, newGatewayInstanceId } from '../src/index.js';
import { GATEWAY_LLM_WIRE_GRAMMARS } from '../src/llm-broker.js';

test('Gateway application wires its private broker into resident HTTP routes', async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-application-'),
  );
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(publicRoot);
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway');
  let randomByte = 0x21;
  const upstream: Request[] = [];
  const app = createGatewayApplication({
    dataDirectory: path.join(directory, 'data'),
    publicRoot,
    listen: { host: '127.0.0.1', port: 0 },
    now: () => 1000,
    randomBytes: (size) => Buffer.alloc(size, randomByte++),
    llmFetch: async (input, init) => {
      const request = new Request(input, init);
      upstream.push(request);
      const response = request.url.startsWith('https://provider.example.com/')
        ? { status: 207, bytes: [0x61, 0x70, 0x70] }
        : request.url.startsWith('https://anthropic.example.com/')
          ? { status: 208, bytes: [0x61, 0x6e, 0x74, 0x68] }
          : request.url.startsWith('https://chatgpt.com/backend-api/')
            ? { status: 209, bytes: [0x63, 0x6f, 0x64, 0x65, 0x78] }
            : null;
      if (!response) throw new Error('unexpected synthetic provider target');
      return new Response(new Uint8Array(response.bytes), {
        status: response.status,
        headers: { 'content-type': 'application/octet-stream' },
      });
    },
  });
  t.after(async () => {
    await app.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  app.store.setPublicUrl('https://gateway.example');
  const grant = app.store.credentials.createEnrollmentGrant();
  const node = createNodeCredential((size) => Buffer.alloc(size, 0x41));
  const instanceId = newGatewayInstanceId((size) => Buffer.alloc(size, 0x42));
  app.store.credentials.enroll({
    grantToken: grant.token,
    instanceId,
    displayName: 'Aster',
    credentialId: node.id,
    credentialVerifier: node.verifier,
  });
  const credential = app.store.providers.installApiKeyCredential({
    providerId: 'ananke',
    accountRef: 'application-test',
    apiKey: 'synthetic-application-key',
  });
  const configured = app.store.providers.configureModel({
    credentialId: credential.credentialId,
    modelRef: 'ananke/application',
    baseUrl: 'https://provider.example.com/v1',
    model: 'upstream-application',
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
  app.store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'ananke/application',
  });
  const anthropicCredential = app.store.providers.installOAuthCredential({
    providerId: 'anthropic',
    providerType: 'anthropic-oauth',
    accountRef: 'application-anthropic',
    accountIdentity: {
      accountId: 'application-anthropic-id',
      authorizedAt: 900,
    },
    accessToken: 'synthetic-application-anthropic-access',
    refreshToken: 'synthetic-application-anthropic-refresh',
    expiresAt: 1000000,
  });
  const anthropicConfigured = app.store.providers.configureModel({
    credentialId: anthropicCredential.credentialId,
    modelRef: 'anthropic/application',
    baseUrl: 'https://anthropic.example.com/',
    model: 'claude-application',
    allowedRoutes: ['messages'],
    wireGrammar: { messages: GATEWAY_LLM_WIRE_GRAMMARS.messages },
    contextSize: 200000,
    reasoningEffort: null,
    reasoningSummary: null,
    reasoningContext: null,
    toolTier: 'medium',
    externalThinking: false,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 60000,
    streamIdleTimeoutMs: 60000,
  });
  app.store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'anthropic/application',
  });
  const codexCredential = app.store.providers.installOAuthCredential({
    providerId: 'codex',
    providerType: 'codex-oauth',
    accountRef: 'application-codex',
    accountIdentity: { accountId: 'application-codex-id', authorizedAt: 900 },
    accessToken: 'synthetic-application-codex-access',
    refreshToken: 'synthetic-application-codex-refresh',
    expiresAt: 1000000,
  });
  const codexConfigured = app.store.providers.configureModel({
    credentialId: codexCredential.credentialId,
    modelRef: 'codex/application',
    baseUrl: 'https://chatgpt.com/backend-api',
    model: 'gpt-codex-application',
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
  app.store.providers.grantModelToInstance({
    instanceId,
    modelRef: 'codex/application',
  });
  const address = await app.start();
  const root = `http://${address.host}:${address.port}`;
  const authorization = `Bearer ${node.token}`;
  const catalogResponse = await fetch(root + LLM_PROXY_PATHS.catalog, {
    headers: { authorization },
  });
  assert.equal(catalogResponse.status, 200);
  const catalog = decodeLlmProxyCatalog(await catalogResponse.text());
  assert.equal(catalog.models.length, 3);
  const send = async (options: {
    modelRef: string;
    targetGeneration: LlmProxyRequest['targetGeneration'];
    route: LlmProxyRequest['route'];
    transport: LlmProxyRequest['transport'];
    requestId: LlmProxyRequest['requestId'];
    payload: Buffer;
    status: number;
    body: Uint8Array;
  }) => {
    const model = catalog.models.find(
      (candidate) => candidate.modelRef === options.modelRef,
    );
    assert.ok(model);
    const request: LlmProxyRequest = {
      format: LLM_PROXY_FORMATS.request,
      requestId: options.requestId,
      modelRef: model.modelRef,
      targetGeneration: options.targetGeneration,
      route: options.route,
      transport: options.transport,
      byteLength: options.payload.byteLength,
      sha256: createHash('sha256').update(options.payload).digest('hex'),
      payload: options.payload,
    };
    const response = await fetch(root + LLM_PROXY_PATHS.request, {
      method: 'POST',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: serializeLlmProxyRequest(request),
    });
    assert.equal(response.status, options.status);
    assert.deepEqual(
      new Uint8Array(await response.arrayBuffer()),
      options.body,
    );
    return options.payload;
  };
  const payloads = [
    await send({
      modelRef: 'ananke/application',
      targetGeneration: configured.targetGeneration,
      route: 'responses',
      transport: { kind: 'none' },
      requestId: 'egr1.OOOOOOOOOOOOOOOOOOOOOO',
      payload: Buffer.from(
        JSON.stringify({ model: 'upstream-application', input: 'hello' }),
      ),
      status: 207,
      body: new Uint8Array([0x61, 0x70, 0x70]),
    }),
    await send({
      modelRef: 'anthropic/application',
      targetGeneration: anthropicConfigured.targetGeneration,
      route: 'messages',
      transport: { kind: 'none' },
      requestId: 'egr1.PPPPPPPPPPPPPPPPPPPPPP',
      payload: Buffer.from(
        JSON.stringify({
          model: 'claude-application',
          stream: true,
          messages: [],
        }),
      ),
      status: 208,
      body: new Uint8Array([0x61, 0x6e, 0x74, 0x68]),
    }),
    await send({
      modelRef: 'codex/application',
      targetGeneration: codexConfigured.targetGeneration,
      route: 'codex/responses',
      transport: { kind: 'codex', sessionId: 'application-session' },
      requestId: 'egr1.QQQQQQQQQQQQQQQQQQQQQQ',
      payload: Buffer.from(
        JSON.stringify({ model: 'gpt-codex-application', stream: true }),
      ),
      status: 209,
      body: new Uint8Array([0x63, 0x6f, 0x64, 0x65, 0x78]),
    }),
  ];
  assert.equal(upstream.length, 3);
  assert.equal(
    upstream[0].headers.get('authorization'),
    'Bearer synthetic-application-key',
  );
  assert.equal(
    upstream[1].headers.get('authorization'),
    'Bearer synthetic-application-anthropic-access',
  );
  assert.equal(
    upstream[2].headers.get('authorization'),
    'Bearer synthetic-application-codex-access',
  );
  assert.equal(
    upstream[2].headers.get('chatgpt-account-id'),
    'application-codex-id',
  );
  for (let index = 0; index < upstream.length; index += 1) {
    assert.deepEqual(
      new Uint8Array(await upstream[index].arrayBuffer()),
      new Uint8Array(payloads[index]),
    );
  }
});
