import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  encodeCredentialVerifier,
  formatNodeBearerAuthorization,
  parseNodeCredential,
  type ResidentControlBody,
} from '@elpis/gateway-protocol';
import {
  createGatewayHttpService,
  createGatewayResidentControlApi,
  openGatewayStore,
  type ResidentControlApi,
} from '../packages/gateway/src/index.js';
import { openDatabase } from '../src/store/db.js';
import { createGatewayResidentStore } from '../src/store/gateway-resident.js';

const PREFIX = 'ELPIS_GATEWAY_BOOT_WITNESS ';
const MAX_CAPTURE_BYTES = 32 * 1024;
const DEADLINE_MS = 8_000;
const FIXTURE = fileURLToPath(
  new URL('./fixtures/gateway-boot-child.ts', import.meta.url),
);
type WitnessEvent = Record<string, unknown> & { event: string; pid: number };
type Capture = {
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  events: WitnessEvent[];
  overflowed: boolean;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function spawnWitness(environment: Record<string, string>): Capture {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', FIXTURE], {
    cwd: path.resolve(path.dirname(FIXTURE), '../..'),
    env: {
      HOME: process.env.HOME ?? '',
      PATH: process.env.PATH ?? '',
      TMPDIR: process.env.TMPDIR ?? '',
      ...environment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const capture: Capture = {
    child,
    stdout: '',
    stderr: '',
    events: [],
    overflowed: false,
    exit: Promise.resolve({ code: null, signal: null }),
  };
  let pending = '';
  const append = (kind: 'stdout' | 'stderr', chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    capture[kind] += text;
    if (
      Buffer.byteLength(capture.stdout) + Buffer.byteLength(capture.stderr) >
      MAX_CAPTURE_BYTES
    ) {
      capture.overflowed = true;
      child.kill('SIGKILL');
    }
    if (kind !== 'stdout') return;
    pending += text;
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.startsWith(PREFIX)) continue;
      try {
        capture.events.push(
          JSON.parse(line.slice(PREFIX.length)) as WitnessEvent,
        );
      } catch {
        child.kill('SIGKILL');
      }
    }
  };
  child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
  capture.exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return capture;
}

