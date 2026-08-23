import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  SecretaryPodRuntime,
  SecretaryProvisionReceipt,
  SecretaryProvisionRequest,
  SecretaryProvisionState,
} from './spawn.js';
import type { SecretarySession } from './session.js';

export interface KubectlResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type KubectlExecutor = (
  args: string[],
  stdin?: string,
) => Promise<KubectlResult>;

export interface KubernetesSecretaryRuntimeOptions {
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
const SCRATCH_MOUNT = { path: '/tmp', name: 'scratch' } as const;

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
    throw new Error('secretary broker URL must be an absolute http(s) URL');
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
      'secretary broker URL must be a credential-free http(s) origin',
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
  throw new Error(`secretary PodTemplate is unsafe: ${message}`);
}

function validateTemplate(
  raw: unknown,
  containerName: string,
): {
  metadata: Record<string, any>;
  spec: Record<string, any>;
  container: Record<string, any>;
} {
  const template = object(raw, 'secretary PodTemplate');
  if (template.apiVersion !== 'v1' || template.kind !== 'PodTemplate')
    securityError('expected apiVersion v1 and kind PodTemplate');
  const podTemplate = object(
    template.template,
    'secretary PodTemplate.template',
  );
  const metadata = object(
    podTemplate.metadata ?? {},
    'secretary PodTemplate metadata',
  );
  const spec = object(podTemplate.spec, 'secretary PodTemplate spec');
  if (spec.automountServiceAccountToken !== false)
    securityError('automountServiceAccountToken must be false');
  if (spec.serviceAccountName != null)
    securityError('serviceAccountName is not allowed');
  if ((spec.imagePullSecrets?.length ?? 0) > 0)
    securityError('imagePullSecrets are not allowed');
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
  const containers = array(spec.containers, 'secretary PodTemplate containers');
  if (containers.length !== 1)
    securityError('exactly one container is required');
  const container = object(containers[0], 'secretary container');
  if (container.name !== containerName)
    securityError('configured secretary container is missing');
  if (
    typeof container.image !== 'string' ||
    !/@sha256:[0-9a-f]{64}$/.test(container.image)
  )
    securityError('secretary image must use an immutable sha256 digest');
  if (container.envFrom?.length) securityError('envFrom is not allowed');
  for (const env of container.env ?? []) {
    const value = object(env, 'secretary container env');
    if (value.valueFrom?.secretKeyRef)
      securityError('template secret env is not allowed');
    if (typeof value.name !== 'string' || SENSITIVE_ENV.test(value.name))
      securityError('sensitive or malformed template env is not allowed');
  }
  const podSecurity = object(
    spec.securityContext,
    'secretary Pod securityContext',
  );
  if (podSecurity.runAsNonRoot !== true)
    securityError('runAsNonRoot must be true');
  if (podSecurity.seccompProfile?.type !== 'RuntimeDefault')
    securityError('seccompProfile.type must be RuntimeDefault');
  const containerSecurity = object(
    container.securityContext,
    'secretary container securityContext',
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

  if (!container.resources?.requests || !container.resources?.limits)
    securityError('fixed resource requests and limits are required');
  const volumes = array(spec.volumes, 'secretary PodTemplate volumes');
  if (volumes.length !== 1)
    securityError('only one scratch emptyDir volume is allowed');
  const volume = object(volumes[0], 'secretary scratch volume');
  if (volume.name !== SCRATCH_MOUNT.name || !volume.emptyDir)
    securityError('secretary scratch volume is invalid');
  const mounts = array(
    container.volumeMounts,
    'secretary container volumeMounts',
  );
  if (mounts.length !== 1) securityError('exactly /tmp must be mounted');
  const mount = object(mounts[0], 'secretary scratch mount');
  if (
    mount.name !== SCRATCH_MOUNT.name ||
    mount.mountPath !== SCRATCH_MOUNT.path ||
    mount.readOnly === true
  )
    securityError('secretary scratch mount is invalid');
  return { metadata, spec, container };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class KubectlSecretaryRuntime implements SecretaryPodRuntime {
  private readonly exec: KubectlExecutor;
  private readonly kubectlPath: string;
  private readonly brokerUrl: string;

  constructor(private readonly options: KubernetesSecretaryRuntimeOptions) {
    assertName(options.namespace, 'secretary namespace');
    assertName(options.template, 'secretary PodTemplate name');
    assertName(options.container, 'secretary container name');
    this.brokerUrl = validateBrokerUrl(options.brokerUrl);
    this.kubectlPath = options.kubectlPath ?? 'kubectl';
    if (!this.kubectlPath) throw new Error('kubectl path must be non-empty');
    this.exec =
      options.exec ??
      ((args, stdin) => defaultExec(this.kubectlPath, args, stdin));
  }

  private names(sessionId: string): { pod: string; secret: string } {
    if (!/^sec-[A-Za-z0-9_-]{22}$/.test(sessionId))
      throw new Error('secretary session id is invalid');
    const suffix = createHash('sha256')
      .update(sessionId)
      .digest('hex')
      .slice(0, 12);
    return {
      pod: `elpis-secretary-${suffix}`,
      secret: `elpis-secretary-${suffix}`,
    };
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
  ): SecretaryProvisionReceipt {
    const names = this.names(sessionId);
    const podName = String(pod.metadata?.name ?? names.pod);
    const podUid = pod.metadata?.uid == null ? '' : String(pod.metadata.uid);
    if (podName !== names.pod || !podUid)
      throw new Error('secretary Pod identity is invalid');
    return { podName, podUid };
  }

  async provision(
    request: SecretaryProvisionRequest,
  ): Promise<SecretaryProvisionReceipt> {
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
      'app.kubernetes.io/name': 'elpis-secretary',
      'app.kubernetes.io/component': 'secretary',
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
      stringData: {
        token: request.token,
        broker_url: this.brokerUrl,
        session_id: request.sessionId,
      },
    };
    await this.run(['create', '-f', '-'], JSON.stringify(secret));
    try {
      const spec = clone(validated.spec);
      const container = spec.containers[0] as Record<string, any>;
      container.env = [
        ...(container.env ?? []),
        { name: 'ELPIS_MODE', value: 'secretary' },
        {
          name: 'ELPIS_SECRETARY_TOKEN',
          valueFrom: { secretKeyRef: { name: names.secret, key: 'token' } },
        },
        {
          name: 'ELPIS_SECRETARY_BROKER_URL',
          valueFrom: {
            secretKeyRef: { name: names.secret, key: 'broker_url' },
          },
        },
        {
          name: 'ELPIS_SECRETARY_SESSION_ID',
          valueFrom: {
            secretKeyRef: { name: names.secret, key: 'session_id' },
          },
        },
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

  async inspect(session: SecretarySession): Promise<SecretaryProvisionState> {
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
    const pod = object(JSON.parse(result.stdout), 'secretary Pod');
    const receipt = this.receipt(session.id, pod);
    if (session.podUid && receipt.podUid !== session.podUid)
      return { state: 'failed', error: 'secretary Pod UID changed' };
    switch (pod.status?.phase) {
      case 'Pending':
        return { state: 'pending' };
      case 'Running':
        return { state: 'ready', receipt };
      case 'Succeeded':
        return { state: 'failed', error: 'secretary Pod exited' };
      case 'Failed': {
        const terminated =
          pod.status?.containerStatuses?.[0]?.state?.terminated;
        const reason = terminated?.reason ?? 'unknown reason';
        const exit = Number.isInteger(terminated?.exitCode)
          ? `, exit ${terminated.exitCode}`
          : '';
        const message =
          typeof terminated?.message === 'string' && terminated.message.trim()
            ? `: ${terminated.message.trim().slice(0, 500)}`
            : '';
        return {
          state: 'failed',
          error: `secretary Pod failed: ${reason}${exit}${message}`,
        };
      }
      default:
        return {
          state: 'failed',
          error: `secretary Pod has invalid phase ${String(pod.status?.phase)}`,
        };
    }
  }

  async cleanup(session: SecretarySession): Promise<void> {
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
