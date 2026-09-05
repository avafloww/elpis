import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  LLM_PROXY_ERROR_CODES,
  LLM_PROXY_FORMATS,
  LLM_PROXY_GET_ROUTES,
  LLM_PROXY_HEADERS,
  LLM_PROXY_LIMITS,
  LLM_PROXY_PATHS,
  LLM_PROXY_PROVIDER_TYPES,
  LLM_PROXY_ROUTES,
  LLM_PROXY_SAFE_RESPONSE_HEADERS,
  LLM_PROXY_TOOL_TIERS,
  LlmProxyCodecError,
  authorizeLlmProxyRequest,
  decodeLlmProxyCatalog,
  decodeLlmProxyError,
  decodeLlmProxyRequest,
  decodeLlmResponseProvenance,
  encodeLlmResponseProvenance,
  isLlmTargetGeneration,
  isSafeLlmResponseHeader,
  newLlmTargetGeneration,
  serializeLlmProxyCatalog,
  serializeLlmProxyError,
  serializeLlmProxyRequest,
  type LlmProxyCatalog,
  type LlmProxyRequest,
  type LlmResponseProvenance,
} from '../src/index.js';

const requestId = 'egr1.AAAAAAAAAAAAAAAAAAAAAA' as const;
const targetGeneration = 'egt1.AAAAAAAAAAAAAAAAAAAAAA' as const;
const payload = Uint8Array.from([0x00, 0xff, 0x7b, 0x0a, 0x80]);
const sha256 = createHash('sha256').update(payload).digest('hex');
const none = Object.freeze({ kind: 'none' as const });

const request: LlmProxyRequest = {
  format: LLM_PROXY_FORMATS.request,
  requestId,
  modelRef: 'resident/gpt-5.4',
  targetGeneration,
  route: 'responses',
  transport: none,
  byteLength: payload.byteLength,
  sha256,
  payload,
};

const model = {
  modelRef: 'resident/gpt-5.4',
  targetGeneration,
  providerType: 'openai-compatible' as const,
  model: 'gpt-5.4-upstream',
  allowedRoutes: ['chat/completions', 'responses'] as const,
  contextSize: 272_000,
  reasoningEffort: 'high',
  reasoningSummary: null,
  reasoningContext: null,
  toolTier: 'strong' as const,
  externalThinking: false,
  toolContractVersion: 'elpis-run-v4',
  callTimeoutMs: 300_000,
  streamIdleTimeoutMs: 45_000,
};
const catalog: LlmProxyCatalog = {
  format: LLM_PROXY_FORMATS.catalog,
  revision: 7,
  models: [model],
};

function wire(value: LlmProxyRequest = request): Record<string, unknown> {
  return JSON.parse(serializeLlmProxyRequest(value)) as Record<string, unknown>;
}
function invalidRequest(value: unknown): void {
  assert.throws(
    () => decodeLlmProxyRequest(JSON.stringify(value)),
    (error) =>
      error instanceof LlmProxyCodecError &&
      error.message === 'invalid gateway LLM proxy input' &&
      error.code === 'invalid_request',
  );
}

function jsonRequest(
  body: Record<string, unknown>,
  overrides: Partial<LlmProxyRequest> = {},
): LlmProxyRequest {
  const encoded = Buffer.from(JSON.stringify(body));
  return {
    ...request,
    payload: encoded,
    byteLength: encoded.byteLength,
    sha256: createHash('sha256').update(encoded).digest('hex'),
    ...overrides,
  };
}

test('catalog model ordering preserves the producer punctuation contract', () => {
  const underscore = { ...model, modelRef: 'resident/m_', toolTier: null };
  const dash = { ...model, modelRef: 'resident/m-', toolTier: null };
  const ordered: LlmProxyCatalog = { ...catalog, models: [underscore, dash] };
  assert.ok(underscore.modelRef.localeCompare(dash.modelRef) < 0);
  assert.deepEqual(
    decodeLlmProxyCatalog(serializeLlmProxyCatalog(ordered)),
    ordered,
  );
  assert.throws(
    () => serializeLlmProxyCatalog({ ...ordered, models: [dash, underscore] }),
    LlmProxyCodecError,
  );
  assert.throws(
    () => serializeLlmProxyCatalog({ ...ordered, models: [dash, dash] }),
    LlmProxyCodecError,
  );
});

