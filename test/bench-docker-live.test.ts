import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parse as parseYaml } from 'yaml';
import { prepareEpisodeMounts, withContainerTimeout } from '../bench/docker.js';
import type { BenchConfig } from '../bench/config.js';
import { runScenario } from '../bench/runner.js';
import { TOOL_CONTRACT_VERSION } from '../src/llm/provenance.js';
import { ORDINARY_TEST_SCENARIO, RESTART_TEST_SCENARIO } from './bench-scenario-fixtures.js';

const live = process.env.ELPISBENCH_DOCKER_LIVE === '1';
const image = process.env.ELPISBENCH_IMAGE ?? 'elpisbench:latest';

test('live Docker boundary denies network/root writes/capabilities and applies deterministic time', { skip: !live }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpisbench-live-'));
  const clock = path.join(root, 'clock');
  prepareEpisodeMounts(path.join(root, 'work'), path.join(root, 'results'), clock, new Date('2026-01-02T03:04:05Z'));
  const uid = process.getuid?.() ?? 65532, gid = process.getgid?.() ?? 65532;
  const script = `
    const fs = require('node:fs');
    let rootReadonly = false;
    try { fs.writeFileSync('/elpisbench-probe', 'x'); } catch { rootReadonly = true; }
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const checks = {
      deterministicTime: new Date().toISOString().startsWith('2026-01-02T03:04:05.'),
      rootReadonly,
      capabilitiesDropped: /^CapEff:\\s+0000000000000000$/m.test(status),
      noNewPrivileges: /^NoNewPrivs:\\s+1$/m.test(status),
      networkDenied: false,
    };
    fetch('https://example.com').then(
      () => finish(),
      () => { checks.networkDenied = true; finish(); },
    );
    function finish() { console.log(JSON.stringify(checks)); if (!Object.values(checks).every(Boolean)) process.exitCode = 1; }
  `;
  try {
    const output = execFileSync('docker', [
      'run', '--rm', '--user', `${uid}:${gid}`, '--read-only', '--network', 'none', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
      '--mount', `type=bind,src=${clock},dst=/run/elpis-clock,readonly`,
      '--env', 'FAKETIME_TIMESTAMP_FILE=/run/elpis-clock', '--env', 'FAKETIME_NO_CACHE=1',
      '--env', 'FAKETIME_DONT_FAKE_MONOTONIC=1', '--entrypoint', 'node', image, '-e', script,
    ], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output.trim()), {
      deterministicTime: true, rootReadonly: true, capabilitiesDropped: true,
      noNewPrivileges: true, networkDenied: true,
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live oracle episode keeps every private artifact at 0700/0600', { skip: !live }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpisbench-private-live-'));
  const dataDirectory = path.join(root, 'data');
  const provider = { provider_type: 'openai-compatible' as const, model: 'oracle-unused', base_url: 'https://oracle.invalid/v1', api_key: 'unused', api: 'auto' as const };
  const config: BenchConfig = {
    version: 1, default_provider: 'oracle', generator_provider: 'oracle', providers: { oracle: provider },
    judges: [
      { id: 'a', provider: 'oracle', family: 'one', teacher_pool: true },
      { id: 'b', provider: 'oracle', family: 'two', teacher_pool: true },
      { id: 'c', provider: 'oracle', family: 'three', teacher_pool: false },
    ],
    image, concurrency: 1, allow_private_input: false, data_directory: dataDirectory,
  };
  const scenario = ORDINARY_TEST_SCENARIO;
  try {
    const record = await runScenario(config, scenario, 'oracle', { oracle: true });
    assert.equal(Object.values(record.gates).every(Boolean), true);
    const episodeNames = fs.readdirSync(path.join(dataDirectory, 'episodes'));
    assert.equal(episodeNames.length, 1);
    const episodeRoot = path.join(dataDirectory, 'episodes', episodeNames[0]);
    const work = path.join(episodeRoot, 'work');
    const results = path.join(episodeRoot, 'results');
    assert.equal(fs.existsSync(path.join(work, 'agent.db')), true);
    const db = new DatabaseSync(path.join(work, 'agent.db'), { readOnly: true });
    try {
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      assert.ok(version.user_version >= 11);
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map((row) => String((row as { name: string }).name));
      assert.ok(tables.includes('mind_items'));
      assert.ok(tables.includes('scheduled_tasks'));
      assert.ok(tables.includes('channels'));
    } finally { db.close(); }
    const sessionDir = path.join(work, 'sessions', 'discord', 'main');
    assert.ok(fs.readdirSync(sessionDir).some((name) => name.endsWith('.jsonl')));
    const runtimeConfig = parseYaml(fs.readFileSync(path.join(results, 'runtime-config.yaml'), 'utf8')) as {
      paths: { data_directory: string }; console: { enabled: boolean }; fleet: { enabled: boolean };
    };
    assert.equal(runtimeConfig.paths.data_directory, '/home/agent/data');
    assert.equal(runtimeConfig.console.enabled, false);
    assert.equal(runtimeConfig.fleet.enabled, false);
    assert.ok(record.provenance);
    assert.match(record.provenance.configDigest, /^[a-f0-9]{64}$/);
    assert.equal(
      record.provenance.configDigest,
      createHash('sha256').update(fs.readFileSync(path.join(results, 'runtime-config.yaml'))).digest('hex'),
    );
    assert.match(record.provenance.dataSnapshotDigest, /^[a-f0-9]{64}$/);
    assert.ok(record.provenance.dbSchemaVersion >= 11);
    assert.equal(record.provenance.toolContractVersion, TOOL_CONTRACT_VERSION);
    assert.equal(record.provenance.promptDigest, record.provenance.promptDigests[0]);
    assert.ok(record.provenance.promptDigests.length >= 1);
    assert.equal(record.provenance.ingressDigests.length, 1);
    assert.equal(record.provenance.llm.model, 'elpisbench-oracle');
    assert.equal(record.provenance.llm.contextSize, 262144);
    assert.equal(record.provenance.adapterVersions.discord, 'deterministic-discord-v1');
    const leakedCandidateFiles: string[] = [];
    const hiddenMarkers = [scenario.title, scenario.expected.outcome].map((marker) => Buffer.from(marker));
    const scanCandidateFiles = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) scanCandidateFiles(file);
        else if (entry.isFile()) {
          const bytes = fs.readFileSync(file);
          if (hiddenMarkers.some((marker) => bytes.indexOf(marker) >= 0)) leakedCandidateFiles.push(path.relative(work, file));
        }
      }
    };
    scanCandidateFiles(work);
    assert.deepEqual(leakedCandidateFiles, []);
    assert.deepEqual(fs.readdirSync(results).sort(), ['record.json', 'runtime-config.yaml']);
    const containerSource = fs.readFileSync(path.join(process.cwd(), 'bench', 'container-main.ts'), 'utf8');
    assert.doesNotMatch(containerSource, /buildTestAgent|test\/helpers/);
    const wrong: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name); const mode = fs.statSync(file).mode & 0o777;
        if (entry.isDirectory()) { if (mode !== 0o700) wrong.push(`${mode.toString(8)} ${file}`); walk(file); }
        else if (mode !== 0o600) wrong.push(`${mode.toString(8)} ${file}`);
      }
    };
    walk(dataDirectory);
    assert.deepEqual(wrong, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live production runtime preserves state across a fresh container restart', { skip: !live }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpisbench-restart-live-'));
  const dataDirectory = path.join(root, 'data');
  const provider = { provider_type: 'openai-compatible' as const, model: 'oracle-unused', base_url: 'https://oracle.invalid/v1', api_key: 'unused', api: 'auto' as const };
  const config: BenchConfig = {
    version: 1, default_provider: 'oracle', generator_provider: 'oracle', providers: { oracle: provider },
    judges: [
      { id: 'a', provider: 'oracle', family: 'one', teacher_pool: true },
      { id: 'b', provider: 'oracle', family: 'two', teacher_pool: true },
      { id: 'c', provider: 'oracle', family: 'three', teacher_pool: false },
    ],
    image, concurrency: 1, allow_private_input: false, data_directory: dataDirectory,
  };
  try {
    const record = await runScenario(config, RESTART_TEST_SCENARIO, 'oracle', { oracle: true });
    assert.equal(Object.values(record.gates).every(Boolean), true);
    const restarts = record.events.filter((event) => event.kind === 'restart');
    assert.ok(restarts.some((event) => event.data?.phase === 'replace'));
    assert.ok(restarts.some((event) => event.data?.phase === 'resume'));
    assert.ok(record.provenance);
    assert.equal(record.provenance.ingressDigests.length, 2);
    assert.ok(record.provenance.promptDigests.length >= 2);
    assert.equal(record.provenance.promptDigest, record.provenance.promptDigests[0]);
    const [episode] = fs.readdirSync(path.join(dataDirectory, 'episodes'));
    const work = path.join(dataDirectory, 'episodes', episode, 'work');
    assert.equal(fs.readFileSync(path.join(work, 'stage-one.txt'), 'utf8'), 'stage one\n');
    assert.equal(fs.readFileSync(path.join(work, 'stage-two.txt'), 'utf8'), 'stage two\n');
    assert.equal(fs.existsSync(path.join(work, 'agent.db')), true);
    const sessionDir = path.join(work, 'sessions', 'discord', 'main');
    assert.ok(fs.readdirSync(sessionDir).some((name) => name.endsWith('.jsonl')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('live Docker timeout removes the named container', { skip: !live }, async () => {
  const name = `elpisbench-timeout-test-${process.pid}`;
  const child = spawn('docker', ['run', '--rm', '--name', name, '--entrypoint', 'node', image, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await assert.rejects(withContainerTimeout(child, name, new Promise<never>(() => {}), 500), /episode timeout/);
  assert.throws(() => execFileSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }));
});
