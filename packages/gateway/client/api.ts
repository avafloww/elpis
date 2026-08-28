const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_BOOTSTRAP_YAML_BYTES = 4096;
const PUBLIC_ID = /^[A-Za-z0-9_-]{22}$/;
const INSTANCE_ID = /^egi1\.[A-Za-z0-9_-]{22}$/;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ENROLLMENT_TOKEN = /^ege1\.([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/;
const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const JSON_SCALAR =
  '("(?:\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4}|[^"\\\u0000-\u001f])*")';
const BOOTSTRAP = new RegExp(
  '^dashboard:\n  remote:\n    url: ' +
    JSON_SCALAR +
    '\n    enrollment_token: ' +
    JSON_SCALAR +
    '\n$',
);

export interface GatewaySetupSummary {
  readonly complete: boolean;
  readonly publicUrl: string | null;
  readonly revision: number;
}

export interface GatewayInstanceSummary {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revokedAt: number | null;
  readonly activeCredentialId: string | null;
  readonly activeSince: number | null;
  readonly lastUsedAt: number | null;
}

export interface GatewayState {
  readonly format: 'elpis-gateway-state-v1';
  readonly setup: GatewaySetupSummary;
  readonly instances: readonly GatewayInstanceSummary[];
}

export interface GatewayEnrollmentGrant {
  readonly format: 'elpis-gateway-enrollment-v1';
  readonly grant: Readonly<{
    id: string;
    expiresAt: number;
  }>;
  readonly bootstrapYaml: string;
}

export interface GatewayEnrollmentRevoke {
  readonly format: 'elpis-gateway-enrollment-revoke-v1';
  readonly grant: Readonly<{
    id: string;
    replayed: boolean;
  }>;
}

export interface GatewayCsrfResponse {
  readonly csrfToken: string;
}

export type GatewayClientErrorCode =
  'invalid_request' | 'invalid_response' | 'request_failed' | (string & {});

/** An intentionally body-free error safe for presentation and telemetry. */
export class GatewayClientError extends Error {
  readonly status: number;
  readonly stableCode: GatewayClientErrorCode;

  constructor(status: number, stableCode: GatewayClientErrorCode) {
    if (
      !Number.isSafeInteger(status) ||
      status < 0 ||
      status > 599 ||
      (status > 0 && status < 100)
    )
      throw new TypeError('Gateway client error status is invalid');
    if (typeof stableCode !== 'string' || !STABLE_CODE.test(stableCode))
      throw new TypeError('Gateway client error code is invalid');
    super(stableCode);
    this.name = 'GatewayClientError';
    this.status = status;
    this.stableCode = stableCode;
  }
}

function invalid(status = 0): never {
  throw new GatewayClientError(status, 'invalid_response');
}

function record(value: unknown, status = 0): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid(status);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  status = 0,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key) => typeof key !== 'string') ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    invalid(status);
}

function integer(value: unknown, status = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(status);
  return value as number;
}

function nullableInteger(value: unknown, status = 0): number | null {
  return value === null ? null : integer(value, status);
}

function canonicalOrigin(
  value: unknown,
  allowLocalHttp: boolean,
  status = 0,
): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048)
    invalid(status);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invalid(status);
  }
  const localHttp =
    allowLocalHttp &&
    parsed.protocol === 'http:' &&
    (parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]');
  if (
    (parsed.protocol !== 'https:' && !localHttp) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.pathname !== '/' ||
    parsed.origin !== value
  )
    invalid(status);
  return value;
}

/** Validate the one canonical HTTPS origin accepted by setup. */
export function validateCanonicalSetupUrl(value: unknown): string {
  try {
    return canonicalOrigin(value, false);
  } catch {
    throw new GatewayClientError(0, 'invalid_request');
  }
}

