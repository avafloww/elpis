import type {
  LlmProxyCatalog,
  LlmProxyCatalogModel,
  LlmProxyRoute,
} from '@elpis/gateway-protocol';
import type {
  Config,
  ParsedConfig,
  PendingGatewayLlmConfig,
} from '../config.js';
import type { GatewayResidentSnapshot } from '../store/gateway-resident.js';
import {
  GatewayLlmClient,
  type GatewayLlmFetch,
  type GatewayLlmResidentStore,
} from './gateway-client.js';
import { TOOL_CONTRACT_VERSION } from './tool-contract.js';

export type GatewayLlmApiSurface =
  'responses' | 'chat-completions' | 'anthropic-messages' | 'codex-responses';

export interface ResolvedGatewayLlmTarget extends LlmProxyCatalogModel {
  readonly route: LlmProxyRoute | null;
  readonly apiSurface: GatewayLlmApiSurface | null;
}

export interface GatewayLlmModelRegistry {
  readonly revision: number;
  readonly models: Readonly<Record<string, ResolvedGatewayLlmTarget>>;
  readonly roles: PendingGatewayLlmConfig['roles'];
  readonly targets: Readonly<{
    main: ResolvedGatewayLlmTarget;
    classifier: ResolvedGatewayLlmTarget;
    motor: ResolvedGatewayLlmTarget | null;
    secretary: ResolvedGatewayLlmTarget | null;
    compaction: ResolvedGatewayLlmTarget | null;
  }>;
  readonly toolTiers: Readonly<{
    weak: ResolvedGatewayLlmTarget | null;
    medium: ResolvedGatewayLlmTarget | null;
    strong: ResolvedGatewayLlmTarget | null;
  }>;
}

export interface ResolvedGatewayLlmConfig {
  readonly registrySource: 'gateway';
  readonly gatewayManaged: true;
  readonly materialization: 'resolved';
  readonly registry: GatewayLlmModelRegistry;
  readonly target: ResolvedGatewayLlmTarget;
  readonly roles: PendingGatewayLlmConfig['roles'];
  readonly gatewayAuthority: string;
  readonly catalogRevision: number;
  readonly toolContractVersion: string;
  readonly completionReserveTokens: number;
}

export type ResolvedGatewayConfig = Omit<Config, 'llm'> & {
  llm: ResolvedGatewayLlmConfig;
};

export interface GatewayConfigMaterializationOptions {
  readonly store: GatewayLlmResidentStore;
  readonly fetch: GatewayLlmFetch;
}

type AuthoritySnapshot = Readonly<{
  instanceId: string;
  endpoint: string;
}>;
type ConfigBaseSnapshot = Omit<ResolvedGatewayConfig, 'llm'>;
type PendingSnapshot = Readonly<{
  pending: PendingGatewayLlmConfig;
  base: ConfigBaseSnapshot;
  authority: string;
}>;

const configKeys = [
  'llm',
  'operator',
  'discord',
  'compaction',
  'memory',
  'heartbeat',
  'sandbox',
  'modules',
  'dashboard',
  'console',
  'kagi',
  'bluesky',
  'secretary',
  'workers',
  'usageTracker',
  'paths',
  'logger',
  'logLevel',
] as const;
const pendingKeys = [
  'registrySource',
  'gatewayManaged',
  'materialization',
  'registry',
  'completionReserveTokens',
  'roles',
] as const;
const resolvedKeys = [
  'registrySource',
  'gatewayManaged',
  'materialization',
  'registry',
  'target',
  'roles',
  'gatewayAuthority',
  'catalogRevision',
  'toolContractVersion',
  'completionReserveTokens',
] as const;
const roleKeys = [
  'main',
  'classifier',
  'motor',
  'secretary',
  'compaction',
] as const;
const dashboardKeys = ['local', 'remote'] as const;
const remoteKeys = ['url', 'enrollmentToken'] as const;

