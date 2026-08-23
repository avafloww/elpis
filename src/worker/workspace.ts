import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Database } from '../store/db.js';
import { resolveWorkerSession, type WorkerSessionBinding } from './session.js';

const SESSION_PATTERN = /^wrk-[a-z0-9]{8}$/;
const ARTIFACT_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export interface WorkerSourceReceipt {
  revision: string;
  sha256: string;
  sizeBytes: number;
}

export interface WorkerSourceArchive extends WorkerSourceReceipt {
  binding: WorkerSessionBinding;
  data: Buffer;
}

export interface WorkerArtifactReceipt {
  id: number;
  sessionId: string;
  key: string;
  kind: 'unified_patch_gzip';
  sourceSha256: string;
  sha256: string;
  sizeBytes: number;
  relativePath: string;
  createdAt: number;
}

export interface WorkerArtifactFile extends WorkerArtifactReceipt {
  localPath: string;
}

export class WorkerWorkspaceError extends Error {
  constructor(
    public readonly code:
      | 'unavailable'
      | 'unauthorized'
      | 'invalid_request'
      | 'conflict'
      | 'corrupt',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerWorkspaceError';
  }
}

export interface WorkerWorkspaceStoreOptions {
  db: Database;
  storageRoot: string;
  sourceRoot: string | null;
  maxSourceBytes: number;
  maxArtifactBytes: number;
  now?: () => number;
  gitPath?: string;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function bounded(message: string): string {
  return message.trim().slice(0, 500) || 'no diagnostic';
}

function syncDirectory(directory: string): void {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

function rowArtifact(row: Record<string, unknown>): WorkerArtifactReceipt {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    key: String(row.artifact_key),
    kind: row.kind as 'unified_patch_gzip',
    sourceSha256: String(row.source_sha256),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    relativePath: String(row.relative_path),
    createdAt: Number(row.created_at),
  };
}

export class WorkerWorkspaceStore {
  private readonly now: () => number;
  private readonly gitPath: string;
  private readonly sourcesRoot: string;
  private readonly artifactsRoot: string;

  constructor(private readonly options: WorkerWorkspaceStoreOptions) {
    if (!path.isAbsolute(options.storageRoot))
      throw new Error('worker workspace storage root must be absolute');
    if (options.sourceRoot !== null && !path.isAbsolute(options.sourceRoot))
      throw new Error('worker workspace source root must be absolute');
    for (const [label, value] of [
      ['maxSourceBytes', options.maxSourceBytes],
      ['maxArtifactBytes', options.maxArtifactBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error(
          `worker workspace ${label} must be a positive safe integer`,
        );
    }
    this.now = options.now ?? Date.now;
    this.gitPath = options.gitPath ?? 'git';
    this.sourcesRoot = path.join(options.storageRoot, 'sources');
    this.artifactsRoot = path.join(options.storageRoot, 'artifacts');
    ensurePrivateDirectory(options.storageRoot);
    ensurePrivateDirectory(this.sourcesRoot);
    ensurePrivateDirectory(this.artifactsRoot);
  }

  private sourceDirectory(sessionId: string): string {
    if (!SESSION_PATTERN.test(sessionId))
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker session id is invalid',
      );
    return path.join(this.sourcesRoot, sessionId);
  }

  private sourcePath(sessionId: string): string {
    return path.join(this.sourceDirectory(sessionId), 'source.tar.gz');
  }

  private artifactPath(sessionId: string, key: string): string {
    if (!SESSION_PATTERN.test(sessionId))
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker session id is invalid',
      );
    if (!ARTIFACT_KEY_PATTERN.test(key))
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker artifact key is invalid',
      );
    return path.join(this.artifactsRoot, sessionId, key);
  }

