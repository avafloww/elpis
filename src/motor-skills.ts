import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './lib/frontmatter.js';
import { resolveDataLayout } from './store/data-layout.js';

export const MAX_MOTOR_SKILL_CATALOG = 128;
export const MAX_MOTOR_SKILLS_PER_EPISODE = 4;
export const MAX_MOTOR_SKILL_BYTES = 24 * 1024;
export const MAX_MOTOR_SKILL_TOTAL_BYTES = 32 * 1024;
export const MAX_MOTOR_SKILL_DESCRIPTION_CHARS = 512;
export const MAX_MOTOR_SKILL_RESOURCES = 32;
export const MAX_MOTOR_SKILL_RESOURCE_ENTRIES = 128;
export const MAX_MOTOR_SKILL_RESOURCE_BYTES = 16 * 1024;
export const MAX_MOTOR_SKILL_PACKAGE_BYTES = 128 * 1024;

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const RESOURCE_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
]);
const moduleFile = fileURLToPath(import.meta.url);
export const DEFAULT_BUNDLED_MOTOR_SKILLS_DIRECTORY = path.resolve(
  path.dirname(moduleFile),
  moduleFile.endsWith('.ts') ? '../motor-skills' : 'motor-skills',
);

export interface MotorSkillSummary {
  name: string;
  description: string;
}

export interface ResolvedMotorSkillResource {
  handle: string;
  relativePath: string;
  path: string;
  sha256: string;
  bytes: number;
  body: string;
}

export interface ResolvedMotorSkill extends MotorSkillSummary {
  source: 'data' | 'bundled';
  rootPath: string;
  path: string;
  sha256: string;
  body: string;
  resources: ReadonlyArray<Readonly<ResolvedMotorSkillResource>>;
}

export interface MotorSkillInspection extends Omit<
  ResolvedMotorSkill,
  'resources'
> {
  resources: ReadonlyArray<Readonly<Omit<ResolvedMotorSkillResource, 'body'>>>;
}

interface MotorSkillRecord extends MotorSkillSummary {
  source: ResolvedMotorSkill['source'];
  rootPath: string;
  path: string;
  realPath: string;
  realRootPath: string;
}

export interface MotorSkillsOptions {
  dataDirectory: string;
  bundledSkillsDirectory?: string | null;
  logger?: { warn(...args: unknown[]): void };
}

function readText(file: string, maxBytes: number, label: string): string {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (stat.size > maxBytes)
      throw new Error(`${label} exceeds ${maxBytes} bytes`);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== stat.size)
      throw new Error(`${label} changed while being read`);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function normalizeDescription(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_MOTOR_SKILL_DESCRIPTION_CHARS);
}

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function roots(options: MotorSkillsOptions): Array<{
  directory: string;
  source: ResolvedMotorSkill['source'];
}> {
  const configured = [
    {
      directory: resolveDataLayout(options.dataDirectory).motorSkills,
      source: 'data' as const,
    },
    ...(options.bundledSkillsDirectory === null
      ? []
      : [
          {
            directory:
              options.bundledSkillsDirectory ??
              DEFAULT_BUNDLED_MOTOR_SKILLS_DIRECTORY,
            source: 'bundled' as const,
          },
        ]),
  ];
  const seen = new Set<string>();
  return configured.filter((entry) => {
    entry.directory = path.resolve(entry.directory);
    if (seen.has(entry.directory)) return false;
    seen.add(entry.directory);
    return true;
  });
}

function discover(options: MotorSkillsOptions): Map<string, MotorSkillRecord> {
  const found = new Map<string, MotorSkillRecord>();
  for (const root of roots(options)) {
    let directories: string[];
    try {
      directories = fs.readdirSync(root.directory).sort();
    } catch {
      continue;
    }
    for (const directoryName of directories) {
      const rootPath = path.join(root.directory, directoryName);
      const candidate = path.join(rootPath, 'SKILL.md');
      let realPath: string;
      let realRootPath: string;
      let raw: string;
      try {
        if (!fs.lstatSync(rootPath).isDirectory()) continue;
        if (!fs.lstatSync(candidate).isFile()) continue;
        realRootPath = fs.realpathSync.native(rootPath);
        realPath = fs.realpathSync.native(candidate);
        if (realPath !== path.join(realRootPath, 'SKILL.md')) continue;
        raw = readText(realPath, MAX_MOTOR_SKILL_BYTES, 'motor skill');
      } catch {
        continue;
      }
      const parsed = parseFrontmatter(raw);
      const name = parsed?.frontmatter.name;
      const description = parsed?.frontmatter.description;
      if (
        typeof name !== 'string' ||
        !NAME_PATTERN.test(name) ||
        directoryName !== name ||
        typeof description !== 'string' ||
        description.trim() === ''
      ) {
        options.logger?.warn(
          'motor skill ignored: invalid or mismatched name/description',
          candidate,
        );
        continue;
      }
      const duplicate = found.get(name);
      if (duplicate)
        throw new Error(
          `duplicate motor skill name ${JSON.stringify(name)}: ${duplicate.path} and ${candidate}`,
        );
      if (found.size >= MAX_MOTOR_SKILL_CATALOG)
        throw new Error(
          `motor skill catalog exceeds the ${MAX_MOTOR_SKILL_CATALOG}-skill limit`,
        );
      found.set(name, {
        name,
        description: normalizeDescription(description),
        source: root.source,
        rootPath,
        path: candidate,
        realPath,
        realRootPath,
      });
    }
  }
  return found;
}