const intrinsicArrayIncludes = Array.prototype.includes;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicArraySome = Array.prototype.some;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicStringCharCodeAt = String.prototype.charCodeAt;
const intrinsicObjectCreate = Object.create;
const intrinsicObjectDefineProperty = Object.defineProperty;
const intrinsicObjectFreeze = Object.freeze;
const intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicObjectIsFrozen = Object.isFrozen;
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectOwnKeys = Reflect.ownKeys;
const intrinsicURL = URL;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const materializedRegistryAuthorities = new WeakMap<object, string>();
const urlDescriptor = intrinsicObjectGetOwnPropertyDescriptor;
const urlGetters = {
  protocol: urlDescriptor(URL.prototype, 'protocol')!.get!,
  username: urlDescriptor(URL.prototype, 'username')!.get!,
  password: urlDescriptor(URL.prototype, 'password')!.get!,
  pathname: urlDescriptor(URL.prototype, 'pathname')!.get!,
  search: urlDescriptor(URL.prototype, 'search')!.get!,
  hash: urlDescriptor(URL.prototype, 'hash')!.get!,
  origin: urlDescriptor(URL.prototype, 'origin')!.get!,
};

function ownData<T>(value: object, key: PropertyKey, label: string): T {
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key);
  if (!descriptor || !('value' in descriptor))
    throw new Error(`Gateway ${label} must be an own data property`);
  return descriptor.value as T;
}

function includes<T>(values: readonly T[], value: T): boolean {
  return intrinsicReflectApply(intrinsicArrayIncludes, values, [
    value,
  ]) as boolean;
}

function assertExactOwnDataKeys(
  value: object,
  expected: readonly string[],
  label: string,
): void {
  const keys = intrinsicReflectOwnKeys(value);
  if (
    keys.length !== expected.length ||
    intrinsicReflectApply(intrinsicArraySome, keys, [
      (key: PropertyKey) => typeof key !== 'string' || !includes(expected, key),
    ])
  )
    throw new Error(`Gateway ${label} has unexpected config keys or symbols`);
  for (let index = 0; index < expected.length; index += 1) {
    const key = expected[index];
    const descriptor = intrinsicObjectGetOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable)
      throw new Error(`Gateway ${label}.${key} must be an own data property`);
  }
}

function urlValue(url: URL, key: keyof typeof urlGetters): string {
  return intrinsicReflectApply(urlGetters[key], url, []);
}

function dashboardAuthority(raw: unknown): string {
  if (typeof raw !== 'string')
    throw new Error('Gateway dashboard.remote.url must be a string');
  const parsed = new intrinsicURL(raw);
  if (
    urlValue(parsed, 'protocol') !== 'https:' ||
    urlValue(parsed, 'username') ||
    urlValue(parsed, 'password') ||
    urlValue(parsed, 'pathname') !== '/' ||
    urlValue(parsed, 'search') ||
    urlValue(parsed, 'hash') ||
    raw !== urlValue(parsed, 'origin')
  )
    throw new Error(
      'Gateway dashboard.remote.url must be an exact HTTPS origin',
    );
  return raw;
}

function stringCodeAt(value: string, index: number): number {
  return intrinsicReflectApply(intrinsicStringCharCodeAt, value, [
    index,
  ]) as number;
}

function validModelId(value: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    const code = stringCodeAt(value, index);
    const alphanumeric =
      (code >= 97 && code <= 122) || (code >= 48 && code <= 57);
    if (alphanumeric) continue;
    if (index === from || (code !== 46 && code !== 95 && code !== 45))
      return false;
  }
  return from < to;
}

function assertModelRef(value: string, label: string): void {
  let slash = -1;
  for (let index = 0; index < value.length; index += 1) {
    if (stringCodeAt(value, index) !== 47) continue;
    if (slash !== -1) throw new Error(`Gateway ${label} must be a model ref`);
    slash = index;
  }
  if (
    slash <= 0 ||
    !validModelId(value, 0, slash) ||
    !validModelId(value, slash + 1, value.length)
  )
    throw new Error(`Gateway ${label} must be a model ref`);
}

