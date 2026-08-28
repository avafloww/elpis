import type {
  GatewayToResidentFrame,
  ResidentMediaResultEffect,
  ViewerOperationFrame,
} from '@elpis/gateway-protocol';
import type { ConsoleHub, HubClient } from './console/hub.js';
import type {
  ConsoleMediaFailure,
  ConsoleMediaReader,
} from './console/media.js';
import type { GatewayLinkEffectSink } from './gateway-link.js';

/** The ConsoleHub surface used by a remote resident viewer. */
export type GatewayConsoleHub = Pick<
  ConsoleHub,
  'addClient' | 'removeClient' | 'sendSnapshot' | 'handleClientMessage'
>;

export interface GatewayConsoleBridgeOptions {
  readonly hub: GatewayConsoleHub;
  readonly media: ConsoleMediaReader;
}

const MEDIA_ERRORS: Readonly<
  Record<
    ConsoleMediaFailure,
    { readonly code: string; readonly message: string }
  >
> = Object.freeze({
  invalid_route: Object.freeze({
    code: 'invalid_route',
    message: 'media route is invalid',
  }),
  not_found: Object.freeze({
    code: 'not_found',
    message: 'media was not found',
  }),
  too_large: Object.freeze({
    code: 'too_large',
    message: 'media exceeds the size limit',
  }),
});

const UNAVAILABLE = Object.freeze({
  code: 'unavailable',
  message: 'console viewer is unavailable',
});
const MEDIA_UNAVAILABLE = Object.freeze({
  code: 'unavailable',
  message: 'media could not be read',
});

/**
 * A HubClient whose only authority is one generation-bound resident effect
 * writer. It deliberately has no transport or protocol-session access.
 */
class RemoteHubClient implements HubClient {
  readonly #viewerId: ViewerOperationFrame['viewerId'];
  readonly #effects: GatewayLinkEffectSink;
  readonly #onWriteFailure: (client: RemoteHubClient) => void;
  #closed = false;

  constructor(
    viewerId: ViewerOperationFrame['viewerId'],
    effects: GatewayLinkEffectSink,
    onWriteFailure: (client: RemoteHubClient) => void,
  ) {
    this.#viewerId = viewerId;
    this.#effects = effects;
    this.#onWriteFailure = onWriteFailure;
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(payload: string): void {
    if (this.#closed) throw new Error('remote console viewer is closed');
    let written = false;
    try {
      written = this.#effects.consoleOutput({
        viewerId: this.#viewerId,
        payload,
      });
    } catch {}
    if (written) return;
    this.#closed = true;
    this.#onWriteFailure(this);
    throw new Error('remote console output was not written');
  }

  close(): void {
    this.#closed = true;
  }
}

/**
 * Maps one accepted Gateway link generation onto ConsoleHub clients and bounded
 * media reads. Every await is fenced by a bridge generation; disconnecting or
 * stopping closes and detaches clients before stale work can emit an effect.
 */
export class GatewayConsoleBridge {
  readonly #hub: GatewayConsoleHub;
  readonly #media: ConsoleMediaReader;
  readonly #viewers = new Map<
    ViewerOperationFrame['viewerId'],
    RemoteHubClient
  >();
  #generation = 1;
  #stopped = false;

  constructor(options: GatewayConsoleBridgeOptions) {
    if (
      !options ||
      !options.hub ||
      typeof options.hub.addClient !== 'function' ||
      typeof options.hub.removeClient !== 'function' ||
      typeof options.hub.sendSnapshot !== 'function' ||
      typeof options.hub.handleClientMessage !== 'function' ||
      !options.media ||
      typeof options.media.read !== 'function'
    )
      throw new TypeError('gateway console bridge options are invalid');
    this.#hub = options.hub;
    this.#media = options.media;
  }

