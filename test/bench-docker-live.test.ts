import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareEpisodeMounts, withContainerTimeout } from '../bench/docker.js';
import type { BenchConfig } from '../bench/config.js';
import { runScenario } from '../bench/runner.js';
import { LOCKED_SCENARIOS } from '../bench/scenarios.js';

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
      '--mount', `type=bind,src=${clock},dst=/episode/clock,readonly`,
      '--env', 'FAKETIME_TIMESTAMP_FILE=/episode/clock', '--env', 'FAKETIME_NO_CACHE=1',
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
  const scenario = LOCKED_SCENARIOS.find((item) => item.id === 'tool/read-edit-verify')!;
  try {
    await runScenario(config, scenario, 'oracle', { oracle: true });
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

test('live Docker timeout removes the named container', { skip: !live }, async () => {
  const name = `elpisbench-timeout-test-${process.pid}`;
  const child = spawn('docker', ['run', '--rm', '--name', name, '--entrypoint', 'node', image, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await assert.rejects(withContainerTimeout(child, name, new Promise<never>(() => {}), 500), /episode timeout/);
  assert.throws(() => execFileSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }));
});