function snapshotRoles(value: unknown): PendingGatewayLlmConfig['roles'] {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value))
    throw new Error('Gateway pending roles must be an object');
  assertExactOwnDataKeys(value, roleKeys, 'pending roles');
  const readRole = (role: (typeof roleKeys)[number]): string | null => {
    const ref = ownData<unknown>(value, role, `pending role ${role}`);
    if (ref === null && role !== 'main' && role !== 'classifier') return null;
    if (typeof ref !== 'string' || !ref)
      throw new Error(`Gateway pending role ${role} must be a model ref`);
    assertModelRef(ref, `pending role ${role}`);
    return ref;
  };
  return intrinsicObjectFreeze({
    main: readRole('main')!,
    classifier: readRole('classifier')!,
    motor: readRole('motor'),
    secretary: readRole('secretary'),
    compaction: readRole('compaction'),
  });
}

function snapshotDashboard(
  value: unknown,
): Readonly<{ dashboard: Config['dashboard']; authority: string }> {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value))
    throw new Error('Gateway dashboard config must be an object');
  assertExactOwnDataKeys(value, dashboardKeys, 'dashboard');
  const local = ownData<Config['dashboard']['local']>(
    value,
    'local',
    'dashboard.local',
  );
  const remote = ownData<unknown>(value, 'remote', 'dashboard.remote');
  if (!remote || typeof remote !== 'object' || intrinsicArrayIsArray(remote))
    throw new Error('Gateway-managed config requires dashboard.remote');
  assertExactOwnDataKeys(remote, remoteKeys, 'dashboard.remote');
  const authority = dashboardAuthority(
    ownData<unknown>(remote, 'url', 'dashboard.remote.url'),
  );
  const enrollmentToken = ownData<unknown>(
    remote,
    'enrollmentToken',
    'dashboard.remote.enrollmentToken',
  );
  if (enrollmentToken !== null && typeof enrollmentToken !== 'string')
    throw new Error(
      'Gateway dashboard.remote.enrollmentToken must be a string or null',
    );
  return {
    authority,
    dashboard: {
      local,
      remote: { url: authority, enrollmentToken },
    },
  };
}

function snapshotBase(
  config: ParsedConfig | ResolvedGatewayConfig,
  dashboard: Config['dashboard'],
): ConfigBaseSnapshot {
  assertExactOwnDataKeys(config, configKeys, 'config');
  const consoleConfig = ownData<Config['console']>(
    config,
    'console',
    'config.console',
  );
  if (consoleConfig !== dashboard.local)
    throw new Error('Gateway config console alias must equal dashboard.local');
  return {
    operator: ownData(config, 'operator', 'config.operator'),
    discord: ownData(config, 'discord', 'config.discord'),
    compaction: ownData(config, 'compaction', 'config.compaction'),
    memory: ownData(config, 'memory', 'config.memory'),
    heartbeat: ownData(config, 'heartbeat', 'config.heartbeat'),
    sandbox: ownData(config, 'sandbox', 'config.sandbox'),
    modules: ownData(config, 'modules', 'config.modules'),
    dashboard,
    console: consoleConfig,
    kagi: ownData(config, 'kagi', 'config.kagi'),
    bluesky: ownData(config, 'bluesky', 'config.bluesky'),
    secretary: ownData(config, 'secretary', 'config.secretary'),
    workers: ownData(config, 'workers', 'config.workers'),
    usageTracker: ownData(config, 'usageTracker', 'config.usageTracker'),
    paths: ownData(config, 'paths', 'config.paths'),
    logger: ownData(config, 'logger', 'config.logger'),
    logLevel: ownData(config, 'logLevel', 'config.logLevel'),
  };
}

