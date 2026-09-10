import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stringify } from 'yaml';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_PATHS,
  createNodeCredential,
  serializeLlmProxyCatalog,
  type LlmProxyCatalogModel,
  type LlmProxyCatalog,
} from '@elpis/gateway-protocol';
import {
  loadConfigFile,
  configForLlmRef,
  configForLlmRole,
  requireMaterializedConfig,
} from '../src/config.js';
import {
  GatewayLlmClient,
  type GatewayLlmResidentStore,
  type GatewayLlmFetch,
} from '../src/llm/gateway-client.js';
import {
  GatewayResidentStateError,
  type GatewayResidentPhase,
  type GatewayResidentSnapshot,
} from '../src/store/gateway-resident.js';
import { createLLM, fetchContextWindow } from '../src/llm/llm.js';
import { createLlmToolRuntime } from '../src/llm/tool-runtime.js';
import {
  replayIdentityForConfig,
  TOOL_CONTRACT_VERSION,
} from '../src/llm/provenance.js';
import { makeStubLLM } from './helpers.js';

// Proposed public boundary: materializeGatewayConfig(parsed, { store, fetch }).
// The implementation constructs one real GatewayLlmClient from that exact store
// and transport; an independently bound client is deliberately not injectable.
// Only the not-yet-existing module is optional at load time. Each case requires
// its export BEFORE testing rejection, so missing implementation cannot make a
// negative contract pass. No substitute materializer or source stub is used.
const moduleUrl = new URL(
  '../src/llm/gateway-managed-config.js',
  import.meta.url,
);
const implementation = await import(moduleUrl.href).catch((error) => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === moduleUrl.href)
    return null;
  throw error;
});
function materializer() {
  assert.equal(
    typeof implementation?.materializeGatewayConfig,
    'function',
    'Gateway catalog materializer unavailable: implement public materializeGatewayConfig',
  );
  return implementation!.materializeGatewayConfig;
}
// Store/config origins omit the slash; canonical replay authority includes it.
const endpoint = 'https://gateway.example.com';
const replayAuthority = endpoint + '/';
const credential = createNodeCredential((size) => Buffer.alloc(size, 1));
const secondCredential = createNodeCredential((size) => Buffer.alloc(size, 2));
const roles = {
  main: 'team/main',
  classifier: 'team/chat',
  motor: null,
  secretary: null,
  compaction: null,
};
function model(
  modelRef: string,
  overrides: Partial<LlmProxyCatalogModel> = {},
): LlmProxyCatalogModel {
  return {
    modelRef,
    targetGeneration: ('egt1.' +
      Buffer.from(modelRef.padEnd(16, '_'))
        .subarray(0, 16)
        .toString('base64url')) as LlmProxyCatalogModel['targetGeneration'],
    providerType: 'openai-compatible',
    model: 'upstream-' + modelRef.split('/')[1],
    allowedRoutes: ['responses'],
    contextSize: 128000,
    reasoningEffort: 'high',
    reasoningSummary: 'detailed',
    reasoningContext: 'preserved',
    toolTier: null,
    externalThinking: false,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    callTimeoutMs: 43000,
    streamIdleTimeoutMs: 17000,
    ...overrides,
  };
}
function models() {
  return [
    model('team/main', {
      allowedRoutes: ['chat/completions', 'responses'],
      toolTier: 'strong',
    }),
    model('team/chat', {
      allowedRoutes: ['chat/completions'],
      toolTier: 'weak',
    }),
    model('other/main', {
      providerType: 'anthropic-oauth',
      allowedRoutes: ['messages'],
      toolTier: 'medium',
      contextSize: 200000,
      reasoningEffort: null,
      reasoningSummary: null,
      reasoningContext: null,
      callTimeoutMs: 51000,
    }),
    model('code/codex', {
      providerType: 'codex-oauth',
      allowedRoutes: ['models', 'codex/models', 'codex/responses'],
      externalThinking: true,
    }),
    model('code/discovery', {
      providerType: 'codex-oauth',
      allowedRoutes: ['models', 'codex/models'],
    }),
    model('code/response-only', {
      providerType: 'codex-oauth',
      allowedRoutes: ['codex/responses'],
    }),
    model('code/models-only', {
      providerType: 'codex-oauth',
      allowedRoutes: ['models'],
    }),
    model('code/codex-models-only', {
      providerType: 'codex-oauth',
      allowedRoutes: ['codex/models'],
    }),
    model('team/old', { toolContractVersion: 'old-contract' }),
    model('team/unknown-context', { contextSize: null }),
  ];
}
function parsed(direct = false) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-materialization-'),
  );
  try {
    const file = path.join(root, 'config.yaml');
    fs.writeFileSync(
      file,
      stringify({
        llm: direct
          ? {
              api_key: 'direct-fixture',
              base_url: 'https://upstream.example/v1',
              model: 'direct',
            }
          : { gateway_managed: true, roles, completion_reserve_tokens: 4096 },
        discord: {
          bot_token:
            Buffer.from('1001').toString('base64url') + '.fixture.token',
          guilds: [
            { id: 'guild-1', slug: 'home', channels: { '1001': 'direct' } },
          ],
        },
        paths: { data_directory: root },
      }),
    );
    const config = loadConfigFile(file);
    config.dashboard.remote = { url: endpoint, enrollmentToken: null };
    return config;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
function snapshot(
  phase: GatewayResidentPhase = 'active',
): GatewayResidentSnapshot {
  const idle = phase === 'idle';
  const enrolling = phase === 'enrolling';
  const rotating = phase === 'rotating';
  return {
    instanceId: 'egi1.AAAAAAAAAAAAAAAAAAAAAA',
    phase,
    endpoint: idle ? null : endpoint,
    displayName: idle ? null : 'Fixture',
    requestId: enrolling || rotating ? 'egr1.AAAAAAAAAAAAAAAAAAAAAA' : null,
    activeCredentialId: idle || enrolling ? null : credential.id,
    pendingCredentialId: enrolling || rotating ? secondCredential.id : null,
    createdAt: 1,
    updatedAt: 4,
    enrollmentStartedAt: idle ? null : 2,
    activatedAt: idle || enrolling ? null : 3,
    rotationStartedAt: rotating ? 4 : null,
    rotationProposedAt: null,
  };
}
function harness(
  catalogModels = models(),
  phase: GatewayResidentPhase = 'active',
) {
  const config = parsed();
  let state = snapshot(phase);
  let reads = 0,
    fetches = 0,
    tokenReads = 0;
  let missingToken = false;
  let onFetch: () => void | Promise<void> = () => {};
  const events: string[] = [];
  const store: GatewayLlmResidentStore = {
    read: () => {
      reads++;
      events.push('read');
      return Object.freeze({ ...state });
    },
    activeNodeToken: () => {
      tokenReads++;
      events.push('active-token');
      if (
        missingToken ||
        (state.phase !== 'active' && state.phase !== 'rotating')
      )
        throw new GatewayResidentStateError('invalid_state');
      return state.activeCredentialId === secondCredential.id
        ? secondCredential.token
        : credential.token;
    },
  };
  const catalog = {
    format: LLM_PROXY_FORMATS.catalog,
    revision: 73,
    models: catalogModels
      .map((m) => ({ ...m, allowedRoutes: [...m.allowedRoutes].sort() }))
      .sort((a, b) => a.modelRef.localeCompare(b.modelRef)),
  };
  // Exercise the strict protocol encoder and the REAL client's decoder/auth seam.
  const wire = serializeLlmProxyCatalog(catalog);
  const transport: GatewayLlmFetch = async (url, init) => {
    fetches++;
    events.push('fetch-enter');
    assert.equal(url, endpoint + LLM_PROXY_PATHS.catalog);
    assert.equal(init.method, 'GET');
    assert.equal(
      new Headers(init.headers).get('authorization'),
      'Bearer ' +
        (state.activeCredentialId === secondCredential.id
          ? secondCredential.token
          : credential.token),
    );
    await onFetch();
    events.push('fetch-complete');
    return new Response(wire, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  };
  return {
    config,
    catalog,
    store,
    fetch: transport,
    events,
    get reads() {
      return reads;
    },
    get tokenReads() {
      return tokenReads;
    },
    get fetches() {
      return fetches;
    },
    changeState(change: Partial<GatewayResidentSnapshot>) {
      state = { ...state, ...change };
    },
    removeActiveToken() {
      missingToken = true;
    },
    duringFetch(action: typeof onFetch) {
      onFetch = action;
    },
  };
}
function observeCatalogClient(t: TestContext, h: ReturnType<typeof harness>) {
  const realFetchCatalog = GatewayLlmClient.prototype.fetchCatalog;
  t.mock.method(
    GatewayLlmClient.prototype,
    'fetchCatalog',
    async function (
      this: GatewayLlmClient,
      ...args: Parameters<typeof realFetchCatalog>
    ) {
      h.events.push('client-fetch-enter');
      const catalog = await realFetchCatalog.apply(this, args);
      h.events.push('client-fetch-complete');
      return catalog;
    },
  );
}
function assertFetchOrdering(h: ReturnType<typeof harness>) {
  assert.equal(h.events.filter((e) => e === 'client-fetch-enter').length, 1);
  assert.equal(h.events.filter((e) => e === 'client-fetch-complete').length, 1);
  const clientEntry = h.events.indexOf('client-fetch-enter');
  const clientComplete = h.events.indexOf('client-fetch-complete');
  assert.ok(
    h.events.slice(0, clientEntry).includes('read'),
    'materializer prevalidation must precede the real client call',
  );
  assert.ok(
    h.events.slice(clientComplete + 1).includes('read'),
    'materializer revalidation must follow real client decode completion',
  );
  const entry = h.events.indexOf('fetch-enter');
  const complete = h.events.indexOf('fetch-complete');
  assert.ok(entry >= 0 && complete > entry);
  // One read belongs to GatewayLlmClient; an additional read must prevalidate
  // the materializer's dashboard/store authority BEFORE issuing any HTTP.
  assert.ok(h.events.slice(0, entry).filter((e) => e === 'read').length >= 2);
  assert.ok(h.events.slice(0, entry).includes('active-token'));
  assert.ok(
    h.events.slice(complete + 1).includes('read'),
    'materializer must revalidate state after catalog fetch completion',
  );
}
function deeplyFrozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) deeplyFrozen(child);
}
function noDirectCredentials(llm: Record<string, unknown>) {
  // Schema-local absence checks, NOT a recursive generic key blacklist:
  // metadata with incidental names must not be mistaken for direct config.
  const registry = llm.registry as
    { models?: Record<string, unknown> } | undefined;
  const locations = [
    llm,
    llm.target,
    registry,
    ...Object.values(registry?.models ?? {}),
  ];
  for (const location of locations) {
    if (!location || typeof location !== 'object') continue;
    for (const key of ['apiKey', 'baseUrl', 'providers', 'provider'])
      assert.equal(Object.hasOwn(location, key), false, key);
  }
}
function noRetainedSecrets(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of [credential.token, secondCredential.token])
    assert.equal(
      serialized.includes(secret),
      false,
      'resident secret retained',
    );
}
function configSnapshot(config: ReturnType<typeof parsed>) {
  const { logger: _logger, ...serializable } = config;
  return structuredClone(serializable);
}
function descriptorSnapshot(config: ReturnType<typeof parsed>) {
  const descriptorValue = (value: object, key: PropertyKey) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : null;
  };
  const values: object[] = [config];
  const llm = descriptorValue(config, 'llm');
  const dashboard = descriptorValue(config, 'dashboard');
  const logger = descriptorValue(config, 'logger');
  if (llm && typeof llm === 'object') {
    values.push(llm);
    const roles = descriptorValue(llm, 'roles');
    if (roles && typeof roles === 'object') values.push(roles);
  }
  if (dashboard && typeof dashboard === 'object') {
    values.push(dashboard);
    const remote = descriptorValue(dashboard, 'remote');
    if (remote && typeof remote === 'object') values.push(remote);
  }
  if (logger && (typeof logger === 'object' || typeof logger === 'function'))
    values.push(logger);
  return values.map((value) =>
    Reflect.ownKeys(value).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(value, key),
    ]),
  );
}
async function rejectAtomically(
  h: ReturnType<typeof harness>,
  pattern: RegExp,
  beforeFetch = false,
) {
  const materialize = materializer();
  const before = configSnapshot(h.config);
  const descriptorsBefore = descriptorSnapshot(h.config);
  const loggerBefore = h.config.logger;
  await assert.rejects(
    () => materialize(h.config, { store: h.store, fetch: h.fetch }),
    pattern,
  );
  assert.deepEqual(configSnapshot(h.config), before);
  assert.deepEqual(descriptorSnapshot(h.config), descriptorsBefore);
  assert.equal(h.config.logger, loggerBefore);
  if (beforeFetch) assert.equal(h.fetches, 0);
}

