import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import {
  GATEWAY_APPLICATION_ID,
  GATEWAY_SCHEMA_VERSION,
  verifyGatewayMigrationHistory,
} from './migrations.js';

export interface GatewayBackupReceipt {
  readonly path: string;
  readonly pages: number;
  readonly bytes: number;
  readonly sha256: string;
}

function pragmaNumber(database: DatabaseSync, name: string): number {
  const row = database.prepare(`PRAGMA ${name}`).get() as Record<
    string,
    unknown
  >;
  const value = Number(row[name]);
  if (!Number.isSafeInteger(value))
    throw new Error(`backup PRAGMA ${name} is invalid`);
  return value;
}

function secureParent(file: string): string {
  const parent = path.dirname(file);
  const stat = fs.lstatSync(parent);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('backup parent must be a real directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    throw new Error('backup parent must be owned by the Gateway process');
  if ((stat.mode & 0o077) !== 0)
    throw new Error('backup parent must not be accessible to group or others');
  return parent;
}

function regularFile(file: string, label: string): fs.Stats {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new Error(`${label} must be a regular file`);
  return stat;
}

function fsyncFile(file: string): void {
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY,
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function verifyGatewayBackup(file: string): void {
  const resolved = path.resolve(file);
  regularFile(resolved, 'backup');
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${resolved}${suffix}`))
      throw new Error('backup must be self-contained before verification');
  }
  const database = new DatabaseSync(resolved, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5000,
  });
  let failure: unknown = null;
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
    const quick = database.prepare('PRAGMA quick_check').get() as {
      quick_check?: unknown;
    };
    if (quick.quick_check !== 'ok')
      throw new Error('backup quick_check failed');
    if (pragmaNumber(database, 'application_id') !== GATEWAY_APPLICATION_ID)
      throw new Error('backup application identity is invalid');
    if (pragmaNumber(database, 'user_version') !== GATEWAY_SCHEMA_VERSION)
      throw new Error('backup schema version is invalid');
    verifyGatewayMigrationHistory(database);
    const foreignKeyFailures = database
      .prepare('PRAGMA foreign_key_check')
      .all();
    if (foreignKeyFailures.length !== 0)
      throw new Error('backup contains foreign-key violations');
  } catch (error) {
    failure = error;
  } finally {
    database.close();
    const wal = `${resolved}-wal`;
    if (fs.existsSync(wal) && fs.statSync(wal).size !== 0 && failure == null)
      failure = new Error('backup verification produced a non-empty WAL');
    for (const suffix of ['-wal', '-shm']) {
      try {
        fs.unlinkSync(`${resolved}${suffix}`);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
          failure == null
        )
          failure = error;
      }
    }
  }
  if (failure) throw failure;
}

export async function backupGatewayDatabase(
  source: DatabaseSync,
  destination: string,
): Promise<GatewayBackupReceipt> {
  const resolved = path.resolve(destination);
  const parent = secureParent(resolved);
  if (fs.existsSync(resolved))
    throw new Error('backup destination already exists');
  const temporary = path.join(
    parent,
    `.${path.basename(resolved)}.${randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(
    temporary,
    fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_RDWR |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  fs.closeSync(descriptor);

  let published = false;
  try {
    const pages = await backup(source, temporary);
    fs.chmodSync(temporary, 0o600);
    const stat = regularFile(temporary, 'temporary backup');
    fsyncFile(temporary);
    verifyGatewayBackup(temporary);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${temporary}${suffix}`))
        throw new Error('backup verification left a SQLite sidecar');
    }
    fs.linkSync(temporary, resolved);
    published = true;
    fs.unlinkSync(temporary);
    fsyncDirectory(parent);
    const finalStat = regularFile(resolved, 'published backup');
    if ((finalStat.mode & 0o777) !== 0o600)
      throw new Error('published backup permissions are not 0600');
    return Object.freeze({
      path: resolved,
      pages,
      bytes: stat.size,
      sha256: sha256File(resolved),
    });
  } catch (error) {
    if (published) {
      try {
        fs.unlinkSync(resolved);
        fsyncDirectory(parent);
      } catch {
        /* preserve the backup failure */
      }
    }
    throw error;
  } finally {
    for (const candidate of [
      temporary,
      `${temporary}-wal`,
      `${temporary}-shm`,
    ]) {
      try {
        fs.unlinkSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}