test('LLM HTTP v1 constants are independent, exact, and frozen', () => {
  assert.deepEqual(LLM_PROXY_PATHS, {
    catalog: '/api/v1/resident/llm/catalog',
    request: '/api/v1/resident/llm/request',
  });
  assert.equal(LLM_PROXY_HEADERS.provenance, 'x-elpis-llm-provenance');
  assert.deepEqual(LLM_PROXY_PROVIDER_TYPES, [
    'openai-compatible',
    'anthropic-oauth',
    'codex-oauth',
  ]);
  assert.deepEqual(LLM_PROXY_TOOL_TIERS, ['weak', 'medium', 'strong']);
  assert.deepEqual(LLM_PROXY_ROUTES, [
    'responses',
    'chat/completions',
    'messages',
    'codex/responses',
    'codex/models',
    'models',
  ]);
  assert.deepEqual(LLM_PROXY_GET_ROUTES, ['codex/models', 'models']);
  assert.ok(LLM_PROXY_ERROR_CODES.includes('stale_target'));
  assert.ok(LLM_PROXY_ERROR_CODES.includes('cancelled'));
  assert.ok(LLM_PROXY_LIMITS.payloadBytes > 0);
  for (const value of [
    LLM_PROXY_PATHS,
    LLM_PROXY_HEADERS,
    LLM_PROXY_FORMATS,
    LLM_PROXY_LIMITS,
    LLM_PROXY_PROVIDER_TYPES,
    LLM_PROXY_TOOL_TIERS,
    LLM_PROXY_ROUTES,
    LLM_PROXY_GET_ROUTES,
    LLM_PROXY_ERROR_CODES,
    LLM_PROXY_SAFE_RESPONSE_HEADERS,
  ])
    assert.ok(Object.isFrozen(value));
});

test('target generations use exact opaque egt1 public-id grammar', () => {
  assert.equal(isLlmTargetGeneration(targetGeneration), true);
  assert.equal(
    newLlmTargetGeneration(() => Buffer.alloc(16)),
    targetGeneration,
  );
  for (const value of [
    'egt1.short',
    'EGT1.AAAAAAAAAAAAAAAAAAAAAA',
    'egt1.AAAAAAAAAAAAAAAAAAAAA+',
    'egt1.AAAAAAAAAAAAAAAAAAAAAA.more',
    'egt1.AAAAAAAAAAAAAAAAAAAAAB',
    null,
  ])
    assert.equal(isLlmTargetGeneration(value), false);
  assert.throws(
    () => newLlmTargetGeneration(() => Buffer.alloc(15)),
    LlmProxyCodecError,
  );
});

test('request codec preserves exact payload bytes, owns copies, and freezes metadata', () => {
  const encoded = serializeLlmProxyRequest(request);
  const parsed = JSON.parse(encoded) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), [
    'format',
    'requestId',
    'modelRef',
    'targetGeneration',
    'route',
    'transport',
    'byteLength',
    'sha256',
    'payload',
  ]);
  assert.equal(parsed.payload, Buffer.from(payload).toString('base64'));
  assert.equal(parsed.byteLength, payload.byteLength);
  assert.equal(parsed.sha256, sha256);

  const mutable = Buffer.from(encoded);
  const decoded = decodeLlmProxyRequest(mutable);
  mutable.fill(0);
  assert.deepEqual(decoded.payload, payload);
  assert.notEqual(decoded.payload, payload);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.transport));
  decoded.payload[0] = 99;
  assert.equal(payload[0], 0);
});