test('direct configuration returns exact identity without store or catalog access', async () => {
  const materialize = materializer();
  const config = parsed(true);
  let operations = 0;
  const forbidden = () => {
    operations++;
    throw new Error('direct mode performed a Gateway operation');
  };
  const options = {
    store: { read: forbidden, activeNodeToken: forbidden },
    fetch: forbidden,
  };
  assert.equal(await materialize(config, options), config);
  assert.equal(operations, 0);
});
test('pending requires dashboard.remote before any catalog fetch', async () => {
  const h = harness();
  h.config.dashboard.remote = null;
  await rejectAtomically(
    h,
    /dashboard\.remote.*required|requires.*dashboard\.remote|remote.*required/i,
    true,
  );
});
for (const phase of ['idle', 'enrolling'] as const) {
  test('pending refuses non-authoritative store phase ' + phase, async () => {
    const h = harness(models(), phase);
    await rejectAtomically(
      h,
      /active.*rotating|not active|resident state invalid state|non.authoritative/i,
      true,
    );
  });
}
for (const wrong of ['https://other.example.com', endpoint + '/', null]) {
  test('pending requires exact store endpoint: ' + wrong, async () => {
    const h = harness();
    h.changeState({ endpoint: wrong });
    await rejectAtomically(
      h,
      /endpoint.*(?:match|invalid)|authority.*(?:match|invalid)|(?:mismatch).*authority/i,
      true,
    );
  });
}
for (const phase of ['active', 'rotating'] as const) {
  test(
    phase +
      ' authority fetches exactly one catalog and publishes a resolved snapshot',
    async (t) => {
      const materialize = materializer();
      const h = harness(models(), phase);
      observeCatalogClient(t, h);
      const before = configSnapshot(h.config);
      const resolved = await materialize(h.config, {
        store: h.store,
        fetch: h.fetch,
      });
      assert.notEqual(resolved, h.config);
      assert.deepEqual(configSnapshot(h.config), before);
      assert.equal(h.fetches, 1);
      assertFetchOrdering(h);
      assert.equal(resolved.llm.registrySource, 'gateway');
      assert.equal(resolved.llm.gatewayManaged, true);
      assert.equal(resolved.llm.materialization, 'resolved');
      assert.equal(resolved.llm.gatewayAuthority, endpoint);
      assert.equal(resolved.llm.catalogRevision, 73);
      assert.equal(resolved.llm.completionReserveTokens, 4096);
      assert.equal(resolved.llm.target.modelRef, roles.main);
      noDirectCredentials(resolved.llm);
      noRetainedSecrets(resolved);
    },
  );
}
test('missing active token refuses before any HTTP request', async () => {
  const h = harness();
  h.removeActiveToken();
  await rejectAtomically(
    h,
    /resident state invalid state|active.*token.*(?:missing|unavailable)/i,
    true,
  );
});
for (const [label, finalState] of [
  ['idle', snapshot('idle')],
  ['enrolling', snapshot('enrolling')],
  ['endpoint change', { ...snapshot(), endpoint: 'https://other.example.com' }],
  [
    'instance replacement',
    { ...snapshot(), instanceId: 'egi1.BBBBBBBBBBBBBBBBBBBBBQ' },
  ],
] as const) {
  test('post-fetch revalidation rejects ' + label, async (t) => {
    const h = harness();
    observeCatalogClient(t, h);
    h.duringFetch(() => h.changeState(finalState));
    await rejectAtomically(
      h,
      /authority.*changed|state.*changed|active.*rotating|non.authoritative|(?:endpoint|instance).*mismatch/i,
    );
    assert.equal(h.fetches, 1);
    assertFetchOrdering(h);
  });
}
// Only instanceId + endpoint identify authority. Credential epoch and incidental
// resident metadata are not replay identity; valid active <-> rotating is legal.
for (const [label, initial, finalState] of [
  ['active to rotating', 'active', snapshot('rotating')],
  [
    'rotating to active with credential rotation',
    'rotating',
    { ...snapshot(), activeCredentialId: secondCredential.id, updatedAt: 6 },
  ],
  [
    'active credential rotation',
    'active',
    { ...snapshot(), activeCredentialId: secondCredential.id, updatedAt: 6 },
  ],
  [
    'pending credential change',
    'rotating',
    {
      ...snapshot('rotating'),
      pendingCredentialId: createNodeCredential((n) => Buffer.alloc(n, 4)).id,
    },
  ],
  [
    'benign timestamps and request metadata',
    'rotating',
    {
      ...snapshot('rotating'),
      updatedAt: 8,
      rotationProposedAt: 7,
      requestId: 'egr1.BBBBBBBBBBBBBBBBBBBBBQ',
      displayName: 'Renamed fixture',
    },
  ],
] as const) {
  test(
    'post-fetch permits ' + label + ' without changing replay identity',
    async (t) => {
      const materialize = materializer();
      const h = harness(models(), initial);
      observeCatalogClient(t, h);
      const before = configSnapshot(h.config);
      h.duringFetch(() => h.changeState(finalState));
      const resolved = await materialize(h.config, {
        store: h.store,
        fetch: h.fetch,
      });
      assert.deepEqual(configSnapshot(h.config), before);
      assert.equal(h.fetches, 1);
      assertFetchOrdering(h);
      assert.deepEqual(
        replayIdentityForConfig(configForLlmRef(resolved, 'team/main')),
        expectedReplay(h.catalog, 'team/main', 'responses'),
      );
      noRetainedSecrets(resolved);
    },
  );
}
test('post-fetch dashboard authority change cannot publish the fetched catalog', async (t) => {
  const materialize = materializer();
  const h = harness();
  observeCatalogClient(t, h);
  const pendingBefore = structuredClone(h.config.llm);
  h.duringFetch(() => {
    h.config.dashboard.remote!.url = 'https://other.example.com';
  });
  await assert.rejects(
    () => materialize(h.config, { store: h.store, fetch: h.fetch }),
    /authority.*changed|dashboard.*changed|endpoint.*(?:changed|mismatch)/i,
  );
  assert.deepEqual(h.config.llm, pendingBefore);
  assert.equal(h.fetches, 1);
  assertFetchOrdering(h);
});
test('registry retains every protocol field and full ref in a deeply frozen revision snapshot', async () => {
  const materialize = materializer();
  const h = harness();
  const resolved = await materialize(h.config, {
    store: h.store,
    fetch: h.fetch,
  });
  const registry = resolved.llm.registry;
  assert.equal(registry.revision, 73);
  assert.deepEqual(
    Object.keys(registry.models).sort(),
    h.catalog.models.map((m) => m.modelRef).sort(),
  );
  for (const source of h.catalog.models) {
    const retained = registry.models[source.modelRef];
    for (const [key, value] of Object.entries(source))
      assert.deepEqual(retained[key], value, source.modelRef + '.' + key);
  }
  deeplyFrozen(registry);
  noDirectCredentials(resolved.llm);
  noRetainedSecrets(resolved);
  assert.throws(() => {
    registry.models['team/main'].allowedRoutes.push('messages');
  }, TypeError);
});
test('managed tool runtime preserves exact catalog tiers and API surfaces', async () => {
  const materialize = materializer();
  const h = harness();
  const resolved = await materialize(h.config, {
    store: h.store,
    fetch: h.fetch,
  });
  const defaultRuntime = createLlmToolRuntime(resolved);
  assert.equal(defaultRuntime.list().length, 3);
  const created: Array<{ ref: string; apiSurface: string | null }> = [];
  const runtime = createLlmToolRuntime(resolved, {
    create(projected) {
      assert.equal(projected.llm.registrySource, 'gateway');
      if (projected.llm.registrySource !== 'gateway')
        throw new Error('expected managed tool projection');
      const target = projected.llm.target;
      assert.equal(projected.llm.registry, resolved.llm.registry);
      assert.equal(target, projected.llm.registry.models[target.modelRef]);
      assert.ok(target.toolTier);
      assert.equal(target, resolved.llm.registry.toolTiers[target.toolTier]);
      assert.equal(Object.isFrozen(target), true);
      created.push({ ref: target.modelRef, apiSurface: target.apiSurface });
      return makeStubLLM({
        model: target.model,
        async completeStandalone() {
          return {
            content: 'managed answer',
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            model: target.model,
            providerType: target.providerType,
            apiSurface: target.apiSurface ?? undefined,
          };
        },
      });
    },
  });
  assert.ok(runtime);
  assert.deepEqual(runtime.list(), [
    {
      tier: 'weak',
      ref: 'team/chat',
      model: 'upstream-chat',
      providerType: 'openai-compatible',
      contextSize: 128000,
    },
    {
      tier: 'medium',
      ref: 'other/main',
      model: 'upstream-main',
      providerType: 'anthropic-oauth',
      contextSize: 200000,
    },
    {
      tier: 'strong',
      ref: 'team/main',
      model: 'upstream-main',
      providerType: 'openai-compatible',
      contextSize: 128000,
    },
  ]);
  assert.deepEqual(created, [
    { ref: 'team/chat', apiSurface: 'chat-completions' },
    { ref: 'other/main', apiSurface: 'anthropic-messages' },
    { ref: 'team/main', apiSurface: 'responses' },
  ]);
  const result = await runtime.query({ prompt: 'managed?', model: 'weak' });
  assert.equal(result.text, 'managed answer');
  assert.deepEqual(result.provenance, {
    providerType: 'openai-compatible',
    apiSurface: 'chat-completions',
  });
});