function snapshotPending(config: ParsedConfig): PendingSnapshot {
  const llm = ownData<unknown>(config, 'llm', 'config.llm');
  if (!llm || typeof llm !== 'object' || intrinsicArrayIsArray(llm))
    throw new Error('Invalid Gateway pending config');
  assertExactOwnDataKeys(llm, pendingKeys, 'pending LLM config');
  if (
    ownData(llm, 'registrySource', 'pending registrySource') !== 'gateway' ||
    ownData(llm, 'gatewayManaged', 'pending gatewayManaged') !== true ||
    ownData(llm, 'materialization', 'pending materialization') !== 'pending' ||
    ownData(llm, 'registry', 'pending registry') !== null
  )
    throw new Error('Invalid Gateway pending config');
  const completionReserveTokens = ownData<unknown>(
    llm,
    'completionReserveTokens',
    'pending completionReserveTokens',
  );
  if (
    typeof completionReserveTokens !== 'number' ||
    !intrinsicNumberIsFinite(completionReserveTokens) ||
    completionReserveTokens <= 0
  )
    throw new Error('Invalid Gateway pending completion reserve');
  const roles = snapshotRoles(ownData(llm, 'roles', 'pending roles'));
  const dashboard = snapshotDashboard(
    ownData(config, 'dashboard', 'config.dashboard'),
  );
  const base = snapshotBase(config, dashboard.dashboard);
  return intrinsicObjectFreeze({
    authority: dashboard.authority,
    base,
    pending: intrinsicObjectFreeze({
      registrySource: 'gateway' as const,
      gatewayManaged: true as const,
      materialization: 'pending' as const,
      registry: null,
      completionReserveTokens,
      roles,
    }),
  });
}

function currentDashboardAuthority(
  config: ParsedConfig | ResolvedGatewayConfig,
): string {
  return snapshotDashboard(ownData(config, 'dashboard', 'config.dashboard'))
    .authority;
}

function candidateMaterialization(value: unknown): unknown {
  if (!value || typeof value !== 'object' || intrinsicArrayIsArray(value))
    return null;
  const llmDescriptor = intrinsicObjectGetOwnPropertyDescriptor(value, 'llm');
  if (!llmDescriptor || !('value' in llmDescriptor)) return null;
  const llm = llmDescriptor.value;
  if (!llm || typeof llm !== 'object' || intrinsicArrayIsArray(llm))
    return null;
  const source = intrinsicObjectGetOwnPropertyDescriptor(llm, 'registrySource');
  if (!source || !('value' in source)) return null;
  if (source.value === 'canonical' || source.value === 'legacy')
    return 'direct';
  if (source.value !== 'gateway') return 'invalid';
  const materialization = intrinsicObjectGetOwnPropertyDescriptor(
    llm,
    'materialization',
  );
  if (!materialization || !('value' in materialization)) return 'invalid';
  if (
    materialization.value === 'pending' ||
    materialization.value === 'resolved'
  )
    return materialization.value;
  return 'invalid';
}

function registryAuthority(registry: object): string | undefined {
  return intrinsicReflectApply(
    intrinsicWeakMapGet,
    materializedRegistryAuthorities,
    [registry],
  ) as string | undefined;
}

