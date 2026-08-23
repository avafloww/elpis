import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const SESSION_ID = 'sec-AAAAAAAAAAAAAAAAAAAAAA';
const RESOURCE_NAME = `elpis-secretary-${createHash('sha256')
  .update(SESSION_ID)
  .digest('hex')
  .slice(0, 12)}`;
import {
  KubectlSecretaryRuntime,
  type KubectlResult,
} from '../src/secretary/kubernetes.js';
import type { SecretarySession } from '../src/secretary/session.js';

function safeTemplate() {
  return {
    apiVersion: 'v1',
    kind: 'PodTemplate',
    template: {
      metadata: { labels: { fixed: 'yes' }, annotations: { fixed: 'yes' } },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: 'Never',
        activeDeadlineSeconds: 3600,
        securityContext: {
          runAsNonRoot: true,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        volumes: [{ name: 'scratch', emptyDir: {} }],
        containers: [
          {
            name: 'secretary',
            image: `example.invalid/elpis@sha256:${'a'.repeat(64)}`,
            command: ['node', '/opt/elpis/dist/secretary-main.js'],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1', memory: '1Gi' },
            },
            env: [{ name: 'FIXED_MODE', value: 'secretary' }],
            volumeMounts: [{ name: 'scratch', mountPath: '/tmp' }],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
          },
        ],
      },
    },
  };
}

function session(patch: Partial<SecretarySession> = {}): SecretarySession {
  return {
    id: SESSION_ID,
    hintMindId: 'elm-secretary001',
    status: 'ready',
    modelRef: 'p/model',
    runtime: 'kubernetes',
    podName: RESOURCE_NAME,
    podUid: 'uid-1',
    createdAt: 1,
    updatedAt: 1,
    lastError: null,
    ...patch,
  };
}

