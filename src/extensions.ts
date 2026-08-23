import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { resolveDataLayout } from './store/data-layout.js';
import type { Database } from './store/db.js';
import { runComponentMigrations, type Migration } from './store/migrations.js';

const EXTENSION_FILE = /^(.+)\.ext\.(?:ts|mts|js|mjs)$/i;
const MAX_DESCRIPTION_CHARS = 4_096;
const MAX_PROMPT_CHARS = 65_536;
const MAX_TOTAL_PROMPT_CHARS = 262_144;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export interface ExtensionContext {
  readonly namespace: string;
  readonly sourceFile: string;
  readonly dataDirectory: string;
  readonly harnessRoot: string;
  readonly agentName: () => string;
  readonly database: Database;
  readonly log: (level: 'info' | 'warn' | 'error', ...args: unknown[]) => void;
  readonly runLog: (...args: unknown[]) => void;
}

export interface ExtensionDefinition {
  readonly description?: string;
  readonly prompt?: string;
  readonly migrations?: readonly Migration[];
  readonly activate?: (context: ExtensionContext) => unknown | Promise<unknown>;
}

export interface ExtensionSummary {
  readonly namespace: string;
  readonly file: string;
  readonly description: string;
  readonly members: readonly string[];
}

export type ExtensionFailureStage =
  | 'discovery'
  | 'namespace'
  | 'import'
  | 'definition'
  | 'prompt'
  | 'migration'
  | 'activation'
  | 'api';

export interface ExtensionFailure {
  readonly file: string;
  readonly namespace: string | null;
  readonly stage: ExtensionFailureStage;
  readonly error: string;
}

export interface ExtensionRegistry {
  readonly apis: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly summaries: readonly ExtensionSummary[];
  readonly failures: readonly ExtensionFailure[];
  readonly prompt: string;
}

