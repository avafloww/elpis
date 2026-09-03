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
const DIRECTORY_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
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

interface PinnedRoot {
  directory: string;
  source: ResolvedMotorSkill['source'];
  fd: number;
}

interface MotorSkillRecord extends MotorSkillSummary {
  source: ResolvedMotorSkill['source'];
  root: PinnedRoot;
  directoryName: string;
  rootPath: string;
  path: string;
  packageDev: bigint;
  packageIno: bigint;
}

export interface MotorSkillsOptions {
  dataDirectory: string;
  bundledSkillsDirectory?: string | null;
  logger?: { warn(...args: unknown[]): void };
}

function descriptorPath(fd: number, ...segments: string[]): string {
  return path.join('/proc/self/fd', String(fd), ...segments);
}

function openDirectory(file: string): number {
  const fd = fs.openSync(file, DIRECTORY_FLAGS);
  try {
    if (!fs.fstatSync(fd).isDirectory())
      throw new Error(`not a directory: ${file}`);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
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

function configuredRoots(options: MotorSkillsOptions): Array<{
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

function pinRoots(options: MotorSkillsOptions): PinnedRoot[] {
  const roots: PinnedRoot[] = [];
  for (const configured of configuredRoots(options)) {
    let fd: number;
    try {
      if (fs.lstatSync(configured.directory).isSymbolicLink())
        throw new Error('library root is a symlink');
      fd = openDirectory(configured.directory);
    } catch (error) {
      if (fs.existsSync(configured.directory))
        options.logger?.warn(
          'motor skill library ignored: root must be a real directory',
          configured.directory,
          error,
        );
      continue;
    }
    roots.push({ ...configured, fd });
  }
  return roots;
}

function discover(
  roots: PinnedRoot[],
  options: MotorSkillsOptions,
): Map<string, MotorSkillRecord> {
  const found = new Map<string, MotorSkillRecord>();
  for (const root of roots) {
    const entries = fs
      .readdirSync(descriptorPath(root.fd), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directoryName = entry.name;
      let packageFd: number;
      let raw: string;
      try {
        packageFd = openDirectory(descriptorPath(root.fd, directoryName));
      } catch {
        continue;
      }
      let identity: fs.BigIntStats;
      try {
        identity = fs.fstatSync(packageFd, { bigint: true });
        raw = readText(
          descriptorPath(packageFd, 'SKILL.md'),
          MAX_MOTOR_SKILL_BYTES,
          'motor skill',
        );
      } catch {
        fs.closeSync(packageFd);
        continue;
      }
      fs.closeSync(packageFd);
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
          path.join(root.directory, directoryName, 'SKILL.md'),
        );
        continue;
      }
      const candidate = path.join(root.directory, directoryName, 'SKILL.md');
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
        root,
        directoryName,
        rootPath: path.join(root.directory, directoryName),
        path: candidate,
        packageDev: identity.dev,
        packageIno: identity.ino,
      });
    }
  }
  return found;
}

function snapshotResources(
  packageFd: number,
  packagePath: string,
  name: string,
): ReadonlyArray<Readonly<ResolvedMotorSkillResource>> {
  const resources: Array<Readonly<ResolvedMotorSkillResource>> = [];
  let entriesSeen = 0;
  let resourceBytes = 0;
  const walk = (directoryFd: number, segments: string[]) => {
    const entries = fs
      .readdirSync(descriptorPath(directoryFd), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      entriesSeen++;
      if (entriesSeen > MAX_MOTOR_SKILL_RESOURCE_ENTRIES)
        throw new Error(
          `motor skill package exceeds ${MAX_MOTOR_SKILL_RESOURCE_ENTRIES} entries`,
        );
      if (!RESOURCE_SEGMENT_PATTERN.test(entry.name))
        throw new Error(`invalid motor skill resource name: ${entry.name}`);
      const childSegments = [...segments, entry.name];
      if (entry.isSymbolicLink())
        throw new Error(
          `motor skill resources may not be symlinks: ${path.join(packagePath, ...childSegments)}`,
        );
      if (entry.isDirectory()) {
        if (childSegments.length > 4)
          throw new Error('motor skill resource nesting exceeds four levels');
        const childFd = openDirectory(descriptorPath(directoryFd, entry.name));
        try {
          walk(childFd, childSegments);
        } finally {
          fs.closeSync(childFd);
        }
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `motor skill resource is not a regular file: ${path.join(packagePath, ...childSegments)}`,
        );
      if (segments.length === 0 && entry.name === 'SKILL.md') continue;
      const relativePath = childSegments.join('/');
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        throw new Error(
          `unsupported motor skill resource type: ${path.join(packagePath, ...childSegments)}`,
        );
      if (resources.length >= MAX_MOTOR_SKILL_RESOURCES)
        throw new Error(
          `motor skill package exceeds ${MAX_MOTOR_SKILL_RESOURCES} resources`,
        );
      const body = readText(
        descriptorPath(directoryFd, entry.name),
        MAX_MOTOR_SKILL_RESOURCE_BYTES,
        'motor skill resource',
      );
      const bytes = Buffer.byteLength(body, 'utf8');
      resourceBytes += bytes;
      const handle = `skill:${name}/${relativePath}`;
      if (handle.length > 512)
        throw new Error('motor skill resource handle exceeds 512 characters');
      resources.push(
        Object.freeze({
          handle,
          relativePath,
          path: path.join(packagePath, ...childSegments),
          sha256: digest(body),
          bytes,
          body,
        }),
      );
    }
  };
  walk(packageFd, []);
  if (resourceBytes > MAX_MOTOR_SKILL_PACKAGE_BYTES)
    throw new Error(
      `motor skill package resources exceed ${MAX_MOTOR_SKILL_PACKAGE_BYTES} bytes`,
    );
  return Object.freeze(resources);
}

export class MotorSkills {
  private readonly roots: PinnedRoot[];
  private readonly skills: Map<string, MotorSkillRecord>;

  constructor(options: MotorSkillsOptions) {
    this.roots = pinRoots(options);
    try {
      this.skills = discover(this.roots, options);
    } catch (error) {
      for (const root of this.roots) fs.closeSync(root.fd);
      throw error;
    }
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
    const packageFd = openDirectory(
      descriptorPath(record.root.fd, record.directoryName),
    );
    try {
      const identity = fs.fstatSync(packageFd, { bigint: true });
      if (
        identity.dev !== record.packageDev ||
        identity.ino !== record.packageIno
      )
        throw new Error(
          `motor skill package changed before selection: ${name}`,
        );
      const body = readText(
        descriptorPath(packageFd, 'SKILL.md'),
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
        throw new Error(
          `motor skill metadata changed before selection: ${name}`,
        );
      const resources = snapshotResources(packageFd, record.rootPath, name);
      const packageBytes =
        Buffer.byteLength(body, 'utf8') +
        resources.reduce((total, resource) => total + resource.bytes, 0);
      if (packageBytes > MAX_MOTOR_SKILL_PACKAGE_BYTES)
        throw new Error(
          `motor skill package exceeds ${MAX_MOTOR_SKILL_PACKAGE_BYTES} bytes`,
        );
      return Object.freeze({
        name: record.name,
        description: record.description,
        source: record.source,
        rootPath: record.rootPath,
        path: record.path,
        sha256: digest(body),
        body,
        resources,
      });
    } finally {
      fs.closeSync(packageFd);
    }
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
