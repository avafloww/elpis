import test from "node:test";
import assert from "node:assert/strict";
import {
  createLlmModelRegistry,
  legacyLlmModelRegistry,
  parseLlmModelRef,
  resolveLlmModelTarget,
  type LlmRegistryInput,
} from "../src/llm/model-registry.js";

function input(): LlmRegistryInput {
  return {
    providers: {
      openrouter: {
        providerType: "openai-compatible",
        apiKey: "placeholder",
        baseUrl: "https://api.example/v1",
        api: "responses",
        externalThinking: false,
        streamIdleTimeoutMs: 180_000,
        callTimeoutMs: 1_200_000,
        models: {
          sol: {
            name: "openai/gpt-5.6-sol",
            contextSize: 272_000,
            reasoningEffort: "high",
            reasoningSummary: null,
            reasoningContext: "all_turns",
          },
          motor: {
            name: "openai/gpt-5.6-mini",
            contextSize: 128_000,
            reasoningEffort: "low",
            reasoningSummary: null,
            reasoningContext: null,
          },
          secretary: {
            name: "openai/gpt-5.6-secretary",
            contextSize: 64_000,
            reasoningEffort: "medium",
            reasoningSummary: null,
            reasoningContext: null,
          },
        },
      },
    },
    roles: {
      main: "openrouter/sol",
      classifier: "openrouter/sol",
      motor: "openrouter/motor",
      secretary: "openrouter/secretary",
    },
  };
}

test("model refs require exactly provider/model-id safe segments", () => {
  assert.deepEqual(parseLlmModelRef("openrouter/gpt-5.6_sol"), {
    providerId: "openrouter",
    modelId: "gpt-5.6_sol",
  });
  for (const bad of [
    "openrouter",
    "a/b/c",
    "/model",
    "provider/",
    "Provider/model",
    "provider/model id",
  ]) {
    assert.throws(() => parseLlmModelRef(bad), /provider\/model-id|must match/);
  }
});

test("registry resolves main, classifier, and motor without requiring distinct role refs", () => {
  const registry = createLlmModelRegistry(input(), { requireMotor: true });
  assert.equal(registry.targets.main.name, "openai/gpt-5.6-sol");
  assert.equal(registry.targets.main.ref, "openrouter/sol");
  assert.equal(registry.targets.classifier.ref, registry.targets.main.ref);
  assert.equal(registry.targets.motor?.name, "openai/gpt-5.6-mini");
  assert.equal(registry.targets.motor?.provider, registry.providers.openrouter);
  assert.equal(registry.targets.secretary?.name, "openai/gpt-5.6-secretary");
  assert.equal(
    registry.targets.secretary?.provider,
    registry.providers.openrouter,
  );
});

test("arbitrary model refs resolve without occupying a role", () => {
  const registry = createLlmModelRegistry(input());
  const target = resolveLlmModelTarget(
    registry,
    "openrouter/motor",
    "worker model",
  );
  assert.equal(target.ref, "openrouter/motor");
  assert.equal(target.name, "openai/gpt-5.6-mini");
  assert.equal(target.provider, registry.providers.openrouter);
  assert.throws(
    () => resolveLlmModelTarget(registry, "missing/motor", "worker model"),
    /worker model references unknown provider/,
  );
  assert.throws(
    () => resolveLlmModelTarget(registry, "openrouter/missing", "worker model"),
    /worker model references unknown model/,
  );
});

test("secretary role is optional", () => {
  const value = input();
  delete value.roles.secretary;
  const registry = createLlmModelRegistry(value);
  assert.equal(registry.roles.secretary, null);
  assert.equal(registry.targets.secretary, null);
});

test("motor role is required only when the motor module is active", () => {
  const value = input();
  value.roles.motor = null;
  assert.equal(createLlmModelRegistry(value).targets.motor, null);
  assert.throws(
    () => createLlmModelRegistry(value, { requireMotor: true }),
    /llm.roles.motor is required/,
  );
});

test("legacy adapter has one explicit compatibility identity for every active role", () => {
  const legacy = legacyLlmModelRegistry(
    {
      providerType: "openai-compatible",
      apiKey: "key",
      baseUrl: "https://api.example/v1",
      model: "wire-model",
      contextSize: 128_000,
      reasoningEffort: "high",
      externalThinking: false,
      streamIdleTimeoutMs: 180_000,
      callTimeoutMs: 1_200_000,
      api: "auto",
      reasoningSummary: null,
      reasoningContext: null,
    },
    { motorEnabled: true },
  );
  assert.equal(legacy.roles.main, "legacy/main");
  assert.equal(legacy.roles.classifier, legacy.roles.main);
  assert.equal(legacy.roles.motor, legacy.roles.main);
  assert.equal(legacy.targets.motor?.name, "wire-model");
});

test("registry rejects unknown refs and invalid provider/model definitions", () => {
  const unknownProvider = input();
  unknownProvider.roles.main = "missing/sol";
  assert.throws(
    () => createLlmModelRegistry(unknownProvider),
    /unknown provider/,
  );
  const unknownModel = input();
  unknownModel.roles.classifier = "openrouter/missing";
  assert.throws(() => createLlmModelRegistry(unknownModel), /unknown model/);
  const emptyModels = input();
  emptyModels.providers.openrouter.models = {};
  assert.throws(
    () => createLlmModelRegistry(emptyModels),
    /at least one model/,
  );
  const badContext = input();
  badContext.providers.openrouter.models.sol.contextSize = 0;
  assert.throws(() => createLlmModelRegistry(badContext), /positive integer/);
});