export interface LoadExtensionsOptions {
  dataDirectory: string;
  harnessRoot: string;
  agentName: () => string;
  database: Database;
  log?: (level: 'info' | 'warn' | 'error', ...args: unknown[]) => void;
  runLog?: (...args: unknown[]) => void;
  importModule?: (filePath: string) => Promise<Record<string, unknown>>;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeExtensionNamespace(fileName: string): string {
  const match = EXTENSION_FILE.exec(fileName);
  if (!match)
    throw new Error(`extension file must match <name>.ext.ts: ${fileName}`);
  const words = match[1]
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  if (words.length === 0)
    throw new Error(`extension filename has no usable namespace: ${fileName}`);
  let namespace =
    words[0] +
    words
      .slice(1)
      .map((word) => word[0].toUpperCase() + word.slice(1))
      .join('');
  if (/^[0-9]/.test(namespace)) namespace = `_${namespace}`;
  return namespace;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function freezeValue(
  value: unknown,
  location: string,
  seen: WeakSet<object>,
): unknown {
  if (
    value == null ||
    ['string', 'boolean', 'bigint', 'undefined'].includes(typeof value)
  )
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error(`${location} contains a non-finite number`);
    return value;
  }
  if (typeof value === 'function') return Object.freeze(value);
  if (typeof value !== 'object')
    throw new Error(`${location} contains unsupported ${typeof value}`);
  if (seen.has(value))
    throw new Error(`${location} contains a circular reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((entry, index) =>
      freezeValue(entry, `${location}[${index}]`, seen),
    );
    seen.delete(value);
    return Object.freeze(copy);
  }
  if (!plainObject(value))
    throw new Error(
      `${location} must contain only plain objects, arrays, primitives, and functions`,
    );
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort(compareText)) {
    if (FORBIDDEN_KEYS.has(key))
      throw new Error(`${location} contains forbidden key ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor))
      throw new Error(`${location}.${key} must be a data property`);
    copy[key] = freezeValue(descriptor.value, `${location}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(copy);
}

function readString(value: unknown, field: string, max: number): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (normalized.length > max)
    throw new Error(`${field} exceeds ${max} characters`);
  return normalized;
}

function readDefinition(
  module: Record<string, unknown>,
  fileName: string,
): ExtensionDefinition {
  const candidate = module.extension;
  if (!plainObject(candidate))
    throw new Error(`${fileName} must export a plain object named extension`);
  if (candidate.activate != null && typeof candidate.activate !== 'function') {
    throw new Error(`${fileName} extension.activate must be a function`);
  }
  if (candidate.migrations != null && !Array.isArray(candidate.migrations)) {
    throw new Error(`${fileName} extension.migrations must be an array`);
  }
  return candidate as ExtensionDefinition;
}

function composePrompt(
  loaded: { summary: ExtensionSummary; prompt: string }[],
): string {
  if (loaded.length === 0) return '';
  const blocks = loaded.map(({ summary, prompt }) => {
    const lines = [`#### \`elpis.ext.${summary.namespace}\``];
    if (summary.description) lines.push(summary.description);
    lines.push(
      `Exported members: ${summary.members.length ? summary.members.map((name) => `\`${name}\``).join(', ') : '(none)'}.`,
    );
    if (prompt) lines.push('', prompt);
    return lines.join('\n');
  });
  const result = blocks.join('\n\n');
  if (result.length > MAX_TOTAL_PROMPT_CHARS)
    throw new Error(
      `combined extension prompt exceeds ${MAX_TOTAL_PROMPT_CHARS} characters`,
    );
  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function loadExtensions(
  options: LoadExtensionsOptions,
): Promise<ExtensionRegistry> {
  const log = (level: 'info' | 'warn' | 'error', ...args: unknown[]): void => {
    try {
      options.log?.(level, ...args);
    } catch {
      /* diagnostics must not become a boot dependency */
    }
  };
  const failures: ExtensionFailure[] = [];
  const fail = (
    file: string,
    namespace: string | null,
    stage: ExtensionFailureStage,
    error: unknown,
  ): void => {
    const failure = Object.freeze({
      file,
      namespace,
      stage,
      error: message(error),
    });
    failures.push(failure);
    log('error', `extension skipped: ${file} [${stage}] ${failure.error}`);
  };
  const finish = (
    apis: Record<string, Readonly<Record<string, unknown>>>,
    summaries: ExtensionSummary[],
    promptParts: { summary: ExtensionSummary; prompt: string }[],
  ): ExtensionRegistry =>
    Object.freeze({
      apis: Object.freeze(apis),
      summaries: Object.freeze(summaries),
      failures: Object.freeze(failures),
      prompt: composePrompt(promptParts),
    });

  const directory = resolveDataLayout(options.dataDirectory).extensions;
  let entries: fs.Dirent[];
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    fail('<extensions-directory>', null, 'discovery', error);
    return finish(Object.create(null), [], []);
  }

  const importModule =
    options.importModule ??
    (async (filePath: string) =>
      tsImport(pathToFileURL(filePath).href, {
        parentURL: import.meta.url,
        tsconfig: false,
      }) as Promise<Record<string, unknown>>);
  const candidates: { file: string; namespace: string }[] = [];
  for (const entry of entries
    .filter((item) => item.isFile() && EXTENSION_FILE.test(item.name))
    .sort((a, b) => compareText(a.name, b.name))) {
    try {
      candidates.push({
        file: entry.name,
        namespace: normalizeExtensionNamespace(entry.name),
      });
    } catch (error) {
      fail(entry.name, null, 'namespace', error);
    }
  }
  candidates.sort(
    (a, b) =>
      compareText(a.namespace, b.namespace) || compareText(a.file, b.file),
  );
  const collided = new Set<string>();
  for (let start = 0; start < candidates.length;) {
    let end = start + 1;
    while (
      end < candidates.length &&
      candidates[end].namespace === candidates[start].namespace
    )
      end += 1;
    if (end - start > 1) {
      const files = candidates
        .slice(start, end)
        .map((candidate) => candidate.file)
        .join(', ');
      for (const candidate of candidates.slice(start, end)) {
        fail(
          candidate.file,
          candidate.namespace,
          'namespace',
          `namespace ${candidate.namespace} is also claimed by ${files}`,
        );
      }
      collided.add(candidates[start].namespace);
    }
    start = end;
  }

  const apis = Object.create(null) as Record<
    string,
    Readonly<Record<string, unknown>>
  >;
  const summaries: ExtensionSummary[] = [];
  const promptParts: { summary: ExtensionSummary; prompt: string }[] = [];
  for (const candidate of candidates) {
    if (collided.has(candidate.namespace)) continue;
    const filePath = path.join(directory, candidate.file);
    let stage: ExtensionFailureStage = 'import';
    try {
      const module = await importModule(filePath);
      stage = 'definition';
      const definition = readDefinition(module, candidate.file);
      stage = 'prompt';
      const description = readString(
        definition.description,
        `${candidate.file} description`,
        MAX_DESCRIPTION_CHARS,
      );
      const prompt = readString(
        definition.prompt,
        `${candidate.file} prompt`,
        MAX_PROMPT_CHARS,
      );
      stage = 'migration';
      const migrationResult = runComponentMigrations(
        options.database,
        `extension:${candidate.namespace}`,
        definition.migrations ?? [],
      );
      for (const name of migrationResult.applied)
        log(
          'info',
          `extension migration applied: ${candidate.namespace}/${name}`,
        );
      const context: ExtensionContext = Object.freeze({
        namespace: candidate.namespace,
        sourceFile: candidate.file,
        dataDirectory: options.dataDirectory,
        harnessRoot: options.harnessRoot,
        agentName: options.agentName,
        database: options.database,
        log,
        runLog: (...args: unknown[]) => options.runLog?.(...args),
      });
      stage = 'activation';
      let rawApi: unknown = definition.activate
        ? await definition.activate(context)
        : {};
      if (rawApi == null) rawApi = {};
      stage = 'api';
      if (!plainObject(rawApi))
        throw new Error(
          `${candidate.file} extension.activate must return a plain object`,
        );
      const api = freezeValue(
        rawApi,
        `elpis.ext.${candidate.namespace}`,
        new WeakSet(),
      ) as Readonly<Record<string, unknown>>;
      const summary = Object.freeze({
        namespace: candidate.namespace,
        file: candidate.file,
        description,
        members: Object.freeze(Object.keys(api).sort(compareText)),
      });
      stage = 'prompt';
      composePrompt([...promptParts, { summary, prompt }]);
      apis[candidate.namespace] = api;
      summaries.push(summary);
      promptParts.push({ summary, prompt });
      log(
        'info',
        `extension loaded: ${candidate.file} -> elpis.ext.${candidate.namespace}`,
      );
    } catch (error) {
      fail(candidate.file, candidate.namespace, stage, error);
    }
  }
  return finish(apis, summaries, promptParts);
}
