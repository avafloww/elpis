import * as fs from 'node:fs';
import * as http from 'node:http';
import { pathToFileURL } from 'node:url';

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

export interface BrokerConfig {
  namespace: string;
  deployment: string;
  container: string;
  image: string;
  port: number;
  kubernetesApi: string;
  tokenFile: string;
}

export interface BrokerDeps {
  patchDeployment(config: BrokerConfig): Promise<void>;
}

function requiredName(value: string, label: string): string {
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(value)) throw new Error(`${label} is not a valid Kubernetes name`);
  return value;
}

export function validateTaggedImage(image: string): string {
  if (image.includes('@')) throw new Error('broker image must be configured as a tag, not a digest');
  const slash = image.indexOf('/');
  if (slash <= 0) throw new Error('broker image must include an explicit registry');
  const remainder = image.slice(slash + 1);
  const lastSlash = remainder.lastIndexOf('/');
  const colon = remainder.lastIndexOf(':');
  const tag = colon > lastSlash ? remainder.slice(colon + 1) : 'latest';
  if (!tag || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) throw new Error('invalid tagged image reference');
  return image;
}

export async function patchHarnessDeployment(config: BrokerConfig, fetchImpl: typeof fetch = fetch): Promise<void> {
  const token = fs.readFileSync(config.tokenFile, 'utf8').trim();
  if (!token) throw new Error('Kubernetes service-account token is empty');
  const endpoint = `${config.kubernetesApi}/apis/apps/v1/namespaces/${encodeURIComponent(config.namespace)}/deployments/${encodeURIComponent(config.deployment)}`;
  const response = await fetchImpl(endpoint, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/strategic-merge-patch+json',
    },
    body: JSON.stringify({
      spec: {
        template: {
          metadata: { annotations: { 'elpis.dev/restarted-at': new Date().toISOString() } },
          spec: { containers: [{ name: config.container, image: config.image, imagePullPolicy: 'Always' }] },
        },
      },
    }),
    redirect: 'error',
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Kubernetes deployment patch returned HTTP ${response.status}`);
}

async function readJson(request: http.IncomingMessage, maxBytes = 4096): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw Object.assign(new Error('request body too large'), { statusCode: 413 });
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { statusCode: 400 }); }
}

function send(response: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function createRestartBrokerServer(config: BrokerConfig, deps: BrokerDeps = {
  patchDeployment: settings => patchHarnessDeployment(settings),
}): http.Server {
  let active = false;
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, { ok: true });
    if (request.method !== 'POST' || request.url !== '/v1/restart') return send(response, 404, { ok: false, error: 'not found' });
    if (active) return send(response, 409, { ok: false, error: 'restart already in progress' });
    active = true;
    try {
      const body = await readJson(request) as { protocol?: unknown; reason?: unknown };
      if (body.protocol !== 1 || !(body.reason === null || body.reason === undefined || (typeof body.reason === 'string' && body.reason.length <= 1000))) {
        return send(response, 400, { ok: false, error: 'invalid restart request' });
      }
      await deps.patchDeployment(config);
      console.info(`[restart-broker] accepted refresh of ${config.namespace}/${config.deployment}`);
      return send(response, 202, { ok: true });
    } catch (error) {
      const status = typeof (error as { statusCode?: unknown }).statusCode === 'number' ? (error as { statusCode: number }).statusCode : 502;
      console.error(`[restart-broker] request failed: ${error instanceof Error ? error.message : String(error)}`);
      return send(response, status, { ok: false, error: 'restart broker failed' });
    } finally {
      active = false;
    }
  });
}

export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const namespace = requiredName(env.ELPIS_BROKER_NAMESPACE ?? fs.readFileSync(`${SERVICE_ACCOUNT_DIR}/namespace`, 'utf8').trim(), 'namespace');
  const deployment = requiredName(env.ELPIS_BROKER_DEPLOYMENT ?? 'elpis-harness', 'deployment');
  const container = requiredName(env.ELPIS_BROKER_CONTAINER ?? 'harness', 'container');
  const image = validateTaggedImage(env.ELPIS_BROKER_IMAGE ?? 'ghcr.io/avafloww/elpis:latest');
  const port = Number(env.ELPIS_BROKER_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ELPIS_BROKER_PORT must be 1..65535');
  const host = env.KUBERNETES_SERVICE_HOST;
  const apiPort = env.KUBERNETES_SERVICE_PORT_HTTPS ?? env.KUBERNETES_SERVICE_PORT;
  if (!host || !apiPort) throw new Error('Kubernetes service environment is unavailable');
  const apiHost = host.includes(':') ? `[${host}]` : host;
  return {
    namespace,
    deployment,
    container,
    image,
    port,
    kubernetesApi: `https://${apiHost}:${apiPort}`,
    tokenFile: env.ELPIS_BROKER_TOKEN_FILE ?? `${SERVICE_ACCOUNT_DIR}/token`,
  };
}

async function main(): Promise<void> {
  const config = loadBrokerConfig();
  const server = createRestartBrokerServer(config);
  server.listen(config.port, '0.0.0.0', () => console.info(`[restart-broker] listening on :${config.port} for ${config.namespace}/${config.deployment}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
