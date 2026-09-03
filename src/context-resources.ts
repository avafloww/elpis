import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './lib/frontmatter.js';
import { resolveDataLayout } from './store/data-layout.js';

export const MAX_SKILLS_PER_CALL = 8;
export const MAX_SKILL_CATALOG = 128;
export const MAX_SKILL_DESCRIPTION_CHARS = 512;
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 192 * 1024;
export const MAX_AGENTS_BYTES = 64 * 1024;
export const MAX_TREE_DIRECTORIES = 4096;
export const MAX_TREE_AGENTS = 128;

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

export interface ContextResourceSnapshot {
  skills: string[];
  agentsFiles: string[];
}

export interface ContextResourceDescriptor {
  kind: 'skill' | 'agents';
  key: string;
  display: string;
  version: string;
}

export interface LoadedSkillContext {
  content: string;
  resources: ContextResourceDescriptor[];
}

const authenticInterrupts = new WeakSet<object>();

export class ContextResourceInterrupt extends Error {
  readonly contextResourceInterrupt = true;
  readonly resourceType = 'agents-md';
  readonly resource: ContextResourceDescriptor;

  constructor(resource: ContextResourceDescriptor, message: string) {
    super(message);
    this.name = 'ContextResourceInterrupt';
    this.resource = Object.freeze({ ...resource });
    authenticInterrupts.add(this);
    Object.freeze(this);
  }
}

