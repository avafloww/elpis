import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRestartBrokerServer,
  recreateHarnessPod,
  loadBrokerConfig,
  type BrokerConfig,
} from '../src/k8s/restart-broker.js';

const config: BrokerConfig = {
  namespace: 'agent-a', port: 8080,
  kubernetesApi: 'https://kubernetes.default.svc', tokenFile: '/unused',
};

const harnessPod = {
  metadata: {
    name: 'elpis-harness-7d9f8d7b58-abcde',
    uid: '6e0b60c9-4b90-4dd0-8e36-8495f81322d4',
    labels: { 'app.kubernetes.io/name': 'elpis', 'app.kubernetes.io/component': 'harness' },
    ownerReferences: [{ apiVersion: 'apps/v1', kind: 'ReplicaSet', name: 'elpis-harness-7d9f8d7b58', controller: true }],
  },
};

test('broker config brackets an IPv6 Kubernetes API host', () => {
  const loaded = loadBrokerConfig({
    ELPIS_BROKER_NAMESPACE: 'agent-a',
    KUBERNETES_SERVICE_HOST: 'fd00::1',
    KUBERNETES_SERVICE_PORT_HTTPS: '6443',
  });
  assert.equal(loaded.kubernetesApi, 'https://[fd00::1]:6443');
});

test('broker lists one fixed-label harness Pod and deletes it with a UID precondition', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-token-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'kube-token\n');
  const seen: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), init });
    return seen.length === 1
      ? new Response(JSON.stringify({ items: [harnessPod] }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('{}', { status: 200 });
  };
  await recreateHarnessPod({ ...config, tokenFile }, fakeFetch as typeof fetch);
  assert.equal(seen.length, 2);
  assert.equal(seen[0]!.url, 'https://kubernetes.default.svc/api/v1/namespaces/agent-a/pods?labelSelector=app.kubernetes.io%2Fname%3Delpis%2Capp.kubernetes.io%2Fcomponent%3Dharness');
  assert.equal(seen[0]!.init?.method, undefined);
  assert.equal(new Headers(seen[0]!.init?.headers).get('authorization'), 'Bearer kube-token');
  assert.equal(seen[1]!.url, 'https://kubernetes.default.svc/api/v1/namespaces/agent-a/pods/elpis-harness-7d9f8d7b58-abcde');
  assert.equal(seen[1]!.init?.method, 'DELETE');
  assert.deepEqual(JSON.parse(String(seen[1]!.init?.body)), {
    apiVersion: 'v1', kind: 'DeleteOptions', gracePeriodSeconds: 1,
    preconditions: { uid: '6e0b60c9-4b90-4dd0-8e36-8495f81322d4' },
  });
});

test('broker rejects ambiguous, terminating, foreign, and non-Deployment Pods', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-token-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'token');
  const run = (items: unknown[]) => recreateHarnessPod({ ...config, tokenFile }, (async () => new Response(JSON.stringify({ items }), { status: 200 })) as typeof fetch);
  await assert.rejects(run([]), /exactly one harness Pod/);
  await assert.rejects(run([harnessPod, harnessPod]), /found 2/);
  await assert.rejects(run([{ ...harnessPod, metadata: { ...harnessPod.metadata, deletionTimestamp: 'now' } }]), /already terminating/);
  await assert.rejects(run([{ ...harnessPod, metadata: { ...harnessPod.metadata, labels: { 'app.kubernetes.io/name': 'other', 'app.kubernetes.io/component': 'harness' } } }]), /outside the fixed harness selector/);
  await assert.rejects(run([{ ...harnessPod, metadata: { ...harnessPod.metadata, ownerReferences: [] } }]), /not controlled by the fixed/);
});

test('broker HTTP surface accepts only one bounded restart shape', async () => {
  let recreations = 0;
  const server = createRestartBrokerServer(config, { recreateHarnessPod: async () => { recreations += 1; } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    assert.equal((await fetch(base + '/nope', { method: 'POST' })).status, 404);
    assert.equal((await fetch(base + '/v1/restart', { method: 'POST', body: '{}' })).status, 400);
    const at = '2026-08-17T23:00:00.000Z';
    assert.equal((await fetch(base + '/v1/restart', {
      method: 'POST', body: JSON.stringify({ protocol: 1, at, reason: null, image: 'evil/image' }),
    })).status, 400);
    assert.equal(recreations, 0);
    const accepted = await fetch(base + '/v1/restart', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ protocol: 1, at, reason: 'load extension' }),
    });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.equal(recreations, 1);
    assert.equal((await fetch(base + '/v1/restart', { method: 'POST', body: 'x'.repeat(5000) })).status, 413);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('broker rejects concurrent recreations and hides backend error details', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const server = createRestartBrokerServer(config, { recreateHarnessPod: async () => { await blocked; throw new Error('private Kubernetes detail'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const url = `http://127.0.0.1:${address.port}/v1/restart`;
  const request = { protocol: 1, at: '2026-08-17T23:00:00.000Z', reason: null };
  const first = fetch(url, { method: 'POST', body: JSON.stringify(request) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await fetch(url, { method: 'POST', body: JSON.stringify(request) })).status, 409);
  release();
  const response = await first;
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private Kubernetes detail/);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});
