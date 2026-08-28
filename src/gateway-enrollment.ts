import {
  RESIDENT_CONTROL_LIMITS,
  RESIDENT_CONTROL_PATHS,
  decodeResidentEnrollmentResult,
  serializeResidentEnrollmentRequest,
  serializeResidentEnrollmentResult,
} from '@elpis/gateway-protocol';
import type { DashboardRemoteConfig } from './config.js';
import { SecretRegistry } from './lib/secrets.js';
import {
  GatewayResidentStateError,
  GatewayResidentStore,
} from './store/gateway-resident.js';

export const GATEWAY_ENROLLMENT_TIMEOUT_MS = 10_000;
export const GATEWAY_ENROLLMENT_MAX_TIMEOUT_MS = 300_000;

export type GatewayEnrollmentStatusCode =
  | 'ready'
  | 'enrolling'
  | 'enrolled'
  | 'active'
  | 'not_configured'
  | 'token_required'
  | 'configuration_conflict'
  | 'invalid_configuration'
  | 'invalid_state'
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  | 'state_error'
  | 'timeout'
  | 'stopped';

/** Deliberately contains no endpoint, response text, exception, or credential. */
export interface GatewayEnrollmentStatus {
  readonly code: GatewayEnrollmentStatusCode;
}
export type GatewayEnrollmentFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;
export interface GatewayEnrollmentControllerOptions {
  readonly store: GatewayResidentStore;
  readonly secrets: SecretRegistry;
  readonly remote: DashboardRemoteConfig | null;
  readonly displayName: string;
  readonly fetch: GatewayEnrollmentFetch;
  readonly timeoutMs?: number;
}
type PreparedEnrollment = Readonly<{ endpoint: string; body: string }>;
type ReadFailure = 'aborted' | 'invalid';
const ABORTED = Symbol('gateway enrollment aborted');

function status(code: GatewayEnrollmentStatusCode): GatewayEnrollmentStatus {
  return Object.freeze({ code });
}
function timeout(value: number | undefined): number {
  const timeoutMs = value ?? GATEWAY_ENROLLMENT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > GATEWAY_ENROLLMENT_MAX_TIMEOUT_MS
  )
    throw new TypeError('gateway enrollment timeout is out of bounds');
  return timeoutMs;
}
function registerStoredSecrets(
  store: GatewayResidentStore,
  registry: SecretRegistry,
): void {
  for (const value of store.secretValues()) registry.register(value);
}
function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {}
}
function exactContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : -1;
}

async function readBoundedBody(
  response: Response,
  signal: AbortSignal,
): Promise<Uint8Array | ReadFailure> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    if (response.body === null) return 'invalid';
    reader = response.body.getReader();
  } catch {
    return 'invalid';
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort: ((reason: typeof ABORTED) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    try {
      void reader.cancel().catch(() => {});
    } catch {}
    rejectAbort?.(ABORTED);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) return 'aborted';
    for (;;) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await Promise.race([reader.read(), aborted]);
      } catch {
        return signal.aborted ? 'aborted' : 'invalid';
      }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) return 'invalid';
      size += item.value.byteLength;
      if (size > RESIDENT_CONTROL_LIMITS.bodyBytes) {
        try {
          void reader.cancel().catch(() => {});
        } catch {}
        return 'invalid';
      }
      chunks.push(Uint8Array.from(item.value));
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {}
  }
  const expected = exactContentLength(response.headers.get('content-length'));
  if (expected === -1 || (expected !== null && expected !== size))
    return 'invalid';
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function stateFailure(error: unknown): GatewayEnrollmentStatus {
  if (error instanceof GatewayResidentStateError) {
    if (error.code === 'conflict') return status('configuration_conflict');
    if (error.code === 'invalid_input') return status('invalid_configuration');
    if (error.code === 'invalid_state') return status('invalid_state');
  }
  return status('state_error');
}

/** One-shot enrollment. Durable preparation and redaction registration happen
 * synchronously before the injected fetch is invoked. */
export class GatewayEnrollmentController {
  readonly #store: GatewayResidentStore;
  readonly #secrets: SecretRegistry;
  readonly #remote: DashboardRemoteConfig | null;
  readonly #displayName: string;
  readonly #fetch: GatewayEnrollmentFetch;
  readonly #timeoutMs: number;
  #current = status('ready');
  #started = false;
  #stopRequested = false;
  #abort: AbortController | null = null;
  #attempt: Promise<GatewayEnrollmentStatus> | null = null;

  constructor(options: GatewayEnrollmentControllerOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    this.#remote = options.remote;
    this.#displayName = options.displayName;
    if (typeof options.fetch !== 'function')
      throw new TypeError('gateway enrollment fetch must be a function');
    this.#fetch = options.fetch;
    this.#timeoutMs = timeout(options.timeoutMs);
  }
  get status(): GatewayEnrollmentStatus {
    return this.#current;
  }

