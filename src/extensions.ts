import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsImport } from 'tsx/esm/api';
import { resolveDataLayout } from './store/data-layout.js';
import type { Database } from './store/db.js';
import { runComponentMigrations, type Migration } from './store/migrations.js';

const EXTENSION_FILE = /^(.+)\.ext\.(?:ts|mts|js|mjs)$/i;
const PACKAGE_MANIFEST = 'package.json';
const MAX_PACKAGE_MANIFEST_BYTES = 64 * 1024;
const MAX_PACKAGE_FIELD_CHARS = 1_024;
const MAX_NAMESPACE_CHARS = 128;
const MAX_DIAGNOSTIC_CHARS = 1_024;
const MAX_DESCRIPTION_CHARS = 4_096;
const MAX_PROMPT_CHARS = 65_536;
const MAX_TOTAL_PROMPT_CHARS = 262_144;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const RESERVED_NAMESPACES = new Set(['$failures', '$help']);
const PACKAGE_NAMESPACE = /^[A-Za-z_][A-Za-z0-9]*$/;

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

interface ExtensionClaim {
  readonly file: string;
  readonly namespace: string;
}

interface ExtensionCandidate extends ExtensionClaim {
  readonly filePath: string;
}

function publicName(value: string): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '\ufffd');
  return clean.length <= 240 ? clean : `${clean.slice(0, 239)}…`;
}

function message(error: unknown, privateRoot?: string): string {
  let text: string;
  try {
    const detail = error instanceof Error ? error.message : error;
    text = typeof detail === 'string' ? detail : String(detail);
  } catch {
    text = 'unavailable error detail';
  }
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '�');
  if (privateRoot) {
    for (const root of new Set([
      privateRoot,
      privateRoot.replaceAll('\\', '/'),
    ])) {
      if (root) text = text.split(root).join('<extensions>');
    }
  }
  if (text.length > MAX_DIAGNOSTIC_CHARS)
    text = `${text.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`;
  return text;
}

function packageNamespace(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('package elpis.namespace must be a non-empty string');
  if (value.length > MAX_NAMESPACE_CHARS)
    throw new Error(
      `package elpis.namespace exceeds ${MAX_NAMESPACE_CHARS} characters`,
    );
  if (!PACKAGE_NAMESPACE.test(value))
    throw new Error(
      'package elpis.namespace must be an exact Elpis identifier',
    );
  if (FORBIDDEN_KEYS.has(value) || RESERVED_NAMESPACES.has(value))
    throw new Error(
      `package elpis.namespace is reserved: ${publicName(value)}`,
    );
  return value;
}

function packageEntry(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('package elpis.extension must be a non-empty string');
  if (value.length > MAX_PACKAGE_FIELD_CHARS)
    throw new Error(
      `package elpis.extension exceeds ${MAX_PACKAGE_FIELD_CHARS} characters`,
    );
  if (/[\u0000-\u001f\u007f]/.test(value))
    throw new Error('package elpis.extension contains control characters');
  if (path.isAbsolute(value) || path.win32.isAbsolute(value))
    throw new Error('package elpis.extension must be relative');
  if (value.includes('\\'))
    throw new Error('package elpis.extension must use forward slashes');
  if (value.split('/').includes('..'))
    throw new Error(
      'package elpis.extension must not contain dot-dot segments',
    );
  return value;
}

function readPackageManifest(
  manifestPath: string,
  initialStat: fs.Stats,
): Record<string, unknown> {
  if (initialStat.isSymbolicLink())
    throw new Error('package.json must not be a symlink');
  if (!initialStat.isFile())
    throw new Error('package.json must be a regular file');
  const noFollow =
    (
      fs.constants as typeof fs.constants & {
        readonly O_NOFOLLOW?: number;
      }
    ).O_NOFOLLOW ?? 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new Error('package.json must not be a symlink');
    throw error;
  }
  let bytes: Buffer;
  try {
    const openedStat = fs.fstatSync(descriptor);
    if (!openedStat.isFile())
      throw new Error('package.json must be a regular file');
    if (
      openedStat.dev !== initialStat.dev ||
      openedStat.ino !== initialStat.ino
    )
      throw new Error('package.json changed during discovery');
    if (openedStat.size > MAX_PACKAGE_MANIFEST_BYTES)
      throw new Error(
        `package.json exceeds ${MAX_PACKAGE_MANIFEST_BYTES} bytes`,
      );
    const buffer = Buffer.allocUnsafe(MAX_PACKAGE_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < buffer.byteLength) {
      const read = fs.readSync(
        descriptor,
        buffer,
        length,
        buffer.byteLength - length,
        null,
      );
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_PACKAGE_MANIFEST_BYTES)
      throw new Error(
        `package.json exceeds ${MAX_PACKAGE_MANIFEST_BYTES} bytes`,
      );
    bytes = buffer.subarray(0, length);
  } finally {
    fs.closeSync(descriptor);
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('package.json must be valid UTF-8');
  }
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  let manifest: unknown;
  try {
    manifest = JSON.parse(source);
  } catch {
    throw new Error('package.json contains malformed JSON');
  }
  if (!plainObject(manifest))
    throw new Error('package.json must contain an object');
  return manifest;
}

