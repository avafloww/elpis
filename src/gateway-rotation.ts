import {
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_LIMITS,
  RESIDENT_CONTROL_PATHS,
  decodeResidentRotationResult,
  formatNodeBearerAuthorization,
  serializeResidentRotationActivationRequest,
  serializeResidentRotationRequest,
  serializeResidentRotationResult,
} from '@elpis/gateway-protocol';
import { SecretRegistry } from './lib/secrets.js';
import {
  GatewayResidentStateError,
  GatewayResidentStore,
} from './store/gateway-resident.js';

export const GATEWAY_ROTATION_TIMEOUT_MS = 10_000;
export const GATEWAY_ROTATION_MAX_TIMEOUT_MS = 300_000;

export type GatewayRotationMode = 'trigger' | 'resume';
export type GatewayRotationStatusCode =
  | 'ready'
  | 'rotating'
  | 'rotated'
  | 'invalid_state'
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  | 'state_error'
  | 'timeout'
  | 'stopped';

/** Deliberately contains no endpoint, response, exception, token, or verifier. */
export interface GatewayRotationStatus {
  readonly code: GatewayRotationStatusCode;
}
export type GatewayRotationFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;
export interface GatewayRotationControllerOptions {
  readonly store: GatewayResidentStore;
  readonly secrets: SecretRegistry;
  readonly fetch: GatewayRotationFetch;
  /** Resume is the safe default for controllers launched during startup. */
  readonly mode?: GatewayRotationMode;
  readonly timeoutMs?: number;
}

type RotationStep = 'proposal' | 'activation';
type PreparedRotation = Readonly<{
  endpoint: string;
  target: string;
  authorization: string;
  body: string;
  step: RotationStep;
}>;
type ReadFailure = 'aborted' | 'invalid';
const ABORTED = Symbol('gateway rotation aborted');

function status(code: GatewayRotationStatusCode): GatewayRotationStatus {
  return Object.freeze({ code });
}
function timeout(value: number | undefined): number {
  const timeoutMs = value ?? GATEWAY_ROTATION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > GATEWAY_ROTATION_MAX_TIMEOUT_MS
  )
    throw new TypeError('gateway rotation timeout is out of bounds');
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
function stateFailure(error: unknown): GatewayRotationStatus {
  if (
    error instanceof GatewayResidentStateError &&
    error.code === 'invalid_state'
  )
    return status('invalid_state');
  return status('state_error');
}

/** Bounded one-shot credential rotation. Trigger mode is an explicit mutation;
 * resume mode only consumes an already durable rotating state. */
export class GatewayRotationController {
  readonly #store: GatewayResidentStore;
  readonly #secrets: SecretRegistry;
  readonly #fetch: GatewayRotationFetch;
  readonly #mode: GatewayRotationMode;
  readonly #timeoutMs: number;
  #current = status('ready');
  #started = false;
  #stopRequested = false;
  #abort: AbortController | null = null;
  #attempt: Promise<GatewayRotationStatus> | null = null;