function validateResolvedGatewayConfig(
  value: unknown,
): ResolvedGatewayConfig | null {
  try {
    if (candidateMaterialization(value) !== 'resolved') return null;
    const config = value as ResolvedGatewayConfig;
    const llm = ownData<object>(config, 'llm', 'resolved config.llm');
    assertExactOwnDataKeys(llm, resolvedKeys, 'resolved LLM config');
    if (
      ownData(llm, 'gatewayManaged', 'resolved gatewayManaged') !== true ||
      ownData(llm, 'registrySource', 'resolved registrySource') !== 'gateway'
    )
      return null;
    const registry = ownData<object>(llm, 'registry', 'resolved registry');
    if (!intrinsicObjectIsFrozen(registry)) return null;
    const authority = dashboardAuthority(
      ownData(llm, 'gatewayAuthority', 'resolved gatewayAuthority'),
    );
    if (registryAuthority(registry) !== authority) return null;
    const dashboard = snapshotDashboard(
      ownData(config, 'dashboard', 'resolved config.dashboard'),
    );
    if (dashboard.authority !== authority) return null;
    snapshotBase(config, dashboard.dashboard);
    const target = ownData<object>(llm, 'target', 'resolved target');
    const models = ownData<object>(registry, 'models', 'resolved models');
    const modelRef = ownData<unknown>(target, 'modelRef', 'resolved modelRef');
    if (typeof modelRef !== 'string') return null;
    const modelDescriptor = intrinsicObjectGetOwnPropertyDescriptor(
      models,
      modelRef,
    );
    if (!modelDescriptor || !('value' in modelDescriptor)) return null;
    if (modelDescriptor.value !== target || !intrinsicObjectIsFrozen(target))
      return null;
    const route = ownData<unknown>(target, 'route', 'resolved route');
    const surface = ownData<unknown>(
      target,
      'apiSurface',
      'resolved apiSurface',
    );
    const targetContract = ownData<unknown>(
      target,
      'toolContractVersion',
      'resolved target tool contract',
    );
    const contract = ownData<unknown>(
      llm,
      'toolContractVersion',
      'resolved tool contract',
    );
    if (
      route === null ||
      surface === null ||
      targetContract !== TOOL_CONTRACT_VERSION ||
      contract !== TOOL_CONTRACT_VERSION
    )
      return null;
    if (
      ownData(llm, 'roles', 'resolved roles') !==
      ownData(registry, 'roles', 'resolved registry roles')
    )
      return null;
    const revision = ownData<unknown>(
      registry,
      'revision',
      'resolved registry revision',
    );
    if (
      ownData(llm, 'catalogRevision', 'resolved catalog revision') !==
        revision ||
      typeof revision !== 'number'
    )
      return null;
    const reserve = ownData<unknown>(
      llm,
      'completionReserveTokens',
      'resolved completion reserve',
    );
    if (
      typeof reserve !== 'number' ||
      !intrinsicNumberIsFinite(reserve) ||
      reserve <= 0
    )
      return null;
    return config;
  } catch {
    return null;
  }
}

export type GatewayConfigKind = 'direct' | 'pending' | 'resolved' | 'invalid';

export function gatewayConfigKind(value: unknown): GatewayConfigKind {
  const candidate = candidateMaterialization(value);
  if (candidate === 'direct') return 'direct';
  if (candidate === 'pending') return 'pending';
  if (candidate === 'resolved')
    return validateResolvedGatewayConfig(value) ? 'resolved' : 'invalid';
  return 'invalid';
}

export function isResolvedGatewayConfig(
  value: unknown,
): value is ResolvedGatewayConfig {
  return gatewayConfigKind(value) === 'resolved';
}

export function requireResolvedGatewayConfig(
  value: unknown,
): ResolvedGatewayConfig {
  const config = validateResolvedGatewayConfig(value);
  if (!config) throw new Error('Invalid resolved Gateway configuration');
  return config;
}

function activeAuthority(
  store: GatewayLlmResidentStore,
  expectedEndpoint: string,
): AuthoritySnapshot {
  const state = store.read() as GatewayResidentSnapshot;
  const phase = ownData<GatewayResidentSnapshot['phase']>(
    state,
    'phase',
    'resident phase',
  );
  if (phase !== 'active' && phase !== 'rotating')
    throw new Error('Gateway resident phase must be active or rotating');
  const endpoint = ownData<unknown>(state, 'endpoint', 'resident endpoint');
  if (endpoint !== expectedEndpoint)
    throw new Error(
      'Gateway resident endpoint must exactly match dashboard.remote',
    );
  const instanceId = ownData<unknown>(
    state,
    'instanceId',
    'resident instance id',
  );
  if (typeof instanceId !== 'string' || !instanceId)
    throw new Error('Gateway resident instance id is invalid');
  const token = store.activeNodeToken();
  if (typeof token !== 'string' || token.length === 0)
    throw new Error('Gateway active token is unavailable');
  return intrinsicObjectFreeze({ instanceId, endpoint });
}

