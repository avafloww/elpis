import type { DashboardRemoteConfig } from './config.js';
import {
  createGatewayRotationController,
  type GatewayRotationControllerOptions,
  type GatewayRotationFetch,
  type GatewayRotationMode,
  type GatewayRotationStatus,
  type GatewayRotationStatusCode,
} from './gateway-rotation.js';
import type { SecretRegistry } from './lib/secrets.js';
import type { GatewayResidentStore } from './store/gateway-resident.js';

const CODES = new Set<GatewayRotationStatusCode>([
  'ready',
  'rotating',
  'rotated',
  'invalid_state',
  'network_error',
  'http_error',
  'invalid_response',
  'state_error',
  'timeout',
  'stopped',
]);

function status(code: GatewayRotationStatusCode): GatewayRotationStatus {
  return Object.freeze({ code });
}

const READY = status('ready');
const ROTATING = status('rotating');
const INVALID_STATE = status('invalid_state');
const STATE_ERROR = status('state_error');
const STOPPED = status('stopped');

/** The one-shot controller shape consumed by the process-lifetime runtime. */
export interface GatewayRotationControllerLike {
  readonly status: GatewayRotationStatus;
  trigger(): Promise<GatewayRotationStatus>;
  resume(): Promise<GatewayRotationStatus>;
  stop(): void;
}

export type GatewayRotationControllerFactory = (
  options: GatewayRotationControllerOptions,
) => GatewayRotationControllerLike;

/** Narrow, secret-free process surface. Rotation starts only through trigger(),
 * except for replay of a rotation that was already durable at startup. */
export interface GatewayRotationRuntime {
  readonly status: GatewayRotationStatus;
  trigger(): Promise<GatewayRotationStatus>;
  stop(): void;
}

export interface StartGatewayRotationRuntimeOptions {
  readonly remote: DashboardRemoteConfig | null;
  readonly store: GatewayResidentStore;
  readonly secrets: SecretRegistry;
  readonly fetch?: GatewayRotationFetch;
  readonly factory?: GatewayRotationControllerFactory;
}

function safeStatus(value: unknown): GatewayRotationStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return STATE_ERROR;
  let code: unknown;
  try {
    code = (value as { code?: unknown }).code;
  } catch {
    return STATE_ERROR;
  }
  return typeof code === 'string' &&
    CODES.has(code as GatewayRotationStatusCode)
    ? status(code as GatewayRotationStatusCode)
    : STATE_ERROR;
}

class StartedGatewayRotationRuntime implements GatewayRotationRuntime {
  readonly #options: StartGatewayRotationRuntimeOptions;
  #current: GatewayRotationStatus = READY;
  #attempt: Promise<GatewayRotationStatus> | null = null;
  #controller: GatewayRotationControllerLike | null = null;
  #finishAttempt: ((result: GatewayRotationStatus) => void) | null = null;
  #controllerStopped = false;
  #stopped = false;

  constructor(options: StartGatewayRotationRuntimeOptions) {
    this.#options = options;
  }

  get status(): GatewayRotationStatus {
    return this.#current;
  }

  /** Startup is intentionally read-only unless a durable rotating checkpoint
   * exists. The launched replay is detached so Gateway I/O cannot delay boot. */
  resumeDurableRotation(): void {
    if (this.#stopped || this.#attempt !== null) return;
    let phase: string;
    try {
      phase = this.#options.store.read().phase;
    } catch {
      this.#current = STATE_ERROR;
      return;
    }
    if (phase === 'rotating') void this.#launch('resume');
  }

  trigger(): Promise<GatewayRotationStatus> {
    if (this.#stopped) return Promise.resolve(STOPPED);
    if (this.#attempt !== null) return this.#attempt;

    let phase: string;
    try {
      phase = this.#options.store.read().phase;
    } catch {
      this.#current = STATE_ERROR;
      return Promise.resolve(STATE_ERROR);
    }
    if (phase === 'active') return this.#launch('trigger');
    if (phase === 'rotating') return this.#launch('resume');
    this.#current = INVALID_STATE;
    return Promise.resolve(INVALID_STATE);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#current = STOPPED;
    this.#stopCurrentController();
    this.#finishAttempt?.(STOPPED);
  }

  #stopCurrentController(): void {
    if (this.#controller === null || this.#controllerStopped) return;
    this.#controllerStopped = true;
    try {
      this.#controller.stop();
    } catch {}
  }

  #launch(mode: GatewayRotationMode): Promise<GatewayRotationStatus> {
    // This guard also makes a trigger racing a startup replay join that replay.
    if (this.#stopped) return Promise.resolve(STOPPED);
    if (this.#attempt !== null) return this.#attempt;

    // Publish the attempt before invoking any injected code. A reentrant trigger
    // from a factory or fetch adapter must join, never launch a second candidate.
    let resolveAttempt!: (result: GatewayRotationStatus) => void;
    const attempt = new Promise<GatewayRotationStatus>((resolve) => {
      resolveAttempt = resolve;
    });
    this.#attempt = attempt;
    let settled = false;
    const finish = (result: GatewayRotationStatus): void => {
      if (settled) return;
      settled = true;
      this.#current = this.#stopped ? STOPPED : result;
      // Clear ownership at settlement, before promise observers run. A caller may
      // therefore retry even when factory/start failure was synchronous.
      if (this.#attempt === attempt) {
        this.#attempt = null;
        this.#controller = null;
        this.#finishAttempt = null;
        this.#controllerStopped = false;
      }
      resolveAttempt(this.#current);
    };
    this.#finishAttempt = finish;

    try {
      const factory = this.#options.factory ?? createGatewayRotationController;
      const controller = factory({
        store: this.#options.store,
        secrets: this.#options.secrets,
        fetch: this.#options.fetch ?? fetch,
        mode,
      });
      this.#controller = controller;
      this.#controllerStopped = false;
      if (
        !controller ||
        typeof controller.trigger !== 'function' ||
        typeof controller.resume !== 'function' ||
        typeof controller.stop !== 'function'
      )
        throw new TypeError(
          'gateway rotation factory returned an invalid controller',
        );
      if (this.#stopped) {
        this.#stopCurrentController();
        finish(STOPPED);
      } else {
        this.#current = ROTATING;
        const result =
          mode === 'trigger' ? controller.trigger() : controller.resume();
        void Promise.resolve(result).then(
          (value) => finish(safeStatus(value)),
          () => {
            this.#stopCurrentController();
            finish(STATE_ERROR);
          },
        );
      }
    } catch {
      this.#stopCurrentController();
      finish(STATE_ERROR);
    }

    return attempt;
  }
}

/** Returns null without reading durable state or constructing a controller when
 * this resident has no remote Gateway configuration. */
export function startGatewayRotationRuntime(
  options: StartGatewayRotationRuntimeOptions,
): GatewayRotationRuntime | null {
  if (options.remote === null) return null;
  const runtime = new StartedGatewayRotationRuntime(options);
  runtime.resumeDurableRotation();
  return runtime;
}
