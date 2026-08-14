import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function privateDataRoot(env = process.env): string {
  return path.resolve(env.ELPISBENCH_DATA_DIR ?? path.join(os.homedir(), '.local', 'share', 'elpisbench'));
}
export function ensurePrivateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}
export function contentDigest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function artifactPath(kind: string, digest: string, root = privateDataRoot()): string {
  if (!/^[a-z0-9-]+$/.test(kind) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('invalid content-addressed artifact key');
  return path.join(ensurePrivateDir(path.join(root, kind)), `${digest}.json`);
}
export function writePrivateJson(file: string, value: unknown): void {
  // Callers may intentionally export to an existing shared parent such as
  // /tmp. Create a missing parent privately, but never chmod an arbitrary
  // pre-existing directory we do not own. Internal artifact roots are already
  // hardened explicitly through ensurePrivateDir().
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  fs.chmodSync(file, 0o600);
}
export function readJson(file: string): unknown { return JSON.parse(fs.readFileSync(file, 'utf8')); }