function fixture(template = safeTemplate()) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const replies: KubectlResult[] = [];
  const exec = async (
    args: string[],
    stdin?: string,
  ): Promise<KubectlResult> => {
    calls.push({ args, stdin });
    if (replies.length > 0) return replies.shift()!;
    if (args.includes('podtemplate'))
      return { code: 0, stdout: JSON.stringify(template), stderr: '' };
    if (args.includes('secret') && args.includes('delete'))
      return { code: 0, stdout: '', stderr: '' };
    if (args.includes('create') && stdin) {
      const value = JSON.parse(stdin);
      if (value.kind === 'Secret')
        return { code: 0, stdout: JSON.stringify(value), stderr: '' };
      return {
        code: 0,
        stdout: JSON.stringify({
          ...value,
          metadata: { ...value.metadata, uid: 'uid-1' },
        }),
        stderr: '',
      };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const runtime = new KubectlSecretaryRuntime({
    namespace: 'residence',
    template: 'elpis-secretary',
    container: 'secretary',
    brokerUrl: 'https://broker.example.com',
    context: 'fixed-context',
    exec,
  });
  return { runtime, calls, replies };
}

test('provision clones only the fixed template and injects token through one Secret', async () => {
  const f = fixture();
  const receipt = await f.runtime.provision({
    sessionId: SESSION_ID,
    hintMindId: 'elm-secretary001',
    modelRef: 'p/model',
    token: 't'.repeat(43),
  });
  assert.deepEqual(receipt, {
    podName: RESOURCE_NAME,
    podUid: 'uid-1',
  });
  assert.equal(f.calls.length, 3);
  for (const call of f.calls)
    assert.deepEqual(call.args.slice(0, 4), [
      '--context',
      'fixed-context',
      '--namespace',
      'residence',
    ]);
  const secret = JSON.parse(f.calls[1].stdin!);
  const pod = JSON.parse(f.calls[2].stdin!);
  assert.equal(secret.kind, 'Secret');
  assert.deepEqual(secret.stringData, {
    token: 't'.repeat(43),
    broker_url: 'https://broker.example.com',
    session_id: SESSION_ID,
  });
  for (const raw of ['t'.repeat(43), 'https://broker.example.com', SESSION_ID])
    assert.equal(
      JSON.stringify(pod).includes(raw),
      false,
      'raw capability values never enter Pod spec',
    );
  assert.equal(
    pod.spec.containers[0].image,
    `example.invalid/elpis@sha256:${'a'.repeat(64)}`,
  );
  assert.deepEqual(pod.spec.containers[0].command, [
    'node',
    '/opt/elpis/dist/secretary-main.js',
  ]);
  assert.deepEqual(pod.spec.containers[0].resources, {
    requests: { cpu: '100m', memory: '128Mi' },
    limits: { cpu: '1', memory: '1Gi' },
  });
  assert.equal(pod.spec.automountServiceAccountToken, false);
  const tokenEnv = pod.spec.containers[0].env.find(
    (env: any) => env.name === 'ELPIS_SECRETARY_TOKEN',
  );
  assert.deepEqual(tokenEnv.valueFrom.secretKeyRef, {
    name: RESOURCE_NAME,
    key: 'token',
  });
  assert.equal(Object.hasOwn(pod.spec, 'serviceAccountName'), false);
});

test('unsafe templates fail before Secret or Pod creation', async () => {
  for (const mutate of [
    (t: any) => {
      t.template.spec.automountServiceAccountToken = true;
    },
    (t: any) => {
      t.template.spec.serviceAccountName = 'default';
    },
    (t: any) => {
      t.template.spec.imagePullSecrets = [{ name: 'registry' }];
    },
    (t: any) => {
      t.template.spec.hostNetwork = true;
    },
    (t: any) => {
      t.template.spec.initContainers = [{ name: 'init' }];
    },
    (t: any) => {
      delete t.template.spec.containers[0].resources.requests;
    },
    (t: any) => {
      t.template.spec.containers[0].envFrom = [
        { secretRef: { name: 'provider' } },
      ];
    },
    (t: any) => {
      t.template.spec.containers[0].env.push({
        name: 'OPENAI_API_KEY',
        value: 'x',
      });
    },
    (t: any) => {
      t.template.spec.volumes[0] = {
        name: 'workspace',
        hostPath: { path: '/' },
      };
    },
    (t: any) => {
      t.template.spec.containers[0].securityContext.allowPrivilegeEscalation = true;
    },
    (t: any) => {
      t.template.spec.containers.push({ name: 'sidecar' });
    },
    (t: any) => {
      delete t.template.spec.activeDeadlineSeconds;
    },
    (t: any) => {
      t.template.spec.containers[0].image = 'example.invalid/elpis:latest';
    },
  ]) {
    const template = safeTemplate();
    mutate(template);
    const f = fixture(template);
    await assert.rejects(
      () =>
        f.runtime.provision({
          sessionId: SESSION_ID,
          hintMindId: 'elm-secretary001',
          modelRef: 'p/model',
          token: 't'.repeat(43),
        }),
      /PodTemplate is unsafe/,
    );
    assert.equal(
      f.calls.length,
      1,
      'validation precedes credential or Pod effects',
    );
  }
});

test('Pod create failure deletes only the deterministic Secret', async () => {
  const f = fixture();
  f.replies.push(
    { code: 0, stdout: JSON.stringify(safeTemplate()), stderr: '' },
    { code: 0, stdout: '{}', stderr: '' },
    { code: 1, stdout: '', stderr: 'admission denied' },
    { code: 0, stdout: '', stderr: '' },
  );
  await assert.rejects(
    () =>
      f.runtime.provision({
        sessionId: SESSION_ID,
        hintMindId: 'elm-secretary001',
        modelRef: 'p/model',
        token: 't'.repeat(43),
      }),
    /admission denied/,
  );
  assert.deepEqual(f.calls[3].args.slice(-4), [
    'delete',
    'secret',
    RESOURCE_NAME,
    '--ignore-not-found=true',
  ]);
});

test('inspect is phase and UID aware, while cleanup uses exact names without selectors', async () => {
  const f = fixture();
  f.replies.push({
    code: 0,
    stdout: JSON.stringify({
      metadata: { name: RESOURCE_NAME, uid: 'uid-1' },
      status: { phase: 'Running' },
    }),
    stderr: '',
  });
  assert.equal((await f.runtime.inspect(session())).state, 'ready');
  f.replies.push({
    code: 0,
    stdout: JSON.stringify({
      metadata: { name: RESOURCE_NAME, uid: 'uid-other' },
      status: { phase: 'Running' },
    }),
    stderr: '',
  });
  assert.deepEqual(await f.runtime.inspect(session()), {
    state: 'failed',
    error: 'secretary Pod UID changed',
  });
  f.replies.push({
    code: 0,
    stdout: JSON.stringify({
      metadata: { name: RESOURCE_NAME, uid: 'uid-1' },
      status: {
        phase: 'Failed',
        containerStatuses: [
          {
            state: {
              terminated: { reason: 'Error', exitCode: 17, message: 'boom' },
            },
          },
        ],
      },
    }),
    stderr: '',
  });
  assert.deepEqual(await f.runtime.inspect(session()), {
    state: 'failed',
    error: 'secretary Pod failed: Error, exit 17: boom',
  });
  f.replies.push({ code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await f.runtime.inspect(session()), { state: 'missing' });
  await f.runtime.cleanup(session());
  const args = f.calls.at(-1)!.args;
  assert.deepEqual(args.slice(-5), [
    'delete',
    `pod/${RESOURCE_NAME}`,
    `secret/${RESOURCE_NAME}`,
    '--ignore-not-found=true',
    '--wait=false',
  ]);
  assert.equal(args.includes('--selector'), false);
});