test('request codec rejects malformed UTF-8/JSON, unknown fields, and oversized bodies input-independently', () => {
  const canonical = serializeLlmProxyRequest(request);
  const duplicateModelRef = canonical.replace(
    '{',
    '{"modelRef":"hidden/model",',
  );
  for (const body of [
    Uint8Array.from([0xc3, 0x28]),
    '{',
    'null',
    '[]',
    ' ' + canonical,
    duplicateModelRef,
    JSON.stringify({ ...wire(), secret: 'must-not-survive' }),
    JSON.stringify({ ...wire(), authorization: 'Bearer secret' }),
    ' '.repeat(LLM_PROXY_LIMITS.requestBodyBytes + 1),
  ]) {
    assert.throws(
      () => decodeLlmProxyRequest(body),
      (error) =>
        error instanceof LlmProxyCodecError &&
        error.message === 'invalid gateway LLM proxy input',
    );
  }
});

test('request exact base64, byte length, SHA-256, generation, route, and model ref are mandatory', () => {
  const valid = wire();
  for (const changed of [
    { ...valid, payload: (valid.payload as string).replace(/=$/, '') },
    { ...valid, payload: 'AP9_\n' },
    { ...valid, byteLength: payload.byteLength + 1 },
    { ...valid, byteLength: 1.5 },
    { ...valid, sha256: '0'.repeat(64) },
    { ...valid, sha256: sha256.toUpperCase() },
    { ...valid, targetGeneration: 'egt1.bad' },
    { ...valid, requestId: 'egr1.bad' },
    { ...valid, modelRef: 'Resident/gpt' },
    { ...valid, modelRef: 'resident//gpt' },
    { ...valid, modelRef: 'resident/gpt', route: '/responses' },
    { ...valid, format: 'elpis-gateway-llm-request-v2' },
  ])
    invalidRequest(changed);
});

test('request bounds and GET payload invariants are enforced', () => {
  const valid = wire();
  invalidRequest({
    ...valid,
    modelRef: 'a/' + 'b'.repeat(LLM_PROXY_LIMITS.modelRefBytes),
  });
  invalidRequest({
    ...valid,
    transport: {
      kind: 'codex',
      sessionId: 'x'.repeat(LLM_PROXY_LIMITS.transportIdBytes + 1),
      conversationId: 'c',
      clientRequestId: 'r',
    },
  });
  invalidRequest({ ...valid, route: 'models' });
  for (const route of LLM_PROXY_GET_ROUTES) {
    const empty = new Uint8Array();
    const got = decodeLlmProxyRequest(
      serializeLlmProxyRequest({
        ...request,
        route,
        transport: { kind: 'codex', sessionId: 'sess-1' },
        payload: empty,
        byteLength: 0,
        sha256: createHash('sha256').update(empty).digest('hex'),
      }),
    );
    assert.equal(got.payload.byteLength, 0);
  }
});

test('transport metadata is a closed none-or-Codex shape', () => {
  const valid = wire();
  const codex = {
    kind: 'codex' as const,
    sessionId: 'sess-1',
  };
  const decoded = decodeLlmProxyRequest(
    serializeLlmProxyRequest({
      ...request,
      route: 'codex/responses',
      transport: codex,
    }),
  );
  assert.deepEqual(decoded.transport, codex);
  assert.ok(Object.isFrozen(decoded.transport));
  for (const transport of [
    {},
    { kind: 'none', sessionId: 'secret' },
    { kind: 'codex' },
    { kind: 'codex', sessionId: 's', conversationId: 'c' },
    { kind: 'codex', sessionId: 's', cookie: 'secret' },
    { kind: 'codex', sessionId: 'bad\r\nheader' },
  ])
    invalidRequest({ ...valid, transport });
  invalidRequest({ ...valid, route: 'responses', transport: codex });
  invalidRequest({ ...valid, route: 'codex/responses', transport: none });
});

