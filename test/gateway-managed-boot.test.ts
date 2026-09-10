import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  LLM_PROXY_FORMATS,
  LLM_PROXY_PATHS,
  RESIDENT_CONTROL_FORMATS,
  createEnrollmentCredential,
  serializeLlmProxyCatalog,
  type LlmProxyCatalogModel,
} from '@elpis/gateway-protocol';
import { createBuildIdentity } from '../src/build-identity.js';
import {
  isResolvedGatewayConfig,
  type Config,
  type ParsedConfig,
} from '../src/config.js';
import { createElpisRuntime } from '../src/index.js';
import { createLlmModelRegistry } from '../src/llm/model-registry.js';
import type {
  GatewayLlmFetch,
  GatewayLlmResidentStore,
} from '../src/llm/gateway-client.js';
import {
  materializeGatewayConfig,
  type GatewayConfigMaterializationOptions,
} from '../src/llm/gateway-managed-config.js';
import { TOOL_CONTRACT_VERSION } from '../src/llm/provenance.js';
import { openDatabase, type Database } from '../src/store/db.js';
import { createGatewayResidentStore } from '../src/store/gateway-resident.js';
import { makeConfig } from './helpers.js';

const pendingLlm = {
  registrySource: 'gateway' as const,
  gatewayManaged: true as const,
  materialization: 'pending' as const,
  registry: null,
  completionReserveTokens: 4096,
  roles: {
    main: 'team/main',
    classifier: 'team/classifier',
    motor: null,
    secretary: null,
    compaction: null,
  },
};

function directConfig(
  dataDirectory: string,
  motor = false,
  compaction = true,
): Config {
  const config = makeConfig({
    modules: { enabled: null, disabled: motor ? [] : ['motor'] },
    paths: {
      dataDirectory,
      soulPath: path.join(dataDirectory, 'SOUL.md'),
      memoryPath: path.join(dataDirectory, 'MEMORY.md'),
      harnessRoot: dataDirectory,
    },
  });
  config.llm.registry = createLlmModelRegistry({
    providers: {
      fixture: {
        providerType: 'openai-compatible',
        apiKey: 'synthetic-provider-key',
        baseUrl: 'https://provider.example.test/v1',
        api: 'responses',
        externalThinking: false,
        streamIdleTimeoutMs: 1_000,
        callTimeoutMs: 2_000,
        models: {
          main: {
            name: 'wire-main',
            contextSize: 128_000,
            reasoningEffort: 'high',
            reasoningSummary: null,
            reasoningContext: 'all_turns',
          },
          compaction: {
            name: 'wire-compaction',
            contextSize: 80_000,
            reasoningEffort: 'low',
            reasoningSummary: null,
            reasoningContext: null,
          },
        },
      },
    },
    roles: {
      main: 'fixture/main',
      classifier: 'fixture/main',
      motor: motor ? 'fixture/main' : null,
      secretary: null,
      compaction: compaction ? 'fixture/compaction' : null,
    },
  });
  config.llm.registrySource = 'canonical';
  return config;
}

function managedConfig(
  dataDirectory: string,
  motor = false,
  compaction = false,
): ParsedConfig {
  const config = directConfig(dataDirectory, motor);
  const local = config.dashboard.local;
  return {
    ...config,
    llm: {
      ...pendingLlm,
      roles: {
        ...pendingLlm.roles,
        compaction: compaction ? 'team/compaction' : null,
      },
    },
    dashboard: {
      local,
      remote: {
        url: 'https://gateway.example.com',
        enrollmentToken: null,
      },
    },
    console: local,
  };
}

const buildIdentity = createBuildIdentity({
  version: '0.0.0',
  revision: null,
  treeClean: null,
  exactTag: null,
});

function trackedDatabase(events: string[], root: string) {
  const database = openDatabase(root);
  const close = database.close.bind(database);
  Object.defineProperty(database, 'close', {
    configurable: true,
    value: () => {
      events.push('database closed');
      close();
    },
  });
  return database;
}

