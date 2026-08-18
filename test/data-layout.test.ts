import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ELPIS_DATA_GITIGNORE, ensureElpisDataScaffold, migrateDataLayout, resolveDataLayout } from '../src/store/data-layout.js';

function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-data-layout-')); }

test('resolveDataLayout keeps inhabitant root separate from harness state and config', () => {
  const root = '/agent';
  const layout = resolveDataLayout(root);
  assert.equal(layout.dataDirectory, root);
  assert.equal(layout.root, '/agent/elpis-data');
  assert.equal(layout.database, '/agent/elpis-data/elpis.db');
  assert.equal(layout.sessions, '/agent/elpis-data/sessions');
  assert.equal(layout.extensions, '/agent/elpis-data/config/extensions');
  assert.equal(layout.wordlists, '/agent/elpis-data/config/wordlists');
  assert.equal(layout.policyDenials, '/agent/elpis-data/policy-denials');
  assert.equal(layout.playwrightCli, '/agent/elpis-data/playwright-cli');
});

test('ensureElpisDataScaffold owns exact gitignore and repairs drift without touching corpus', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'SOUL.md'), 'inhabitant');
  const first = ensureElpisDataScaffold(root);
  assert.equal(first.gitignoreRepaired, true);
  assert.equal(fs.readFileSync(first.layout.gitignore, 'utf8'), ELPIS_DATA_GITIGNORE);
  assert.equal(fs.statSync(first.layout.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(first.layout.config).mode & 0o777, 0o700);
  assert.equal(fs.statSync(first.layout.gitignore).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(root, 'SOUL.md'), 'utf8'), 'inhabitant');

  fs.writeFileSync(first.layout.gitignore, '*\n');
  fs.chmodSync(first.layout.gitignore, 0o600);
  const repaired = ensureElpisDataScaffold(root);
  assert.equal(repaired.gitignoreRepaired, true);
  assert.equal(fs.readFileSync(first.layout.gitignore, 'utf8'), ELPIS_DATA_GITIGNORE);
  assert.equal(fs.statSync(first.layout.gitignore).mode & 0o777, 0o644);

  const stable = ensureElpisDataScaffold(root);
  assert.equal(stable.gitignoreRepaired, false);
});

test('fresh layout scaffolds without manufacturing a migration journal', () => {
  const root = tmpDir();
  const result = migrateDataLayout(root);
  assert.deepEqual(result.moved, []);
  assert.equal(fs.existsSync(result.layout.gitignore), true);
  assert.equal(fs.existsSync(result.layout.migrationJournal), false);
});

