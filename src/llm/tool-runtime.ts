import type { DatabaseSync } from 'node:sqlite';
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { configForLlmTarget, type Config } from '../config.js';
import {
  LLM_TOOL_TIERS,
  resolveLlmModelTarget,
  type LlmProviderType,
  type LlmToolTier,
} from './model-registry.js';
import {
  createLLM,
  type LLM,
  type LLMUsage,
  type StandaloneCompleteResult,
} from './llm.js';
import type { ApiSurface } from './provenance.js';

export const LLM_TOOL_MAX_CALLS_PER_RUN = 4;
export const LLM_TOOL_MAX_PROMPT_BYTES = 64 * 1024;
export const LLM_TOOL_MAX_SCHEMA_BYTES = 16 * 1024;
export const LLM_TOOL_MAX_COMBINED_INPUT_BYTES = 80 * 1024;
export const LLM_TOOL_MAX_RUN_INPUT_BYTES = 128 * 1024;
export const LLM_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
export const LLM_TOOL_MAX_SCHEMA_DEPTH = 12;
export const LLM_TOOL_MAX_SCHEMA_NODES = 512;
export const LLM_TOOL_MAX_TOKENS = 4096;
export const LLM_TOOL_TIMEOUT_MS = 120_000;

export interface LlmToolCatalogEntry {
  tier: LlmToolTier;
  ref: string;
  model: string;
  providerType: LlmProviderType;
  contextSize: number | null;
}

export interface LlmToolQueryResult {
  text: string;
  parsed?: unknown;
  model: LlmToolCatalogEntry;
  provenance: {
    providerType: LlmProviderType;
    apiSurface: ApiSurface | null;
  };
  usage: LLMUsage;
}

export interface LlmToolRuntime {
  list(): readonly LlmToolCatalogEntry[];
  query(input: unknown): Promise<LlmToolQueryResult>;
}

interface RuntimeOptions {
  create?: typeof createLLM;
  db?: DatabaseSync;
  timeoutMs?: number;
  maxTokens?: number;
}

interface ParsedQuery {
  prompt: string;
  selector: string;
  schema: Record<string, unknown> | null;
  schemaJson: string | null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function boundSchema(value: unknown): {
  schema: Record<string, unknown>;
  json: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('elpis.llm.query: schema must be a JSON Schema object');
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error('elpis.llm.query: schema must be JSON-serializable');
  }
  if (utf8Bytes(json) > LLM_TOOL_MAX_SCHEMA_BYTES)
    throw new Error(
      `elpis.llm.query: schema exceeds ${LLM_TOOL_MAX_SCHEMA_BYTES} UTF-8 bytes`,
    );
  const schema = JSON.parse(json) as Record<string, unknown>;
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    nodes++;
    if (nodes > LLM_TOOL_MAX_SCHEMA_NODES)
      throw new Error(
        `elpis.llm.query: schema exceeds ${LLM_TOOL_MAX_SCHEMA_NODES} nodes`,
      );
    if (depth > LLM_TOOL_MAX_SCHEMA_DEPTH)
      throw new Error(
        `elpis.llm.query: schema exceeds depth ${LLM_TOOL_MAX_SCHEMA_DEPTH}`,
      );
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef')
        throw new Error(
          `elpis.llm.query: schema keyword ${key} is not supported`,
        );
      visit(child, depth + 1);
    }
  };
  visit(schema, 0);
  return { schema, json };
}

function parseQuery(input: unknown): ParsedQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('elpis.llm.query: expected { prompt, model, schema? }');
  const record = input as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => key !== 'prompt' && key !== 'model' && key !== 'schema',
  );
  if (unknown.length > 0)
    throw new Error(
      `elpis.llm.query: unknown option(s): ${unknown.join(', ')}`,
    );
  if (typeof record.prompt !== 'string' || record.prompt.length === 0)
    throw new Error('elpis.llm.query: prompt must be a non-empty string');
  if (typeof record.model !== 'string' || record.model.length === 0)
    throw new Error(
      'elpis.llm.query: model must be an exposed tier or model ref',
    );
  if (utf8Bytes(record.prompt) > LLM_TOOL_MAX_PROMPT_BYTES)
    throw new Error(
      `elpis.llm.query: prompt exceeds ${LLM_TOOL_MAX_PROMPT_BYTES} UTF-8 bytes`,
    );
  const bounded =
    record.schema === undefined ? null : boundSchema(record.schema);
  return {
    prompt: record.prompt,
    selector: record.model,
    schema: bounded?.schema ?? null,
    schemaJson: bounded?.json ?? null,
  };
}

function schemaPrompt(prompt: string, schemaJson: string): string {
  return (
    prompt +
    '\n\nReturn exactly one JSON value and no Markdown or commentary. The JSON must satisfy this schema:\n' +
    schemaJson
  );
}

function sanitizedUsage(usage: LLMUsage): LLMUsage {
  const number = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : 0;
  const cached = usage.cached_tokens;
  return Object.freeze({
    prompt_tokens: number(usage.prompt_tokens),
    completion_tokens: number(usage.completion_tokens),
    total_tokens: number(usage.total_tokens),
    ...(typeof cached === 'number' && Number.isFinite(cached) && cached >= 0
      ? { cached_tokens: Math.floor(cached) }
      : {}),
  });
}

function validationError(
  ajv: Ajv,
  errors: ErrorObject[] | null | undefined,
): string {
  return ajv.errorsText(errors, { separator: '; ' }).slice(0, 1000);
}

