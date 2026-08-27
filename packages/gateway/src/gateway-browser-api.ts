import {
  GatewayApiError,
  type BrowserApi,
  type BrowserApiReadRoute,
  type BrowserApiSetupMutationRoute,
  type JsonObject,
} from './browser-api.js';
import { parseCanonicalPublicOrigin } from './http-guards.js';
import type { GatewayStore } from './store.js';

function stateBody(store: GatewayStore): JsonObject {
  const config = store.config();
  const instances = store.instances().map((instance) => ({
    id: instance.id,
    displayName: instance.displayName,
    createdAt: instance.createdAt,
    updatedAt: instance.updatedAt,
    revokedAt: instance.revokedAt,
    activeCredentialId: instance.activeCredentialId,
    activeSince: instance.activeSince,
    lastUsedAt: instance.lastUsedAt,
  }));
  return {
    format: 'elpis-gateway-state-v1',
    setup: {
      complete: config.setupCompletedAt !== null,
      publicUrl: config.publicUrl,
      revision: config.revision,
    },
    instances,
  };
}

function candidatePublicUrl(body: JsonObject): string {
  try {
    const keys = Object.keys(body);
    if (keys.length !== 1 || keys[0] !== 'publicUrl')
      throw new Error('setup body has invalid keys');
    const value = body.publicUrl;
    if (typeof value !== 'string')
      throw new Error('publicUrl must be a string');
    const canonical = parseCanonicalPublicOrigin(value);
    if (value !== canonical)
      throw new Error('publicUrl must use its canonical spelling');
    return canonical;
  } catch {
    throw new GatewayApiError(400, 'invalid_request');
  }
}

/** Browser state and public-origin setup backed by one Gateway store. */
export function createGatewayBrowserApi(store: GatewayStore): BrowserApi {
  const stateRoute: BrowserApiReadRoute = {
    policy: 'read',
    handle: () => ({ status: 200, body: stateBody(store) }),
  };
  const setupRoute: BrowserApiSetupMutationRoute = {
    policy: 'setup-mutation',
    method: 'PUT',
    candidatePublicUrl,
    handle: (body) => {
      // The service invokes handlers only after authorizing against stored state.
      // That guard and this write are not one transaction; concurrent replacements
      // can race after their individual guards.
      const candidate = candidatePublicUrl(body);
      store.setPublicUrl(candidate);
      return { status: 200, body: stateBody(store) };
    },
  };

  return {
    // Path recognition does not depend on the method; the HTTP core owns 405s.
    match: (_method, pathname) => {
      if (pathname === '/api/v1/state') return stateRoute;
      if (pathname === '/api/v1/setup') return setupRoute;
      return null;
    },
  };
}
