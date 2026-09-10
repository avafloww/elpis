import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContextResources } from '../src/context-resources.js';
import { createElpisRuntime } from '../src/index.js';
import { MotorSkills } from '../src/motor-skills.js';
import { resolveDataLayout } from '../src/store/data-layout.js';
import { makeConfig } from './helpers.js';

test('runtime migrates legacy state before opening consumers', async () => {
  const originalCwd = process.cwd();
  const dataDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runtime-data-layout-'),
  );
  const harnessRoot = path.resolve(import.meta.dirname, '..');
  const layout = resolveDataLayout(dataDirectory);
  fs.mkdirSync(path.join(dataDirectory, 'extensions'));
  fs.writeFileSync(
    path.join(dataDirectory, 'extensions', 'proof.ext.ts'),
    'legacy extension',
  );
  fs.mkdirSync(path.join(dataDirectory, 'sessions', 'discord', 'main'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dataDirectory, 'sessions', 'discord', 'main', 'proof.jsonl'),
    'legacy transcript',
  );
  const skill = path.join(
    dataDirectory,
    'elpis-data',
    'skills',
    'resident-check',
    'SKILL.md',
  );
  const motorSkill = path.join(
    dataDirectory,
    'elpis-data',
    'motor-skills',
    'pixel-check',
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.mkdirSync(path.dirname(motorSkill), { recursive: true });
  fs.writeFileSync(
    skill,
    '---\nname: resident-check\ndescription: Resident check\n---\n\nCHECK\n',
  );
  fs.writeFileSync(
    motorSkill,
    '---\nname: pixel-check\ndescription: Pixel check\n---\n\nMOVE\n',
  );
  fs.writeFileSync(path.join(dataDirectory, 'unknown-work.txt'), 'inhabitant');
  const legacy = new DatabaseSync(path.join(dataDirectory, 'agent.db'));
  legacy.exec(
    "CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('kept')",
  );
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
    await assert.rejects(
      createElpisRuntime({
        loadConfigFile: () => config,
        fetchContextWindow: async () => config.llm.contextSize,
        loadExtensions: async () => {
          assert.equal(
            fs.existsSync(path.join(dataDirectory, 'agent.db')),
            false,
          );
          assert.equal(
            fs.existsSync(path.join(dataDirectory, 'extensions')),
            false,
          );
          assert.equal(
            fs.existsSync(path.join(dataDirectory, 'sessions')),
            false,
          );
          assert.equal(
            fs.readFileSync(
              path.join(layout.extensions, 'proof.ext.ts'),
              'utf8',
            ),
            'legacy extension',
          );
          assert.equal(
            fs.readFileSync(
              path.join(layout.sessions, 'discord', 'main', 'proof.jsonl'),
              'utf8',
            ),
            'legacy transcript',
          );
          assert.equal(
            fs.readFileSync(
              path.join(dataDirectory, 'unknown-work.txt'),
              'utf8',
            ),
            'inhabitant',
          );
          assert.equal(
            fs.existsSync(path.join(dataDirectory, 'elpis-data', 'skills')),
            false,
          );
          assert.equal(
            fs.existsSync(
              path.join(dataDirectory, 'elpis-data', 'motor-skills'),
            ),
            false,
          );
          const contextResources = new ContextResources({
            dataDirectory,
            bundledSkillsDirectory: null,
          });
          assert.deepEqual(
            contextResources.catalog().map(({ name }) => name),
            ['resident-check'],
          );
          const motorSkills = new MotorSkills({
            dataDirectory,
            bundledSkillsDirectory: null,
          });
          assert.deepEqual(motorSkills.catalog(), [
            { name: 'pixel-check', description: 'Pixel check' },
          ]);
          const migrated = new DatabaseSync(layout.database, {
            readOnly: true,
          });
          assert.equal(
            (
              migrated.prepare('SELECT value FROM proof').get() as {
                value: string;
              }
            ).value,
            'kept',
          );
          migrated.close();
          throw stop;
        },
      }),
      stop,
    );
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  }
});
