import * as path from 'node:path';
import {
  createGatewayEnrollmentController,
  type GatewayEnrollmentFetch,
} from '../../src/gateway-enrollment.js';
import {
  loadConfigFile,
  ensureDataDirectory,
  type Config,
} from '../../src/config.js';
import { ConsoleHub } from '../../src/console/hub.js';
import { createConsoleServer } from '../../src/console/server.js';
import { SecretRegistry } from '../../src/lib/secrets.js';
import { openDatabase } from '../../src/store/db.js';
import { createGatewayResidentStore } from '../../src/store/gateway-resident.js';

const PREFIX = 'ELPIS_GATEWAY_BOOT_WITNESS ';
/** The durable production endpoint remains canonical HTTPS. The injected fetch
 * seam carries the same request to the parent-owned plain loopback listener; it
 * does not disable TLS validation or alter production endpoint validation. */
const RESIDENT_ENDPOINT = 'https://gateway.witness.invalid';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('missing witness input');
  return value;
}

function configProjection(config: Config): Record<string, unknown> {
  return {
    dataDirectoryName: path.basename(config.paths.dataDirectory),
    localConsole: {
      enabled: config.dashboard.local.enabled,
      mcpEnabled: config.dashboard.local.mcpEnabled,
      host: config.dashboard.local.host,
      port: config.dashboard.local.port,
    },
    remoteConfigured: config.dashboard.remote !== null,
    logLevel: config.logLevel,
  };
}

function emit(value: Record<string, unknown>): void {
  process.stdout.write(PREFIX + JSON.stringify(value) + '\n');
}

async function enroll(
  config: Config,
  origin: string,
  grant: string,
): Promise<void> {
  ensureDataDirectory(config.paths.dataDirectory);
  const database = openDatabase(config.paths.dataDirectory);
  try {
    const store = createGatewayResidentStore(database);
    let fetchCalls = 0;
    let requestBodyBytes = 0;
    let authorizationPresent = false;
    const enrollmentFetch: GatewayEnrollmentFetch = async (input, init) => {
      fetchCalls += 1;
      requestBodyBytes = Buffer.byteLength(String(init.body ?? ''), 'utf8');
      const headers = new Headers(init.headers);
      authorizationPresent = headers.has('authorization');
      const target = new URL(input);
      if (target.origin !== RESIDENT_ENDPOINT)
        throw new Error('unexpected resident endpoint');
      const response = await fetch(origin + target.pathname, init);
      const bytes = await response.arrayBuffer();
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    const controller = createGatewayEnrollmentController({
      store,
      secrets: new SecretRegistry(),
      remote: { url: RESIDENT_ENDPOINT, enrollmentToken: grant },
      displayName: 'Fresh process resident',
      fetch: enrollmentFetch,
      timeoutMs: 5_000,
    });
    const status = await controller.start();
    config.logger.info('gateway enrollment:', status.code);
    emit({
      event: 'enrolled',
      pid: process.pid,
      config: configProjection(config),
      status,
      resident: store.read(),
      transport: { fetchCalls, requestBodyBytes, authorizationPresent },
    });
    if (status.code !== 'enrolled') process.exitCode = 2;
  } finally {
    database.close();
  }
}

async function restarted(config: Config, origin: string): Promise<void> {
  ensureDataDirectory(config.paths.dataDirectory);
  const database = openDatabase(config.paths.dataDirectory);
  const store = createGatewayResidentStore(database);
  let fetchCalls = 0;
  const controller = createGatewayEnrollmentController({
    store,
    secrets: new SecretRegistry(),
    remote: { url: RESIDENT_ENDPOINT, enrollmentToken: null },
    displayName: 'Fresh process resident',
    fetch: async (input, init) => {
      fetchCalls += 1;
      return fetch(origin + new URL(input).pathname, init);
    },
    timeoutMs: 1_000,
  });
  let consoleServer: ReturnType<typeof createConsoleServer> | null = null;
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    controller.stop();
    consoleServer?.stop();
    database.close();
  };
  try {
    const status = await controller.start();
    config.logger.info('gateway enrollment after restart:', status.code);
    const hub = new ConsoleHub([]);
    consoleServer = createConsoleServer(config, hub);
    await consoleServer.start();
    emit({
      event: 'console_ready',
      pid: process.pid,
      config: configProjection(config),
      status,
      resident: store.read(),
      transport: { fetchCalls },
      console: {
        started: true,
        host: config.console.host,
        port: config.console.port,
      },
    });
    if (status.code !== 'active' || fetchCalls !== 0) {
      process.exitCode = 3;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('bounded shutdown input expired')),
        5_000,
      );
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      process.stdin.resume();
    });
    stop();
    emit({ event: 'stopped', pid: process.pid, boundedShutdown: true });
  } finally {
    stop();
  }
}

async function main(): Promise<void> {
  const mode = required('ELPIS_WITNESS_MODE');
  const config = loadConfigFile(required('ELPIS_WITNESS_CONFIG'));
  const expectedDirectory = path.resolve(required('ELPIS_WITNESS_DATA_DIR'));
  if (config.paths.dataDirectory !== expectedDirectory)
    throw new Error('config data directory mismatch');
  const origin = required('ELPIS_WITNESS_GATEWAY_ORIGIN');
  if (mode === 'enroll') {
    await enroll(config, origin, required('ELPIS_WITNESS_GRANT'));
    return;
  }
  if (mode === 'restart') {
    await restarted(config, origin);
    return;
  }
  throw new Error('invalid witness mode');
}

main().catch(() => {
  process.stderr.write('fresh-process witness failed\n');
  process.exitCode = 1;
});
