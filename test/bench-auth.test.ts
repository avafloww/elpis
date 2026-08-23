import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hardenAuthStore } from '../bench/auth.js';

test('benchmark OAuth store hardens its directory and SQLite files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpisbench-auth-'));
  fs.chmodSync(root, 0o755);
  for (const name of ['elpis.db', 'elpis.db-wal', 'elpis.db-shm'])
    fs.writeFileSync(path.join(root, name), 'x', { mode: 0o644 });
  hardenAuthStore(root);
  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  for (const name of ['elpis.db', 'elpis.db-wal', 'elpis.db-shm'])
    assert.equal(fs.statSync(path.join(root, name)).mode & 0o777, 0o600);
  fs.rmSync(root, { recursive: true, force: true });
});
