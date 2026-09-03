import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFrontmatter } from './lib/frontmatter.js';

export const MAX_SKILLS_PER_CALL = 8;
export const MAX_SKILL_CATALOG = 128;
export const MAX_SKILL_DESCRIPTION_CHARS = 512;
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 192 * 1024;
export const MAX_AGENTS_BYTES = 64 * 1024;

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

export class ContextResourceInterrupt extends Error {
  readonly contextResourceInterrupt = true;
  readonly resourceType = 'agents-md';

  constructor(
    readonly resource: ContextResourceDescriptor,
    message: string,
  ) {
    super(message);
    this.name = 'ContextResourceInterrupt';
  }
}

export function isContextResourceInterrupt(
  value: unknown,
): value is ContextResourceInterrupt {
  if (!value || typeof value !== 'object') return false;
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
  harnessRoot: string;
  homeDirectory?: string | null;
  logger?: { warn(...args: unknown[]): void };
}

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

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => path.resolve(value)))];
}

function boundedPrefix(file: string, maxBytes: number): string {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`not a regular file: ${file}`);
  const size = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(file, 'r');
  try {
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function boundedFile(file: string, maxBytes: number, label: string): string {
  const stat = fs.statSync(file);
  if (!stat.isFile())
    throw new Error(`${label} is not a regular file: ${file}`);
  if (stat.size > maxBytes) {
    throw new Error(
      `${label} exceeds the ${maxBytes}-byte context limit: ${file} (${stat.size} bytes)`,
    );
  }
  const raw = fs.readFileSync(file, 'utf8');
  const bytes = Buffer.byteLength(raw, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(
      `${label} exceeds the ${maxBytes}-byte context limit after decoding: ${file} (${bytes} bytes)`,
    );
  }
  return raw;
}

function versionOf(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function skillRoots(options: ContextResourcesOptions): string[] {
  const roots: string[] = [];
  const chains = [options.dataDirectory, options.harnessRoot].map((start) =>
    ancestors(path.resolve(start)),
  );
  const depth = Math.max(...chains.map((chain) => chain.length));
  for (let index = 0; index < depth; index++) {
    for (const chain of chains) {
      const directory = chain[index];
      if (directory) roots.push(path.join(directory, '.agents', 'skills'));
    }
  }
  if (options.homeDirectory) {
    roots.push(path.join(options.homeDirectory, '.agents', 'skills'));
  }
  return unique(roots);
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
      if (found.has(name)) {
        options.logger?.warn(
          'skill ignored: duplicate name shadowed by earlier root',
          name,
          candidate,
        );
        continue;
      }
      found.set(name, {
        name,
        description: description.trim().slice(0, MAX_SKILL_DESCRIPTION_CHARS),
        path: candidate,
        realPath,
      });
      if (found.size >= MAX_SKILL_CATALOG) {
        options.logger?.warn(
          `skill catalog reached ${MAX_SKILL_CATALOG} entries; remaining candidates were ignored`,
        );
        return found;
      }
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

  beforeFileAccess(
    target: string,
    kind: 'file' | 'directory' | 'auto' = 'auto',
  ): void {
    if (typeof target !== 'string' || target.trim() === '') return;
    const agents = this.nearestAgents(target, kind);
    if (!agents) return;
    const raw = boundedFile(agents.realPath, MAX_AGENTS_BYTES, 'AGENTS.md');
    const resource: ContextResourceDescriptor = {
      kind: 'agents',
      key: agents.realPath,
      display: agents.path,
      version: versionOf(raw),
    };
    if (this.loadedAgents.get(resource.key)?.version === resource.version)
      return;
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

  takeCompactionReminder(): string | null {
    const prior = this.snapshot();
    this.resetContext();
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
  ): { path: string; realPath: string } | null {
    const absolute = path.resolve(target);
    let directory: string;
    if (kind === 'directory') {
      directory = absolute;
    } else if (kind === 'file') {
      directory = path.dirname(absolute);
    } else {
      try {
        directory = fs.statSync(absolute).isDirectory()
          ? absolute
          : path.dirname(absolute);
      } catch {
        directory = path.dirname(absolute);
      }
    }
    for (const current of ancestors(directory)) {
      const candidate = path.join(current, 'AGENTS.md');
      try {
        const realPath = fs.realpathSync.native(candidate);
        if (!fs.statSync(realPath).isFile()) continue;
        return { path: candidate, realPath };
      } catch {
        continue;
      }
    }
    return null;
  }
}