export function isContextResourceInterrupt(
  value: unknown,
): value is ContextResourceInterrupt {
  if (!value || typeof value !== 'object' || !authenticInterrupts.has(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.contextResourceInterrupt !== true) return false;
  if (!candidate.resource || typeof candidate.resource !== 'object')
    return false;
  const resource = candidate.resource as Record<string, unknown>;
  return (
    resource.kind === 'agents' &&
    typeof resource.key === 'string' &&
    resource.key.length > 0 &&
    typeof resource.display === 'string' &&
    resource.display.length > 0 &&
    typeof resource.version === 'string' &&
    /^[a-f0-9]{64}$/.test(resource.version) &&
    typeof candidate.message === 'string'
  );
}

interface SkillRecord extends SkillSummary {
  realPath: string;
}

export interface ContextResourcesOptions {
  dataDirectory: string;
  bundledSkillsDirectory?: string | null;
  logger?: { warn(...args: unknown[]): void };
}

const contextResourcesModule = fileURLToPath(import.meta.url);
export const DEFAULT_BUNDLED_SKILLS_DIRECTORY = path.resolve(
  path.dirname(contextResourcesModule),
  contextResourcesModule.endsWith('.ts') ? '../skills' : 'skills',
);

function ancestors(start: string): string[] {
  const out: string[] = [];
  let current = path.resolve(start);
  for (;;) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

function readBounded(
  file: string,
  maxBytes: number,
  label: string,
  truncate: boolean,
): string {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile())
      throw new Error(`${label} is not a regular file: ${file}`);
    if (!truncate && stat.size > maxBytes) {
      throw new Error(
        `${label} exceeds the ${maxBytes}-byte context limit: ${file} (${stat.size} bytes)`,
      );
    }
    const capacity = truncate ? maxBytes : maxBytes + 1;
    const buffer = Buffer.alloc(capacity);
    let total = 0;
    while (total < capacity) {
      const read = fs.readSync(fd, buffer, total, capacity - total, null);
      if (read === 0) break;
      total += read;
    }
    if (!truncate && total > maxBytes) {
      throw new Error(
        `${label} exceeds the ${maxBytes}-byte context limit while reading: ${file}`,
      );
    }
    return buffer.subarray(0, total).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function boundedPrefix(file: string, maxBytes: number): string {
  return readBounded(file, maxBytes, 'skill catalog candidate', true);
}

function boundedFile(file: string, maxBytes: number, label: string): string {
  return readBounded(file, maxBytes, label, false);
}

function versionOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function skillRoots(options: ContextResourcesOptions): string[] {
  const roots = [
    resolveDataLayout(options.dataDirectory).skills,
    options.bundledSkillsDirectory === undefined
      ? DEFAULT_BUNDLED_SKILLS_DIRECTORY
      : options.bundledSkillsDirectory,
  ].filter((root): root is string => typeof root === 'string');
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function discoverSkills(
  options: ContextResourcesOptions,
): Map<string, SkillRecord> {
  const found = new Map<string, SkillRecord>();
  for (const root of skillRoots(options)) {
    let names: string[];
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const directoryName of names) {
      const candidate = path.join(root, directoryName, 'SKILL.md');
      let realPath: string;
      let raw: string;
      try {
        realPath = fs.realpathSync.native(candidate);
        raw = boundedPrefix(realPath, 8 * 1024);
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(raw);
      const name = parsed?.frontmatter.name;
      const description = parsed?.frontmatter.description;
      if (
        typeof name !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) ||
        typeof description !== 'string' ||
        description.trim() === ''
      ) {
        options.logger?.warn(
          'skill ignored: invalid name/description',
          candidate,
        );
        continue;
      }
      const duplicate = found.get(name);
      if (duplicate) {
        throw new Error(
          `duplicate skill name ${JSON.stringify(name)}: ${duplicate.path} and ${candidate}`,
        );
      }
      if (found.size >= MAX_SKILL_CATALOG) {
        throw new Error(
          `skill catalog exceeds the ${MAX_SKILL_CATALOG}-skill limit`,
        );
      }
      found.set(name, {
        name,
        description: description.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS),
        path: candidate,
        realPath,
      });
    }
  }
  return found;
}

export class ContextResources {
  private readonly skills: Map<string, SkillRecord>;
  private readonly loadedSkills = new Map<string, ContextResourceDescriptor>();
  private readonly loadedAgents = new Map<string, ContextResourceDescriptor>();
  private readonly pendingSkills = new Map<string, ContextResourceDescriptor>();
  private readonly pendingAgents = new Map<
    string,
    { resource: ContextResourceDescriptor; message: string }
  >();

  constructor(private readonly options: ContextResourcesOptions) {
    this.skills = discoverSkills(options);
  }

  catalog(): SkillSummary[] {
    return [...this.skills.values()].map(
      ({ name, description, path: skillPath }) => ({
        name,
        description,
        path: skillPath,
      }),
    );
  }

  loadSkills(names: unknown): string {
    const loaded = this.loadSkillContext(names);
    this.acknowledge(loaded.resources);
    return loaded.content;
  }

  loadSkillContext(names: unknown): LoadedSkillContext {
    if (!Array.isArray(names) || names.length === 0) {
      throw new Error('skill(names): names must be a non-empty array');
    }
    if (names.length > MAX_SKILLS_PER_CALL) {
      throw new Error(
        `skill(names): at most ${MAX_SKILLS_PER_CALL} skills may be loaded at once`,
      );
    }
    const normalized = names.map((name) => {
      if (
        typeof name !== 'string' ||
        !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name)
      ) {
        throw new Error(
          `skill(names): invalid skill name ${JSON.stringify(name)}`,
        );
      }
      return name;
    });
    if (new Set(normalized).size !== normalized.length) {
      throw new Error('skill(names): duplicate names are not allowed');
    }
    const records = normalized.map((name) => {
      const record = this.skills.get(name);
      if (!record) {
        const available = [...this.skills.keys()].sort().join(', ') || '(none)';
        throw new Error(
          `unknown skill ${JSON.stringify(name)}; available: ${available}`,
        );
      }
      return record;
    });
    const bodies = records.map((record) => {
      const raw = boundedFile(record.realPath, MAX_SKILL_BYTES, 'SKILL.md');
      const resource: ContextResourceDescriptor = {
        kind: 'skill',
        key: record.name,
        display: record.name,
        version: versionOf(raw),
      };
      return { record, raw, resource };
    });
    const total = bodies.reduce(
      (sum, body) => sum + Buffer.byteLength(body.raw, 'utf8'),
      0,
    );
    if (total > MAX_SKILL_TOTAL_BYTES) {
      throw new Error(
        `skill(names): selected SKILL.md files total ${total} bytes; limit is ${MAX_SKILL_TOTAL_BYTES}`,
      );
    }
    const fresh = bodies.filter(
      ({ resource }) =>
        this.loadedSkills.get(resource.key)?.version !== resource.version,
    );
    if (fresh.length === 0) {
      return {
        content: `[skills already present in the current context: ${normalized.join(', ')}]`,
        resources: bodies.map(({ resource }) => resource),
      };
    }
    for (const { resource } of fresh) {
      this.pendingSkills.set(resource.key, resource);
    }
    return {
      content: [
        '[skill context loaded — read these instructions before calling run]',
        ...fresh.map(
          ({ record, raw }) =>
            `<skill name=${JSON.stringify(record.name)} path=${JSON.stringify(record.path)}>\n${raw}\n</skill>`,
        ),
      ].join('\n\n'),
      resources: bodies.map(({ resource }) => resource),
    };
  }

  beforeTreeAccess(target: string): void {
    this.beforeFileAccess(target, 'auto');
    let root: string;
    try {
      root = fs.realpathSync.native(path.resolve(target));
      if (!fs.statSync(root).isDirectory()) return;
    } catch {
      return;
    }
    const pending = [root];
    let directories = 0;
    let agentsFiles = 0;
    while (pending.length > 0) {
      const directory = pending.pop()!;
      directories++;
      if (directories > MAX_TREE_DIRECTORIES) {
        throw new Error(
          `AGENTS.md tree preflight exceeds ${MAX_TREE_DIRECTORIES} directories: ${target}`,
        );
      }
      let entries: fs.Dirent[];
      try {
        entries = fs
          .readdirSync(directory, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (
          entry.name === 'AGENTS.md' &&
          (entry.isFile() || entry.isSymbolicLink())
        ) {
          agentsFiles++;
          if (agentsFiles > MAX_TREE_AGENTS) {
            throw new Error(
              `AGENTS.md tree preflight exceeds ${MAX_TREE_AGENTS} instruction files: ${target}`,
            );
          }
          this.beforeFileAccess(candidate, 'file');
        } else if (entry.isDirectory()) {
          pending.push(candidate);
        }
      }
    }
  }

  beforeFileAccess(
    target: string,
    kind: 'file' | 'directory' | 'auto' = 'auto',
  ): void {
    if (typeof target !== 'string' || target.trim() === '') return;
    for (const agents of this.nearestAgents(target, kind)) {
      const raw = boundedFile(agents.realPath, MAX_AGENTS_BYTES, 'AGENTS.md');
      const resource: ContextResourceDescriptor = {
        kind: 'agents',
        key: agents.realPath,
        display: agents.path,
        version: versionOf(raw),
      };
      if (this.loadedAgents.get(resource.key)?.version === resource.version)
        continue;
      const pending = this.pendingAgents.get(resource.key);
      const message =
        pending?.resource.version === resource.version
          ? pending.message
          : [
              '[AGENTS.md loaded before file access — retry the run]',
              `target: ${path.resolve(target)}`,
              `instructions: ${agents.path}`,
              '',
              `<AGENTS.md path=${JSON.stringify(agents.path)}>`,
              raw,
              '</AGENTS.md>',
            ].join('\n');
      this.pendingAgents.set(resource.key, { resource, message });
      throw new ContextResourceInterrupt(resource, message);
    }
  }

  acknowledge(resources: ContextResourceDescriptor[]): void {
    for (const resource of resources) {
      if (resource.kind === 'skill') {
        const pending = this.pendingSkills.get(resource.key);
        if (!pending || pending.version !== resource.version) continue;
        this.loadedSkills.set(resource.key, pending);
        this.pendingSkills.delete(resource.key);
        continue;
      }
      const pending = this.pendingAgents.get(resource.key);
      if (!pending || pending.resource.version !== resource.version) continue;
      this.loadedAgents.set(resource.key, pending.resource);
      this.pendingAgents.delete(resource.key);
    }
  }

  discardPending(): void {
    this.pendingSkills.clear();
    this.pendingAgents.clear();
  }

  restore(resources: ContextResourceDescriptor[]): void {
    for (const resource of resources) {
      if (resource.kind === 'skill') {
        this.loadedSkills.delete(resource.key);
        const record = this.skills.get(resource.key);
        if (!record) continue;
        try {
          const raw = boundedFile(record.realPath, MAX_SKILL_BYTES, 'SKILL.md');
          if (versionOf(raw) === resource.version) {
            this.loadedSkills.set(resource.key, resource);
          }
        } catch {
          continue;
        }
      } else {
        this.loadedAgents.delete(resource.key);
        try {
          const raw = boundedFile(resource.key, MAX_AGENTS_BYTES, 'AGENTS.md');
          if (versionOf(raw) === resource.version) {
            this.loadedAgents.set(resource.key, resource);
          }
        } catch {
          continue;
        }
      }
    }
  }

  snapshot(): ContextResourceSnapshot {
    return {
      skills: [...this.loadedSkills.values()]
        .map((resource) => resource.display)
        .sort(),
      agentsFiles: [...this.loadedAgents.values()]
        .map((resource) => resource.display)
        .sort(),
    };
  }

  takeCompactionReminder(
    survivingResources: ContextResourceDescriptor[] = [],
  ): string | null {
    const priorSkills = new Map(this.loadedSkills);
    const priorAgents = new Map(this.loadedAgents);
    this.resetContext();
    this.restore(survivingResources);
    const prior: ContextResourceSnapshot = {
      skills: [...priorSkills]
        .filter(([key]) => !this.loadedSkills.has(key))
        .map(([, resource]) => resource.display)
        .sort(),
      agentsFiles: [...priorAgents]
        .filter(([key]) => !this.loadedAgents.has(key))
        .map(([, resource]) => resource.display)
        .sort(),
    };
    if (prior.skills.length === 0 && prior.agentsFiles.length === 0)
      return null;
    const lines = [
      '[harness: context resources were present before the fold.]',
      'Before responding or running more code, decide which are still relevant. Reload relevant skills with the top-level skill tool, and reload relevant AGENTS.md files with elpis.read(path) in their own run call. Do not reload irrelevant resources; only resources loaded again belong to this context window.',
    ];
    if (prior.skills.length > 0) {
      lines.push(
        `skills: ${prior.skills.map((name) => JSON.stringify(name)).join(', ')}`,
      );
    }
    if (prior.agentsFiles.length > 0) {
      lines.push(
        `AGENTS.md: ${prior.agentsFiles.map((file) => JSON.stringify(file)).join(', ')}`,
      );
    }
    return lines.join('\n');
  }

  resetContext(): void {
    this.loadedSkills.clear();
    this.loadedAgents.clear();
    this.pendingSkills.clear();
    this.pendingAgents.clear();
  }

  private nearestAgents(
    target: string,
    kind: 'file' | 'directory' | 'auto',
  ): { path: string; realPath: string }[] {
    const absolute = path.resolve(target);
    const directoryFor = (candidate: string): string => {
      if (kind === 'directory') return candidate;
      if (kind === 'file') return path.dirname(candidate);
      try {
        return fs.statSync(candidate).isDirectory()
          ? candidate
          : path.dirname(candidate);
      } catch {
        return path.dirname(candidate);
      }
    };
    const directories = [directoryFor(absolute)];
    try {
      const physical = fs.realpathSync.native(absolute);
      const physicalDirectory = directoryFor(physical);
      if (!directories.includes(physicalDirectory))
        directories.push(physicalDirectory);
    } catch {
      // A missing target still inherits instructions from its lexical parent.
    }
    const found: { path: string; realPath: string }[] = [];
    const seen = new Set<string>();
    for (const directory of directories) {
      for (const current of ancestors(directory)) {
        const candidate = path.join(current, 'AGENTS.md');
        try {
          const realPath = fs.realpathSync.native(candidate);
          if (!fs.statSync(realPath).isFile() || seen.has(realPath)) continue;
          seen.add(realPath);
          found.push({ path: candidate, realPath });
          break;
        } catch {
          continue;
        }
      }
    }
    return found;
  }
}
