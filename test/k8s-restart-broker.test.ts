import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRestartBrokerServer,
  patchHarnessDeployment,
  validateTaggedImage,
  loadBrokerConfig,
  type BrokerConfig,
} from '../src/k8s/restart-broker.js';

const config: BrokerConfig = {
  namespace: 'agent-a', deployment: 'elpis-harness', container: 'harness',
  image: 'ghcr.io/avafloww/elpis:latest', port: 8080,
  kubernetesApi: 'https://kubernetes.default.svc', tokenFile: '/unused',
};

test('broker config brackets an IPv6 Kubernetes API host', () => {
  const loaded = loadBrokerConfig({
    ELPIS_BROKER_NAMESPACE: 'agent-a',
    KUBERNETES_SERVICE_HOST: 'fd00::1',
    KUBERNETES_SERVICE_PORT_HTTPS: '6443',
  });
  assert.equal(loaded.kubernetesApi, 'https://[fd00::1]:6443');
});

test('broker accepts only explicit tagged image references', () => {
  assert.equal(validateTaggedImage('ghcr.io/avafloww/elpis:latest'), 'ghcr.io/avafloww/elpis:latest');
  assert.equal(validateTaggedImage('registry.example:5000/team/image'), 'registry.example:5000/team/image');
  assert.throws(() => validateTaggedImage('elpis:latest'), /explicit registry/);
  assert.throws(() => validateTaggedImage('ghcr.io/x/y@sha256:' + 'a'.repeat(64)), /tag, not a digest/);
});

test('broker patches only the configured deployment container and forces tag refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-token-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'kube-token\n');
  let seen: { url?: string; init?: RequestInit } = {};
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen = { url: String(input), init };
    return new Response('{}', { status: 200 });
  };
  await patchHarnessDeployment({ ...config, tokenFile }, fakeFetch as typeof fetch);
  assert.equal(seen.url, 'https://kubernetes.default.svc/apis/apps/v1/namespaces/agent-a/deployments/elpis-harness');
  const headers = new Headers(seen.init?.headers);
  assert.equal(headers.get('authorization'), 'Bearer kube-token');
  assert.equal(headers.get('content-type'), 'application/strategic-merge-patch+json');
  const body = JSON.parse(String(seen.init?.body));
  assert.deepEqual(body.spec.template.spec.containers[0], {
    name: 'harness', image: 'ghcr.io/avafloww/elpis:latest', imagePullPolicy: 'Always',
  });
  assert.equal(typeof body.spec.template.metadata.annotations['elpis.dev/restarted-at'], 'string');
});

test('broker HTTP surface accepts only one bounded restart shape', async () => {
  let patches = 0;
  const server = createRestartBrokerServer(config, { patchDeployment: async () => { patches += 1; } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/nope', { method: 'POST' })).status, 404);
    assert.equal((await fetch(base + '/v1/restart', { method: 'POST', body: '{}' })).status, 400);
    const accepted = await fetch(base + '/v1/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 1, reason: 'load extension' }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.equal(patches, 1);
    assert.equal((await fetch(base + '/v1/restart', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('broker rejects concurrent refreshes and hides backend error details', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const server = createRestartBrokerServer(config, { patchDeployment: async () => { await blocked; throw new Error('private Kubernetes detail'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}/v1/restart`;
  const first = fetch(url, { method: 'POST', body: JSON.stringify({ protocol: 1 }) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify({ protocol: 1 }) })).status, 409);
  release();
  const response = await first;
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private Kubernetes detail/);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