  /** Dispatch one post-ack frame from the current resident link. */
  handleFrame(
    frame: GatewayToResidentFrame,
    effects: GatewayLinkEffectSink,
  ): void {
    if (this.#stopped) return;
    switch (frame.type) {
      case 'viewer.open':
        this.#open(frame, effects);
        return;
      case 'viewer.close':
        this.#close(frame, effects);
        return;
      case 'viewer.snapshot':
        this.#snapshot(frame, effects);
        return;
      case 'console.input': {
        const client = this.#viewers.get(frame.viewerId);
        if (client && !client.closed)
          this.#hub.handleClientMessage(client, frame.payload);
        return;
      }
      case 'media.get':
        this.#readMedia(frame.requestId, frame.route, effects);
        return;
      default:
        return;
    }
  }

  /** Detach one ended link while allowing a later reconnect generation. */
  disconnect(): void {
    if (this.#stopped) return;
    this.#generation += 1;
    this.#detachAll();
  }

  /** Permanently fence the bridge and detach every remote viewer. */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    this.#detachAll();
  }

  #open(frame: ViewerOperationFrame, effects: GatewayLinkEffectSink): void {
    if (this.#viewers.has(frame.viewerId)) {
      this.#operation(effects, frame, false, UNAVAILABLE);
      return;
    }
    const generation = this.#generation;
    const client = new RemoteHubClient(frame.viewerId, effects, (failed) => {
      if (this.#viewers.get(frame.viewerId) !== failed) return;
      this.#viewers.delete(frame.viewerId);
      this.#detachHub(failed);
    });
    this.#viewers.set(frame.viewerId, client);

    // The session recognizes a viewer only after its successful open result.
    // Emit that result before attaching, since addClient starts an async snapshot
    // which ultimately writes console.output for the new viewer.
    if (!this.#operation(effects, frame, true)) {
      this.#remove(frame.viewerId, client);
      return;
    }
    // A hostile transport adapter can synchronously re-enter while the result is
    // written. Do not attach if that re-entry already closed or reset this viewer.
    if (
      !this.#isCurrent(generation) ||
      client.closed ||
      this.#viewers.get(frame.viewerId) !== client
    )
      return;
    let attaching: Promise<void>;
    try {
      attaching = Promise.resolve(this.#hub.addClient(client));
    } catch {
      this.#remove(frame.viewerId, client);
      return;
    }
    void attaching.then(
      () => {
        // ConsoleHub attaches synchronously, but retain the fence at this
        // structural seam too: a deferred hub must not add a ghost client after
        // disconnect or a same-id reconnect.
        if (
          !this.#isCurrent(generation) ||
          this.#viewers.get(frame.viewerId) !== client ||
          client.closed
        )
          this.#remove(frame.viewerId, client);
      },
      () => this.#remove(frame.viewerId, client),
    );
  }

  #close(frame: ViewerOperationFrame, effects: GatewayLinkEffectSink): void {
    const client = this.#viewers.get(frame.viewerId);
    if (!client) {
      this.#operation(effects, frame, false, UNAVAILABLE);
      return;
    }
    this.#remove(frame.viewerId, client);
    this.#operation(effects, frame, true);
  }

  #snapshot(frame: ViewerOperationFrame, effects: GatewayLinkEffectSink): void {
    const client = this.#viewers.get(frame.viewerId);
    if (!client || client.closed) {
      this.#operation(effects, frame, false, UNAVAILABLE);
      return;
    }
    const generation = this.#generation;
    // The snapshot output must reach the typed writer before its correlated
    // operation result, so Gateway can use that result as a fresh-state barrier.
    void this.#hub.sendSnapshot(client).then(
      (sent) => {
        if (
          !this.#isCurrent(generation) ||
          this.#viewers.get(frame.viewerId) !== client
        )
          return;
        if (!sent) this.#remove(frame.viewerId, client);
        this.#operation(effects, frame, sent, sent ? undefined : UNAVAILABLE);
      },
      () => {
        if (!this.#isCurrent(generation)) return;
        this.#remove(frame.viewerId, client);
        this.#operation(effects, frame, false, UNAVAILABLE);
      },
    );
  }

  #operation(
    effects: GatewayLinkEffectSink,
    frame: ViewerOperationFrame,
    ok: boolean,
    error?: { readonly code: string; readonly message: string },
  ): boolean {
    try {
      return effects.operationResult({
        requestId: frame.requestId,
        viewerId: frame.viewerId,
        operation: frame.type,
        ok,
        ...(ok ? {} : { error: error ?? UNAVAILABLE }),
      });
    } catch {
      return false;
    }
  }

  #readMedia(
    requestId: Extract<
      GatewayToResidentFrame,
      { type: 'media.get' }
    >['requestId'],
    route: string,
    effects: GatewayLinkEffectSink,
  ): void {
    const generation = this.#generation;
    void Promise.resolve()
      .then(() => this.#media.read(route))
      .then(
        (result) => {
          if (!this.#isCurrent(generation)) return;
          let effect: ResidentMediaResultEffect;
          if (result.ok) {
            effect = {
              requestId,
              ok: true,
              mediaType: result.mediaType,
              byteLength: result.byteLength,
              sha256: result.sha256,
              data: result.bytes.toString('base64'),
            };
          } else {
            effect = {
              requestId,
              ok: false,
              error: MEDIA_ERRORS[result.reason],
            };
          }
          try {
            effects.mediaResult(effect);
          } catch {}
        },
        () => {
          if (!this.#isCurrent(generation)) return;
          try {
            effects.mediaResult({
              requestId,
              ok: false,
              error: MEDIA_UNAVAILABLE,
            });
          } catch {}
        },
      );
  }

  #remove(
    viewerId: ViewerOperationFrame['viewerId'],
    client: RemoteHubClient,
  ): void {
    if (this.#viewers.get(viewerId) === client) this.#viewers.delete(viewerId);
    client.close();
    this.#detachHub(client);
  }

  #detachAll(): void {
    const clients = [...this.#viewers.values()];
    this.#viewers.clear();
    // Mark all closed before invoking the hub so any in-flight snapshot observes
    // the fence even if a hostile dependency re-enters during removal.
    for (const client of clients) client.close();
    for (const client of clients) this.#detachHub(client);
  }

  #detachHub(client: RemoteHubClient): void {
    try {
      this.#hub.removeClient(client);
    } catch {}
  }

  #isCurrent(generation: number): boolean {
    return !this.#stopped && generation === this.#generation;
  }
}

export function createGatewayConsoleBridge(
  options: GatewayConsoleBridgeOptions,
): GatewayConsoleBridge {
  return new GatewayConsoleBridge(options);
}