function instanceSummary(value: unknown): GatewayInstanceSummary {
  const input = record(value);
  exactKeys(input, [
    'id',
    'displayName',
    'createdAt',
    'updatedAt',
    'revokedAt',
    'activeCredentialId',
    'activeSince',
    'lastUsedAt',
  ]);
  if (typeof input.id !== 'string' || !INSTANCE_ID.test(input.id)) invalid();
  if (
    typeof input.displayName !== 'string' ||
    input.displayName.length < 1 ||
    input.displayName.length > 256 ||
    input.displayName.trim() !== input.displayName ||
    /\p{Cc}/u.test(input.displayName)
  )
    invalid();
  const createdAt = integer(input.createdAt);
  const updatedAt = integer(input.updatedAt);
  const revokedAt = nullableInteger(input.revokedAt);
  const activeCredentialId = input.activeCredentialId;
  const activeSince = nullableInteger(input.activeSince);
  const lastUsedAt = nullableInteger(input.lastUsedAt);
  if (
    updatedAt < createdAt ||
    (revokedAt !== null && revokedAt < createdAt) ||
    (activeCredentialId !== null &&
      (typeof activeCredentialId !== 'string' ||
        !PUBLIC_ID.test(activeCredentialId))) ||
    (activeCredentialId === null) !== (activeSince === null) ||
    (activeCredentialId === null && lastUsedAt !== null) ||
    (activeSince !== null && activeSince < createdAt) ||
    (lastUsedAt !== null && (activeSince === null || lastUsedAt < activeSince))
  )
    invalid();
  return Object.freeze({
    id: input.id,
    displayName: input.displayName,
    createdAt,
    updatedAt,
    revokedAt,
    activeCredentialId,
    activeSince,
    lastUsedAt,
  });
}

export function validateGatewayState(value: unknown): GatewayState {
  const input = record(value);
  exactKeys(input, ['format', 'setup', 'instances']);
  if (input.format !== 'elpis-gateway-state-v1') invalid();
  const setupInput = record(input.setup);
  exactKeys(setupInput, ['complete', 'publicUrl', 'revision']);
  if (typeof setupInput.complete !== 'boolean') invalid();
  const revision = integer(setupInput.revision);
  let publicUrl: string | null;
  if (setupInput.publicUrl === null) publicUrl = null;
  else publicUrl = canonicalOrigin(setupInput.publicUrl, true);
  if (
    (setupInput.complete && (publicUrl === null || revision < 1)) ||
    (!setupInput.complete && (publicUrl !== null || revision !== 0)) ||
    !Array.isArray(input.instances)
  )
    invalid();
  const instances = input.instances.map(instanceSummary);
  if (
    new Set(instances.map((instance) => instance.id)).size !== instances.length
  )
    invalid();
  return Object.freeze({
    format: 'elpis-gateway-state-v1',
    setup: Object.freeze({
      complete: setupInput.complete,
      publicUrl,
      revision,
    }),
    instances: Object.freeze(instances),
  });
}

export function validateCsrfResponse(value: unknown): GatewayCsrfResponse {
  const input = record(value);
  exactKeys(input, ['csrfToken']);
  if (typeof input.csrfToken !== 'string' || !CSRF_TOKEN.test(input.csrfToken))
    invalid();
  return Object.freeze({ csrfToken: input.csrfToken });
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function validateEnrollmentGrant(
  value: unknown,
): GatewayEnrollmentGrant {
  const input = record(value);
  exactKeys(input, ['format', 'grant', 'bootstrapYaml']);
  if (input.format !== 'elpis-gateway-enrollment-v1') invalid();
  const grantInput = record(input.grant);
  exactKeys(grantInput, ['id', 'expiresAt']);
  if (typeof grantInput.id !== 'string' || !PUBLIC_ID.test(grantInput.id))
    invalid();
  const expiresAt = integer(grantInput.expiresAt);
  if (
    typeof input.bootstrapYaml !== 'string' ||
    utf8Length(input.bootstrapYaml) > MAX_BOOTSTRAP_YAML_BYTES
  )
    invalid();
  const match = BOOTSTRAP.exec(input.bootstrapYaml);
  if (!match) invalid();
  let publicUrl: unknown;
  let token: unknown;
  try {
    publicUrl = JSON.parse(match[1]);
    token = JSON.parse(match[2]);
  } catch {
    invalid();
  }
  canonicalOrigin(publicUrl, true);
  if (typeof token !== 'string') invalid();
  const tokenMatch = ENROLLMENT_TOKEN.exec(token);
  const occurrences = input.bootstrapYaml.match(
    /ege1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
  );
  if (
    !tokenMatch ||
    tokenMatch[1] !== grantInput.id ||
    occurrences?.length !== 1
  )
    invalid();
  return Object.freeze({
    format: 'elpis-gateway-enrollment-v1',
    grant: Object.freeze({ id: grantInput.id, expiresAt }),
    bootstrapYaml: input.bootstrapYaml,
  });
}

export function validateEnrollmentRevoke(
  value: unknown,
): GatewayEnrollmentRevoke {
  const input = record(value);
  exactKeys(input, ['format', 'grant']);
  if (input.format !== 'elpis-gateway-enrollment-revoke-v1') invalid();
  const grantInput = record(input.grant);
  exactKeys(grantInput, ['id', 'replayed']);
  if (
    typeof grantInput.id !== 'string' ||
    !PUBLIC_ID.test(grantInput.id) ||
    typeof grantInput.replayed !== 'boolean'
  )
    invalid();
  return Object.freeze({
    format: 'elpis-gateway-enrollment-revoke-v1',
    grant: Object.freeze({ id: grantInput.id, replayed: grantInput.replayed }),
  });
}

function validateError(value: unknown, status: number): string {
  const input = record(value, status);
  exactKeys(input, ['error'], status);
  if (typeof input.error !== 'string' || !STABLE_CODE.test(input.error))
    invalid(status);
  return input.error;
}

async function responseJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type');
  if (
    contentType === null ||
    !/^application\/json(?:\s*;[^,]*)?$/i.test(contentType)
  )
    invalid(response.status);
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) invalid(response.status);
    const size = Number(contentLength);
    if (!Number.isSafeInteger(size) || size > MAX_RESPONSE_BYTES)
      invalid(response.status);
  }
  if (response.body === null) invalid(response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        invalid(response.status);
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof GatewayClientError) throw error;
    invalid(response.status);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    invalid(response.status);
  }
}

