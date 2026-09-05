import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { CREDENTIAL_VECTORS } from '@elpis/gateway-protocol';
import { createBuildIdentity } from '../src/build-identity.js';
import type { Config } from '../src/config.js';
import { createElpisRuntime } from '../src/index.js';
import { createLlmModelRegistry } from '../src/llm/model-registry.js';
import { openDatabase, type Database } from '../src/store/db.js';
import { makeConfig } from './helpers.js';

function bootConfig(dataDirectory: string): Config {
  const config = makeConfig({
    modules: { enabled: null, disabled: ['motor'] },
    paths: {
      dataDirectory,
      soulPath: path.join(dataDirectory, 'SOUL.md'),
      memoryPath: path.join(dataDirectory, 'MEMORY.md'),
      harnessRoot: dataDirectory,
    },
    dashboard: {
      local: {
        enabled: false,
        mcpEnabled: false,
        host: '127.0.0.1',
        port: 8787,
      },
      // A canonical synthetic grant makes enrollment fetch immediately if boot
      // reaches Gateway activity. A null remote would not exercise that path.
      remote: {
        url: 'https://gateway.example.test',
        enrollmentToken: CREDENTIAL_VECTORS.enrollment.token,
      },
    },
  });
  config.llm.registry = createLlmModelRegistry({
    providers: {
      selected: {
        providerType: 'openai-compatible',
        apiKey: 'synthetic-provider-key',
        baseUrl: 'https://provider.example.test/v1',
        api: 'responses',
        externalThinking: false,
        streamIdleTimeoutMs: 1_000,
        callTimeoutMs: 2_000,
        models: {
          foreground: {
            name: 'wire-foreground',
            contextSize: 250_000,
            reasoningEffort: 'high',
            reasoningSummary: null,
            reasoningContext: 'all_turns',
          },
          summary: {
            name: 'wire-summary',
            contextSize: 80_000,
            reasoningEffort: 'low',
            reasoningSummary: null,
            reasoningContext: null,
          },
        },
      },
    },
    roles: {
      main: 'selected/foreground',
      classifier: 'selected/foreground',
      motor: null,
      compaction: 'selected/summary',
    },
  });
  config.llm.registrySource = 'canonical';
  return config;
}

const lookupFailure = new Error('synthetic summary window lookup failed');
const scenarios = [
  {
    name: 'selected-model lookup failure',
    window: null,
    expected: lookupFailure,
    closeThrows: false,
  },
  {
    name: 'selected-model invalid budget',
    window: 13_024,
    expected: null,
    closeThrows: true,
  },
] as const;

for (const scenario of scenarios) {
  test(`runtime rejects ${scenario.name} before enabled Gateway or extensions`, async () => {
    const dataDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'elpis-compaction-budget-boot-'),
    );
    const config = bootConfig(dataDirectory);
    const events: string[] = [];
    let database: Database | undefined;
    let forceClose: (() => void) | undefined;

    try {
      await assert.rejects(
        createElpisRuntime({
          loadConfigFile: () => config,
          resolveBuildIdentity: async () =>
            createBuildIdentity({
              version: '0.0.0',
              revision: null,
              treeClean: null,
              exactTag: null,
            }),
          openDatabase: (root) => {
            events.push('database opened');
            database = openDatabase(root);
            const close = database.close.bind(database);
            forceClose = close;
            Object.defineProperty(database, 'close', {
              configurable: true,
              value: () => {
                events.push('database closed');
                close();
                if (scenario.closeThrows)
                  throw new Error('synthetic database close failure');
              },
            });
            return database;
          },
          fetchContextWindow: async (projected) => {
            events.push(`context lookup: ${projected.llm.model}`);
            assert.equal(projected.llm.model, 'wire-summary');
            if (scenario.expected) throw scenario.expected;
            return scenario.window;
          },
          createLLM: () => {
            events.push('provider client created');
            throw new Error('provider clients must not run');
          },
          gatewayEnrollmentFetch: async () => {
            events.push('gateway enrollment fetch');
            throw new Error('Gateway must not run');
          },
          createGatewayRotationController: () => {
            events.push('gateway rotation controller');
            throw new Error('Gateway must not run');
          },
          createGatewayLinkController: () => {
            events.push('gateway link controller');
            throw new Error('Gateway must not run');
          },
          loadExtensions: async () => {
            events.push('extensions loaded');
            throw new Error('extensions must not run');
          },
          createDiscord: () => {
            events.push('Discord created');
            throw new Error('Discord must not run');
          },
        }),
        (error) => {
          if (scenario.expected) assert.equal(error, scenario.expected);
          else
            assert.match(
              String(error),
              /output reserve and framing must leave input capacity/,
            );
          return true;
        },
      );

      assert.deepEqual(events, [
        'database opened',
        'context lookup: wire-summary',
        'database closed',
      ]);
      assert.ok(database);
      assert.equal(database.isOpen, false);
    } finally {
      if (database?.isOpen) forceClose?.();
      fs.rmSync(dataDirectory, { recursive: true, force: true });
    }
  });
}