function resolvePackageEntry(
  rootRealPath: string,
  packagePath: string,
  declaredEntry: string,
): string {
  const packageStat = fs.lstatSync(packagePath);
  if (packageStat.isSymbolicLink())
    throw new Error('package directory must not be a symlink');
  if (!packageStat.isDirectory())
    throw new Error('package path must be a directory');
  const packageRealPath = fs.realpathSync(packagePath);
  if (path.dirname(packageRealPath) !== rootRealPath)
    throw new Error('package directory resolves outside the extensions root');

  const pieces = declaredEntry.split('/').filter((piece) => piece !== '.');
  let cursor = packageRealPath;
  for (const piece of pieces) {
    cursor = path.join(cursor, piece);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink())
      throw new Error('package elpis.extension must not traverse a symlink');
  }
  const entryRealPath = fs.realpathSync(cursor);
  if (
    entryRealPath === packageRealPath ||
    !entryRealPath.startsWith(`${packageRealPath}${path.sep}`)
  )
    throw new Error('package elpis.extension resolves outside its package');
  if (!fs.statSync(entryRealPath).isFile())
    throw new Error('package elpis.extension must resolve to a regular file');
  return entryRealPath;
}

export async function loadExtensions(
  options: LoadExtensionsOptions,
): Promise<ExtensionRegistry> {
  const directory = resolveDataLayout(options.dataDirectory).extensions;
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
      error: message(error, directory),
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

  let entries: fs.Dirent[];
  let directoryRealPath: string;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    directoryRealPath = fs.realpathSync(directory);
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
  const candidates: ExtensionCandidate[] = [];
  const claims: ExtensionClaim[] = [];
  for (const entry of entries.sort((a, b) => compareText(a.name, b.name))) {
    if (entry.isFile() && EXTENSION_FILE.test(entry.name)) {
      try {
        const candidate = {
          file: entry.name,
          filePath: path.join(directory, entry.name),
          namespace: normalizeExtensionNamespace(entry.name),
        };
        candidates.push(candidate);
        claims.push(candidate);
      } catch (error) {
        fail(entry.name, null, 'namespace', error);
      }
      continue;
    }
    if (entry.isSymbolicLink()) {
      // Preserve flat-file behavior, but never inspect a possible package through
      // a top-level symlink merely to decide whether it should be rejected.
      if (!EXTENSION_FILE.test(entry.name))
        fail(
          publicName(entry.name),
          null,
          'discovery',
          'package directory must not be a symlink',
        );
      continue;
    }
    if (!entry.isDirectory()) continue;

    const packageName = publicName(entry.name);
    const manifestFile = `${packageName}/${PACKAGE_MANIFEST}`;
    const packagePath = path.join(directory, entry.name);
    const manifestPath = path.join(packagePath, PACKAGE_MANIFEST);
    let manifestStat: fs.Stats;
    try {
      manifestStat = fs.lstatSync(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      fail(manifestFile, null, 'discovery', error);
      continue;
    }
    let declaration: Record<string, unknown>;
    try {
      const manifest = readPackageManifest(manifestPath, manifestStat);
      if (!Object.hasOwn(manifest, 'elpis')) continue;
      if (!plainObject(manifest.elpis))
        throw new Error('package elpis field must be a plain object');
      declaration = manifest.elpis;
      if (!Object.hasOwn(declaration, 'namespace'))
        throw new Error('package elpis.namespace is required');
    } catch (error) {
      fail(manifestFile, null, 'discovery', error);
      continue;
    }

    let namespace: string;
    try {
      namespace = packageNamespace(declaration.namespace);
    } catch (error) {
      fail(manifestFile, null, 'namespace', error);
      continue;
    }

    if (!Object.hasOwn(declaration, 'extension')) {
      claims.push({ file: manifestFile, namespace });
      fail(
        manifestFile,
        namespace,
        'discovery',
        'package elpis.extension is required',
      );
      continue;
    }

    try {
      const declaredEntry = packageEntry(declaration.extension);
      const filePath = resolvePackageEntry(
        directoryRealPath,
        packagePath,
        declaredEntry,
      );
      const relativeEntry = path
        .relative(fs.realpathSync(packagePath), filePath)
        .split(path.sep)
        .join('/');
      const candidate = {
        file: `${packageName}/${relativeEntry}`,
        filePath,
        namespace,
      };
      candidates.push(candidate);
      claims.push(candidate);
    } catch (error) {
      claims.push({ file: manifestFile, namespace });
      fail(manifestFile, namespace, 'discovery', error);
    }
  }
  const compareClaims = (a: ExtensionClaim, b: ExtensionClaim): number =>
    compareText(a.namespace, b.namespace) || compareText(a.file, b.file);
  candidates.sort(compareClaims);
  claims.sort(compareClaims);
  const collided = new Set<string>();
  for (let start = 0; start < claims.length;) {
    let end = start + 1;
    while (
      end < claims.length &&
      claims[end].namespace === claims[start].namespace
    )
      end += 1;
    if (end - start > 1) {
      const files = claims
        .slice(start, end)
        .map((claim) => claim.file)
        .join(', ');
      for (const claim of claims.slice(start, end)) {
        fail(
          claim.file,
          claim.namespace,
          'namespace',
          `namespace ${claim.namespace} is also claimed by ${files}`,
        );
      }
      collided.add(claims[start].namespace);
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
    const filePath = candidate.filePath;
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
