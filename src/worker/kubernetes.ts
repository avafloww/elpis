import { spawn } from 'node:child_process';
import type {
  WorkerPodRuntime,
  WorkerProvisionReceipt,
  WorkerProvisionRequest,
  WorkerProvisionState,
  WorkerSession,
} from './spawn.js';

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type KubectlExecutor = (
  args: string[],
  stdin?: string,
) => Promise<KubectlResult>;

export interface KubernetesWorkerRuntimeOptions {
  namespace: string;
  template: string;
  container: string;
  brokerUrl: string;
  kubectlPath?: string;
  context?: string | null;
  exec?: KubectlExecutor;
}

const DNS_LABEL = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const SENSITIVE_ENV =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|DISCORD|ANTHROPIC|OPENAI|CODEX)/i;
const REQUIRED_MOUNTS = new Map([
  ['/workspace', 'workspace'],
  ['/data', 'data'],
  ['/tmp', 'scratch'],
]);
const WORKER_FATAL_PREFIX = '[worker] fatal:';
const MAX_FATAL_LOG_BYTES = 4096;
const MAX_FATAL_DIAGNOSTIC_BYTES = 500;

function boundedUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  const marker = Buffer.from('…');
  let end = Math.max(0, maxBytes - marker.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString('utf8')}…`;
}

function sanitizeWorkerDiagnostic(value: string): string | null {
  const diagnostic = value
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '[REDACTED]')
    .replace(
      /\/(?:workspace|data|tmp|home|opt\/elpis)(?:\/[^\s,;:]*)?/g,
      '[WORKER PATH]',
    )
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return diagnostic
    ? boundedUtf8(diagnostic, MAX_FATAL_DIAGNOSTIC_BYTES)
    : null;
}

function workerFatalDiagnostic(logs: string): string | null {
  const line = logs
    .split(/\r?\n/)
    .reverse()
    .find((entry) => entry.startsWith(WORKER_FATAL_PREFIX));
  return line
    ? sanitizeWorkerDiagnostic(line.slice(WORKER_FATAL_PREFIX.length))
    : null;
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}

function array(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function assertName(value: string, label: string): void {
  if (!DNS_LABEL.test(value) || value.length > 63)
    throw new Error(`${label} must be a Kubernetes DNS label`);
}

function validateBrokerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('worker broker URL must be an absolute http(s) URL');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  )
    throw new Error(
      'worker broker URL must be a credential-free http(s) origin',
    );
  return url.origin;
}

async function defaultExec(
  binary: string,
  args: string[],
  stdin?: string,
): Promise<KubectlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
    child.stdin.end(stdin);
  });
}

function securityError(message: string): never {
  throw new Error(`worker PodTemplate is unsafe: ${message}`);
}

function validateTemplate(
  raw: unknown,
  containerName: string,
): {
  metadata: Record<string, any>;
  spec: Record<string, any>;
  container: Record<string, any>;
} {
  const template = object(raw, 'worker PodTemplate');
  if (template.apiVersion !== 'v1' || template.kind !== 'PodTemplate')
    securityError('expected apiVersion v1 and kind PodTemplate');
  const podTemplate = object(template.template, 'worker PodTemplate.template');
  const metadata = object(
    podTemplate.metadata ?? {},
    'worker PodTemplate metadata',
  );
  const spec = object(podTemplate.spec, 'worker PodTemplate spec');
  if (spec.automountServiceAccountToken !== false)
    securityError('automountServiceAccountToken must be false');
  if (spec.restartPolicy !== 'Never')
    securityError('restartPolicy must be Never');
  if (
    !Number.isInteger(spec.activeDeadlineSeconds) ||
    spec.activeDeadlineSeconds < 60 ||
    spec.activeDeadlineSeconds > 86_400
  )
    securityError('activeDeadlineSeconds must be an integer from 60 to 86400');
  for (const key of [
    'hostNetwork',
    'hostPID',
    'hostIPC',
    'shareProcessNamespace',
  ])
    if (spec[key] === true) securityError(`${key} must not be true`);
  if (
    (spec.initContainers?.length ?? 0) > 0 ||
    (spec.ephemeralContainers?.length ?? 0) > 0
  )
    securityError('init and ephemeral containers are not allowed');
  const containers = array(spec.containers, 'worker PodTemplate containers');
  if (containers.length !== 1)
    securityError('exactly one container is required');
  const container = object(containers[0], 'worker container');
  if (container.name !== containerName)
    securityError('configured worker container is missing');
  if (
    typeof container.image !== 'string' ||
    !/@sha256:[0-9a-f]{64}$/.test(container.image)
  )
    securityError('worker image must use an immutable sha256 digest');
  if (container.envFrom?.length) securityError('envFrom is not allowed');
  for (const env of container.env ?? []) {
    const value = object(env, 'worker container env');
    if (value.valueFrom?.secretKeyRef)
      securityError('template secret env is not allowed');
    if (typeof value.name !== 'string' || SENSITIVE_ENV.test(value.name))
      securityError('sensitive or malformed template env is not allowed');
  }
  const podSecurity = object(
    spec.securityContext,
    'worker Pod securityContext',
  );
  if (podSecurity.runAsNonRoot !== true)
    securityError('runAsNonRoot must be true');
  if (podSecurity.seccompProfile?.type !== 'RuntimeDefault')
    securityError('seccompProfile.type must be RuntimeDefault');
  const containerSecurity = object(
    container.securityContext,
    'worker container securityContext',
  );
  if (containerSecurity.privileged === true)
    securityError('privileged containers are not allowed');
  if (containerSecurity.allowPrivilegeEscalation !== false)
    securityError('allowPrivilegeEscalation must be false');
  if (containerSecurity.readOnlyRootFilesystem !== true)
    securityError('readOnlyRootFilesystem must be true');
  const dropped = containerSecurity.capabilities?.drop;
  if (!Array.isArray(dropped) || !dropped.includes('ALL'))
    securityError('all Linux capabilities must be dropped');

  const volumes = array(spec.volumes, 'worker PodTemplate volumes');
  if (volumes.length !== REQUIRED_MOUNTS.size)
    securityError('only workspace, data, and scratch volumes are allowed');
  const volumeNames = new Set<string>();
  for (const rawVolume of volumes) {
    const volume = object(rawVolume, 'worker volume');
    if (typeof volume.name !== 'string' || !volume.emptyDir)
      securityError('worker volumes must be named emptyDir volumes');
    volumeNames.add(volume.name);
  }
  const mounts = array(container.volumeMounts, 'worker container volumeMounts');
  if (mounts.length !== REQUIRED_MOUNTS.size)
    securityError('exactly /workspace, /data, and /tmp must be mounted');
  for (const rawMount of mounts) {
    const mount = object(rawMount, 'worker volume mount');
    const expected = REQUIRED_MOUNTS.get(mount.mountPath);
    if (!expected || mount.name !== expected || mount.readOnly === true)
      securityError('worker volume mount set is invalid');
    if (!volumeNames.has(mount.name))
      securityError('worker mount has no volume');
  }
  return { metadata, spec, container };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class KubectlWorkerRuntime implements WorkerPodRuntime {
  private readonly exec: KubectlExecutor;
  private readonly kubectlPath: string;
  private readonly brokerUrl: string;

  constructor(private readonly options: KubernetesWorkerRuntimeOptions) {
    assertName(options.namespace, 'worker namespace');
    assertName(options.template, 'worker PodTemplate name');
    assertName(options.container, 'worker container name');
    this.brokerUrl = validateBrokerUrl(options.brokerUrl);
    this.kubectlPath = options.kubectlPath ?? 'kubectl';
    if (!this.kubectlPath) throw new Error('kubectl path must be non-empty');
    this.exec =
      options.exec ??
      ((args, stdin) => defaultExec(this.kubectlPath, args, stdin));
  }

  private names(sessionId: string): { pod: string; secret: string } {
    if (!/^wrk-[a-z0-9]{8}$/.test(sessionId))
      throw new Error('worker session id is invalid');
    const suffix = sessionId.slice(4);
    return { pod: `elpis-worker-${suffix}`, secret: `elpis-worker-${suffix}` };
  }

  private args(...args: string[]): string[] {
    const context = this.options.context
      ? ['--context', this.options.context]
      : [];
    return [...context, '--namespace', this.options.namespace, ...args];
  }

  private async run(args: string[], stdin?: string): Promise<KubectlResult> {
    const result = await this.exec(this.args(...args), stdin);
    if (result.code !== 0)
      throw new Error(
        `kubectl failed (${result.code}): ${result.stderr.trim().slice(0, 500) || 'no diagnostic'}`,
      );
    return result;
  }

  private receipt(
    sessionId: string,
    pod: Record<string, any>,
  ): WorkerProvisionReceipt {
    const names = this.names(sessionId);
    return {
      podName: String(pod.metadata?.name ?? names.pod),
      podUid: pod.metadata?.uid == null ? null : String(pod.metadata.uid),
      workspaceRef: `pod/${this.options.namespace}/${names.pod}`,
    };
  }

  async provision(
    request: WorkerProvisionRequest,
  ): Promise<WorkerProvisionReceipt> {
    const names = this.names(request.sessionId);
    const templateResult = await this.run([
      'get',
      'podtemplate',
      this.options.template,
      '-o',
      'json',
    ]);
    let template: unknown;
    try {
      template = JSON.parse(templateResult.stdout);
    } catch {
      throw new Error('kubectl returned malformed PodTemplate JSON');
    }
    const validated = validateTemplate(template, this.options.container);
    const labels = {
      'app.kubernetes.io/name': 'elpis-worker',
      'app.kubernetes.io/component': 'worker',
      'elpis-worker-id': request.sessionId,
    };
    const secret = {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: names.secret,
        namespace: this.options.namespace,
        labels,
      },
      type: 'Opaque',
      stringData: { token: request.token },
    };
    await this.run(['create', '-f', '-'], JSON.stringify(secret));
    try {
      const spec = clone(validated.spec);
      const container = spec.containers[0] as Record<string, any>;
      container.env = [
        ...(container.env ?? []),
        {
          name: 'ELPIS_WORKER_TOKEN',
          valueFrom: { secretKeyRef: { name: names.secret, key: 'token' } },
        },
        { name: 'ELPIS_WORKER_BROKER_URL', value: this.brokerUrl },
        { name: 'ELPIS_WORKER_SESSION_ID', value: request.sessionId },
      ];
      const pod = {
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          ...clone(validated.metadata),
          name: names.pod,
          namespace: this.options.namespace,
          labels: { ...(validated.metadata.labels ?? {}), ...labels },
          annotations: clone(validated.metadata.annotations ?? {}),
          ownerReferences: undefined,
        },
        spec,
      };
      const created = await this.run(
        ['create', '-f', '-', '-o', 'json'],
        JSON.stringify(pod),
      );
      return this.receipt(request.sessionId, JSON.parse(created.stdout));
    } catch (error) {
      await this.exec(
        this.args('delete', 'secret', names.secret, '--ignore-not-found=true'),
      );
      throw error;
    }
  }

  async inspect(session: WorkerSession): Promise<WorkerProvisionState> {
    const names = this.names(session.id);
    const result = await this.run([
      'get',
      'pod',
      names.pod,
      '-o',
      'json',
      '--ignore-not-found=true',
    ]);
    if (!result.stdout.trim()) return { state: 'missing' };
    const pod = object(JSON.parse(result.stdout), 'worker Pod');
    const receipt = this.receipt(session.id, pod);
    if (session.podUid && receipt.podUid !== session.podUid)
      return { state: 'failed', error: 'worker Pod UID changed', receipt };
    switch (pod.status?.phase) {
      case 'Pending':
        return { state: 'pending', receipt };
      case 'Running':
        return { state: 'ready', receipt };
      case 'Succeeded':
        return { state: 'succeeded', receipt };
      case 'Failed': {
        const terminated =
          pod.status?.containerStatuses?.[0]?.state?.terminated;
        const reason = terminated?.reason ?? 'unknown reason';
        const exit = Number.isInteger(terminated?.exitCode)
          ? `, exit ${terminated.exitCode}`
          : '';
        const terminatedMessage =
          typeof terminated?.message === 'string'
            ? sanitizeWorkerDiagnostic(terminated.message)
            : null;
        const message = terminatedMessage ? `: ${terminatedMessage}` : '';
        const logs = await this.exec(
          this.args(
            'logs',
            names.pod,
            '--container',
            this.options.container,
            '--tail=20',
            `--limit-bytes=${MAX_FATAL_LOG_BYTES}`,
          ),
        );
        const diagnostic =
          logs.code === 0 ? workerFatalDiagnostic(logs.stdout) : null;
        return {
          state: 'failed',
          error: `worker Pod failed: ${reason}${exit}${message}${diagnostic ? `; diagnostic: ${diagnostic}` : ''}`,
          receipt,
        };
      }
      default:
        return {
          state: 'failed',
          error: `worker Pod has invalid phase ${String(pod.status?.phase)}`,
          receipt,
        };
    }
  }

  async cleanup(session: WorkerSession): Promise<void> {
    const names = this.names(session.id);
    await this.run([
      'delete',
      `pod/${names.pod}`,
      `secret/${names.secret}`,
      '--ignore-not-found=true',
      '--wait=false',
    ]);
  }
}