async function expectStoppedAfterCompaction(
  input: ParsedConfig,
  resolved: Config,
  expectedSource: 'gateway' | 'canonical',
) {
  const stop = new Error('stop after compaction projection');
  const events: string[] = [];
  let database: Database | undefined;
  let calls = 0;
  const transport: GatewayLlmFetch = async () => {
    events.push('Gateway fetch');
    throw new Error('Gateway transport must not run');
  };
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => input,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          events.push('database opened');
          database = trackedDatabase(events, root);
          return database;
        },
        gatewayLlmFetch: transport,
        materializeGatewayConfig: async (
          candidate: ParsedConfig,
          options: GatewayConfigMaterializationOptions,
        ) => {
          calls += 1;
          events.push('config materialized');
          assert.equal(candidate, input);
          assert.equal(options.fetch, transport);
          assert.equal(typeof options.store.read, 'function');
          return resolved;
        },
        fetchContextWindow: async (projected) => {
          assert.equal(projected.llm.registrySource, 'canonical');
          const model = projected.llm.model;
          events.push(
            model === 'wire-compaction' ? 'compaction context' : 'main context',
          );
          if (model === 'wire-compaction') throw stop;
          return 128_000;
        },
        loadExtensions: async () => {
          events.push('extensions loaded');
          throw new Error('extensions must not run before compaction budget');
        },
        createLLM: () => {
          events.push('provider created');
          throw new Error('provider must not run before compaction budget');
        },
      }),
      stop,
    );
    assert.equal(input.llm.registrySource, expectedSource);
    assert.equal(calls, 1);
    assert.deepEqual(events, [
      'database opened',
      'config materialized',
      'main context',
      'compaction context',
      'database closed',
    ]);
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
  }
}

test('managed credential failure closes the database before boot consumers', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-managed-boot-failure-'),
  );
  const config = managedConfig(dataDirectory);
  const events: string[] = [];
  let database: Database | undefined;
  let gatewayFetches = 0;
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => config,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          events.push('database opened');
          database = trackedDatabase(events, root);
          return database;
        },
        gatewayLlmFetch: async () => {
          gatewayFetches += 1;
          throw new Error('idle resident must fail before catalog fetch');
        },
        loadExtensions: async () => {
          events.push('extensions loaded');
          throw new Error('extensions must not run');
        },
        fetchContextWindow: async () => {
          events.push('context lookup');
          throw new Error('context lookup must not run');
        },
        createLLM: () => {
          events.push('provider created');
          throw new Error('provider must not run');
        },
      }),
      /resident phase must be active or rotating/i,
    );
    assert.deepEqual(events, ['database opened', 'database closed']);
    assert.equal(gatewayFetches, 0);
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('materializer seam resolves before motor and compaction consumers', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-managed-boot-order-'),
  );
  try {
    await expectStoppedAfterCompaction(
      managedConfig(dataDirectory, true),
      directConfig(dataDirectory, true),
      'gateway',
    );
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('direct config crosses materialization once without requiring Gateway activity', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-direct-boot-order-'),
  );
  const config = directConfig(dataDirectory);
  try {
    await expectStoppedAfterCompaction(config, config, 'canonical');
  } finally {
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('resident store construction failure closes the newly opened database', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-store-boot-failure-'),
  );
  const config = managedConfig(dataDirectory);
  const events: string[] = [];
  let database: Database | undefined;
  const stop = new Error('resident store construction failed');
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => config,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          events.push('database opened');
          database = trackedDatabase(events, root);
          return database;
        },
        createGatewayResidentStore: () => {
          events.push('resident store construction');
          throw stop;
        },
        materializeGatewayConfig: async () => {
          events.push('config materialized');
          return directConfig(dataDirectory);
        },
      }),
      stop,
    );
    assert.deepEqual(events, [
      'database opened',
      'resident store construction',
      'database closed',
    ]);
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('main context failure closes the database before downstream effects', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-main-context-failure-'),
  );
  const input = managedConfig(dataDirectory);
  const resolved = directConfig(dataDirectory, false, false);
  const events: string[] = [];
  let database: Database | undefined;
  const stop = new Error('main context is unknown');
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => input,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          events.push('database opened');
          database = trackedDatabase(events, root);
          return database;
        },
        materializeGatewayConfig: async () => {
          events.push('config materialized');
          return resolved;
        },
        fetchContextWindow: async () => {
          events.push('main context');
          throw stop;
        },
        loadExtensions: async () => {
          events.push('extensions loaded');
          throw new Error('extensions must not run');
        },
        createLLM: () => {
          events.push('provider created');
          throw new Error('provider must not run');
        },
      }),
      stop,
    );
    assert.deepEqual(events, [
      'database opened',
      'config materialized',
      'main context',
      'database closed',
    ]);
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

