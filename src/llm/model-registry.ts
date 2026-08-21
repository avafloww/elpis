export const LLM_PROVIDER_TYPES = [
  "openai-compatible",
  "anthropic-oauth",
  "codex-oauth",
] as const;
export type LlmProviderType = (typeof LLM_PROVIDER_TYPES)[number];
export type LlmRole = "main" | "classifier" | "motor";

export interface LlmModelDefinition {
  name: string;
  contextSize: number | null;
  reasoningEffort: string | null;
  reasoningSummary: string | null;
  reasoningContext: string | null;
}

export interface LlmProviderDefinition {
  providerType: LlmProviderType;
  apiKey: string;
  baseUrl: string;
  api: "auto" | "responses" | "chat";
  externalThinking: boolean;
  streamIdleTimeoutMs: number;
  callTimeoutMs: number;
  models: Record<string, LlmModelDefinition>;
}

export interface LlmRegistryInput {
  providers: Record<string, LlmProviderDefinition>;
  roles: { main: string; classifier: string; motor: string | null };
}

export interface ResolvedLlmTarget extends LlmModelDefinition {
  ref: string;
  providerId: string;
  modelId: string;
  provider: LlmProviderDefinition;
}

export interface LlmModelRegistry {
  providers: Record<string, LlmProviderDefinition>;
  roles: LlmRegistryInput["roles"];
  targets: {
    main: ResolvedLlmTarget;
    classifier: ResolvedLlmTarget;
    motor: ResolvedLlmTarget | null;
  };
}

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function requireId(value: string, label: string): void {
  if (!ID_RE.test(value))
    throw new Error(
      `${label} must match ${ID_RE.source} (got ${JSON.stringify(value)})`,
    );
}

export function parseLlmModelRef(
  value: string,
  label = "model ref",
): { providerId: string; modelId: string } {
  if (typeof value !== "string")
    throw new Error(`${label} must be a string in provider/model-id form`);
  const parts = value.split("/");
  if (parts.length !== 2)
    throw new Error(
      `${label} must be in provider/model-id form (got ${JSON.stringify(value)})`,
    );
  const [providerId, modelId] = parts;
  requireId(providerId, `${label} provider id`);
  requireId(modelId, `${label} model id`);
  return { providerId, modelId };
}

export function resolveLlmModelTarget(
  registry: Pick<LlmModelRegistry, "providers">,
  ref: string,
  label = "model ref",
): ResolvedLlmTarget {
  const { providerId, modelId } = parseLlmModelRef(ref, label);
  const provider = registry.providers[providerId];
  if (!provider)
    throw new Error(
      `${label} references unknown provider ${JSON.stringify(providerId)}`,
    );
  const model = provider.models[modelId];
  if (!model)
    throw new Error(
      `${label} references unknown model ${JSON.stringify(modelId)} on provider ${JSON.stringify(providerId)}`,
    );
  return { ...model, ref, providerId, modelId, provider };
}

function validateModel(model: LlmModelDefinition, path: string): void {
  if (!model || typeof model !== "object")
    throw new Error(`${path} must be a model mapping`);
  if (typeof model.name !== "string" || model.name.length === 0)
    throw new Error(`${path}.name must be a non-empty string`);
  if (
    model.contextSize !== null &&
    (!Number.isInteger(model.contextSize) || model.contextSize <= 0)
  ) {
    throw new Error(`${path}.context_size must be a positive integer or null`);
  }
  for (const key of [
    "reasoningEffort",
    "reasoningSummary",
    "reasoningContext",
  ] as const) {
    if (model[key] !== null && typeof model[key] !== "string")
      throw new Error(`${path}.${key} must be a string or null`);
  }
}

