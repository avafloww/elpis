import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createNodeCredential,
  newGatewayInstanceId,
  openGatewayStore,
} from '../src/index.js';
import { GATEWAY_LLM_WIRE_GRAMMARS } from '../src/llm-broker.js';

function fixture(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-provider-store-'));
}

test('provider target generations and grants produce exact secret-free catalogs', (t) => {
  const directory = fixture();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  let randomByte = 0x41;
  let randomCalls = 0;
  const store = openGatewayStore(directory, {
    now: () => now,
    randomBytes: (size) => {
      randomCalls += 1;
      return Buffer.alloc(size, randomByte++);
    },
  });
  store.setPublicUrl('https://gateway.example.com');
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

  const hiddenAccountRef = 'hidden-provider-account-ref';
  const hiddenAccountId = 'hidden-provider-account-id';
  const api = store.providers.installApiKeyCredential({
    providerId: 'ananke',
    accountRef: hiddenAccountRef,
    apiKey: 'synthetic-provider-api-key',
  });
  const oauth = store.providers.installOAuthCredential({
    providerId: 'codex',
    providerType: 'codex-oauth',
    accountRef: hiddenAccountRef,
    accountIdentity: { accountId: hiddenAccountId, authorizedAt: 900 },
    accessToken: 'synthetic-provider-access',
    refreshToken: 'synthetic-provider-refresh',
    expiresAt: 9000,
  });
  const hiddenOpenAiBase = 'https://private-openai-endpoint.example/v1';
  const hiddenCodexBase = 'https://chatgpt.com/backend-api';
  const weakConfig = {
    credentialId: api.credentialId,
    modelRef: 'ananke/weak',
    baseUrl: hiddenOpenAiBase,
    model: 'upstream-weak-a',
    allowedRoutes: ['chat/completions', 'responses'] as const,
    wireGrammar: {
      responses: GATEWAY_LLM_WIRE_GRAMMARS.responses,
      'chat/completions': GATEWAY_LLM_WIRE_GRAMMARS['chat/completions'],
    },
    contextSize: 32768,
    reasoningEffort: null,
    reasoningSummary: null,
    reasoningContext: null,
    toolTier: 'weak' as const,
    externalThinking: false,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 60000,
    streamIdleTimeoutMs: 60000,
  };
  const codexConfig = {
    credentialId: oauth.credentialId,
    modelRef: 'codex/strong',
    baseUrl: hiddenCodexBase,
    model: 'gpt-codex-test',
    allowedRoutes: ['codex/models', 'codex/responses', 'models'] as const,
    wireGrammar: {
      models: GATEWAY_LLM_WIRE_GRAMMARS.models,
      'codex/responses': GATEWAY_LLM_WIRE_GRAMMARS.codexResponses,
      'codex/models': GATEWAY_LLM_WIRE_GRAMMARS.codexModels,
    },
    contextSize: null,
    reasoningEffort: 'high',
    reasoningSummary: 'auto',
    reasoningContext: 'opaque',
    toolTier: 'strong' as const,
    externalThinking: true,
    toolContractVersion: 'elpis-tools-v1',
    callTimeoutMs: 120000,
    streamIdleTimeoutMs: 120000,
  };

  const modelErrors: string[] = [];
  const missingCredentialId = `epc1.${Buffer.alloc(16, 0x7f).toString('base64url')}`;
  assert.throws(
    () =>
      store.providers.configureModel({
        ...weakConfig,
        credentialId: missingCredentialId,
      }),
    (error) => {
      modelErrors.push(String(error));
      return /credential not found/.test(String(error));
    },
  );
  for (const invalid of [
    {
      ...weakConfig,
      modelRef: 'ananke/http',
      baseUrl: 'http://provider.example/v1',
    },
    {
      ...weakConfig,
      modelRef: 'ananke/route',
      allowedRoutes: ['messages'] as const,
      wireGrammar: { messages: GATEWAY_LLM_WIRE_GRAMMARS.messages },
    },
    {
      ...weakConfig,
      modelRef: 'ananke/grammar',
      wireGrammar: {
        responses: 'wrong-responses-v1',
        'chat/completions': GATEWAY_LLM_WIRE_GRAMMARS['chat/completions'],
      },
    },
    {
      ...codexConfig,
      modelRef: 'codex/deceptive',
      baseUrl: 'https://provider.example/backend-api',
    },
  ]) {
    assert.throws(
      () => store.providers.configureModel(invalid),
      /(?:provider base URL has invalid syntax|provider model configuration failed)/,
    );
  }

  now = 2000;
  const weakA = store.providers.configureModel(weakConfig);
  assert.equal(weakA.changed, true);
  assert.equal(weakA.modelRef, 'ananke/weak');
  assert.equal(weakA.revision, 1);
  assert.equal(Object.isFrozen(weakA), true);
  const callsAfterFirstTarget = randomCalls;
  const weakNoop = store.providers.configureModel({ ...weakConfig });
  assert.deepEqual(weakNoop, { ...weakA, changed: false });
  assert.equal(randomCalls, callsAfterFirstTarget);

  now = 3000;
  const weakGrantA = store.providers.grantModelToInstance({
    instanceId,
    modelRef: weakA.modelRef,
  });
  assert.equal(weakGrantA.changed, true);
  assert.equal(weakGrantA.targetGeneration, weakA.targetGeneration);
  assert.equal(weakGrantA.revision, 2);
  const catalogA = store.providers.catalogForInstance(instanceId);
  assert.deepEqual(catalogA, {
    format: 'elpis-gateway-llm-catalog-v1',
    revision: weakGrantA.revision,
    models: [
      {
        modelRef: 'ananke/weak',
        targetGeneration: weakA.targetGeneration,
        providerType: 'openai-compatible',
        model: 'upstream-weak-a',
        allowedRoutes: ['chat/completions', 'responses'],
        contextSize: 32768,
        reasoningEffort: null,
        reasoningSummary: null,
        reasoningContext: null,
        toolTier: 'weak',
        externalThinking: false,
        toolContractVersion: 'elpis-tools-v1',
        callTimeoutMs: 60000,
        streamIdleTimeoutMs: 60000,
      },
    ],
  });
  assert.equal(Object.isFrozen(catalogA), true);
  assert.equal(Object.isFrozen(catalogA.models), true);
  assert.equal(Object.isFrozen(catalogA.models[0]), true);

  now = 4000;
  const weakB = store.providers.configureModel({
    ...weakConfig,
    model: 'upstream-weak-b',
  });
  assert.equal(weakB.changed, true);
  assert.notEqual(weakB.targetGeneration, weakA.targetGeneration);
  assert.ok(weakB.revision > weakGrantA.revision);
  assert.deepEqual(store.providers.catalogForInstance(instanceId).models, []);

  const otherWeak = store.providers.configureModel({
    ...weakConfig,
    modelRef: 'ananke/other',
    model: 'upstream-other',
  });
  assert.equal(otherWeak.revision, weakB.revision + 1);
  const weakGrantB = store.providers.grantModelToInstance({
    instanceId,
    modelRef: weakB.modelRef,
  });
  assert.equal(weakGrantB.revision, otherWeak.revision + 1);
  assert.throws(
    () =>
      store.providers.grantModelToInstance({
        instanceId,
        modelRef: otherWeak.modelRef,
      }),
    (error) => {
      modelErrors.push(String(error));
      return /conflicts with catalog/.test(String(error));
    },
  );
  assert.equal(
    store.providers.catalogForInstance(instanceId).revision,
    weakGrantB.revision,
  );

  now = 5000;
  const codexA = store.providers.configureModel(codexConfig);
  assert.equal(codexA.revision, weakGrantB.revision + 1);
  const codexGrant = store.providers.grantModelToInstance({
    instanceId,
    modelRef: codexA.modelRef,
  });
  assert.equal(codexGrant.revision, codexA.revision + 1);
  const catalogBoth = store.providers.catalogForInstance(instanceId);
  assert.deepEqual(
    catalogBoth.models.map((model) => [
      model.modelRef,
      model.targetGeneration,
      model.providerType,
      model.model,
      model.toolTier,
    ]),
    [
      [
        'ananke/weak',
        weakB.targetGeneration,
        'openai-compatible',
        'upstream-weak-b',
        'weak',
      ],
      [
        'codex/strong',
        codexA.targetGeneration,
        'codex-oauth',
        'gpt-codex-test',
        'strong',
      ],
    ],
  );
  const duplicateGrant = store.providers.grantModelToInstance({
    instanceId,
    modelRef: weakB.modelRef,
  });
  assert.equal(duplicateGrant.changed, false);
  assert.equal(duplicateGrant.targetGeneration, weakB.targetGeneration);
  assert.equal(duplicateGrant.revision, codexGrant.revision);

  now = 6000;
  const revoked = store.providers.revokeModelFromInstance({
    instanceId,
    modelRef: weakB.modelRef,
  });
  assert.equal(revoked.changed, true);
  assert.equal(revoked.revision, codexGrant.revision + 1);
  const revokedNoop = store.providers.revokeModelFromInstance({
    instanceId,
    modelRef: weakB.modelRef,
  });
  assert.deepEqual(revokedNoop, { ...revoked, changed: false });
  assert.deepEqual(
    store.providers
      .catalogForInstance(instanceId)
      .models.map((model) => model.modelRef),
    ['codex/strong'],
  );

  now = 7000;
  const disabled = store.providers.disableModel({ modelRef: codexA.modelRef });
  assert.equal(disabled.changed, true);
  assert.ok(disabled.revision > revoked.revision);
  assert.deepEqual(store.providers.catalogForInstance(instanceId).models, []);
  const disabledNoop = store.providers.disableModel({
    modelRef: codexA.modelRef,
  });
  assert.deepEqual(disabledNoop, { ...disabled, changed: false });
  const callsBeforeReenable = randomCalls;
  const codexB = store.providers.configureModel({ ...codexConfig });
  assert.equal(codexB.changed, true);
  assert.notEqual(codexB.targetGeneration, codexA.targetGeneration);
  assert.equal(randomCalls, callsBeforeReenable + 1);
  assert.deepEqual(store.providers.catalogForInstance(instanceId).models, []);

  assert.ok('ananke/m_'.localeCompare('ananke/m-') < 0);
  const punctuationDash = store.providers.configureModel({
    ...weakConfig,
    modelRef: 'ananke/m-',
    model: 'upstream-punctuation-dash',
    toolTier: null,
  });
  const punctuationUnderscore = store.providers.configureModel({
    ...weakConfig,
    modelRef: 'ananke/m_',
    model: 'upstream-punctuation-underscore',
    toolTier: null,
  });
  const punctuationDashGrant = store.providers.grantModelToInstance({
    instanceId,
    modelRef: punctuationDash.modelRef,
  });
  const punctuationUnderscoreGrant = store.providers.grantModelToInstance({
    instanceId,
    modelRef: punctuationUnderscore.modelRef,
  });
  assert.equal(
    punctuationUnderscoreGrant.revision,
    punctuationDashGrant.revision + 1,
  );
  const punctuationCatalog = store.providers.catalogForInstance(instanceId);
  assert.deepEqual(
    punctuationCatalog.models.map((model) => model.modelRef),
    ['ananke/m_', 'ananke/m-'],
  );

  const providerAudit = store
    .audit(1000)
    .filter(
      (event) =>
        event.action.startsWith('provider.model.') ||
        event.action.startsWith('provider.instance-model.'),
    );
  const externallyVisible = JSON.stringify({
    weakA,
    weakNoop,
    weakGrantA,
    catalogA,
    weakB,
    otherWeak,
    weakGrantB,
    codexA,
    codexGrant,
    catalogBoth,
    duplicateGrant,
    revoked,
    revokedNoop,
    disabled,
    disabledNoop,
    codexB,
    punctuationDash,
    punctuationUnderscore,
    punctuationDashGrant,
    punctuationUnderscoreGrant,
    punctuationCatalog,
    providerAudit,
    modelErrors,
  });
  for (const hidden of [
    api.credentialId,
    oauth.credentialId,
    missingCredentialId,
    hiddenAccountRef,
    hiddenAccountId,
    hiddenOpenAiBase,
    hiddenCodexBase,
    'hidden-openai-responses-grammar-v1',
    'hidden-openai-chat-grammar-v1',
    'hidden-codex-models-grammar-v1',
    'hidden-codex-responses-grammar-v1',
    'hidden-codex-models-backend-grammar-v1',
  ])
    assert.equal(externallyVisible.includes(hidden), false, hidden);

  const witness = new DatabaseSync(store.databasePath, {
    enableForeignKeyConstraints: true,
    readOnly: true,
  });
  const targets = witness
    .prepare(
      `SELECT model_ref, credential_id, account_ref, base_url, wire_grammar_json,
              target_generation
       FROM gateway_provider_targets ORDER BY target_seq`,
    )
    .all() as unknown as Array<Record<string, unknown>>;
  assert.deepEqual(
    targets.map((row) => row.model_ref),
    [
      'ananke/weak',
      'ananke/weak',
      'ananke/other',
      'codex/strong',
      'codex/strong',
      'ananke/m-',
      'ananke/m_',
    ],
  );
  assert.equal(targets[0].credential_id, api.credentialId);
  assert.equal(targets[0].account_ref, hiddenAccountRef);
  assert.equal(targets[0].base_url, hiddenOpenAiBase);
  assert.equal(
    JSON.parse(String(targets[0].wire_grammar_json)).responses,
    GATEWAY_LLM_WIRE_GRAMMARS.responses,
  );
  assert.equal(targets[3].credential_id, oauth.credentialId);
  assert.equal(targets[3].base_url, hiddenCodexBase);
  assert.equal(
    targets.some((row) => row.target_generation === weakA.targetGeneration),
    true,
  );
  assert.equal(
    targets.some((row) => row.target_generation === codexA.targetGeneration),
    true,
  );
  assert.deepEqual(witness.prepare('PRAGMA foreign_key_check').all(), []);
  witness.close();

  const corruption = new DatabaseSync(store.databasePath, {
    enableForeignKeyConstraints: true,
  });
  corruption.exec('DROP TRIGGER gateway_provider_targets_no_update');
  corruption
    .prepare(
      `UPDATE gateway_provider_targets SET base_url = 'http://provider.example/v1'
       WHERE target_generation = ?`,
    )
    .run(punctuationDash.targetGeneration);
  corruption.close();
  assert.throws(
    () => store.providers.catalogForInstance(instanceId),
    /gateway provider catalog is invalid/,
  );
  store.close();
});