  start(): Promise<GatewayEnrollmentStatus> {
    if (this.#attempt !== null) return this.#attempt;
    if (this.#started) return Promise.resolve(this.#current);
    this.#started = true;
    if (this.#stopRequested) {
      this.#current = status('stopped');
      return Promise.resolve(this.#current);
    }
    let prepared: PreparedEnrollment | GatewayEnrollmentStatus;
    try {
      prepared = this.#prepare();
    } catch (error) {
      this.#current = stateFailure(error);
      return Promise.resolve(this.#current);
    }
    if ('code' in prepared) {
      this.#current = prepared;
      return Promise.resolve(prepared);
    }
    const abort = new AbortController();
    this.#abort = abort;
    this.#current = status('enrolling');
    const timer = setTimeout(() => abort.abort(ABORTED), this.#timeoutMs);
    timer.unref?.();
    const attempt = this.#post(prepared, abort.signal)
      .catch(() =>
        status(
          abort.signal.aborted
            ? this.#stopRequested
              ? 'stopped'
              : 'timeout'
            : 'state_error',
        ),
      )
      .then((result) => {
        this.#current = result;
        return result;
      })
      .finally(() => {
        clearTimeout(timer);
        this.#abort = null;
      });
    this.#attempt = attempt;
    return attempt;
  }
  stop(): void {
    this.#stopRequested = true;
    this.#abort?.abort(ABORTED);
  }

  #prepare(): PreparedEnrollment | GatewayEnrollmentStatus {
    registerStoredSecrets(this.#store, this.#secrets);
    const snapshot = this.#store.read();
    if (snapshot.phase === 'active') return status('active');
    if (snapshot.phase !== 'idle' && snapshot.phase !== 'enrolling')
      return status('invalid_state');
    if (this.#remote === null) return status('not_configured');
    let endpoint: string;
    let configuredToken: string | null;
    try {
      endpoint = this.#remote.url;
      configuredToken = this.#remote.enrollmentToken;
    } catch {
      return status('invalid_configuration');
    }
    if (snapshot.phase === 'idle') {
      if (configuredToken === null) return status('token_required');
      this.#store.beginEnrollment({
        endpoint,
        grantToken: configuredToken,
        displayName: this.#displayName,
      });
    } else {
      const persisted = this.#store.enrollmentRequest();
      if (snapshot.endpoint === null || snapshot.displayName === null)
        throw new GatewayResidentStateError('corrupt_state');
      if (
        endpoint !== snapshot.endpoint ||
        (configuredToken !== null && configuredToken !== persisted.grantToken)
      )
        return status('configuration_conflict');
      // Re-enter the store only with its persisted tuple; config cannot replace it.
      this.#store.beginEnrollment({
        endpoint: snapshot.endpoint,
        grantToken: persisted.grantToken,
        displayName: snapshot.displayName,
      });
    }
    registerStoredSecrets(this.#store, this.#secrets);
    const enrolled = this.#store.read();
    const request = this.#store.enrollmentRequest();
    if (enrolled.endpoint === null)
      throw new GatewayResidentStateError('corrupt_state');
    return Object.freeze({
      endpoint: enrolled.endpoint,
      body: serializeResidentEnrollmentRequest(request),
    });
  }

  async #post(
    prepared: PreparedEnrollment,
    signal: AbortSignal,
  ): Promise<GatewayEnrollmentStatus> {
    const target = prepared.endpoint + RESIDENT_CONTROL_PATHS.enrollment;
    let response: Response;
    try {
      const request = this.#fetch(target, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          'content-type': 'application/json; charset=utf-8',
        },
        body: prepared.body,
        redirect: 'error',
        signal,
      });
      let rejectAbort: ((reason: typeof ABORTED) => void) | undefined;
      const onAbort = () => rejectAbort?.(ABORTED);
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        response = await Promise.race([request, aborted]);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    } catch {
      if (signal.aborted)
        return status(this.#stopRequested ? 'stopped' : 'timeout');
      return status('network_error');
    }
    if (signal.aborted) {
      cancelBody(response);
      return status(this.#stopRequested ? 'stopped' : 'timeout');
    }
    try {
      if (
        response.redirected === true ||
        response.type === 'opaqueredirect' ||
        (response.url !== '' && response.url !== target)
      ) {
        cancelBody(response);
        return status('invalid_response');
      }
      if (response.headers.get('content-encoding') !== null) {
        cancelBody(response);
        return status('invalid_response');
      }
      const announced = exactContentLength(
        response.headers.get('content-length'),
      );
      if (
        announced === -1 ||
        (announced !== null && announced > RESIDENT_CONTROL_LIMITS.bodyBytes)
      ) {
        cancelBody(response);
        return status('invalid_response');
      }
      if (response.status !== 200 && response.status !== 201) {
        cancelBody(response);
        return status('http_error');
      }
      if (
        response.headers.get('content-type') !==
        'application/json; charset=utf-8'
      ) {
        cancelBody(response);
        return status('invalid_response');
      }
      const body = await readBoundedBody(response, signal);
      if (body === 'aborted' || signal.aborted)
        return status(this.#stopRequested ? 'stopped' : 'timeout');
      if (body === 'invalid') return status('invalid_response');
      let result: ReturnType<typeof decodeResidentEnrollmentResult>;
      try {
        result = decodeResidentEnrollmentResult(body);
        const canonical = Buffer.from(
          serializeResidentEnrollmentResult(result),
          'utf8',
        );
        if (!canonical.equals(Buffer.from(body)))
          return status('invalid_response');
      } catch {
        return status('invalid_response');
      }
      if (response.status !== (result.replayed ? 200 : 201))
        return status('invalid_response');
      try {
        this.#store.activateEnrollment(result);
      } catch (error) {
        if (
          error instanceof GatewayResidentStateError &&
          (error.code === 'conflict' || error.code === 'invalid_input')
        )
          return status('invalid_response');
        return status('state_error');
      }
      return status('enrolled');
    } catch {
      if (signal.aborted)
        return status(this.#stopRequested ? 'stopped' : 'timeout');
      return status('invalid_response');
    }
  }
}

export function createGatewayEnrollmentController(
  options: GatewayEnrollmentControllerOptions,
): GatewayEnrollmentController {
  return new GatewayEnrollmentController(options);
}