function freezeJson(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  for (const child of Object.values(value)) freezeJson(child);
  return Object.freeze(value);
}

function sanitizedApiSurface(value: unknown): ApiSurface | null {
  if (value === undefined || value === null) return null;
  if (
    value === 'responses' ||
    value === 'chat-completions' ||
    value === 'codex-responses' ||
    value === 'anthropic-messages'
  )
    return value;
  throw new Error('elpis.llm.query: provider API surface provenance mismatch');
}

function sanitizedResult(
  result: StandaloneCompleteResult,
  entry: LlmToolCatalogEntry,
  parsed?: unknown,
): LlmToolQueryResult {
  if (result.model && result.model !== entry.model)
    throw new Error('elpis.llm.query: provider model provenance mismatch');
  if (result.providerType && result.providerType !== entry.providerType)
    throw new Error('elpis.llm.query: provider type provenance mismatch');
  if (result.toolCalls?.length)
    throw new Error(
      'elpis.llm.query: provider returned an unexpected tool call',
    );
  if (utf8Bytes(result.content) > LLM_TOOL_MAX_OUTPUT_BYTES)
    throw new Error(
      `elpis.llm.query: output exceeds ${LLM_TOOL_MAX_OUTPUT_BYTES} UTF-8 bytes`,
    );
  return Object.freeze({
    text: result.content,
    ...(parsed === undefined ? {} : { parsed: freezeJson(parsed) }),
    model: entry,
    provenance: Object.freeze({
      providerType: entry.providerType,
      apiSurface: sanitizedApiSurface(result.apiSurface),
    }),
    usage: sanitizedUsage(result.usage),
  });
}

export function createLlmToolRuntime(
  config: Config,
  options: RuntimeOptions = {},
): LlmToolRuntime | null {
  if (config.llm.registrySource !== 'canonical') return null;
  const create = options.create ?? createLLM;
  const timeoutMs = options.timeoutMs ?? LLM_TOOL_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? LLM_TOOL_MAX_TOKENS;
  const entries: LlmToolCatalogEntry[] = [];
  const clients = new Map<string, LLM>();
  const selectors = new Map<string, LlmToolCatalogEntry>();
  for (const tier of LLM_TOOL_TIERS) {
    for (const [providerId, provider] of Object.entries(
      config.llm.registry.providers,
    )) {
      for (const [modelId, model] of Object.entries(provider.models)) {
        if (model.toolTier !== tier) continue;
        const ref = `${providerId}/${modelId}`;
        if (selectors.has(tier))
          throw new Error(`llm tool tier ${tier} is assigned more than once`);
        const target = resolveLlmModelTarget(
          config.llm.registry,
          ref,
          'llm tool model',
        );
        const entry = Object.freeze({
          tier,
          ref,
          model: target.name,
          providerType: target.provider.providerType,
          contextSize: target.contextSize,
        });
        entries.push(entry);
        selectors.set(tier, entry);
        selectors.set(ref, entry);
        clients.set(
          ref,
          create(configForLlmTarget(config, target), undefined, options.db),
        );
      }
    }
  }
  if (entries.length === 0) return null;
  const catalog = Object.freeze(entries);
  const ajv = new Ajv({
    strict: true,
    allErrors: true,
    removeAdditional: false,
    coerceTypes: false,
    useDefaults: false,
    validateFormats: false,
  });
  return Object.freeze({
    list: () => catalog,
    query: async (input: unknown): Promise<LlmToolQueryResult> => {
      const query = parseQuery(input);
      const entry = selectors.get(query.selector);
      if (!entry)
        throw new Error(
          `elpis.llm.query: model must be an exposed tier or ref (${catalog.map((item) => `${item.tier}|${item.ref}`).join(', ')})`,
        );
      const client = clients.get(entry.ref);
      if (!client?.completeStandalone)
        throw new Error(
          `elpis.llm.query: configured model ${entry.ref} has no standalone completion path`,
        );
      const prompt = query.schemaJson
        ? schemaPrompt(query.prompt, query.schemaJson)
        : query.prompt;
      if (utf8Bytes(prompt) > LLM_TOOL_MAX_COMBINED_INPUT_BYTES)
        throw new Error(
          `elpis.llm.query: combined prompt exceeds ${LLM_TOOL_MAX_COMBINED_INPUT_BYTES} UTF-8 bytes`,
        );
      let validate: ValidateFunction | null = null;
      if (query.schema) {
        try {
          validate = ajv.compile(query.schema);
        } catch (error) {
          throw new Error(
            `elpis.llm.query: invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('LLM tool timeout')),
        timeoutMs,
      );
      let result: StandaloneCompleteResult;
      try {
        result = await client.completeStandalone(
          [{ role: 'user', content: prompt }],
          { maxTokens, signal: controller.signal },
        );
      } catch {
        if (controller.signal.aborted)
          throw new Error(`elpis.llm.query: timed out after ${timeoutMs}ms`);
        throw new Error(
          `elpis.llm.query: provider request failed for ${entry.ref}`,
        );
      } finally {
        clearTimeout(timer);
      }
      if (!validate) return sanitizedResult(result, entry);
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.content);
      } catch {
        throw new Error('elpis.llm.query: model output was not exact JSON');
      }
      if (!validate(parsed))
        throw new Error(
          `elpis.llm.query: model output failed schema validation: ${validationError(ajv, validate.errors)}`,
        );
      return sanitizedResult(result, entry, parsed);
    },
  });
}
