import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const broker = fs.readFileSync(
  path.join(root, 'deploy/kubernetes/restart-broker/broker.yaml'),
  'utf8',
);
const harness = fs.readFileSync(
  path.join(root, 'deploy/kubernetes/restart-broker/harness-patch.yaml'),
  'utf8',
);
const egress = fs.readFileSync(
  path.join(root, 'deploy/kubernetes/restart-broker/broker-egress-k3s.yaml'),
  'utf8',
);
const docs = fs.readFileSync(path.join(root, 'docs/kubernetes.md'), 'utf8');

test('Kubernetes broker RBAC can only list and delete Pods', () => {
  assert.doesNotMatch(broker, /kind: ClusterRole/);
  const role = broker.split('---')[1]!;
  assert.match(role, /apiGroups: \[""\]/);
  assert.match(role, /resources: \["pods"\]/);
  assert.match(role, /verbs: \["list", "delete"\]/);
  assert.doesNotMatch(
    role,
    /deployments|secrets|pods\/exec|patch|create|update|get/,
  );
  assert.match(broker, /serviceAccountName: elpis-restart-broker/);
});

test('harness has no Kubernetes token and only receives the narrow broker endpoint', () => {
  assert.match(harness, /automountServiceAccountToken: false/);
  assert.match(harness, /ELPIS_RESTART_ENDPOINT/);
  assert.match(harness, /http:\/\/elpis-restart-broker:8080\/v1\/restart/);
  assert.match(harness, /imagePullPolicy: Always/);
  assert.match(harness, /maxUnavailable: 0/);
  assert.doesNotMatch(harness, /serviceAccountName:/);
});

test('broker runtime is non-root, read-only, and exposes only health/restart HTTP', () => {
  assert.match(broker, /runAsUser: 10001/);
  assert.match(broker, /readOnlyRootFilesystem: true/);
  assert.match(broker, /allowPrivilegeEscalation: false/);
  assert.match(broker, /drop: \["ALL"\]/);
  assert.match(broker, /dist\/k8s\/restart-broker\.js/);
  assert.doesNotMatch(broker, /api[_-]?key|provider.*secret|docker\.sock/i);
});

test('k3s API egress example is explicit and docs require verification', () => {
  assert.match(egress, /cidr: 10\.43\.0\.1\/32/);
  assert.match(egress, /port: 443/);
  assert.match(docs, /verify .*clusterIP/is);
  assert.match(docs, /does not claim the egress boundary exists yet/);
  assert.match(docs, /never a ClusterRole/);
  assert.match(docs, /denial of service/);
  assert.match(docs, /cannot create code, alter an image or command/);
  assert.match(
    docs,
    /prevents the restart channel.*different image.*cluster-level code execution/s,
  );
});