function revalidateAuthority(
  store: GatewayLlmResidentStore,
  expected: AuthoritySnapshot,
): void {
  const state = store.read() as GatewayResidentSnapshot;
  const phase = ownData<GatewayResidentSnapshot['phase']>(
    state,
    'phase',
    'resident phase',
  );
  const endpoint = ownData<unknown>(state, 'endpoint', 'resident endpoint');
  const instanceId = ownData<unknown>(
    state,
    'instanceId',
    'resident instance id',
  );
  if (
    (phase !== 'active' && phase !== 'rotating') ||
    endpoint !== expected.endpoint ||
    instanceId !== expected.instanceId
  )
    throw new Error(
      'Gateway resident authority changed during materialization',
    );
  const token = store.activeNodeToken();
  if (typeof token !== 'string' || token.length === 0)
    throw new Error('Gateway active token is unavailable');
}

function includesRoute(
  routes: readonly LlmProxyRoute[],
  route: LlmProxyRoute,
): boolean {
  return includes(routes, route);
}

function executableRoute(model: LlmProxyCatalogModel): Readonly<{
  route: LlmProxyRoute | null;
  apiSurface: GatewayLlmApiSurface | null;
}> {
  if (model.providerType === 'openai-compatible') {
    if (includesRoute(model.allowedRoutes, 'responses'))
      return { route: 'responses', apiSurface: 'responses' };
    if (includesRoute(model.allowedRoutes, 'chat/completions'))
      return { route: 'chat/completions', apiSurface: 'chat-completions' };
  } else if (model.providerType === 'anthropic-oauth') {
    if (includesRoute(model.allowedRoutes, 'messages'))
      return { route: 'messages', apiSurface: 'anthropic-messages' };
  } else if (includesRoute(model.allowedRoutes, 'codex/responses')) {
    return { route: 'codex/responses', apiSurface: 'codex-responses' };
  }
  return { route: null, apiSurface: null };
}

function defineModel(
  models: Record<string, ResolvedGatewayLlmTarget>,
  model: LlmProxyCatalogModel,
): ResolvedGatewayLlmTarget {
  const execution = executableRoute(model);
  const target = intrinsicObjectFreeze({ ...model, ...execution });
  intrinsicObjectDefineProperty(models, model.modelRef, {
    value: target,
    enumerable: true,
    configurable: false,
    writable: false,
  });
  return target;
}

function requireExecutable(
  models: Readonly<Record<string, ResolvedGatewayLlmTarget>>,
  ref: string,
  label: string,
): ResolvedGatewayLlmTarget {
  const descriptor = intrinsicObjectGetOwnPropertyDescriptor(models, ref);
  const target = descriptor?.value as ResolvedGatewayLlmTarget | undefined;
  if (!target) throw new Error(`${label} references an unknown model ref`);
  if (target.route === null || target.apiSurface === null)
    throw new Error(
      `${label} references a non-executable discovery-only model`,
    );
  if (target.toolContractVersion !== TOOL_CONTRACT_VERSION)
    throw new Error(`${label} tool contract version mismatch`);
  return target;
}

