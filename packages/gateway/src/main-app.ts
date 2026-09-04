import { CAPABILITIES } from '@elpis/gateway-protocol';
import { createGatewayBrowserApi } from './gateway-browser-api.js';
import {
  createGatewayHttpService,
  type GatewayListenAddress,
  type GatewayListenOptions,
} from './http-service.js';
import { createGatewayResidentControlApi } from './resident-control-api.js';
import { createGatewayResidentLinkAuditWriter } from './resident-link-audit.js';
import { GatewayResidentLinkRegistry } from './resident-link-registry.js';
import {
  openGatewayStore,
  type GatewayStore,
  type OpenGatewayStoreOptions,
} from './store.js';

export interface GatewayApplicationOptions extends Pick<
  OpenGatewayStoreOptions,
  'now' | 'randomBytes' | 'llmFetch' | 'llmDispatcher'
> {
  readonly dataDirectory: string;
  readonly publicRoot: string;
  readonly listen?: GatewayListenOptions;
}

export interface GatewayApplication {
  readonly store: GatewayStore;
  start(): Promise<GatewayListenAddress>;
  stop(): Promise<void>;
}

export function createGatewayApplication(
  options: GatewayApplicationOptions,
): GatewayApplication {
  const now = options.now ?? Date.now;
  const store = openGatewayStore(options.dataDirectory, {
    now,
    randomBytes: options.randomBytes,
    llmFetch: options.llmFetch,
    llmDispatcher: options.llmDispatcher,
  });
  let service: ReturnType<typeof createGatewayHttpService>;
  try {
    const linkRegistry = new GatewayResidentLinkRegistry({
      clock: {
        now,
        setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      supportedCapabilities: CAPABILITIES,
      audit: createGatewayResidentLinkAuditWriter(store),
    });
    service = createGatewayHttpService({
      publicRoot: options.publicRoot,
      store,
      api: createGatewayBrowserApi(store),
      residentControl: createGatewayResidentControlApi(store.credentials),
      residentCredentialStore: store.credentials,
      residentLinkRegistry: linkRegistry,
      llmProxy: store.llmProxy,
      llmNow: now,
      residentNow: now,
      listen: options.listen,
    });
  } catch (error) {
    store.close();
    throw error;
  }
  let closed = false;
  return Object.freeze({
    store,
    start: () => service.start(),
    async stop() {
      if (closed) return;
      closed = true;
      try {
        await service.stop();
      } finally {
        store.close();
      }
    },
  });
}
