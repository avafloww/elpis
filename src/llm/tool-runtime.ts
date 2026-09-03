import type { DatabaseSync } from 'node:sqlite';
import { types as utilTypes } from 'node:util';
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
import { isStandaloneOutputLimitError } from './standalone-limits.js';

export const LLM_TOOL_MAX_CALLS_PER_RUN = 4;
export const LLM_TOOL_MAX_PROMPT_BYTES = 64 * 1024;
export const LLM_TOOL_MAX_SCHEMA_BYTES = 16 * 1024;
export const LLM_TOOL_MAX_COMBINED_INPUT_BYTES = 80 * 1024;
export const LLM_TOOL_MAX_RUN_INPUT_BYTES = 128 * 1024;
export const LLM_TOOL_MAX_OUTPUT_BYTES = 64 * 1024;
export const LLM_TOOL_MAX_OUTPUT_JSON_DEPTH = 64;
export const LLM_TOOL_MAX_OUTPUT_JSON_NODES = 4096;
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

export interface PreparedLlmToolQuery {
  readonly prompt: string;
  readonly selector: string;
  readonly schema: Record<string, unknown> | null;
  readonly schemaJson: string | null;
  readonly inputBytes: number;
}

export interface LlmToolRuntime {
  list(): readonly LlmToolCatalogEntry[];
  prepare(input: unknown): PreparedLlmToolQuery;
  queryPrepared(query: PreparedLlmToolQuery): Promise<LlmToolQueryResult>;
  query(input: unknown): Promise<LlmToolQueryResult>;
}

interface RuntimeOptions {
  create?: typeof createLLM;
  db?: DatabaseSync;
  timeoutMs?: number;
  maxTokens?: number;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertDataPrototype(
  value: object,
  expected: 'Array' | 'Object',
  proxyMessage: string,
  shapeMessage: string,
): void {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new Error(shapeMessage);
  }
  if (prototype === null) return;
  const expectedNames = expected === 'Array' ? ['Array', 'Object'] : ['Object'];
  let index = 0;
  while (prototype !== null) {
    if (index >= expectedNames.length) throw new Error(shapeMessage);
    if (utilTypes.isProxy(prototype)) throw new Error(proxyMessage);
    const constructor = Object.getOwnPropertyDescriptor(
      prototype,
      'constructor',
    )?.value;
    const constructorName =
      typeof constructor === 'function' && !utilTypes.isProxy(constructor)
        ? Object.getOwnPropertyDescriptor(constructor, 'name')?.value
        : undefined;
    if (constructorName !== expectedNames[index]) throw new Error(shapeMessage);
    try {
      prototype = Object.getPrototypeOf(prototype);
    } catch {
      throw new Error(shapeMessage);
    }
    index++;
  }
}