for (const [ref, route, apiSurface] of [
  ['team/main', 'responses', 'responses'],
  ['team/chat', 'chat/completions', 'chat-completions'],
  ['other/main', 'messages', 'anthropic-messages'],
  ['code/codex', 'codex/responses', 'codex-responses'],
  ['code/discovery', null, null],
  ['code/response-only', 'codex/responses', 'codex-responses'],
  ['code/models-only', null, null],
  ['code/codex-models-only', null, null],
  ['team/unknown-context', 'responses', 'responses'],
]) {
  test('deterministic executable route and surface for ' + ref, async () => {
    const materialize = materializer();
    const h = harness();
    const resolved = await materialize(h.config, {
      store: h.store,
      fetch: h.fetch,
    });
    const target = resolved.llm.registry.models[ref!];
    assert.equal(target.route, route);
    assert.equal(target.apiSurface, apiSurface);
  });
}
function selectionError(ref: string) {
  if (ref === 'missing/model')
    return /unknown.*(?:ref|model)|(?:ref|model).*not found/i;
  if (ref === 'team/old')
    return /tool.contract|contract.*(?:version|unsupported|mismatch)/i;
  return /not executable|non.executable|no executable route|discovery.only/i;
}
for (const role of ['main', 'classifier', 'motor', 'secretary', 'compaction']) {
  for (const ref of ['missing/model', 'code/discovery', 'team/old']) {
    test(
      role + ' rejects unknown/non-executable/old-contract selection ' + ref,
      async () => {
        const h = harness();
        Reflect.set(Reflect.get(h.config.llm, 'roles'), role, ref);
        await rejectAtomically(h, selectionError(ref));
      },
    );
  }
}
for (const tier of ['weak', 'medium', 'strong'] as const) {
  for (const bad of ['discovery', 'old']) {
    test(
      tier + ' tool tier rejects ' + bad + ' even when no role selects it',
      async () => {
        const catalog = models().map((m) => ({ ...m, toolTier: null }));
        const selected = catalog.find(
          (m) =>
            m.modelRef ===
            (bad === 'discovery' ? 'code/discovery' : 'team/old'),
        )!;
        Reflect.set(selected, 'toolTier', tier);
        await rejectAtomically(
          harness(catalog),
          selectionError(bad === 'discovery' ? 'code/discovery' : 'team/old'),
        );
      },
    );
  }
}
function catalogModel(catalog: LlmProxyCatalog, ref: string) {
  const source = catalog.models.find((m) => m.modelRef === ref);
  assert.ok(source, 'expected catalog fixture for full ref ' + ref);
  return source;
}
function expectedReplay(
  catalog: LlmProxyCatalog,
  ref: string,
  apiSurface: string,
) {
  const source = catalogModel(catalog, ref);
  return {
    providerType: source.providerType,
    model: source.model,
    apiSurface,
    apiEndpoint: endpoint + LLM_PROXY_PATHS.request,
    toolContractVersion: source.toolContractVersion,
    gateway: {
      authority: replayAuthority,
      modelRef: source.modelRef,
      targetGeneration: source.targetGeneration,
    },
  };
}
test('role/ref projections preserve catalog-derived full targets and complete Gateway replay identities', async () => {
  const materialize = materializer();
  const h = harness();
  Reflect.set(Reflect.get(h.config.llm, 'roles'), 'motor', 'other/main');
  Reflect.set(Reflect.get(h.config.llm, 'roles'), 'secretary', 'code/codex');
  const resolved = await materialize(h.config, {
    store: h.store,
    fetch: h.fetch,
  });
  for (const [role, ref, route, apiSurface] of [
    ['main', 'team/main', 'responses', 'responses'],
    ['classifier', 'team/chat', 'chat/completions', 'chat-completions'],
    ['motor', 'other/main', 'messages', 'anthropic-messages'],
    ['secretary', 'code/codex', 'codex/responses', 'codex-responses'],
  ] as const) {
    const byRole = configForLlmRole(resolved, role);
    const byRef = configForLlmRef(resolved, ref);
    assert.deepEqual(byRole, byRef);
    const target = Reflect.get(byRef.llm, 'target');
    // Expected provider/model/generation come ONLY from the original catalog,
    // never from the projected output under test (including same-leaf refs).
    const source = catalogModel(h.catalog, ref);
    for (const [key, value] of Object.entries(source))
      assert.deepEqual(target[key], value, ref + '.' + key);
    assert.equal(target.route, route);
    assert.equal(target.apiSurface, apiSurface);
    assert.equal(Reflect.get(byRef.llm, 'registry'), resolved.llm.registry);
    assert.equal(Reflect.get(byRef.llm, 'gatewayAuthority'), endpoint);
    assert.equal(Reflect.get(byRef.llm, 'catalogRevision'), h.catalog.revision);
    noDirectCredentials(byRef.llm);
    noRetainedSecrets(byRef);
    assert.deepEqual(
      replayIdentityForConfig(byRef),
      apiSurface === 'chat-completions'
        ? null
        : expectedReplay(h.catalog, ref, apiSurface),
    );
  }
  assert.equal(resolved.llm.target.modelRef, 'team/main');
  assert.equal(h.fetches, 1);
});
for (const ref of ['missing/model', 'code/discovery', 'team/old']) {
  test(
    'later ref selection rejects ' + ref + ' without catalog refresh',
    async () => {
      const materialize = materializer();
      const h = harness();
      const resolved = await materialize(h.config, {
        store: h.store,
        fetch: h.fetch,
      });
      assert.throws(() => configForLlmRef(resolved, ref), selectionError(ref));
      assert.equal(h.fetches, 1);
    },
  );
}
test('Gateway materialization cannot alias the direct discriminator', async () => {
  const materialize = materializer();
  const h = harness();
  Reflect.set(h.config.llm, 'materialization', 'direct');
  await assert.rejects(
    () => materialize(h.config, { store: h.store, fetch: h.fetch }),
    /invalid.*Gateway/i,
  );
  assert.throws(() => requireMaterializedConfig(h.config), /invalid.*Gateway/i);
  await assert.rejects(() => fetchContextWindow(h.config), /invalid.*Gateway/i);
  assert.throws(() => replayIdentityForConfig(h.config), /invalid.*Gateway/i);
  assert.throws(() => createLLM(h.config), /invalid.*Gateway/i);
  assert.equal(h.reads, 0);
  assert.equal(h.fetches, 0);
});

