import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareEpisodeMounts, withContainerTimeout } from '../bench/docker.js';

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

test('live Docker timeout removes the named container', { skip: !live }, async () => {
  const name = `elpisbench-timeout-test-${process.pid}`;
  const child = spawn('docker', ['run', '--rm', '--name', name, '--entrypoint', 'node', image, '-e', 'setInterval(() => {}, 1000)'], { stdio: ['pipe', 'pipe', 'pipe'] });
  await assert.rejects(withContainerTimeout(child, name, new Promise<never>(() => {}), 500), /episode timeout/);
  assert.throws(() => execFileSync('docker', ['container', 'inspect', name], { stdio: 'ignore' }));
});