test('catalog authorization binds model generation route and exact payload model', () => {
  const allowed = jsonRequest({ model: model.model, input: 'hello' });
  const success = authorizeLlmProxyRequest(catalog, allowed);
  assert.equal(success.ok, true);
  if (success.ok) {
    assert.deepEqual(success.model, model);
    assert.ok(Object.isFrozen(success));
    assert.ok(Object.isFrozen(success.model));
  }

  assert.deepEqual(
    authorizeLlmProxyRequest(catalog, {
      ...allowed,
      modelRef: 'other/model',
    }),
    { ok: false, code: 'not_found' },
  );
  assert.deepEqual(
    authorizeLlmProxyRequest(catalog, {
      ...allowed,
      targetGeneration: 'egt1.AAAAAAAAAAAAAAAAAAAAAQ',
    }),
    { ok: false, code: 'stale_target' },
  );
  assert.deepEqual(
    authorizeLlmProxyRequest(catalog, { ...allowed, route: 'messages' }),
    { ok: false, code: 'route_not_allowed' },
  );
  assert.deepEqual(
    authorizeLlmProxyRequest(
      catalog,
      jsonRequest({ model: 'provider-admin-model', input: 'hello' }),
    ),
    { ok: false, code: 'forbidden' },
  );

  const duplicateModel = Buffer.from(
    `{"model":"provider-admin-model","model":"${model.model}","input":"hello"}`,
  );
  assert.throws(
    () =>
      authorizeLlmProxyRequest(catalog, {
        ...allowed,
        payload: duplicateModel,
        byteLength: duplicateModel.byteLength,
        sha256: createHash('sha256').update(duplicateModel).digest('hex'),
      }),
    LlmProxyCodecError,
  );
  assert.throws(
    () =>
      authorizeLlmProxyRequest(
        catalog,
        jsonRequest({ input: 'missing model' }),
      ),
    LlmProxyCodecError,
  );
});