test('materialized registry provenance cannot be transplanted to another authority', async () => {
  const materialize = materializer();
  const h = harness();
  const resolved = await materialize(h.config, {
    store: h.store,
    fetch: h.fetch,
  });
  const otherAuthority = 'https://other.example.com';
  const transplanted = {
    ...resolved,
    dashboard: {
      ...resolved.dashboard,
      remote: { ...resolved.dashboard.remote!, url: otherAuthority },
    },
    llm: { ...resolved.llm, gatewayAuthority: otherAuthority },
  };
  assert.throws(
    () => configForLlmRef(transplanted, 'team/main'),
    /invalid.*Gateway/i,
  );
  await assert.rejects(
    () => fetchContextWindow(transplanted),
    /invalid.*Gateway/i,
  );
  assert.throws(
    () => replayIdentityForConfig(transplanted),
    /invalid.*Gateway/i,
  );
  assert.throws(() => createLLM(transplanted), /invalid.*Gateway/i);
  await assert.rejects(
    () => materialize(transplanted, { store: h.store, fetch: h.fetch }),
    /invalid.*Gateway/i,
  );
  assert.equal(h.fetches, 1);
});

test('forged resolved target cannot drive managed context or replay identity', async () => {
  const materialize = materializer();
  const h = harness();
  const resolved = await materialize(h.config, {
    store: h.store,
    fetch: h.fetch,
  });
  const forged = {
    ...resolved,
    llm: {
      ...resolved.llm,
      target: { ...resolved.llm.target, model: 'forged', contextSize: 1 },
    },
  };
  await assert.rejects(
    () => fetchContextWindow(forged),
    /invalid.*(?:resolved )?Gateway|Gateway.*target.*catalog/i,
  );
  assert.throws(
    () => replayIdentityForConfig(forged),
    /invalid.*(?:resolved )?Gateway|Gateway.*target.*catalog/i,
  );
});

