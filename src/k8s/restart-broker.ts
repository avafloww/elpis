import * as fs from 'node:fs';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';
const HARNESS_SELECTOR =
  'app.kubernetes.io/name=elpis,app.kubernetes.io/component=harness';
const HARNESS_REPLICA_SET_PREFIX = 'elpis-harness-';

export interface BrokerConfig {
  namespace: string;
  port: number;
  kubernetesApi: string;
  tokenFile: string;
}

export interface BrokerDeps {
  recreateHarnessPod(config: BrokerConfig): Promise<void>;
}

function requiredName(value: string, label: string): string {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value))
    throw new Error(`${label} is not a valid Kubernetes name`);
  return value;
}

interface PodMetadata {
  name?: unknown;
  uid?: unknown;
  labels?: Record<string, unknown>;
  deletionTimestamp?: unknown;
  ownerReferences?: {
    apiVersion?: unknown;
    kind?: unknown;
    name?: unknown;
    controller?: unknown;
  }[];
}

function harnessPodFromList(payload: unknown): { name: string; uid: string } {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length !== 1)
    throw new Error(
      `expected exactly one harness Pod, found ${Array.isArray(items) ? items.length : 0}`,
    );
  const metadata = (items[0] as { metadata?: PodMetadata })?.metadata;
  if (!metadata || metadata.deletionTimestamp != null)
    throw new Error('harness Pod is already terminating');
  if (
    metadata.labels?.['app.kubernetes.io/name'] !== 'elpis' ||
    metadata.labels?.['app.kubernetes.io/component'] !== 'harness'
  ) {
    throw new Error(
      'Kubernetes returned a Pod outside the fixed harness selector',
    );
  }
  const owner = metadata.ownerReferences?.find(
    (ref) => ref.controller === true,
  );
  if (
    owner?.apiVersion !== 'apps/v1' ||
    owner.kind !== 'ReplicaSet' ||
    typeof owner.name !== 'string' ||
    !owner.name.startsWith(HARNESS_REPLICA_SET_PREFIX)
  ) {
    throw new Error(
      'harness Pod is not controlled by the fixed elpis-harness Deployment',
    );
  }
  const name = requiredName(String(metadata.name ?? ''), 'Pod name');
  const uid = String(metadata.uid ?? '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(uid))
    throw new Error('Pod UID is invalid');
  return { name, uid };
}

export async function recreateHarnessPod(
  config: BrokerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const token = fs.readFileSync(config.tokenFile, 'utf8').trim();
  if (!token) throw new Error('Kubernetes service-account token is empty');
  const headers = { authorization: `Bearer ${token}` };
  const listUrl = `${config.kubernetesApi}/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods?labelSelector=${encodeURIComponent(HARNESS_SELECTOR)}`;
  const listResponse = await fetchImpl(listUrl, {
    headers: { ...headers, accept: 'application/json' },
    redirect: 'error',
  });
  if (!listResponse.ok) {
    await listResponse.body?.cancel();
    throw new Error(`Kubernetes Pod list returned HTTP ${listResponse.status}`);
  }
  const pod = harnessPodFromList(await listResponse.json());
  const deleteUrl = `${config.kubernetesApi}/api/v1/namespaces/${encodeURIComponent(config.namespace)}/pods/${encodeURIComponent(pod.name)}`;
  const deleteResponse = await fetchImpl(deleteUrl, {
    method: 'DELETE',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      gracePeriodSeconds: 1,
      preconditions: { uid: pod.uid },
    }),
    redirect: 'error',
  });
  await deleteResponse.body?.cancel();
  if (!deleteResponse.ok)
    throw new Error(
      `Kubernetes Pod deletion returned HTTP ${deleteResponse.status}`,
    );
}

async function readJson(
  request: http.IncomingMessage,
  maxBytes = 4096,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes)
      throw Object.assign(new Error('request body too large'), {
        statusCode: 413,
      });
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { statusCode: 400 });
  }
}

function send(
  response: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function validRestartRequest(
  value: unknown,
): value is { protocol: 1; at: string; reason: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  return (
    keys.length === 3 &&
    keys[0] === 'at' &&
    keys[1] === 'protocol' &&
    keys[2] === 'reason' &&
    body.protocol === 1 &&
    typeof body.at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(body.at) &&
    Number.isFinite(Date.parse(body.at)) &&
    (body.reason === null ||
      (typeof body.reason === 'string' && body.reason.length <= 1000))
  );
}

export function createRestartBrokerServer(
  config: BrokerConfig,
  deps: BrokerDeps = {
    recreateHarnessPod: (settings) => recreateHarnessPod(settings),
  },
): http.Server {
  let active = false;
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz')
      return send(response, 200, { ok: true });
    if (request.method !== 'POST' || request.url !== '/v1/restart')
      return send(response, 404, { ok: false, error: 'not found' });
    if (active)
      return send(response, 409, {
        ok: false,
        error: 'restart already in progress',
      });
    active = true;
    try {
      const body = await readJson(request);
      if (!validRestartRequest(body))
        return send(response, 400, {
          ok: false,
          error: 'invalid restart request',
        });
      await deps.recreateHarnessPod(config);
      console.info(
        `[restart-broker] accepted recreation of ${config.namespace}/elpis-harness`,
      );
      return send(response, 202, { ok: true });
    } catch (error) {
      const status =
        typeof (error as { statusCode?: unknown }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 502;
      console.error(
        `[restart-broker] request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return send(response, status, {
        ok: false,
        error: 'restart broker failed',
      });
    } finally {
      active = false;
    }
  });
}

export function loadBrokerConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrokerConfig {
  const namespace = requiredName(
    env.ELPIS_BROKER_NAMESPACE ??
      fs.readFileSync(`${SERVICE_ACCOUNT_DIR}/namespace`, 'utf8').trim(),
    'namespace',
  );
  const port = Number(env.ELPIS_BROKER_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('ELPIS_BROKER_PORT must be 1..65535');
  const host = env.KUBERNETES_SERVICE_HOST;
  const apiPort =
    env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT;
  if (!host || !apiPort)
    throw new Error('Kubernetes service environment is unavailable');
  const apiHost = host.includes(':') ? `[${host}]` : host;
  return {
    namespace,
    port,
    kubernetesApi: `https://${apiHost}:${apiPort}`,
    tokenFile: env.ELPIS_BROKER_TOKEN_FILE ?? `${SERVICE_ACCOUNT_DIR}/token`,
  };
}

async function main(): Promise<void> {
  const config = loadBrokerConfig();
  const server = createRestartBrokerServer(config);
  server.listen(config.port, '0.0.0.0', () =>
    console.info(
      `[restart-broker] listening on :${config.port} for ${config.namespace}/elpis-harness`,
    ),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