test('migrateDataLayout moves known state, preserves unknown corpus, and rewrites embedded paths', () => {
  const root = tmpDir();
  const oldBg = path.join(root, 'bg');
  const oldMotor = path.join(root, 'motor');
  fs.mkdirSync(oldBg);
  fs.writeFileSync(path.join(oldBg, 'job.log'), 'log');
  fs.writeFileSync(path.join(oldBg, 'registry.json'), JSON.stringify([{ id: 'j1', logFile: path.join(oldBg, 'job.log') }]));
  fs.mkdirSync(path.join(oldMotor, 'traces'), { recursive: true });
  fs.writeFileSync(path.join(oldMotor, 'traces', 't.jsonl'), `${JSON.stringify({ frame: path.join(oldMotor, 'traces', 'f.png') })}\n`);
  fs.mkdirSync(path.join(root, 'sessions', 'discord'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sessions', 'discord', 'x'), 'session');
  fs.mkdirSync(path.join(root, 'extensions'));
  fs.writeFileSync(path.join(root, 'extensions', 'x.ext.ts'), 'extension');
  fs.mkdirSync(path.join(root, 'books'));
  fs.writeFileSync(path.join(root, 'books', 'mine.md'), 'inhabitant');

  const db = new DatabaseSync(path.join(root, 'agent.db'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES (\'kept\');');
  db.close();

  const result = migrateDataLayout(root, { now: () => new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(result.moved.slice(0, 4), ['database', 'sessions', 'extensions', 'bg']);
  assert.ok(result.moved.includes('motor'));
  assert.equal(fs.existsSync(path.join(root, 'agent.db')), false);
  const migrated = new DatabaseSync(result.layout.database, { readOnly: true });
  assert.equal((migrated.prepare('SELECT value FROM proof').get() as { value: string }).value, 'kept');
  migrated.close();
  assert.equal(fs.readFileSync(path.join(result.layout.sessions, 'discord', 'x'), 'utf8'), 'session');
  assert.equal(fs.readFileSync(path.join(result.layout.extensions, 'x.ext.ts'), 'utf8'), 'extension');
  assert.equal(fs.readFileSync(path.join(root, 'books', 'mine.md'), 'utf8'), 'inhabitant');
  const registry = JSON.parse(fs.readFileSync(path.join(result.layout.bg, 'registry.json'), 'utf8')) as Array<{ logFile: string }>;
  assert.equal(registry[0].logFile, path.join(result.layout.bg, 'job.log'));
  const trace = JSON.parse(fs.readFileSync(path.join(result.layout.motor, 'traces', 't.jsonl'), 'utf8').trim()) as { frame: string };
  assert.equal(trace.frame, path.join(result.layout.motor, 'traces', 'f.png'));
  const journal = JSON.parse(fs.readFileSync(result.layout.migrationJournal, 'utf8')) as { status: string; completed: string[] };
  assert.equal(journal.status, 'complete');
  assert.ok(journal.completed.includes('rewrite-motor-paths'));

  const journalBefore = fs.readFileSync(result.layout.migrationJournal, 'utf8');
  const again = migrateDataLayout(root, { now: () => new Date('2026-01-01T00:00:01.000Z') });
  assert.deepEqual(again.moved, []);
  assert.equal(fs.readFileSync(result.layout.migrationJournal, 'utf8'), journalBefore, 'stable boot does not churn migration state');
});

test('nested gitignore tracks inhabitant config and ignores runtime state', () => {
  const root = tmpDir();
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: root }).status, 0);
  const { layout } = ensureElpisDataScaffold(root);
  fs.mkdirSync(layout.extensions, { recursive: true });
  fs.writeFileSync(path.join(layout.extensions, 'x.ext.ts'), 'export default {}');
  fs.writeFileSync(layout.database, 'runtime');
  assert.equal(spawnSync('git', ['check-ignore', '-q', layout.database], { cwd: root }).status, 0);
  assert.equal(spawnSync('git', ['check-ignore', '-q', layout.gitignore], { cwd: root }).status, 1);
  assert.equal(spawnSync('git', ['check-ignore', '-q', path.join(layout.extensions, 'x.ext.ts')], { cwd: root }).status, 1);
});

test('migrateDataLayout blocks before mutation when a live process references process-coupled state', () => {
  const root = tmpDir();
  const browser = path.join(root, 'browser');
  fs.mkdirSync(browser);
  fs.writeFileSync(path.join(browser, 'state'), 'kept');
  assert.throws(() => migrateDataLayout(root, {
    processCommands: () => [`node cliDaemon.js --config=${path.join(browser, 'config.json')}`],
  }), /blocked by live processes using legacy browser state/);
  assert.equal(fs.readFileSync(path.join(browser, 'state'), 'utf8'), 'kept');
  assert.equal(fs.existsSync(resolveDataLayout(root).gitignore), false);
});

test('migrateDataLayout resumes remaining paths when database is already at the target', () => {
  const root = tmpDir();
  const layout = resolveDataLayout(root);
  fs.mkdirSync(layout.root, { recursive: true });
  const db = new DatabaseSync(layout.database);
  db.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES (\'target\')');
  db.close();
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.writeFileSync(path.join(root, 'sessions', 'tail.jsonl'), 'tail');

  const result = migrateDataLayout(root);
  assert.deepEqual(result.moved, ['sessions']);
  assert.equal(fs.readFileSync(path.join(layout.sessions, 'tail.jsonl'), 'utf8'), 'tail');
  const kept = new DatabaseSync(layout.database, { readOnly: true });
  assert.equal((kept.prepare('SELECT value FROM proof').get() as { value: string }).value, 'target');
  kept.close();
});

test('migrateDataLayout refuses a legacy WAL database still open elsewhere', () => {
  const root = tmpDir();
  const legacy = path.join(root, 'agent.db');
  const holder = new DatabaseSync(legacy);
  holder.exec('PRAGMA journal_mode=WAL; CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES (\'held\')');
  assert.throws(() => migrateDataLayout(root), /locked|busy|collapse/i);
  assert.equal(fs.existsSync(legacy), true);
  assert.equal(fs.existsSync(resolveDataLayout(root).database), false);
  holder.close();
});

test('migrateDataLayout fatals before mutation when old and new database both exist', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'agent.db'), 'old');
  const layout = resolveDataLayout(root);
  fs.mkdirSync(layout.root, { recursive: true });
  fs.writeFileSync(layout.database, 'new');
  assert.throws(() => migrateDataLayout(root), /data layout conflict for database/);
  assert.equal(fs.readFileSync(path.join(root, 'agent.db'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(layout.database, 'utf8'), 'new');
  assert.equal(fs.existsSync(layout.gitignore), false);
});

test('migrateDataLayout fatals all conflicts before moving any earlier item', () => {
  const root = tmpDir();
  const layout = resolveDataLayout(root);
  const db = new DatabaseSync(path.join(root, 'agent.db'));
  db.exec('CREATE TABLE proof(value TEXT)');
  db.close();
  fs.mkdirSync(path.join(root, 'sessions'));
  fs.mkdirSync(layout.sessions, { recursive: true });
  assert.throws(() => migrateDataLayout(root), /data layout conflict for sessions/);
  assert.equal(fs.existsSync(path.join(root, 'agent.db')), true);
  assert.equal(fs.existsSync(layout.database), false);
});
