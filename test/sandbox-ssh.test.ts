// Unit tests for elpis.ssh (src/sandbox/ssh.ts).
//
// No live ssh / no network: the ControlPath + argv construction is split into
// PURE exported helpers, and the registry's exec is exercised against a FAKE
// `sshBinary` (a script that echoes a fixed string) so we verify the spawn
// shape, result contract, and handle dedup without ever opening a socket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createSshRegistry,
  controlPath,
  controlOpts,
  execArgv,
  closeArgv,
  slugifyHost,
  SSH_MAX_BUFFER,
} from '../src/sandbox/ssh.js';

// ─── pure helpers: control-path derivation ──────────────────────────────────

test('slugifyHost: collapses non-alnum, lowercases, trims edges', () => {
  assert.equal(slugifyHost('ai.example.com'), 'ai-example-com');
  assert.equal(slugifyHost('AI.EXAMPLE.COM'), 'ai-example-com');
  assert.equal(slugifyHost('user@host.example.com'), 'user-host-example-com');
  assert.equal(slugifyHost('--weird--'), 'weird');
  assert.equal(slugifyHost(''), 'host'); // empty → sentinel fallback
  assert.equal(slugifyHost('   '), 'host');
});

test('controlPath: stable for host+user, distinct otherwise', () => {
  const dir = '/tmp/socks';
  // Same host + same user → identical socket (so two handles share ONE master).
  assert.equal(
    controlPath('ai.example.com', { socketDir: dir, user: 'agent' }),
    controlPath('ai.example.com', { socketDir: dir, user: 'agent' }),
  );
  // Different user → different socket.
  assert.notEqual(
    controlPath('ai.example.com', { socketDir: dir, user: 'agent' }),
    controlPath('ai.example.com', { socketDir: dir, user: 'root' }),
  );
  // No user → shorter prefix.
  assert.equal(
    controlPath('ai.example.com', { socketDir: dir }),
    path.join(dir, 'elpis-ssh-ai-example-com'),
  );
  // With user → user- prefixed.
  assert.equal(
    controlPath('ai.example.com', { socketDir: dir, user: 'root' }),
    path.join(dir, 'elpis-ssh-root-ai-example-com'),
  );
  // Different host → different socket.
  assert.notEqual(
    controlPath('hostA', { socketDir: dir }),
    controlPath('hostB', { socketDir: dir }),
  );
});

// ─── pure helpers: argv construction ────────────────────────────────────────

test('controlOpts: emits ControlMaster/ControlPath/ControlPersist/BatchMode', () => {
  const opts = controlOpts('/tmp/cp', '10m');
  // Pairs of -o / value, in order.
  assert.deepEqual(opts, [
    '-o',
    'ControlMaster=auto',
    '-o',
    'ControlPath=/tmp/cp',
    '-o',
    'ControlPersist=10m',
    '-o',
    'BatchMode=yes',
  ]);
});

test('execArgv: full argv for an exec, no shell, BatchMode, target -- cmd', () => {
  const argv = execArgv('ssh', 'ai.example.com', 'uptime', {
    controlPath: '/tmp/cp',
    persist: '10m',
  });
  assert.equal(argv[0], 'ssh');
  assert.deepEqual(argv.slice(1, 9), [
    '-o',
    'ControlMaster=auto',
    '-o',
    'ControlPath=/tmp/cp',
    '-o',
    'ControlPersist=10m',
    '-o',
    'BatchMode=yes',
  ]);
  assert.equal(argv[9], 'ai.example.com'); // target form (no user)
  assert.equal(argv[10], '--'); // separator before the remote command
  assert.equal(argv[11], 'uptime'); // the command, NOT re-split by a shell
});

test('execArgv: user@host target form when a user is given', () => {
  const argv = execArgv('ssh', 'ai.example.com', 'ls', {
    controlPath: '/tmp/cp',
    persist: '10m',
    user: 'root',
  });
  assert.equal(argv[9], 'root@ai.example.com');
  assert.equal(argv[10], '--');
  assert.equal(argv[11], 'ls');
});

test('execArgv: a command with shell metacharacters is passed as a SINGLE arg', () => {
  // The whole cmd string is one argv element — argv-array spawn never shells it,
  // so `rm -rf /` or `; whoami` cannot break out of the remote command slot.
  const argv = execArgv('ssh', 'h', 'echo $(whoami); rm -rf /', {
    controlPath: '/tmp/cp',
    persist: '10m',
  });
  assert.equal(argv.at(-1), 'echo $(whoami); rm -rf /');
  assert.equal(argv.length, 12); // binary + 8 control opts + target + -- + cmd
});