function resourceFiles(rootPath: string): string[] {
  const files: string[] = [];
  let entries = 0;
  const walk = (directory: string, segments: string[]) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      entries++;
      if (entries > MAX_MOTOR_SKILL_RESOURCE_ENTRIES)
        throw new Error(
          `motor skill package exceeds ${MAX_MOTOR_SKILL_RESOURCE_ENTRIES} entries`,
        );
      if (!RESOURCE_SEGMENT_PATTERN.test(entry.name))
        throw new Error(`invalid motor skill resource name: ${entry.name}`);
      const childSegments = [...segments, entry.name];
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`motor skill resources may not be symlinks: ${child}`);
      if (entry.isDirectory()) {
        if (childSegments.length > 4)
          throw new Error('motor skill resource nesting exceeds four levels');
        walk(child, childSegments);
        continue;
      }
      if (!entry.isFile())
        throw new Error(`motor skill resource is not a regular file: ${child}`);
      if (segments.length === 0 && entry.name === 'SKILL.md') continue;
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        throw new Error(`unsupported motor skill resource type: ${child}`);
      files.push(childSegments.join('/'));
      if (files.length > MAX_MOTOR_SKILL_RESOURCES)
        throw new Error(
          `motor skill package exceeds ${MAX_MOTOR_SKILL_RESOURCES} resources`,
        );
    }
  };
  walk(rootPath, []);
  return files.sort();
}

export class MotorSkills {
  private readonly skills: Map<string, MotorSkillRecord>;

  constructor(private readonly options: MotorSkillsOptions) {
    this.skills = discover(options);
  }

  catalog(): MotorSkillSummary[] {
    return [...this.skills.values()]
      .map(({ name, description }) => Object.freeze({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private load(name: string): Readonly<ResolvedMotorSkill> {
    if (typeof name !== 'string' || !NAME_PATTERN.test(name))
      throw new Error('invalid motor skill name');
    const record = this.skills.get(name);
    if (!record) {
      const available = this.catalog()
        .map((skill) => skill.name)
        .join(', ');
      throw new Error(
        `unknown motor skill ${JSON.stringify(name)}${available ? `; available: ${available}` : ''}`,
      );
    }
    if (
      !fs.lstatSync(record.rootPath).isDirectory() ||
      fs.realpathSync.native(record.rootPath) !== record.realRootPath ||
      !fs.lstatSync(record.path).isFile() ||
      fs.realpathSync.native(record.path) !== record.realPath
    )
      throw new Error(`motor skill package changed before selection: ${name}`);
    const body = readText(
      record.realPath,
      MAX_MOTOR_SKILL_BYTES,
      'motor skill',
    );
    const parsed = parseFrontmatter(body);
    if (
      parsed?.frontmatter.name !== record.name ||
      typeof parsed.frontmatter.description !== 'string' ||
      normalizeDescription(parsed.frontmatter.description) !==
        record.description
    )
      throw new Error(`motor skill metadata changed before selection: ${name}`);
    let packageBytes = Buffer.byteLength(body, 'utf8');
    const resources = resourceFiles(record.rootPath).map((relativePath) => {
      const resourcePath = path.join(
        record.rootPath,
        ...relativePath.split('/'),
      );
      const resourceBody = readText(
        resourcePath,
        MAX_MOTOR_SKILL_RESOURCE_BYTES,
        'motor skill resource',
      );
      const bytes = Buffer.byteLength(resourceBody, 'utf8');
      packageBytes += bytes;
      if (packageBytes > MAX_MOTOR_SKILL_PACKAGE_BYTES)
        throw new Error(
          `motor skill package exceeds ${MAX_MOTOR_SKILL_PACKAGE_BYTES} bytes`,
        );
      const handle = `skill:${name}/${relativePath}`;
      if (handle.length > 512)
        throw new Error(`motor skill resource handle exceeds 512 characters`);
      return Object.freeze({
        handle,
        relativePath,
        path: resourcePath,
        sha256: digest(resourceBody),
        bytes,
        body: resourceBody,
      });
    });
    return Object.freeze({
      name: record.name,
      description: record.description,
      source: record.source,
      rootPath: record.rootPath,
      path: record.path,
      sha256: digest(body),
      body,
      resources: Object.freeze(resources),
    });
  }

  inspect(name: string): Readonly<MotorSkillInspection> {
    const skill = this.load(name);
    return Object.freeze({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      rootPath: skill.rootPath,
      path: skill.path,
      sha256: skill.sha256,
      body: skill.body,
      resources: Object.freeze(
        skill.resources.map(({ body: _body, ...resource }) =>
          Object.freeze({ ...resource }),
        ),
      ),
    });
  }

  select(names: string[] = []): ReadonlyArray<Readonly<ResolvedMotorSkill>> {
    if (!Array.isArray(names))
      throw new Error('motor skills must be an array of names');
    if (names.length > MAX_MOTOR_SKILLS_PER_EPISODE)
      throw new Error(
        `motor episode may select at most ${MAX_MOTOR_SKILLS_PER_EPISODE} skills`,
      );
    const seen = new Set<string>();
    const selected = names.map((name) => {
      if (seen.has(name))
        throw new Error(`duplicate motor skill selection: ${name}`);
      seen.add(name);
      return this.load(name);
    });
    const total = selected.reduce(
      (bytes, skill) => bytes + Buffer.byteLength(skill.body, 'utf8'),
      0,
    );
    if (total > MAX_MOTOR_SKILL_TOTAL_BYTES)
      throw new Error(
        `selected motor skills exceed the ${MAX_MOTOR_SKILL_TOTAL_BYTES}-byte aggregate limit`,
      );
    return Object.freeze(selected);
  }
}