function buildRegistry(
  catalog: LlmProxyCatalog,
  pending: PendingGatewayLlmConfig,
  authority: string,
): GatewayLlmModelRegistry {
  const models = intrinsicObjectCreate(null) as Record<
    string,
    ResolvedGatewayLlmTarget
  >;
  for (let index = 0; index < catalog.models.length; index += 1)
    defineModel(models, catalog.models[index]);
  intrinsicObjectFreeze(models);
  const roles = pending.roles;
  const resolveRole = <T extends string | null>(
    role: keyof PendingGatewayLlmConfig['roles'],
    ref: T,
  ): T extends string ? ResolvedGatewayLlmTarget : null =>
    (ref === null
      ? null
      : requireExecutable(models, ref, `llm.roles.${role}`)) as T extends string
      ? ResolvedGatewayLlmTarget
      : null;
  const targets = intrinsicObjectFreeze({
    main: resolveRole('main', roles.main),
    classifier: resolveRole('classifier', roles.classifier),
    motor: resolveRole('motor', roles.motor),
    secretary: resolveRole('secretary', roles.secretary),
    compaction: resolveRole('compaction', roles.compaction),
  });
  let weak: ResolvedGatewayLlmTarget | null = null;
  let medium: ResolvedGatewayLlmTarget | null = null;
  let strong: ResolvedGatewayLlmTarget | null = null;
  for (let index = 0; index < catalog.models.length; index += 1) {
    const source = catalog.models[index];
    if (source.toolTier === null) continue;
    const target = requireExecutable(
      models,
      source.modelRef,
      `llm tool tier ${source.toolTier}`,
    );
    if (source.toolTier === 'weak') weak = target;
    else if (source.toolTier === 'medium') medium = target;
    else strong = target;
  }
  const registry = {
    revision: catalog.revision,
    models,
    roles,
    targets,
    toolTiers: intrinsicObjectFreeze({ weak, medium, strong }),
  };
  intrinsicReflectApply(intrinsicWeakMapSet, materializedRegistryAuthorities, [
    registry,
    authority,
  ]);
  return intrinsicObjectFreeze(registry);
}

function resolvedConfig(
  snapshot: PendingSnapshot,
  llm: ResolvedGatewayLlmConfig,
): ResolvedGatewayConfig {
  const base = snapshot.base;
  return {
    llm,
    operator: base.operator,
    discord: base.discord,
    compaction: base.compaction,
    memory: base.memory,
    heartbeat: base.heartbeat,
    sandbox: base.sandbox,
    modules: base.modules,
    dashboard: base.dashboard,
    console: base.console,
    kagi: base.kagi,
    bluesky: base.bluesky,
    secretary: base.secretary,
    workers: base.workers,
    usageTracker: base.usageTracker,
    paths: base.paths,
    logger: base.logger,
    logLevel: base.logLevel,
  };
}

export async function materializeGatewayConfig(
  config: ParsedConfig,
  options: GatewayConfigMaterializationOptions,
): Promise<Config | ResolvedGatewayConfig> {
  const kind = gatewayConfigKind(config);
  if (kind === 'direct') return config as Config;
  if (kind === 'resolved') return requireResolvedGatewayConfig(config);
  if (kind !== 'pending') throw new Error('Invalid Gateway configuration');
  const snapshot = snapshotPending(config);
  const store = ownData<GatewayLlmResidentStore>(
    options,
    'store',
    'materialization store',
  );
  const fetch = ownData<GatewayLlmFetch>(
    options,
    'fetch',
    'materialization fetch',
  );
  const authority = activeAuthority(store, snapshot.authority);
  const client = new GatewayLlmClient({ store, fetch });
  const catalog = await client.fetchCatalog();
  revalidateAuthority(store, authority);
  if (currentDashboardAuthority(config) !== authority.endpoint)
    throw new Error(
      'Gateway dashboard authority changed during materialization',
    );
  const registry = buildRegistry(catalog, snapshot.pending, authority.endpoint);
  const llm = intrinsicObjectFreeze({
    registrySource: 'gateway' as const,
    gatewayManaged: true as const,
    materialization: 'resolved' as const,
    registry,
    target: registry.targets.main,
    roles: registry.roles,
    gatewayAuthority: authority.endpoint,
    catalogRevision: catalog.revision,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    completionReserveTokens: snapshot.pending.completionReserveTokens,
  });
  return resolvedConfig(snapshot, llm);
}
