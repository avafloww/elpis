import type { BuildMetadata, ResidentIdentity } from '@elpis/gateway-protocol';
import type { DashboardRemoteConfig } from './config.js';
import {
  createGatewayLinkController,
  type GatewayLinkControllerOptions,
  type GatewayLinkState,
  type GatewayLinkStatus,
  type GatewayLinkStoreView,
} from './gateway-link.js';

const STATES = new Set<GatewayLinkState>([
  'idle',
  'not_configured',
  'waiting_for_enrollment',
  'configuration_error',
  'connecting',
  'handshaking',
  'ready',
  'backoff',
  'faulted',
  'stopped',
]);
const FAULTED = Object.freeze({ state: 'faulted', failures: 0 } as const);

export interface GatewayLinkControllerLike {
  readonly status: GatewayLinkStatus;
  start(): void;
  stop(): void;
}

export type GatewayLinkControllerFactory = (
  options: GatewayLinkControllerOptions,
) => GatewayLinkControllerLike;

export interface GatewayLinkRuntime {
  readonly status: GatewayLinkStatus;
  stop(): void;
}

export interface GatewayControlStoppable {
  stop(): void;
}

export interface StartGatewayLinkRuntimeOptions {
  readonly remote: DashboardRemoteConfig | null;
  readonly store: GatewayLinkStoreView;
  readonly identity: ResidentIdentity;
  readonly build: BuildMetadata;
  readonly factory?: GatewayLinkControllerFactory;
  readonly onStatus?: (status: GatewayLinkStatus) => void;
}

function safeStatus(value: unknown): GatewayLinkStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return FAULTED;
  let state: unknown;
  let failures: unknown;
  try {
    state = (value as { state?: unknown }).state;
    failures = (value as { failures?: unknown }).failures;
  } catch {
    return FAULTED;
  }
  if (
    typeof state !== 'string' ||
    !STATES.has(state as GatewayLinkState) ||
    !Number.isSafeInteger(failures) ||
    (failures as number) < 0 ||
    (failures as number) > 31
  )
    return FAULTED;
  return Object.freeze({
    state: state as GatewayLinkState,
    failures: failures as number,
  });
}

class StartedGatewayLinkRuntime implements GatewayLinkRuntime {
  readonly #controller: GatewayLinkControllerLike;
  #stopped = false;

  constructor(controller: GatewayLinkControllerLike) {
    this.#controller = controller;
  }

  get status(): GatewayLinkStatus {
    try {
      return safeStatus(this.#controller.status);
    } catch {
      return FAULTED;
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      this.#controller.stop();
    } catch {}
  }
}

class FaultedGatewayLinkRuntime implements GatewayLinkRuntime {
  readonly status = FAULTED;
  stop(): void {}
}

export function stopGatewayControlPlane(
  rotation: GatewayControlStoppable | null,
  enrollment: GatewayControlStoppable,
  link: GatewayLinkRuntime | null,
): void {
  try {
    rotation?.stop();
  } catch {}
  try {
    enrollment.stop();
  } catch {}
  try {
    link?.stop();
  } catch {}
}

export function startGatewayLinkRuntime(
  options: StartGatewayLinkRuntimeOptions,
): GatewayLinkRuntime | null {
  if (options.remote === null) return null;
  let lastStatus: GatewayLinkStatus | null = null;
  const emit = (value: unknown): void => {
    const status = safeStatus(value);
    if (
      lastStatus?.state === status.state &&
      lastStatus.failures === status.failures
    )
      return;
    lastStatus = status;
    try {
      options.onStatus?.(status);
    } catch {}
  };
  let controller: GatewayLinkControllerLike | null = null;
  try {
    const factory = options.factory ?? createGatewayLinkController;
    controller = factory({
      remote: options.remote,
      store: options.store,
      identity: options.identity,
      build: options.build,
      events: { status: emit },
    });
    if (
      !controller ||
      typeof controller.start !== 'function' ||
      typeof controller.stop !== 'function'
    )
      throw new TypeError(
        'gateway link factory returned an invalid controller',
      );
    controller.start();
    return new StartedGatewayLinkRuntime(controller);
  } catch {
    try {
      controller?.stop();
    } catch {}
    emit(FAULTED);
    return new FaultedGatewayLinkRuntime();
  }
}
