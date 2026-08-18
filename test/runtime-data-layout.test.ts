import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createElpisRuntime } from '../src/index.js';
import { resolveDataLayout } from '../src/store/data-layout.js';
import { makeConfig } from './helpers.js';

test('runtime migrates legacy state before opening consumers', async () => {
  const originalCwd = process.cwd();
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-data-layout-'));
  const harnessRoot = path.resolve(import.meta.dirname, '..');
  const layout = resolveDataLayout(dataDirectory);
  fs.mkdirSync(path.join(dataDirectory, 'extensions'));
  fs.writeFileSync(path.join(dataDirectory, 'extensions', 'proof.ext.ts'), 'legacy extension');
  fs.mkdirSync(path.join(dataDirectory, 'sessions', 'discord', 'main'), { recursive: true });
  fs.writeFileSync(path.join(dataDirectory, 'sessions', 'discord', 'main', 'proof.jsonl'), 'legacy transcript');
  fs.writeFileSync(path.join(dataDirectory, 'unknown-work.txt'), 'inhabitant');
  const legacy = new DatabaseSync(path.join(dataDirectory, 'agent.db'));
  legacy.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('kept')");
  legacy.close();

  const base = makeConfig();
  const config = makeConfig({
    paths: {
      ...base.paths,
      dataDirectory,
      soulPath: path.join(dataDirectory, 'SOUL.md'),
      memoryPath: path.join(dataDirectory, 'MEMORY.md'),
      harnessRoot,
    },
  });
  const stop = new Error('stop after migration assertion');
  try {
    await assert.rejects(createElpisRuntime({
      loadConfigFile: () => config,
      loadExtensions: async () => {
        assert.equal(fs.existsSync(path.join(dataDirectory, 'agent.db')), false);
        assert.equal(fs.existsSync(path.join(dataDirectory, 'extensions')), false);
        assert.equal(fs.existsSync(path.join(dataDirectory, 'sessions')), false);
        assert.equal(fs.readFileSync(path.join(layout.extensions, 'proof.ext.ts'), 'utf8'), 'legacy extension');
        assert.equal(fs.readFileSync(path.join(layout.sessions, 'discord', 'main', 'proof.jsonl'), 'utf8'), 'legacy transcript');
        assert.equal(fs.readFileSync(path.join(dataDirectory, 'unknown-work.txt'), 'utf8'), 'inhabitant');
        const migrated = new DatabaseSync(layout.database, { readOnly: true });
        assert.equal((migrated.prepare('SELECT value FROM proof').get() as { value: string }).value, 'kept');
        migrated.close();
        throw stop;
      },
    }), stop);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
