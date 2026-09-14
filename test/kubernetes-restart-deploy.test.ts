import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) =>
  fs.readFileSync(
    path.join(root, 'deploy/kubernetes/restart-broker', file),
    'utf8',
  );
const broker = parseAllDocuments(read('broker.yaml')).map((doc) => {
  assert.deepEqual(doc.errors, []);
  return doc.toJSON();
});
const harness = parse(read('harness-patch.yaml'));
const egress = parse(read('broker-egress-k3s.yaml'));

test('restart broker RBAC grants only namespaced Pod list and delete', () => {
  assert.equal(
    broker.some((doc) =>
      ['ClusterRole', 'ClusterRoleBinding'].includes(doc.kind),
    ),
    false,
  );
  const roles = broker.filter((doc) => doc.kind === 'Role');
  assert.equal(roles.length, 1);
  assert.deepEqual(roles[0].rules, [
    { apiGroups: [''], resources: ['pods'], verbs: ['list', 'delete'] },
  ]);
  const bindings = broker.filter((doc) => doc.kind === 'RoleBinding');
  assert.equal(bindings.length, 1);
  const account = broker.find((doc) => doc.kind === 'ServiceAccount');
  const pod = broker.find((doc) => doc.kind === 'Deployment').spec.template
    .spec;
  assert.equal(pod.serviceAccountName, account.metadata.name);
  assert.deepEqual(bindings[0].roleRef, {
    apiGroup: 'rbac.authorization.k8s.io',
    kind: 'Role',
    name: roles[0].metadata.name,
  });
  assert.deepEqual(bindings[0].subjects, [
    { kind: 'ServiceAccount', name: account.metadata.name },
  ]);
});

test('harness receives a restart endpoint without a Kubernetes service account token', () => {
  const pod = harness.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.serviceAccountName, undefined);
  const container = pod.containers[0];
  assert.deepEqual(container.env, [
    {
      name: 'ELPIS_RESTART_ENDPOINT',
      value: 'http://elpis-restart-broker:8080/v1/restart',
    },
  ]);
  assert.equal(container.imagePullPolicy, 'Always');
  assert.equal(harness.spec.strategy.rollingUpdate.maxUnavailable, 0);
});

test('broker Pod is non-root and read-only with no additional credential or host mounts', () => {
  const pod = broker.find((doc) => doc.kind === 'Deployment').spec.template
    .spec;
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.runAsUser, 10001);
  assert.equal(pod.containers.length, 1);
  const container = pod.containers[0];
  assert.deepEqual(container.securityContext, {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  });
  assert.deepEqual(container.command, [
    'node',
    '/opt/elpis/dist/k8s/restart-broker.js',
  ]);
  assert.equal(pod.volumes, undefined);
  assert.equal(container.volumeMounts, undefined);
  assert.equal(container.envFrom, undefined);
  assert.deepEqual(container.env, [
    {
      name: 'ELPIS_BROKER_NAMESPACE',
      valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } },
    },
    {
      name: 'NODE_EXTRA_CA_CERTS',
      value: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    },
  ]);
});

test('k3s egress example allows only its declared API address and port', () => {
  assert.deepEqual(egress.spec.policyTypes, ['Egress']);
  assert.deepEqual(egress.spec.egress, [
    {
      to: [{ ipBlock: { cidr: '10.43.0.1/32' } }],
      ports: [{ protocol: 'TCP', port: 443 }],
    },
  ]);
});