  constructor(options: GatewayRotationControllerOptions) {
    this.#store = options.store;
    this.#secrets = options.secrets;
    if (typeof options.fetch !== 'function')
      throw new TypeError('gateway rotation fetch must be a function');
    this.#fetch = options.fetch;
    this.#mode = options.mode ?? 'resume';
    if (this.#mode !== 'trigger' && this.#mode !== 'resume')
      throw new TypeError('gateway rotation mode is invalid');
    this.#timeoutMs = timeout(options.timeoutMs);
  }
  get status(): GatewayRotationStatus {
    return this.#current;
  }
  start(
    mode: GatewayRotationMode = this.#mode,
  ): Promise<GatewayRotationStatus> {
    if (this.#attempt !== null) return this.#attempt;
    if (this.#started) return Promise.resolve(this.#current);
    this.#started = true;
    if (mode !== 'trigger' && mode !== 'resume') {
      this.#current = status('invalid_state');
      return Promise.resolve(this.#current);
    }
    if (this.#stopRequested) {
      this.#current = status('stopped');
      return Promise.resolve(this.#current);
    }
    try {
      registerStoredSecrets(this.#store, this.#secrets);
      const before = this.#store.read();
      if (mode === 'trigger') {
        if (before.phase !== 'active') {
          this.#current = status('invalid_state');
          return Promise.resolve(this.#current);
        }
        this.#store.beginRotation();
        // beginRotation generated the pending token; redact it before fetch.
        registerStoredSecrets(this.#store, this.#secrets);
      } else if (before.phase !== 'rotating') {
        this.#current = status('invalid_state');
        return Promise.resolve(this.#current);
      }
    } catch (error) {
      this.#current = stateFailure(error);
      return Promise.resolve(this.#current);
    }
    const abort = new AbortController();
    this.#abort = abort;
    this.#current = status('rotating');
    const timer = setTimeout(() => abort.abort(ABORTED), this.#timeoutMs);
    timer.unref?.();
    const attempt = this.#run(abort.signal)
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
  trigger(): Promise<GatewayRotationStatus> {
    return this.start('trigger');
  }
  resume(): Promise<GatewayRotationStatus> {
    return this.start('resume');
  }
  stop(): void {
    this.#stopRequested = true;
    this.#abort?.abort(ABORTED);
  }

  #prepare(): PreparedRotation {
    registerStoredSecrets(this.#store, this.#secrets);
    const snapshot = this.#store.read();
    if (
      snapshot.phase !== 'rotating' ||
      snapshot.endpoint === null ||
      snapshot.requestId === null
    )
      throw new GatewayResidentStateError('invalid_state');
    if (snapshot.rotationProposedAt === null) {
      return Object.freeze({
        endpoint: snapshot.endpoint,
        target: RESIDENT_CONTROL_PATHS.rotation,
        authorization: formatNodeBearerAuthorization(
          this.#store.activeNodeToken(),
        ),
        body: serializeResidentRotationRequest(this.#store.rotationRequest()),
        step: 'proposal',
      });
    }
    const request = this.#store.rotationRequest();
    return Object.freeze({
      endpoint: snapshot.endpoint,
      target: RESIDENT_CONTROL_PATHS.rotationActivation,
      authorization: formatNodeBearerAuthorization(
        this.#store.pendingNodeToken(),
      ),
      body: serializeResidentRotationActivationRequest({
        format: RESIDENT_CONTROL_FORMATS.rotationActivationRequest,
        requestId: request.requestId,
      }),
      step: 'activation',
    });
  }

  async #run(signal: AbortSignal): Promise<GatewayRotationStatus> {
    for (;;) {
      if (signal.aborted)
        return status(this.#stopRequested ? 'stopped' : 'timeout');
      let prepared: PreparedRotation;
      try {
        prepared = this.#prepare();
      } catch (error) {
        return stateFailure(error);
      }
      const result = await this.#post(prepared, signal);
      if ('code' in result) return result;
      if (signal.aborted)
        return status(this.#stopRequested ? 'stopped' : 'timeout');
      try {
        if (prepared.step === 'proposal') {
          this.#store.markRotationProposed(result);
          // Continue immediately with pending-bearer activation. The checkpoint
          // makes interruption at this boundary restart-safe.
          continue;
        }
        this.#store.activateRotation(result);
      } catch (error) {
        if (
          error instanceof GatewayResidentStateError &&
          (error.code === 'conflict' || error.code === 'invalid_input')
        )
          return status('invalid_response');
        return status('state_error');
      }
      return status('rotated');
    }
  }

  async #post(
    prepared: PreparedRotation,
    signal: AbortSignal,
  ): Promise<
    GatewayRotationStatus | ReturnType<typeof decodeResidentRotationResult>
  > {
    const target = prepared.endpoint + prepared.target;
    let response: Response;
    try {
      const request = this.#fetch(target, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'identity',
          authorization: prepared.authorization,
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
      // Fetch implementations may synchronously call stop before returning their
      // promise, so observe an abort that preceded listener installation.
      if (signal.aborted) rejectAbort?.(ABORTED);
      void request.then(
        (late) => {
          if (signal.aborted) cancelBody(late);
        },
        () => {},
      );
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
      let result: ReturnType<typeof decodeResidentRotationResult>;
      try {
        result = decodeResidentRotationResult(body);
        const canonical = Buffer.from(
          serializeResidentRotationResult(result),
          'utf8',
        );
        if (!canonical.equals(Buffer.from(body)))
          return status('invalid_response');
      } catch {
        return status('invalid_response');
      }
      const expectedStatus =
        prepared.step === 'activation' || result.replayed ? 200 : 201;
      if (response.status !== expectedStatus) return status('invalid_response');
      return result;
    } catch {
      if (signal.aborted)
        return status(this.#stopRequested ? 'stopped' : 'timeout');
      return status('invalid_response');
    }
  }
}

export function createGatewayRotationController(
  options: GatewayRotationControllerOptions,
): GatewayRotationController {
  return new GatewayRotationController(options);
}