async function checkedJson(
  fetcher: typeof fetch,
  path: string,
  options: RequestInit,
  successStatus: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(path, options);
  } catch {
    throw new GatewayClientError(0, 'request_failed');
  }
  const status = response.status;
  if (!Number.isSafeInteger(status) || status < 100 || status > 599) invalid();
  let value: unknown;
  try {
    value = await responseJson(response);
  } catch (error) {
    if (error instanceof GatewayClientError) throw error;
    invalid(status);
  }
  if (!response.ok)
    throw new GatewayClientError(status, validateError(value, status));
  if (status !== successStatus) invalid(status);
  return value;
}

const readOptions = (): RequestInit => ({
  method: 'GET',
  mode: 'same-origin',
  credentials: 'same-origin',
  cache: 'no-store',
  redirect: 'error',
  headers: { accept: 'application/json' },
});

const mutationOptions = (
  method: 'PUT' | 'POST' | 'DELETE',
  csrfToken: string,
  body: string,
): RequestInit => ({
  method,
  mode: 'same-origin',
  credentials: 'same-origin',
  cache: 'no-store',
  redirect: 'error',
  headers: {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-elpis-csrf': csrfToken,
  },
  body,
});

export interface GatewayClient {
  getState(): Promise<GatewayState>;
  setup(publicUrl: string): Promise<GatewayState>;
  createEnrollmentGrant(): Promise<GatewayEnrollmentGrant>;
  revokeEnrollmentGrant(id: string): Promise<GatewayEnrollmentRevoke>;
}

/** Create a fixed-path, same-origin Gateway client. */
export function createGatewayClient(
  fetcher: typeof fetch = globalThis.fetch,
): GatewayClient {
  const csrf = async (): Promise<string> => {
    const value = await checkedJson(fetcher, '/api/csrf', readOptions(), 200);
    return validateCsrfResponse(value).csrfToken;
  };
  const mutate = async (
    method: 'PUT' | 'POST' | 'DELETE',
    path: string,
    body: string,
    status: number,
  ): Promise<unknown> => {
    const token = await csrf();
    return checkedJson(
      fetcher,
      path,
      mutationOptions(method, token, body),
      status,
    );
  };
  return Object.freeze({
    async getState() {
      return validateGatewayState(
        await checkedJson(fetcher, '/api/v1/state', readOptions(), 200),
      );
    },
    async setup(publicUrl: string) {
      const canonical = validateCanonicalSetupUrl(publicUrl);
      return validateGatewayState(
        await mutate(
          'PUT',
          '/api/v1/setup',
          JSON.stringify({ publicUrl: canonical }),
          200,
        ),
      );
    },
    async createEnrollmentGrant() {
      return validateEnrollmentGrant(
        await mutate('POST', '/api/v1/enrollment-grants', '{}', 201),
      );
    },
    async revokeEnrollmentGrant(id: string) {
      if (!PUBLIC_ID.test(id))
        throw new GatewayClientError(0, 'invalid_request');
      return validateEnrollmentRevoke(
        await mutate('DELETE', '/api/v1/enrollment-grants/' + id, '{}', 200),
      );
    },
  });
}