test('catalog is versioned, bounded, sorted, unique, strict, and deeply frozen', () => {
  const encoded = serializeLlmProxyCatalog(catalog);
  const decoded = decodeLlmProxyCatalog(Buffer.from(encoded));
  assert.deepEqual(decoded, catalog);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.models));
  assert.ok(Object.isFrozen(decoded.models[0]));
  assert.ok(Object.isFrozen(decoded.models[0].allowedRoutes));
  const base = JSON.parse(encoded) as {
    format: string;
    revision: number;
    models: Array<Record<string, unknown>>;
  };
  assert.equal(base.revision, 7);
  const second = {
    ...base.models[0],
    modelRef: 'z/model',
    targetGeneration: 'egt1.AAAAAAAAAAAAAAAAAAAAAQ',
  };
  for (const bad of [
    { ...base, url: 'https://secret.invalid' },
    { ...base, revision: -1 },
    { ...base, revision: 1.5 },
    { ...base, models: [{ ...base.models[0], apiKey: 'secret' }] },
    {
      ...base,
      models: [
        {
          ...base.models[0],
          model: 'https://upstream.invalid/v1?api_key=SECRET',
        },
      ],
    },
    { ...base, models: [{ ...base.models[0], model: 'https:example.com/v1' }] },
    { ...base, models: [{ ...base.models[0], model: 'file:/etc/passwd' }] },
    {
      ...base,
      models: [
        {
          ...base.models[0],
          model: 'gopher://169.254.169.254/latest/meta-data',
        },
      ],
    },
    { ...base, models: [{ ...base.models[0], model: 'https:example.com' }] },
    { ...base, models: [{ ...base.models[0], model: 'invented:payload' }] },
    { ...base, models: [{ ...base.models[0], model: 'llama3.1:8b' }] },
    {
      ...base,
      models: [{ ...base.models[0], model: 'sk-proj-THIS_IS_A_SECRET' }],
    },
    { ...base, models: [{ ...base.models[0], model: 'api_key:SECRET' }] },
    { ...base, models: [{ ...base.models[0], model: 'safe-model\u202eexe' }] },
    { ...base, models: [{ ...base.models[0], externalThinking: true }] },
    { ...base, models: [{ ...base.models[0], allowedRoutes: ['messages'] }] },
    {
      ...base,
      models: [
        {
          ...base.models[0],
          providerType: 'anthropic-oauth',
          allowedRoutes: ['responses'],
        },
      ],
    },
    { ...base, models: [second, base.models[0]] },
    { ...base, models: [base.models[0], { ...base.models[0] }] },
    {
      ...base,
      models: [
        base.models[0],
        { ...second, toolTier: base.models[0].toolTier },
      ],
    },
    {
      ...base,
      models: [
        base.models[0],
        {
          ...second,
          modelRef: 'resident/other',
          providerType: 'anthropic-oauth',
          allowedRoutes: ['messages'],
          toolTier: null,
        },
      ],
    },
    {
      ...base,
      models: [
        { ...base.models[0], allowedRoutes: ['responses', 'chat/completions'] },
      ],
    },
    { ...base, models: [{ ...base.models[0], contextSize: 0 }] },
    {
      ...base,
      models: [
        {
          ...base.models[0],
          reasoningEffort: 'x'.repeat(LLM_PROXY_LIMITS.reasoningBytes + 1),
        },
      ],
    },
    {
      ...base,
      models: [
        { ...base.models[0], callTimeoutMs: LLM_PROXY_LIMITS.timeoutMs + 1 },
      ],
    },
  ])
    assert.throws(
      () => decodeLlmProxyCatalog(JSON.stringify(bad)),
      LlmProxyCodecError,
    );
  assert.throws(
    () =>
      decodeLlmProxyCatalog(' '.repeat(LLM_PROXY_LIMITS.catalogBodyBytes + 1)),
    LlmProxyCodecError,
  );
  assert.throws(
    () =>
      decodeLlmProxyCatalog(
        serializeLlmProxyCatalog(catalog).replace('{', '{"revision":999,'),
      ),
    LlmProxyCodecError,
  );
  for (const allowedModel of [
    'meta-llama/llama-3.1-8b-instruct',
    'qwen3.8-flash-next',
  ]) {
    const allowedCatalog = {
      ...catalog,
      models: [{ ...model, model: allowedModel }],
    };
    assert.equal(
      decodeLlmProxyCatalog(serializeLlmProxyCatalog(allowedCatalog)).models[0]
        .model,
      allowedModel,
    );
  }
});

test('typed broker errors expose only closed code and optional requestId', () => {
  for (const error of [
    {
      format: LLM_PROXY_FORMATS.error,
      code: 'stale_target' as const,
      requestId,
    },
    { format: LLM_PROXY_FORMATS.error, code: 'unauthorized' as const },
  ]) {
    const decoded = decodeLlmProxyError(serializeLlmProxyError(error));
    assert.deepEqual(decoded, error);
    assert.ok(Object.isFrozen(decoded));
  }
  const canonicalError = serializeLlmProxyError({
    format: LLM_PROXY_FORMATS.error,
    code: 'internal_error',
  });
  assert.throws(
    () =>
      decodeLlmProxyError(
        canonicalError.replace('{', '{"code":"unauthorized",'),
      ),
    LlmProxyCodecError,
  );
  for (const bad of [
    { format: LLM_PROXY_FORMATS.error, code: 'not_closed' },
    {
      format: LLM_PROXY_FORMATS.error,
      code: 'internal_error',
      message: 'raw upstream body',
    },
    {
      format: LLM_PROXY_FORMATS.error,
      code: 'internal_error',
      details: { token: 'secret' },
    },
    {
      format: LLM_PROXY_FORMATS.error,
      code: 'internal_error',
      rawBody: 'secret',
    },
  ])
    assert.throws(
      () => decodeLlmProxyError(JSON.stringify(bad)),
      LlmProxyCodecError,
    );
});

