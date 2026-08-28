import {
  GatewayApiError,
  type BrowserApi,
  type BrowserApiMutationRoute,
  type BrowserApiReadRoute,
  type BrowserApiSetupMutationRoute,
  type JsonObject,
} from './browser-api.js';
import { GatewayCredentialError } from './credential-store.js';
import { isCredentialId } from './credentials.js';
import { parseCanonicalPublicOrigin } from './http-guards.js';
import type { GatewayStore } from './store.js';

const ENROLLMENT_GRANTS_PATH = '/api/v1/enrollment-grants';
const ENROLLMENT_GRANT_TTL_MS = 600_000;
const MAX_BOOTSTRAP_YAML_BYTES = 4096;
const TOKEN_SIZE_SENTINEL = `ege1.${'A'.repeat(22)}.${'A'.repeat(43)}`;

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

function requireEmptyBody(body: JsonObject): void {
  if (Reflect.ownKeys(body).length !== 0)
    throw new GatewayApiError(400, 'invalid_request');
}

function bootstrapYaml(publicUrl: string, token: string): string {
  const yaml =
    `dashboard:
  remote:
    url: ${JSON.stringify(publicUrl)}
` +
    `    enrollment_token: ${JSON.stringify(token)}
`;
  if (Buffer.byteLength(yaml, 'utf8') > MAX_BOOTSTRAP_YAML_BYTES)
    throw new Error('bootstrap YAML exceeds its wire bound');
  return yaml;
}

/** Browser state, setup, and enrollment grants backed by one Gateway store. */
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
  const createGrantRoute: BrowserApiMutationRoute = {
    policy: 'mutation',
    method: 'POST',
    requiresSetup: true,
    handle: (body, publicUrl) => {
      requireEmptyBody(body);
      if (publicUrl === null) throw new GatewayApiError(409, 'setup_required');
      // Check the bound before creating the one-time secret. Enrollment tokens have
      // a fixed wire length, so the sentinel and generated YAML have equal lengths.
      bootstrapYaml(publicUrl, TOKEN_SIZE_SENTINEL);
      const grant = store.credentials.createEnrollmentGrant(
        ENROLLMENT_GRANT_TTL_MS,
      );
      const yaml = bootstrapYaml(publicUrl, grant.token);
      return {
        status: 201,
        body: {
          format: 'elpis-gateway-enrollment-v1',
          grant: { id: grant.id, expiresAt: grant.expiresAt },
          bootstrapYaml: yaml,
        },
      };
    },
  };

  const revokeGrantRoute = (id: string): BrowserApiMutationRoute => ({
    policy: 'mutation',
    method: 'DELETE',
    requiresSetup: true,
    handle: (body) => {
      requireEmptyBody(body);
      if (!isCredentialId(id)) throw new GatewayApiError(404, 'not_found');
      try {
        const grant = store.credentials.revokeEnrollmentGrant(id);
        return {
          status: 200,
          body: {
            format: 'elpis-gateway-enrollment-revoke-v1',
            grant: { id: grant.id, replayed: grant.replayed },
          },
        };
      } catch (error) {
        if (error instanceof GatewayCredentialError && error.code === 'invalid')
          throw new GatewayApiError(404, 'not_found');
        throw error;
      }
    },
  });

  return {
    // Path recognition does not depend on the method; the HTTP core owns 405s.
    match: (_method, pathname) => {
      if (pathname === '/api/v1/state') return stateRoute;
      if (pathname === '/api/v1/setup') return setupRoute;
      if (pathname === ENROLLMENT_GRANTS_PATH) return createGrantRoute;
      const revokePrefix = ENROLLMENT_GRANTS_PATH + '/';
      if (pathname.startsWith(revokePrefix)) {
        const id = pathname.slice(revokePrefix.length);
        if (isCredentialId(id)) return revokeGrantRoute(id);
      }
      return null;
    },
  };
}