test('closeArgv: ssh -O exit -o ControlPath target', () => {
  assert.deepEqual(closeArgv('ssh', 'ai.example.com', '/tmp/cp'), [
    'ssh',
    '-O',
    'exit',
    '-o',
    'ControlPath=/tmp/cp',
    'ai.example.com',
  ]);
  assert.deepEqual(closeArgv('ssh', 'ai.example.com', '/tmp/cp', 'root'), [
    'ssh',
    '-O',
    'exit',
    '-o',
    'ControlPath=/tmp/cp',
    'root@ai.example.com',
  ]);
});

// ─── registry: handle dedup + exec result shape (fake binary, no network) ───

/** Write a fake `ssh` shim that ignores its args and prints a fixed payload,
 * so exec resolves a real {stdout, stderr, code} without a socket. */
function fakeSshBin(payload: string, exitCode = 0): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-bin-'));
  const bin = path.join(dir, 'ssh');
  // `#!/bin/sh` + echo: argv is ignored, stdout gets the payload, stderr empty.
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho ${JSON.stringify(payload)}\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return bin;
}

test('registry.open: dedupes handles by host+user (shares one master)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reg-'));
  const reg = createSshRegistry(dir, { socketDir: dir, sshBinary: 'ssh' });
  const a = reg.open('ai.example.com');
  const b = reg.open('ai.example.com');
  const c = reg.open('ai.example.com', { user: 'root' });
  assert.equal(a, b, 'same host (no user) → same handle object');
  assert.notEqual(a, c, 'different user → distinct handle');
  assert.equal(a.controlPath, b.controlPath);
  assert.notEqual(a.controlPath, c.controlPath);
});

test('exec: resolves {stdout, stderr, code, signal, host} via the fake binary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reg-'));
  const bin = fakeSshBin('hello-from-remote');
  const reg = createSshRegistry(dir, { sshBinary: bin });
  const h = reg.open('ai.example.com');
  const r = await h.exec('anything');
  assert.equal(r.host, 'ai.example.com');
  assert.match(r.stdout, /hello-from-remote/);
  assert.equal(r.stderr, '');
  assert.equal(r.code, 0);
  assert.equal(r.signal, null);
});

test('exec: nonzero remote exit surfaces in .code (never throws)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reg-'));
  const bin = fakeSshBin('oops', 42);
  const reg = createSshRegistry(dir, { sshBinary: bin });
  const r = await reg.open('h').exec('false-ish');
  assert.equal(r.code, 42);
  // Must NOT throw — the contract is "check .code yourself".
  assert.match(r.stdout, /oops/);
});

test('exec: a missing ssh binary resolves code 127 with a stderr note (no throw)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reg-'));
  const reg = createSshRegistry(dir, {
    sshBinary: '/nonexistent/ssh-binary-xyz',
  });
  const r = await reg.open('h').exec('uptime');
  assert.equal(r.code, 127);
  assert.match(r.stderr, /ssh spawn failed/);
  assert.equal(r.stdout, '');
});

test('exec: respects a per-call timeout (resolves with TIMEOUT signal)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reg-'));
  // A fake ssh that sleeps longer than the timeout.
  const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-bin-'));
  const bin = path.join(sdir, 'ssh');
  fs.writeFileSync(bin, `#!/bin/sh\nsleep 5\n`, { mode: 0o755 });
  const reg = createSshRegistry(dir, { sshBinary: bin });
  const r = await reg.open('h').exec('slow', { timeout: 150 });
  assert.equal(r.signal, 'TIMEOUT');
  assert.equal(r.code, null);
});

test('close: resolves even with a no-op fake binary', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reg-'));
  const bin = fakeSshBin('x');
  const reg = createSshRegistry(dir, { sshBinary: bin });
  const h = reg.open('h');
  const r = await h.close();
  assert.equal(r.ok, true);
  assert.match(r.note, /closed for h/);
});

test('dispose: closes all live handles without throwing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-reg-'));
  const bin = fakeSshBin('x');
  const reg = createSshRegistry(dir, { sshBinary: bin });
  reg.open('h1');
  reg.open('h2');
  reg.open('h3', { user: 'root' });
  // Should not throw and should resolve.
  await reg.dispose();
  // After dispose, open mints fresh handles (the live map was cleared).
  const h = reg.open('h1');
  assert.ok(h);
});

// ─── constants ──────────────────────────────────────────────────────────────

test('SSH_MAX_BUFFER matches elpis.sh (32MB) so a runaway remote cannot OOM', () => {
  assert.equal(SSH_MAX_BUFFER, 32 * 1024 * 1024);
});

test('registry: creates the socket dir if missing', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-ssh-'));
  const sock = path.join(base, 'nested', 'sockets');
  createSshRegistry('/unused', { socketDir: sock, sshBinary: '/bin/true' });
  assert.ok(fs.existsSync(sock), 'socket dir should be created');
  fs.rmSync(base, { recursive: true, force: true });
});