test('pending accessor fields are rejected without invocation or Gateway access', async () => {
  const materialize = materializer();
  const h = harness();
  let getterCalls = 0;
  Object.defineProperty(h.config.llm, 'completionReserveTokens', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls++;
      return 4096;
    },
  });
  await assert.rejects(
    () => materialize(h.config, { store: h.store, fetch: h.fetch }),
    /own data|invalid.*pending|pending.*invalid/i,
  );
  assert.equal(getterCalls, 0);
  assert.equal(h.reads, 0);
  assert.equal(h.fetches, 0);
});

test('top-level config accessors and symbol extras are rejected before Gateway access', async () => {
  const materialize = materializer();
  for (const kind of ['accessor', 'symbol'] as const) {
    const h = harness();
    let getterCalls = 0;
    if (kind === 'accessor') {
      Object.defineProperty(h.config, 'logger', {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls++;
          return () => {};
        },
      });
    } else {
      Object.defineProperty(h.config, Symbol('synthetic secret'), {
        enumerable: true,
        value: credential.token,
      });
    }
    const descriptorsBefore = descriptorSnapshot(h.config);
    await assert.rejects(
      () => materialize(h.config, { store: h.store, fetch: h.fetch }),
      /own data|unexpected.*config|symbol|invalid.*config/i,
    );
    assert.deepEqual(descriptorSnapshot(h.config), descriptorsBefore);
    assert.equal(getterCalls, 0);
    assert.equal(h.reads, 0);
    assert.equal(h.fetches, 0);
  }
});