async function boundedExit(
  capture: Capture,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      capture.exit,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          capture.child.kill('SIGKILL');
          reject(new Error('fresh child process exceeded deadline'));
        }, DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitEvent(
  capture: Capture,
  name: string,
): Promise<WitnessEvent> {
  const deadline = Date.now() + DEADLINE_MS;
  while (Date.now() < deadline) {
    const event = capture.events.find((value) => value.event === name);
    if (event) return event;
    if (capture.child.exitCode !== null)
      throw new Error('child exited before ' + name);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  capture.child.kill('SIGKILL');
  throw new Error('timed out waiting for ' + name);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function configText(dataDirectory: string, consolePort: number): string {
  return [
    'log_level: info',
    'llm:',
    '  api_key: fixture-llm-key',
    '  base_url: https://llm.invalid/v1',
    '  model: fixture-model',
    'discord:',
    '  bot_token: MTIzNDU2Nzg5MDEyMzQ1Njc4.fixture.token',
    '  guilds:',
    '    - id: "1"',
    '      slug: home',
    '      channels:',
    '        "2": direct',
    'dashboard:',
    '  local:',
    '    enabled: true',
    '    mcp_enabled: false',
    '    host: 127.0.0.1',
    '    port: ' + consolePort,
    '  remote: null',
    'paths:',
    '  data_directory: ' + JSON.stringify(dataDirectory),
    '',
  ].join('\n');
}

function readResident(dataDirectory: string) {
  const database = openDatabase(dataDirectory);
  try {
    const store = createGatewayResidentStore(database);
    return { snapshot: store.read(), nodeToken: store.activeNodeToken() };
  } finally {
    database.close();
  }
}

/**
 * Fresh-process means two separately spawned Node runtimes (different PIDs),
 * not module-cache resets. Process one creates and activates the credential;
 * after the listener closes, process two reopens that DB and starts Console.
 */
test('fresh resident processes enroll over Gateway HTTP and keep local console independent', async (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-boot-process-'),
  );
  const gatewayDirectory = path.join(root, 'gateway');
  const residentDirectory = path.join(root, 'resident');
  const publicRoot = path.join(root, 'gateway-public');
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway witness');
  const consolePort = await freePort();
  const configPath = path.join(root, 'config.yaml');
  const rawConfig = configText(residentDirectory, consolePort);
  fs.writeFileSync(configPath, rawConfig, { encoding: 'utf8', mode: 0o600 });

  const gateway = openGatewayStore(gatewayDirectory);
  const grant = gateway.credentials.createEnrollmentGrant();
  const grantSecret = grant.token.split('.')[2];
  assert.ok(grantSecret);
  const control = createGatewayResidentControlApi(gateway.credentials);
  let wireBody = '';
  const residentControl: ResidentControlApi = {
    authorizeProposal: (value) => control.authorizeProposal(value),
    activationAuthorization: (value) => control.activationAuthorization(value),
    enroll(body: ResidentControlBody) {
      wireBody = Buffer.from(body).toString('utf8');
      return control.enroll(body);
    },
    proposeRotation: (authorization, body) =>
      control.proposeRotation(authorization, body),
    activateRotation: (token, body) => control.activateRotation(token, body),
  };
  const service = createGatewayHttpService({
    publicRoot,
    store: gateway,
    residentControl,
    listen: { host: '127.0.0.1', port: 0 },
    shutdownGraceMs: 250,
  });
  let stopped = false;
  let liveChild: Capture | null = null;
  t.after(async () => {
    if (liveChild && liveChild.child.exitCode === null) {
      liveChild.child.kill('SIGKILL');
      await liveChild.exit.catch(() => undefined);
    }
    if (!stopped) await service.stop();
    gateway.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const address = await service.start();
  const origin = 'http://127.0.0.1:' + address.port;
  gateway.setPublicUrl(origin);
  const common = {
    ELPIS_WITNESS_CONFIG: configPath,
    ELPIS_WITNESS_DATA_DIR: residentDirectory,
    ELPIS_WITNESS_GATEWAY_ORIGIN: origin,
  };
  const first = spawnWitness({
    ...common,
    ELPIS_WITNESS_MODE: 'enroll',
    ELPIS_WITNESS_GRANT: grant.token,
  });
  liveChild = first;
  assert.deepEqual(
    await boundedExit(first),
    { code: 0, signal: null },
    first.stderr,
  );
  liveChild = null;
  assert.equal(first.overflowed, false);
  const enrolled = first.events.find((value) => value.event === 'enrolled');
  assert.ok(enrolled);
  assert.notEqual(enrolled.pid, process.pid);
  assert.deepEqual(enrolled.status, { code: 'enrolled' });
  assert.deepEqual(enrolled.transport, {
    fetchCalls: 1,
    requestBodyBytes: Buffer.byteLength(wireBody),
    authorizationPresent: false,
  });
  assert.equal((enrolled.resident as { phase: string }).phase, 'active');
  assert.deepEqual(enrolled.config, {
    dataDirectoryName: 'resident',
    localConsole: {
      enabled: true,
      mcpEnabled: false,
      host: '127.0.0.1',
      port: consolePort,
    },
    remoteConfigured: false,
    logLevel: 'info',
  });

  const resident = readResident(residentDirectory);
  const parsedNode = parseNodeCredential(resident.nodeToken);
  assert.ok(parsedNode);
  const nodeSecret = resident.nodeToken.split('.')[2];
  assert.ok(nodeSecret);
  const verifier = encodeCredentialVerifier(parsedNode.verifier);
  assert.equal(wireBody.includes(grant.token), true);
  assert.equal(wireBody.includes(verifier), true);
  assert.deepEqual(gateway.credentials.authenticateNode(resident.nodeToken), {
    instanceId: resident.snapshot.instanceId,
    credentialId: resident.snapshot.activeCredentialId,
  });
  const gatewayProjection = {
    config: gateway.config(),
    instances: gateway.instances(),
    audit: gateway.audit(),
  };
  assert.equal(gatewayProjection.instances.length, 1);
  assert.equal(
    gatewayProjection.instances[0]?.activeCredentialId,
    resident.snapshot.activeCredentialId,
  );

  await service.stop();
  stopped = true;
  await assert.rejects(
    fetch(origin + '/readyz', {
      signal: AbortSignal.timeout(500),
      headers: { connection: 'close' },
    }),
  );

  const second = spawnWitness({ ...common, ELPIS_WITNESS_MODE: 'restart' });
  liveChild = second;
  const ready = await waitEvent(second, 'console_ready');
  assert.notEqual(ready.pid, process.pid);
  assert.notEqual(ready.pid, enrolled.pid);
  assert.deepEqual(ready.status, { code: 'active' });
  assert.deepEqual(ready.transport, { fetchCalls: 0 });
  assert.deepEqual(ready.resident, resident.snapshot);
  assert.deepEqual(ready.console, {
    started: true,
    host: '127.0.0.1',
    port: consolePort,
  });
  const consoleResponse = await fetch('http://127.0.0.1:' + consolePort + '/', {
    headers: { connection: 'close' },
    signal: AbortSignal.timeout(1_000),
  });
  assert.equal(consoleResponse.status, 200);
  assert.match(await consoleResponse.text(), /<!doctype html>/i);

  second.child.stdin.end('shutdown\n');
  assert.deepEqual(
    await boundedExit(second),
    { code: 0, signal: null },
    second.stderr,
  );
  liveChild = null;
  assert.equal(second.overflowed, false);
  assert.deepEqual(second.events.at(-1), {
    event: 'stopped',
    pid: ready.pid,
    boundedShutdown: true,
  });

  const publicCaptures = [
    rawConfig,
    first.stdout,
    first.stderr,
    second.stdout,
    second.stderr,
    JSON.stringify(gatewayProjection),
    JSON.stringify(resident.snapshot),
  ].join('\n');
  const authorization = formatNodeBearerAuthorization(resident.nodeToken);
  for (const secret of [
    grant.token,
    grantSecret,
    resident.nodeToken,
    nodeSecret,
    verifier,
    authorization,
    wireBody,
  ])
    assert.equal(publicCaptures.includes(secret), false);
  assert.equal(publicCaptures.includes('"grantToken"'), false);
  assert.equal(publicCaptures.includes('"credentialVerifier"'), false);
  assert.equal(publicCaptures.includes('Authorization:'), false);
  assert.ok(
    Buffer.byteLength(first.stdout) + Buffer.byteLength(first.stderr) <
      MAX_CAPTURE_BYTES,
  );
  assert.ok(
    Buffer.byteLength(second.stdout) + Buffer.byteLength(second.stderr) <
      MAX_CAPTURE_BYTES,
  );
  assert.ok(first.stderr.trim().split('\n').length <= 2);
  assert.ok(second.stderr.trim().split('\n').length <= 3);
});