function managedCatalogModel(modelRef: string): LlmProxyCatalogModel {
  return {
    modelRef,
    targetGeneration: ('egt1.' +
      Buffer.from(modelRef.padEnd(16, '_'))
        .subarray(0, 16)
        .toString('base64url')) as LlmProxyCatalogModel['targetGeneration'],
    providerType: 'openai-compatible',
    model: `upstream-${modelRef.split('/')[1]}`,
    allowedRoutes: ['responses'],
    contextSize: 128_000,
    reasoningEffort: 'high',
    reasoningSummary: null,
    reasoningContext: 'all_turns',
    toolTier: null,
    externalThinking: false,
    toolContractVersion: TOOL_CONTRACT_VERSION,
    callTimeoutMs: 120_000,
    streamIdleTimeoutMs: 60_000,
  };
}

test('production direct materialization never contacts Gateway', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-direct-production-seam-'),
  );
  const config = directConfig(dataDirectory, false, false);
  const events: string[] = [];
  let database: Database | undefined;
  let gatewayFetches = 0;
  const stop = new Error('stop after direct main context');
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => config,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          events.push('database opened');
          database = trackedDatabase(events, root);
          return database;
        },
        gatewayLlmFetch: async () => {
          gatewayFetches += 1;
          throw new Error('direct mode must not contact Gateway');
        },
        fetchContextWindow: async (projected) => {
          assert.equal(projected, config);
          events.push('direct main context');
          throw stop;
        },
      }),
      stop,
    );
    assert.equal(gatewayFetches, 0);
    assert.deepEqual(events, [
      'database opened',
      'direct main context',
      'database closed',
    ]);
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('resident secret failure closes the database before downstream effects', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-secret-boot-failure-'),
  );
  const config = directConfig(dataDirectory, false, false);
  const events: string[] = [];
  let database: Database | undefined;
  const stop = new Error('resident secret read failed');
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => config,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          events.push('database opened');
          database = trackedDatabase(events, root);
          return database;
        },
        createGatewayResidentStore: (opened) => {
          const store = createGatewayResidentStore(opened);
          Object.defineProperty(store, 'secretValues', {
            value: () => {
              events.push('resident secrets');
              throw stop;
            },
          });
          return store;
        },
        fetchContextWindow: async () => {
          events.push('main context');
          return 128_000;
        },
        loadExtensions: async () => {
          events.push('extensions loaded');
          throw new Error('extensions must not run');
        },
      }),
      stop,
    );
    assert.deepEqual(events, [
      'database opened',
      'main context',
      'resident secrets',
      'database closed',
    ]);
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('database close failure does not replace the startup error', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-close-boot-failure-'),
  );
  const config = directConfig(dataDirectory, false, false);
  const stop = new Error('main context failed first');
  let database: Database | undefined;
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => config,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          database = openDatabase(root);
          const close = database.close.bind(database);
          Object.defineProperty(database, 'close', {
            configurable: true,
            value: () => {
              close();
              throw new Error('database close failed second');
            },
          });
          return database;
        },
        fetchContextWindow: async () => {
          throw stop;
        },
      }),
      stop,
    );
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});

test('materializer seam closes the database on a missing motor role', async () => {
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'gateway-motor-role-failure-'),
  );
  const input = managedConfig(dataDirectory, true);
  const resolved = directConfig(dataDirectory, true, false);
  resolved.llm.registry = createLlmModelRegistry({
    providers: resolved.llm.registry.providers,
    roles: {
      ...resolved.llm.registry.roles,
      motor: null,
      compaction: null,
    },
  });
  const events: string[] = [];
  let database: Database | undefined;
  try {
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => input,
        resolveBuildIdentity: async () => buildIdentity,
        openDatabase: (root) => {
          events.push('database opened');
          database = trackedDatabase(events, root);
          return database;
        },
        materializeGatewayConfig: async () => {
          events.push('config materialized');
          return resolved;
        },
        fetchContextWindow: async () => {
          events.push('context lookup');
          return 128_000;
        },
        loadExtensions: async () => {
          events.push('extensions loaded');
          throw new Error('extensions must not run');
        },
      }),
      /llm\.roles\.motor is required/,
    );
    assert.deepEqual(events, [
      'database opened',
      'config materialized',
      'database closed',
    ]);
    assert.ok(database);
    assert.equal(database.isOpen, false);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