function validateProvider(provider: LlmProviderDefinition, path: string): void {
  if (!provider || typeof provider !== "object")
    throw new Error(`${path} must be a provider mapping`);
  if (!LLM_PROVIDER_TYPES.includes(provider.providerType))
    throw new Error(`${path}.provider_type is invalid`);
  if (typeof provider.baseUrl !== "string" || provider.baseUrl.length === 0)
    throw new Error(`${path}.base_url must be a non-empty string`);
  if (
    provider.providerType === "openai-compatible" &&
    (typeof provider.apiKey !== "string" || provider.apiKey.length === 0)
  ) {
    throw new Error(
      `${path}.api_key must be a non-empty string for openai-compatible`,
    );
  }
  if (!["auto", "responses", "chat"].includes(provider.api))
    throw new Error(`${path}.api must be auto, responses, or chat`);
  if (provider.providerType === "codex-oauth" && provider.api === "chat")
    throw new Error(`${path}.api=chat is not supported for codex-oauth`);
  if (typeof provider.externalThinking !== "boolean")
    throw new Error(`${path}.external_thinking must be boolean`);
  if (provider.externalThinking && provider.providerType !== "codex-oauth")
    throw new Error(`${path}.external_thinking requires codex-oauth`);
  for (const [key, value] of [
    ["stream_idle_timeout_ms", provider.streamIdleTimeoutMs],
    ["call_timeout_ms", provider.callTimeoutMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${path}.${key} must be a non-negative finite number`);
  }
  const models = Object.entries(provider.models ?? {});
  if (models.length === 0)
    throw new Error(`${path}.models must contain at least one model`);
  for (const [modelId, model] of models) {
    requireId(modelId, `${path} model id`);
    validateModel(model, `${path}.models.${modelId}`);
  }
}

export interface LegacyLlmDefinition {
  providerType: LlmProviderType;
  apiKey: string;
  baseUrl: string;
  model: string;
  contextSize: number | null;
  reasoningEffort: string | null;
  externalThinking: boolean;
  streamIdleTimeoutMs: number;
  callTimeoutMs: number;
  api: "auto" | "responses" | "chat";
  reasoningSummary: string | null;
  reasoningContext: string | null;
}

export function legacyLlmModelRegistry(
  legacy: LegacyLlmDefinition,
  opts: { motorEnabled?: boolean } = {},
): LlmModelRegistry {
  const ref = "legacy/main";
  return createLlmModelRegistry(
    {
      providers: {
        legacy: {
          providerType: legacy.providerType,
          apiKey: legacy.apiKey,
          baseUrl: legacy.baseUrl,
          api: legacy.api,
          externalThinking: legacy.externalThinking,
          streamIdleTimeoutMs: legacy.streamIdleTimeoutMs,
          callTimeoutMs: legacy.callTimeoutMs,
          models: {
            main: {
              name: legacy.model,
              contextSize: legacy.contextSize,
              reasoningEffort: legacy.reasoningEffort,
              reasoningSummary: legacy.reasoningSummary,
              reasoningContext: legacy.reasoningContext,
            },
          },
        },
      },
      roles: {
        main: ref,
        classifier: ref,
        motor: opts.motorEnabled ? ref : null,
      },
    },
    { requireMotor: opts.motorEnabled },
  );
}

export function createLlmModelRegistry(
  input: LlmRegistryInput,
  opts: { requireMotor?: boolean } = {},
): LlmModelRegistry {
  const providers = Object.entries(input.providers ?? {});
  if (providers.length === 0)
    throw new Error("llm.providers must contain at least one provider");
  for (const [providerId, provider] of providers) {
    requireId(providerId, "llm provider id");
    validateProvider(provider, `llm.providers.${providerId}`);
  }
  const resolve = (
    role: LlmRole,
    ref: string | null,
  ): ResolvedLlmTarget | null =>
    ref === null
      ? null
      : resolveLlmModelTarget(
          { providers: input.providers },
          ref,
          `llm.roles.${role}`,
        );
  if (!input.roles?.main) throw new Error("llm.roles.main is required");
  if (!input.roles?.classifier)
    throw new Error("llm.roles.classifier is required");
  if (opts.requireMotor && !input.roles.motor)
    throw new Error(
      "llm.roles.motor is required while the motor module is active",
    );
  return {
    providers: input.providers,
    roles: input.roles,
    targets: {
      main: resolve("main", input.roles.main)!,
      classifier: resolve("classifier", input.roles.classifier)!,
      motor: resolve("motor", input.roles.motor),
    },
  };
}
