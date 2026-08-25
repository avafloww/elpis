import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KubectlWorkerRuntime,
  type KubectlResult,
} from '../src/worker/kubernetes.js';
import type { WorkerSession } from '../src/worker/spawn.js';

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
        volumes: [
          { name: 'workspace', emptyDir: {} },
          { name: 'data', emptyDir: {} },
          { name: 'scratch', emptyDir: {} },
        ],
        containers: [
          {
            name: 'worker',
            image: `example.invalid/elpis@sha256:${'a'.repeat(64)}`,
            command: ['node', '/opt/elpis/dist/worker-main.js'],
            resources: { limits: { cpu: '1', memory: '1Gi' } },
            env: [{ name: 'FIXED_MODE', value: 'worker' }],
            volumeMounts: [
              { name: 'workspace', mountPath: '/workspace' },
              { name: 'data', mountPath: '/data' },
              { name: 'scratch', mountPath: '/tmp' },
            ],
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

function session(patch: Partial<WorkerSession> = {}): WorkerSession {
  return {
    id: 'wrk-a1b2c3d4',
    slug: 'quiet-otter',
    worker: 'worker:quiet-otter',
    status: 'running',
    modelRef: 'p/model',
    mindId: 'elm-worker001',
    runtime: 'kubernetes',
    podName: 'elpis-worker-a1b2c3d4',
    podUid: 'uid-1',
    workspaceRef: 'pod/workers/elpis-worker-a1b2c3d4',
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
  const runtime = new KubectlWorkerRuntime({
    namespace: 'workers',
    template: 'elpis-worker',
    container: 'worker',
    brokerUrl: 'https://broker.example.com',
    context: 'fixed-context',
    exec,
  });
  return { runtime, calls, replies };
}

test('provision clones only the fixed template and injects token through one Secret', async () => {
  const f = fixture();
  const receipt = await f.runtime.provision({
    sessionId: 'wrk-a1b2c3d4',
    slug: 'quiet-otter',
    token: 't'.repeat(43),
  });
  assert.deepEqual(receipt, {
    podName: 'elpis-worker-a1b2c3d4',
    podUid: 'uid-1',
    workspaceRef: 'pod/workers/elpis-worker-a1b2c3d4',
  });
  assert.equal(f.calls.length, 3);
  for (const call of f.calls)
    assert.deepEqual(call.args.slice(0, 4), [
      '--context',
      'fixed-context',
      '--namespace',
      'workers',
    ]);
  const secret = JSON.parse(f.calls[1].stdin!);
  const pod = JSON.parse(f.calls[2].stdin!);
  assert.equal(secret.kind, 'Secret');
  assert.equal(secret.stringData.token, 't'.repeat(43));
  assert.equal(
    JSON.stringify(pod).includes('t'.repeat(43)),
    false,
    'raw token never enters Pod spec',
  );
  assert.equal(
    pod.spec.containers[0].image,
    `example.invalid/elpis@sha256:${'a'.repeat(64)}`,
  );
  assert.deepEqual(pod.spec.containers[0].command, [
    'node',
    '/opt/elpis/dist/worker-main.js',
  ]);
  assert.deepEqual(pod.spec.containers[0].resources, {
    limits: { cpu: '1', memory: '1Gi' },
  });
  assert.equal(pod.spec.automountServiceAccountToken, false);
  const tokenEnv = pod.spec.containers[0].env.find(
    (env: any) => env.name === 'ELPIS_WORKER_TOKEN',
  );
  assert.deepEqual(tokenEnv.valueFrom.secretKeyRef, {
    name: 'elpis-worker-a1b2c3d4',
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
          sessionId: 'wrk-a1b2c3d4',
          slug: 'quiet-otter',
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
        sessionId: 'wrk-a1b2c3d4',
        slug: 'quiet-otter',
        token: 't'.repeat(43),
      }),
    /admission denied/,
  );
  assert.deepEqual(f.calls[3].args.slice(-4), [
    'delete',
    'secret',
    'elpis-worker-a1b2c3d4',
    '--ignore-not-found=true',
  ]);
});

test('failed worker fatal diagnostics are bounded on a UTF-8 boundary', async () => {
  const f = fixture();
  f.replies.push(
    {
      code: 0,
      stdout: JSON.stringify({
        metadata: { name: 'elpis-worker-a1b2c3d4', uid: 'uid-1' },
        status: {
          phase: 'Failed',
          containerStatuses: [
            { state: { terminated: { reason: 'Error', exitCode: 1 } } },
          ],
        },
      }),
      stderr: '',
    },
    {
      code: 0,
      stdout: `[worker] fatal: ${'😀'.repeat(300)}`,
      stderr: '',
    },
  );
  const state = await f.runtime.inspect(session());
  assert.equal(state.state, 'failed');
  if (state.state !== 'failed') return;
  const diagnostic = state.error.split('; diagnostic: ')[1];
  assert.ok(diagnostic);
  assert.ok(Buffer.byteLength(diagnostic, 'utf8') <= 500);
  assert.match(diagnostic, /…$/);
});

test('inspect is phase and UID aware, while cleanup uses exact names without selectors', async () => {
  const f = fixture();
  f.replies.push({
    code: 0,
    stdout: JSON.stringify({
      metadata: { name: 'elpis-worker-a1b2c3d4', uid: 'uid-1' },
      status: { phase: 'Running' },
    }),
    stderr: '',
  });
  assert.equal((await f.runtime.inspect(session())).state, 'ready');
  f.replies.push({
    code: 0,
    stdout: JSON.stringify({
      metadata: { name: 'elpis-worker-a1b2c3d4', uid: 'uid-other' },
      status: { phase: 'Running' },
    }),
    stderr: '',
  });
  assert.deepEqual(await f.runtime.inspect(session()), {
    state: 'failed',
    error: 'worker Pod UID changed',
    receipt: {
      podName: 'elpis-worker-a1b2c3d4',
      podUid: 'uid-other',
      workspaceRef: 'pod/workers/elpis-worker-a1b2c3d4',
    },
  });
  f.replies.push(
    {
      code: 0,
      stdout: JSON.stringify({
        metadata: { name: 'elpis-worker-a1b2c3d4', uid: 'uid-1' },
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
    },
    {
      code: 0,
      stdout: [
        'untrusted unrelated output must not escape',
        `[worker] fatal: broker Bearer ${'x'.repeat(43)} failed in /workspace/repo/file.ts`,
      ].join('\n'),
      stderr: '',
    },
  );
  assert.deepEqual(await f.runtime.inspect(session()), {
    state: 'failed',
    error:
      'worker Pod failed: Error, exit 17: boom; diagnostic: broker Bearer [REDACTED] failed in [WORKER PATH]',
    receipt: {
      podName: 'elpis-worker-a1b2c3d4',
      podUid: 'uid-1',
      workspaceRef: 'pod/workers/elpis-worker-a1b2c3d4',
    },
  });
  assert.deepEqual(f.calls.at(-1)!.args.slice(-6), [
    'logs',
    'elpis-worker-a1b2c3d4',
    '--container',
    'worker',
    '--tail=20',
    '--limit-bytes=4096',
  ]);
  f.replies.push(
    {
      code: 0,
      stdout: JSON.stringify({
        metadata: { name: 'elpis-worker-a1b2c3d4', uid: 'uid-1' },
        status: {
          phase: 'Failed',
          containerStatuses: [
            { state: { terminated: { reason: 'Error', exitCode: 23 } } },
          ],
        },
      }),
      stderr: '',
    },
    { code: 1, stdout: '', stderr: 'logs unavailable' },
  );
  assert.deepEqual(await f.runtime.inspect(session()), {
    state: 'failed',
    error: 'worker Pod failed: Error, exit 23',
    receipt: {
      podName: 'elpis-worker-a1b2c3d4',
      podUid: 'uid-1',
      workspaceRef: 'pod/workers/elpis-worker-a1b2c3d4',
    },
  });
  f.replies.push({ code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await f.runtime.inspect(session()), { state: 'missing' });
  await f.runtime.cleanup(session());
  const args = f.calls.at(-1)!.args;
  assert.deepEqual(args.slice(-5), [
    'delete',
    'pod/elpis-worker-a1b2c3d4',
    'secret/elpis-worker-a1b2c3d4',
    '--ignore-not-found=true',
    '--wait=false',
  ]);
  assert.equal(args.includes('--selector'), false);
});