function boundedOwnEnumerableDataEntries(
  value: object,
  limit: number,
  invalidMessage: string,
  overflow: () => Error,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (entries.length >= limit) throw overflow();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new Error(invalidMessage);
    }
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value'))
      throw new Error(invalidMessage);
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function boundSchema(value: unknown): {
  schema: Record<string, unknown>;
  json: string;
} {
  let nodes = 0;
  let encodedStringBytes = 0;
  const stack = new WeakSet<object>();
  const sizeError = (): Error =>
    new Error(
      `elpis.llm.query: schema exceeds ${LLM_TOOL_MAX_SCHEMA_BYTES} UTF-8 bytes`,
    );
  const nodeError = (): Error =>
    new Error(
      `elpis.llm.query: schema exceeds ${LLM_TOOL_MAX_SCHEMA_NODES} nodes`,
    );
  const chargeString = (text: string): void => {
    if (utf8Bytes(text) > LLM_TOOL_MAX_SCHEMA_BYTES) throw sizeError();
    encodedStringBytes += utf8Bytes(JSON.stringify(text));
    if (encodedStringBytes > LLM_TOOL_MAX_SCHEMA_BYTES) throw sizeError();
  };
  const clone = (node: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > LLM_TOOL_MAX_SCHEMA_NODES) throw nodeError();
    if (depth > LLM_TOOL_MAX_SCHEMA_DEPTH)
      throw new Error(
        `elpis.llm.query: schema exceeds depth ${LLM_TOOL_MAX_SCHEMA_DEPTH}`,
      );
    if (node === null || typeof node === 'boolean') return node;
    if (typeof node === 'string') {
      chargeString(node);
      return node;
    }
    if (typeof node === 'number' && Number.isFinite(node)) return node;
    if (typeof node !== 'object')
      throw new Error(
        'elpis.llm.query: schema values must contain only JSON-compatible data',
      );
    if (utilTypes.isProxy(node))
      throw new Error('elpis.llm.query: schema proxies are not supported');
    if (stack.has(node))
      throw new Error('elpis.llm.query: schema must not contain cycles');
    const isArray = Array.isArray(node);
    assertDataPrototype(
      node,
      isArray ? 'Array' : 'Object',
      'elpis.llm.query: schema prototype proxies are not supported',
      'elpis.llm.query: schema values must be plain objects or arrays',
    );
    stack.add(node);
    try {
      const entries = boundedOwnEnumerableDataEntries(
        node,
        LLM_TOOL_MAX_SCHEMA_NODES - nodes,
        'elpis.llm.query: schema values must use own enumerable data properties',
        nodeError,
      );
      if (isArray) {
        const length = Object.getOwnPropertyDescriptor(node, 'length')?.value;
        if (
          !Number.isSafeInteger(length) ||
          length < 0 ||
          entries.length !== length ||
          entries.some(([key], index) => key !== String(index))
        )
          throw new Error(
            'elpis.llm.query: schema arrays must be dense JSON arrays',
          );
        const result: unknown[] = [];
        for (const [, item] of entries) result.push(clone(item, depth + 1));
        return Object.freeze(result);
      }
      const result = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of entries) {
        chargeString(key);
        if (
          key === '$ref' ||
          key === '$dynamicRef' ||
          key === '$recursiveRef' ||
          key === 'pattern' ||
          key === 'patternProperties'
        )
          throw new Error(
            `elpis.llm.query: schema keyword ${key} is not supported`,
          );
        if (
          key === '$schema' &&
          item !== 'http://json-schema.org/draft-07/schema#' &&
          item !== 'https://json-schema.org/draft-07/schema#'
        )
          throw new Error(
            'elpis.llm.query: only JSON Schema draft-07 is supported',
          );
        Object.defineProperty(result, key, {
          value: clone(item, depth + 1),
          enumerable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      stack.delete(node);
    }
  };
  const schema = clone(value, 0);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    throw new Error('elpis.llm.query: schema must be a JSON Schema object');
  const json = JSON.stringify(schema);
  if (utf8Bytes(json) > LLM_TOOL_MAX_SCHEMA_BYTES) throw sizeError();
  return { schema: schema as Record<string, unknown>, json };
}
function prepareQuery(input: unknown): PreparedLlmToolQuery {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('elpis.llm.query: expected { prompt, model, schema? }');
  if (utilTypes.isProxy(input))
    throw new Error('elpis.llm.query: query option proxies are not supported');
  assertDataPrototype(
    input,
    'Object',
    'elpis.llm.query: query option prototype proxies are not supported',
    'elpis.llm.query: options must be a plain object',
  );
  const entries = boundedOwnEnumerableDataEntries(
    input,
    4,
    'elpis.llm.query: options must use own enumerable data properties',
    () => new Error('elpis.llm.query: too many options'),
  );
  const values = new Map(entries);
  const unknown = entries
    .map(([key]) => key)
    .filter((key) => key !== 'prompt' && key !== 'model' && key !== 'schema');
  if (unknown.length > 0)
    throw new Error(
      `elpis.llm.query: unknown option(s): ${unknown.join(', ')}`,
    );
  const prompt = values.get('prompt');
  const selector = values.get('model');
  const schemaValue = values.get('schema');
  if (typeof prompt !== 'string' || prompt.length === 0)
    throw new Error('elpis.llm.query: prompt must be a non-empty string');
  if (typeof selector !== 'string' || selector.length === 0)
    throw new Error(
      'elpis.llm.query: model must be an exposed tier or model ref',
    );
  if (utf8Bytes(prompt) > LLM_TOOL_MAX_PROMPT_BYTES)
    throw new Error(
      `elpis.llm.query: prompt exceeds ${LLM_TOOL_MAX_PROMPT_BYTES} UTF-8 bytes`,
    );
  const bounded = values.has('schema') ? boundSchema(schemaValue) : null;
  const normalized = {
    prompt,
    model: selector,
    ...(bounded ? { schema: bounded.schema } : {}),
  };
  return Object.freeze({
    prompt,
    selector,
    schema: bounded?.schema ?? null,
    schemaJson: bounded?.json ?? null,
    inputBytes: utf8Bytes(JSON.stringify(normalized)),
  });
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

function boundAndFreezeJson(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const work: Array<{
    value: object;
    depth: number;
    freeze: boolean;
  }> = [{ value, depth: 0, freeze: false }];
  let nodes = 1;
  while (work.length > 0) {
    const current = work.pop();
    if (!current) break;
    if (current.freeze) {
      Object.freeze(current.value);
      continue;
    }
    const values = Object.values(current.value);
    if (values.length === 0) {
      Object.freeze(current.value);
      continue;
    }
    const childDepth = current.depth + 1;
    if (childDepth > LLM_TOOL_MAX_OUTPUT_JSON_DEPTH)
      throw new Error(
        `elpis.llm.query: model output JSON exceeds depth ${LLM_TOOL_MAX_OUTPUT_JSON_DEPTH}`,
      );
    if (nodes + values.length > LLM_TOOL_MAX_OUTPUT_JSON_NODES)
      throw new Error(
        `elpis.llm.query: model output JSON exceeds ${LLM_TOOL_MAX_OUTPUT_JSON_NODES} nodes`,
      );
    nodes += values.length;
    const children = values.filter(
      (child): child is object => typeof child === 'object' && child !== null,
    );
    if (children.length === 0) {
      Object.freeze(current.value);
      continue;
    }
    work.push({ ...current, freeze: true });
    for (let index = children.length - 1; index >= 0; index--)
      work.push({ value: children[index], depth: childDepth, freeze: false });
  }
  return value;
}
function expectedApiSurfaces(
  providerType: LlmProviderType,
  api: 'auto' | 'responses' | 'chat',
): ReadonlySet<ApiSurface> {
  if (providerType === 'anthropic-oauth')
    return new Set<ApiSurface>(['anthropic-messages']);
  if (providerType === 'codex-oauth')
    return new Set<ApiSurface>(['codex-responses']);
  if (api === 'responses') return new Set<ApiSurface>(['responses']);
  if (api === 'chat') return new Set<ApiSurface>(['chat-completions']);
  return new Set<ApiSurface>(['responses', 'chat-completions']);
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

function assertBoundedResult(
  result: StandaloneCompleteResult,
  entry: LlmToolCatalogEntry,
  expectedSurfaces: ReadonlySet<ApiSurface>,
): void {
  if (typeof result.content !== 'string')
    throw new Error('elpis.llm.query: provider returned invalid text');
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
  const apiSurface = sanitizedApiSurface(result.apiSurface);
  if (apiSurface && !expectedSurfaces.has(apiSurface))
    throw new Error(
      'elpis.llm.query: provider API surface provenance mismatch',
    );
}

function sanitizedResult(
  result: StandaloneCompleteResult,
  entry: LlmToolCatalogEntry,
  expectedSurfaces: ReadonlySet<ApiSurface>,
  parsed?: unknown,
): LlmToolQueryResult {
  assertBoundedResult(result, entry, expectedSurfaces);
  return Object.freeze({
    text: result.content,
    ...(parsed === undefined ? {} : { parsed }),
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
  const expectedSurfacesByRef = new Map<string, ReadonlySet<ApiSurface>>();
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
        expectedSurfacesByRef.set(
          ref,
          expectedApiSurfaces(
            target.provider.providerType,
            target.provider.api,
          ),
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
  const mintedQueries = new WeakSet<PreparedLlmToolQuery>();
  const prepare = (input: unknown): PreparedLlmToolQuery => {
    const query = prepareQuery(input);
    mintedQueries.add(query);
    return query;
  };
  const queryPrepared = async (
    query: PreparedLlmToolQuery,
  ): Promise<LlmToolQueryResult> => {
    if (!mintedQueries.has(query))
      throw new Error(
        'elpis.llm.query: prepared query was not created by this runtime',
      );
    const entry = selectors.get(query.selector);
    if (!entry)
      throw new Error(
        `elpis.llm.query: model must be an exposed tier or ref (${catalog.map((item) => `${item.tier}|${item.ref}`).join(', ')})`,
      );
    const client = clients.get(entry.ref);
    const expectedSurfaces = expectedSurfacesByRef.get(entry.ref);
    if (!client?.completeStandalone || !expectedSurfaces)
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
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error('LLM tool timeout'));
        reject(new Error(`elpis.llm.query: timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const completion = Promise.resolve().then(() =>
      client.completeStandalone!([{ role: 'user', content: prompt }], {
        maxTokens,
        maxOutputBytes: LLM_TOOL_MAX_OUTPUT_BYTES,
        signal: controller.signal,
      }),
    );
    void completion.catch(() => {});
    let result: StandaloneCompleteResult;
    try {
      result = await Promise.race([completion, timeout]);
    } catch (error) {
      if (timedOut)
        throw new Error(`elpis.llm.query: timed out after ${timeoutMs}ms`);
      if (isStandaloneOutputLimitError(error))
        throw new Error(
          `elpis.llm.query: output exceeds ${LLM_TOOL_MAX_OUTPUT_BYTES} UTF-8 bytes`,
        );
      throw new Error(
        `elpis.llm.query: provider request failed for ${entry.ref}`,
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    assertBoundedResult(result, entry, expectedSurfaces);
    if (!validate) return sanitizedResult(result, entry, expectedSurfaces);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.content);
    } catch {
      throw new Error('elpis.llm.query: model output was not exact JSON');
    }
    parsed = boundAndFreezeJson(parsed);
    if (!validate(parsed))
      throw new Error(
        `elpis.llm.query: model output failed schema validation: ${validationError(ajv, validate.errors)}`,
      );
    return sanitizedResult(result, entry, expectedSurfaces, parsed);
  };
  return Object.freeze({
    list: () => catalog,
    prepare,
    queryPrepared,
    query: async (input: unknown) => queryPrepared(prepare(input)),
  });
}
