#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from '@elpis/gateway-protocol';
import { createGatewayBrowserApi } from './gateway-browser-api.js';
import { createGatewayHttpService } from './http-service.js';
import { createGatewayResidentControlApi } from './resident-control-api.js';
import { createGatewayResidentLinkAuditWriter } from './resident-link-audit.js';
import { GatewayResidentLinkRegistry } from './resident-link-registry.js';
import { openGatewayStore } from './store.js';

function envPort(value: string | undefined): number {
  if (value === undefined) return 8790;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value))
    throw new Error('invalid listen port');
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65535)
    throw new Error('invalid listen port');
  return port;
}

const dataDirectory = path.resolve(
  process.env.ELPIS_GATEWAY_DATA_DIR ??
    path.join(process.cwd(), 'gateway-data'),
);
const publicRoot = fileURLToPath(new URL('./public/', import.meta.url));
let store: ReturnType<typeof openGatewayStore> | null = null;
let service: ReturnType<typeof createGatewayHttpService> | null = null;
let stopping = false;

async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await service?.stop();
  } catch {
    exitCode = 1;
  }
  try {
    store?.close();
  } catch {
    exitCode = 1;
  }
  process.exitCode = exitCode;
}

async function main(): Promise<void> {
  store = openGatewayStore(dataDirectory);
  const linkRegistry = new GatewayResidentLinkRegistry({
    clock: {
      now: Date.now,
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    supportedCapabilities: CAPABILITIES,
    audit: createGatewayResidentLinkAuditWriter(store),
  });
  service = createGatewayHttpService({
    publicRoot,
    store,
    api: createGatewayBrowserApi(store),
    residentControl: createGatewayResidentControlApi(store.credentials),
    residentCredentialStore: store.credentials,
    residentLinkRegistry: linkRegistry,
    listen: {
      host: process.env.ELPIS_GATEWAY_LISTEN_HOST ?? '127.0.0.1',
      port: envPort(process.env.ELPIS_GATEWAY_LISTEN_PORT),
    },
  });
  const address = await service.start();
  process.stdout.write(
    `elpis-gateway listening on ${address.host}:${address.port}\n`,
  );
  process.once('SIGTERM', () => void shutdown(0));
  process.once('SIGINT', () => void shutdown(0));
}

main().catch(async () => {
  process.stderr.write('elpis-gateway failed to start\n');
  await shutdown(1);
});