test('response provenance is complete before the raw body begins streaming', () => {
  const provenance: LlmResponseProvenance = {
    format: LLM_PROXY_FORMATS.responseProvenance,
    requestId,
    modelRef: request.modelRef,
    targetGeneration,
    route: request.route,
    status: 200,
    headers: Object.freeze([
      Object.freeze({ name: 'content-type', value: 'text/event-stream' }),
      Object.freeze({ name: 'x-request-id', value: 'upstream-1' }),
    ]),
  };
  const encoded = encodeLlmResponseProvenance(provenance);
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  const decoded = decodeLlmResponseProvenance(encoded);
  assert.deepEqual(decoded, provenance);
  assert.ok(Object.isFrozen(decoded));
  assert.ok(Object.isFrozen(decoded.headers));
  assert.ok(Object.isFrozen(decoded.headers[0]));
  const json = JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  ) as Record<string, unknown>;
  assert.equal(Object.hasOwn(json, 'body'), false);
  assert.equal(Object.hasOwn(json, 'byteLength'), false);
  assert.equal(Object.hasOwn(json, 'sha256'), false);
  assert.throws(
    () =>
      encodeLlmResponseProvenance({
        ...provenance,
        body: 'raw secret',
      } as never),
    LlmProxyCodecError,
  );
  for (const malformed of [
    encoded + '=',
    encoded + '!',
    '',
    'A'.repeat(LLM_PROXY_LIMITS.provenanceHeaderBytes + 1),
  ])
    assert.throws(
      () => decodeLlmResponseProvenance(malformed),
      LlmProxyCodecError,
    );
});

test('maximum useful provenance fits the default Node HTTP header budget', async (t) => {
  const wide: LlmResponseProvenance = {
    format: LLM_PROXY_FORMATS.responseProvenance,
    requestId,
    modelRef: request.modelRef,
    targetGeneration,
    route: request.route,
    status: 200,
    headers: Object.freeze([
      Object.freeze({ name: 'content-type', value: 'x'.repeat(700) }),
      Object.freeze({ name: 'request-id', value: 'y'.repeat(700) }),
      Object.freeze({ name: 'x-request-id', value: 'z'.repeat(700) }),
    ]),
  };
  const encoded = encodeLlmResponseProvenance(wide);
  assert.ok(encoded.length > 3_000);
  assert.ok(encoded.length <= LLM_PROXY_LIMITS.provenanceHeaderBytes);
  assert.throws(
    () =>
      encodeLlmResponseProvenance({
        ...wide,
        headers: Object.freeze([
          Object.freeze({ name: 'content-type', value: 'w'.repeat(1024) }),
          Object.freeze({
            name: 'openai-processing-ms',
            value: 'x'.repeat(1024),
          }),
          Object.freeze({ name: 'request-id', value: 'y'.repeat(1024) }),
          Object.freeze({ name: 'x-request-id', value: 'z'.repeat(1024) }),
        ]),
      }),
    LlmProxyCodecError,
  );

  const server = createServer((_request, response) => {
    response.setHeader(LLM_PROXY_HEADERS.provenance, encoded);
    response.end('ok');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${address.port}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get(LLM_PROXY_HEADERS.provenance), encoded);
  assert.equal(await response.text(), 'ok');
});

test('response header policy is a fixed lowercase allowlist excluding redirects and secrets', () => {
  for (const name of LLM_PROXY_SAFE_RESPONSE_HEADERS) {
    assert.equal(name, name.toLowerCase());
    assert.equal(isSafeLlmResponseHeader(name), true);
  }
  for (const name of [
    'set-cookie',
    'set-cookie2',
    'cookie',
    'authorization',
    'proxy-authenticate',
    'www-authenticate',
    'location',
    'refresh',
    'x-api-key',
    'chatgpt-account-id',
    'Set-Cookie',
  ])
    assert.equal(isSafeLlmResponseHeader(name), false);
});
