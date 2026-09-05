import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import {
  COMPACTION_FRAMING_TOKENS,
  resolveCompactionRoleBudget,
} from '../src/llm/compaction-role.js';
import type { LlmProviderType } from '../src/llm/model-registry.js';
import { createLlmModelRegistry } from '../src/llm/model-registry.js';
import type { Database } from '../src/store/db.js';
import { makeConfig } from './helpers.js';

const fakeDb = {} as Database;

function configuredRole(
  providerType: LlmProviderType = 'openai-compatible',
  completionReserveTokens = 8_192,
): Config {
  const config = makeConfig();
  const provider = {
    providerType,
    apiKey: 'synthetic-key',
    baseUrl: 'https://example.test/v1',
    api: 'responses' as const,
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
  };
  config.llm.registry = createLlmModelRegistry({
    providers: { selected: provider },
    roles: {
      main: 'selected/foreground',
      classifier: 'selected/foreground',
      motor: null,
      compaction: 'selected/summary',
    },
  });
  config.llm.registrySource = 'canonical';
  config.llm.completionReserveTokens = completionReserveTokens;
  // Deliberately leave the flattened foreground projection unrelated to the
  // role target. Resolution must project the role instead of reading these.
  config.llm.model = 'unrelated-foreground';
  config.llm.contextSize = 999_999;
  return config;
}

test('omitted compaction role performs no lookup or density construction', async () => {
  const config = makeConfig();
  let lookups = 0;
  let densities = 0;
  const budget = await resolveCompactionRoleBudget(config, fakeDb, {
    fetchContextWindow: async () => {
      lookups++;
      return 1;
    },
    createDensityModel: () => {
      densities++;
      throw new Error('must not construct density');
    },
  });
  assert.equal(budget, undefined);
  assert.equal(lookups, 0);
  assert.equal(densities, 0);
});

test('explicit role uses its projected window, model density, and full budget', async () => {
  const config = configuredRole('openai-compatible', 20_000);
  let lookupConfig: Config | undefined;
  let densityModel: string | undefined;
  let densityDb: Database | undefined;
  const budget = await resolveCompactionRoleBudget(config, fakeDb, {
    fetchContextWindow: async (projected, db) => {
      lookupConfig = projected;
      assert.equal(db, fakeDb);
      return 70_000;
    },
    createDensityModel: (db, model) => {
      densityDb = db;
      densityModel = model;
      return {
        ratio: () => 2,
        estimate: (chars) => Math.ceil(chars / 2),
        observe: () => {},
      };
    },
  });

  assert.equal(lookupConfig?.llm.model, 'wire-summary');
  assert.equal(lookupConfig?.llm.contextSize, 80_000);
  assert.equal(densityModel, 'wire-summary');
  assert.equal(densityDb, fakeDb);
  assert.equal(budget?.contextWindowTokens, 70_000);
  assert.equal(budget?.outputReserveTokens, 20_000);
  assert.equal(budget?.framingTokens, COMPACTION_FRAMING_TOKENS);
  assert.equal(COMPACTION_FRAMING_TOKENS, 1_024);
  assert.equal(budget?.estimateTokens('12345'), 3);
  assert.equal(config.llm.model, 'unrelated-foreground');
  assert.equal(config.llm.contextSize, 999_999);
});

test('provider summary headroom is reserved without lowering configured reserve', async () => {
  for (const [providerType, nativeReserve] of [
    ['openai-compatible', 12_000],
    ['codex-oauth', 12_000],
    ['anthropic-oauth', 32_000],
  ] as const) {
    const nativeBudget = await resolveCompactionRoleBudget(
      configuredRole(providerType, 8_192),
      fakeDb,
      {
        fetchContextWindow: async () => 100_000,
        createDensityModel: () => ({
          ratio: () => 4,
          estimate: (chars) => Math.ceil(chars / 4),
          observe: () => {},
        }),
      },
    );
    assert.equal(
      nativeBudget?.outputReserveTokens,
      nativeReserve,
      providerType,
    );

    const configuredBudget = await resolveCompactionRoleBudget(
      configuredRole(providerType, 40_000),
      fakeDb,
      {
        fetchContextWindow: async () => 100_000,
        createDensityModel: () => ({
          ratio: () => 4,
          estimate: (chars) => Math.ceil(chars / 4),
          observe: () => {},
        }),
      },
    );
    assert.equal(configuredBudget?.outputReserveTokens, 40_000, providerType);
  }
});

test('insufficient selected-model context fails during early resolution', async () => {
  await assert.rejects(
    resolveCompactionRoleBudget(configuredRole(), fakeDb, {
      fetchContextWindow: async () => 13_024,
      createDensityModel: () => ({
        ratio: () => 4,
        estimate: (chars) => Math.ceil(chars / 4),
        observe: () => {},
      }),
    }),
    /output reserve and framing must leave input capacity/,
  );
});

test('selected-model context lookup failure is fatal with no fallback', async () => {
  let densities = 0;
  await assert.rejects(
    resolveCompactionRoleBudget(configuredRole(), fakeDb, {
      fetchContextWindow: async (projected) => {
        assert.equal(projected.llm.model, 'wire-summary');
        throw new Error('synthetic summary window lookup failed');
      },
      createDensityModel: () => {
        densities++;
        throw new Error('must not construct after failed lookup');
      },
    }),
    /synthetic summary window lookup failed/,
  );
  assert.equal(densities, 0);
});