  private async git(args: string[]): Promise<GitResult> {
    if (this.options.sourceRoot === null)
      throw new WorkerWorkspaceError(
        'unavailable',
        'worker source workspace is disabled',
      );
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.gitPath,
        ['-C', this.options.sourceRoot!, ...args],
        {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
      child.once('error', reject);
      child.once('close', (code) =>
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }),
      );
    });
  }

  async prepareSource(sessionId: string): Promise<WorkerSourceReceipt | null> {
    if (this.options.sourceRoot === null) return null;
    const status = await this.git(['status', '--porcelain']);
    if (status.code !== 0)
      throw new WorkerWorkspaceError(
        'unavailable',
        `worker source status failed: ${bounded(status.stderr)}`,
      );
    if (status.stdout.trim())
      throw new WorkerWorkspaceError(
        'conflict',
        'worker source repository must be clean',
      );
    const revision = await this.git(['rev-parse', '--verify', 'HEAD']);
    if (revision.code !== 0 || !/^[0-9a-f]{40,64}\n?$/.test(revision.stdout))
      throw new WorkerWorkspaceError(
        'unavailable',
        `worker source revision failed: ${bounded(revision.stderr)}`,
      );
    const directory = this.sourceDirectory(sessionId);
    ensurePrivateDirectory(directory);
    const finalPath = this.sourcePath(sessionId);
    const temporary = path.join(
      directory,
      `.source-${process.pid}-${Date.now()}.tmp`,
    );
    const archive = await this.git([
      'archive',
      '--format=tar.gz',
      `--output=${temporary}`,
      'HEAD',
    ]);
    if (archive.code !== 0) {
      fs.rmSync(temporary, { force: true });
      throw new WorkerWorkspaceError(
        'unavailable',
        `worker source archive failed: ${bounded(archive.stderr)}`,
      );
    }
    const data = fs.readFileSync(temporary);
    if (data.length > this.options.maxSourceBytes) {
      fs.rmSync(temporary, { force: true });
      throw new WorkerWorkspaceError(
        'invalid_request',
        `worker source archive exceeds ${this.options.maxSourceBytes} bytes`,
      );
    }
    fs.chmodSync(temporary, 0o600);
    const fd = fs.openSync(temporary, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, finalPath);
    syncDirectory(directory);
    return {
      revision: revision.stdout.trim(),
      sha256: digest(data),
      sizeBytes: data.length,
    };
  }

  discardSource(sessionId: string): void {
    fs.rmSync(this.sourceDirectory(sessionId), {
      recursive: true,
      force: true,
    });
  }

  sourceForWorker(token: string): WorkerSourceArchive | null {
    const binding = resolveWorkerSession(this.options.db, token);
    if (!binding)
      throw new WorkerWorkspaceError(
        'unauthorized',
        'worker session is unavailable',
      );
    const row = this.options.db
      .prepare(
        'SELECT source_revision, source_sha256, source_bytes FROM worker_sessions WHERE id = ?',
      )
      .get(binding.sessionId) as Record<string, unknown> | undefined;
    if (!row || row.source_revision == null) return null;
    const receipt = {
      revision: String(row.source_revision),
      sha256: String(row.source_sha256),
      sizeBytes: Number(row.source_bytes),
    };
    let data: Buffer;
    try {
      data = fs.readFileSync(this.sourcePath(binding.sessionId));
    } catch {
      throw new WorkerWorkspaceError(
        'corrupt',
        'worker source archive is missing',
      );
    }
    if (data.length !== receipt.sizeBytes || digest(data) !== receipt.sha256)
      throw new WorkerWorkspaceError(
        'corrupt',
        'worker source archive failed verification',
      );
    return { binding, ...receipt, data };
  }

  putArtifactForWorker(input: {
    token: string;
    key: string;
    kind: 'unified_patch_gzip';
    sourceSha256: string;
    data: Buffer;
    sha256?: string;
  }): WorkerArtifactReceipt {
    const binding = resolveWorkerSession(this.options.db, input.token);
    if (!binding)
      throw new WorkerWorkspaceError(
        'unauthorized',
        'worker session is unavailable',
      );
    if (!ARTIFACT_KEY_PATTERN.test(input.key))
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker artifact key is invalid',
      );
    if (input.kind !== 'unified_patch_gzip')
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker artifact kind is unsupported',
      );
    if (
      !Buffer.isBuffer(input.data) ||
      input.data.length > this.options.maxArtifactBytes
    )
      throw new WorkerWorkspaceError(
        'invalid_request',
        `worker artifact exceeds ${this.options.maxArtifactBytes} bytes`,
      );
    if (!SHA256_PATTERN.test(input.sourceSha256))
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker source digest is invalid',
      );
    const source = this.options.db
      .prepare('SELECT source_sha256 FROM worker_sessions WHERE id = ?')
      .get(binding.sessionId) as { source_sha256: string | null } | undefined;
    if (!source?.source_sha256 || source.source_sha256 !== input.sourceSha256)
      throw new WorkerWorkspaceError(
        'conflict',
        'worker artifact source digest changed',
      );
    const sha256 = digest(input.data);
    if (input.sha256 !== undefined && input.sha256 !== sha256)
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker artifact digest is invalid',
      );
    const existing = this.options.db
      .prepare(
        'SELECT * FROM worker_workspace_artifacts WHERE session_id = ? AND artifact_key = ?',
      )
      .get(binding.sessionId, input.key) as Record<string, unknown> | undefined;
    if (existing) {
      const receipt = rowArtifact(existing);
      if (
        receipt.kind !== input.kind ||
        receipt.sourceSha256 !== input.sourceSha256 ||
        receipt.sha256 !== sha256 ||
        receipt.sizeBytes !== input.data.length
      )
        throw new WorkerWorkspaceError(
          'conflict',
          'worker artifact key is already bound differently',
        );
      const verified = this.artifactFile(binding.sessionId, input.key);
      return {
        id: verified.id,
        sessionId: verified.sessionId,
        key: verified.key,
        kind: verified.kind,
        sourceSha256: verified.sourceSha256,
        sha256: verified.sha256,
        sizeBytes: verified.sizeBytes,
        relativePath: verified.relativePath,
        createdAt: verified.createdAt,
      };
    }
    const relativePath = path.posix.join(
      'artifacts',
      binding.sessionId,
      input.key,
    );
    const destination = this.artifactPath(binding.sessionId, input.key);
    const directory = path.dirname(destination);
    ensurePrivateDirectory(directory);
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, input.data, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    const fd = fs.openSync(temporary, 'r');
    try {
      fs.fdatasyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, destination);
    syncDirectory(directory);
    const createdAt = this.now();
    try {
      this.options.db
        .prepare(
          `INSERT INTO worker_workspace_artifacts
           (session_id, artifact_key, kind, source_sha256, sha256, size_bytes, relative_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          binding.sessionId,
          input.key,
          input.kind,
          input.sourceSha256,
          sha256,
          input.data.length,
          relativePath,
          createdAt,
        );
    } catch (error) {
      fs.rmSync(destination, { force: true });
      throw error;
    }
    return rowArtifact(
      this.options.db
        .prepare(
          'SELECT * FROM worker_workspace_artifacts WHERE session_id = ? AND artifact_key = ?',
        )
        .get(binding.sessionId, input.key) as Record<string, unknown>,
    );
  }

  listArtifacts(sessionId: string): WorkerArtifactReceipt[] {
    if (!SESSION_PATTERN.test(sessionId))
      throw new WorkerWorkspaceError(
        'invalid_request',
        'worker session id is invalid',
      );
    return (
      this.options.db
        .prepare(
          'SELECT * FROM worker_workspace_artifacts WHERE session_id = ? ORDER BY id',
        )
        .all(sessionId) as Record<string, unknown>[]
    ).map(rowArtifact);
  }

  artifactFile(sessionId: string, key: string): WorkerArtifactFile {
    const row = this.options.db
      .prepare(
        'SELECT * FROM worker_workspace_artifacts WHERE session_id = ? AND artifact_key = ?',
      )
      .get(sessionId, key) as Record<string, unknown> | undefined;
    if (!row)
      throw new WorkerWorkspaceError(
        'unavailable',
        'worker artifact is unavailable',
      );
    const receipt = rowArtifact(row);
    const localPath = path.join(this.options.storageRoot, receipt.relativePath);
    const data = fs.readFileSync(localPath);
    if (data.length !== receipt.sizeBytes || digest(data) !== receipt.sha256)
      throw new WorkerWorkspaceError(
        'corrupt',
        'worker artifact failed verification',
      );
    return { ...receipt, localPath };
  }
}