test('null context is retained, but context lookup refuses locally without provider probing', async (t) => {
  const materialize = materializer();
  const h = harness();
  const resolved = await materialize(h.config, {
    store: h.store,
    fetch: h.fetch,
  });
  const selected = configForLlmRef(resolved, 'team/unknown-context');
  assert.equal(Reflect.get(selected.llm, 'target').contextSize, null);
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    probes++;
    throw new Error('unexpected direct provider probe');
  });
  await assert.rejects(
    () => fetchContextWindow(selected),
    /Gateway.*context.*(?:unknown|unavailable|null)|(?:unknown|unavailable|null).*Gateway.*context/i,
  );
  assert.equal(probes, 0);
  assert.equal(h.fetches, 1);
});
test('createLLM constructs an authentic managed client without provider I/O', async (t) => {
  const materialize = materializer();
  const h = harness();
  const resolved = await materialize(h.config, {
    store: h.store,
    fetch: h.fetch,
  });
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    probes++;
    throw new Error('unexpected provider probe');
  });
  const llm = createLLM(resolved);
  assert.equal(llm.model, resolved.llm.target.model);
  assert.equal(probes, 0);
  assert.equal(h.fetches, 1);
});
test('catalog transport failure is atomic and does not mutate pending selection', async () => {
  const h = harness();
  h.duringFetch(() => {
    throw new Error('synthetic transport failure');
  });
  await rejectAtomically(h, /gateway LLM transport boundary failed/i);
  assert.equal(h.fetches, 1);
});

test('synthetic catalog fixture passes strict serialization and real Gateway client round trip', async () => {
  const h = harness();
  const client = new GatewayLlmClient({ store: h.store, fetch: h.fetch });
  assert.deepEqual(await client.fetchCatalog(), h.catalog);
  assert.equal(h.reads, 1);
  assert.equal(h.tokenReads, 1);
  assert.equal(h.fetches, 1);
});
