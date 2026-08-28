import {
  LIMITS,
  PROTOCOL_VERSION,
  newRequestId,
  newViewerId,
  serializeGatewayFrame,
  type ConsoleOutputFrame,
  type InstanceId,
  type MediaResultFrame,
  type RequestId,
  type ResidentToGatewayFrame,
  type ViewerId,
} from '@elpis/gateway-protocol';
import {
  type GatewayResidentLinkEvent,
  type GatewayResidentLinkSummary,
  GatewayResidentLinkRegistry,
} from './resident-link-registry.js';

export type GatewaySelectedViewerPhase =
  'idle' | 'opening' | 'snapshotting' | 'ready' | 'closed';

export interface GatewaySelectedViewerState {
  readonly generation: number;
  readonly phase: GatewaySelectedViewerPhase;
  readonly instanceId?: string;
  readonly connectionId?: string;
  readonly linkGeneration?: number;
  readonly viewerId?: ViewerId;
}

export type GatewaySelectedViewerSelectionReason =
  | 'selected'
  | 'snapshot'
  | 'ready'
  | 'deselected'
  | 'unavailable'
  | 'operation_failed'
  | 'link_removed'
  | 'backpressure'
  | 'disconnected';

export interface GatewaySelectedViewerSelectionEvent extends GatewaySelectedViewerState {
  readonly reason: GatewaySelectedViewerSelectionReason;
}

export interface GatewaySelectedViewerBrokerOptions {
  readonly registry: GatewayResidentLinkRegistry;
  /** Return false when the browser-side transport cannot accept more output. */
  readonly onConsoleOutput: (
    frame: ConsoleOutputFrame,
    state: GatewaySelectedViewerState,
  ) => boolean | void;
  /** Media results are delivered only for requests made by this viewer generation. */
  readonly onMediaResult?: (
    frame: MediaResultFrame,
    state: GatewaySelectedViewerState,
  ) => boolean | void;
  /** Optional transport-neutral state notification. It is not an audit sink. */
  readonly onSelection?: (event: GatewaySelectedViewerSelectionEvent) => void;
  readonly createViewerId?: () => ViewerId;
  readonly createRequestId?: () => RequestId;
  readonly maxSnapshotBufferBytes?: number;
  readonly maxSnapshotBufferFrames?: number;
}

type ActiveSelection = {
  readonly generation: number;
  readonly instanceId: string;
  readonly connectionId: GatewayResidentLinkSummary['connectionId'];
  readonly linkGeneration: number;
  readonly viewerId: ViewerId;
  phase: 'opening' | 'snapshotting' | 'ready';
  operationRequestId?: RequestId;
  buffered: ConsoleOutputFrame[];
  bufferedBytes: number;
};

type PendingRequest = {
  readonly generation: number;
  readonly instanceId: string;
  readonly connectionId: GatewayResidentLinkSummary['connectionId'];
  readonly linkGeneration: number;
  readonly kind: 'open' | 'snapshot' | 'close' | 'media';
};

const utf8 = new TextEncoder();
const VIEWER_ID = /^egv1\.[A-Za-z0-9_-]{22}$/;
const REQUEST_ID = /^egr1\.[A-Za-z0-9_-]{22}$/;

function bounded(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new TypeError(label + ' is outside its allowed range');
  return value;
}

/**
 * Pure selected-viewer state over an authenticated resident registry. One
 * broker represents one browser viewer and never owns HTTP or socket details.
 * Every resident result is fenced by both registry and selection generations.
 */
export class GatewaySelectedViewerBroker {
  readonly #registry: GatewayResidentLinkRegistry;
  readonly #onConsoleOutput: GatewaySelectedViewerBrokerOptions['onConsoleOutput'];
  readonly #onMediaResult?: GatewaySelectedViewerBrokerOptions['onMediaResult'];
  readonly #onSelection?: GatewaySelectedViewerBrokerOptions['onSelection'];
  readonly #createViewerId: () => ViewerId;
  readonly #createRequestId: () => RequestId;
  readonly #maxSnapshotBufferBytes: number;
  readonly #maxSnapshotBufferFrames: number;
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #requestHistory = new Map<
    string,
    { readonly used: Set<RequestId>; readonly order: RequestId[] }
  >();
  readonly #unsubscribe: () => void;
  #selection?: ActiveSelection;
  #generation = 0;
  #closed = false;
  #cleaning = false;

  constructor(options: GatewaySelectedViewerBrokerOptions) {
    if (
      !options ||
      !(options.registry instanceof GatewayResidentLinkRegistry) ||
      typeof options.onConsoleOutput !== 'function' ||
      (options.onMediaResult !== undefined &&
        typeof options.onMediaResult !== 'function') ||
      (options.onSelection !== undefined &&
        typeof options.onSelection !== 'function') ||
      (options.createViewerId !== undefined &&
        typeof options.createViewerId !== 'function') ||
      (options.createRequestId !== undefined &&
        typeof options.createRequestId !== 'function')
    )
      throw new TypeError('selected viewer broker options are invalid');
    this.#registry = options.registry;
    this.#onConsoleOutput = options.onConsoleOutput;
    this.#onMediaResult = options.onMediaResult;
    this.#onSelection = options.onSelection;
    this.#createViewerId = options.createViewerId ?? newViewerId;
    this.#createRequestId = options.createRequestId ?? newRequestId;
    this.#maxSnapshotBufferBytes = bounded(
      options.maxSnapshotBufferBytes ?? LIMITS.frameBytes,
      LIMITS.frameBytes,
      'maxSnapshotBufferBytes',
    );
    this.#maxSnapshotBufferFrames = bounded(
      options.maxSnapshotBufferFrames ?? LIMITS.requestHistoryPerConnection,
      LIMITS.requestHistoryPerConnection,
      'maxSnapshotBufferFrames',
    );
    this.#unsubscribe = this.#registry.subscribe((event) =>
      this.#handleResidentEvent(event),
    );
  }

  get state(): GatewaySelectedViewerState {
    return this.#state();
  }

  /** Select only an exact currently-ready console-capable resident generation. */
  select(instanceId: string): boolean {
    if (this.#closed || typeof instanceId !== 'string') return false;
    const target = this.#registry.summary(instanceId);
    if (
      target?.state !== 'ready' ||
      !target.capabilities.includes('console.v1')
    ) {
      this.#notify('unavailable');
      return false;
    }
    const current = this.#selection;
    if (
      current &&
      current.instanceId === target.instanceId &&
      current.connectionId === target.connectionId &&
      current.linkGeneration === target.generation
    )
      return true;

    if (current) this.#retire(current, 'deselected');
    if (this.#generation === Number.MAX_SAFE_INTEGER) {
      this.#closed = true;
      this.#pending.clear();
      this.#unsubscribe();
      this.#notify('disconnected');
      return false;
    }
    const generation = ++this.#generation;
    let viewerId: ViewerId;
    try {
      viewerId = this.#freshViewerId();
    } catch {
      this.#notify('operation_failed');
      return false;
    }
    const selection: ActiveSelection = {
      generation,
      instanceId: target.instanceId,
      connectionId: target.connectionId,
      linkGeneration: target.generation,
      viewerId,
      phase: 'opening',
      buffered: [],
      bufferedBytes: 0,
    };
    this.#selection = selection;
    const requestId = this.#request('open', selection);
    if (!requestId) {
      this.#fail(selection, 'operation_failed');
      return false;
    }
    selection.operationRequestId = requestId;
    this.#notify('selected');
    if (
      !this.#send(selection, {
        type: 'viewer.open',
        requestId,
        viewerId,
      })
    ) {
      this.#pending.delete(requestId);
      this.#fail(selection, 'backpressure');
      return false;
    }
    return true;
  }

  /** Send browser console input only after the fresh snapshot barrier. */
  input(payload: string): boolean {
    const selection = this.#selection;
    if (
      this.#closed ||
      !selection ||
      selection.phase !== 'ready' ||
      typeof payload !== 'string'
    )
      return false;
    const effect = {
      type: 'console.input' as const,
      viewerId: selection.viewerId,
      payload,
    };
    if (!this.#validEffect(selection, effect)) return false;
    if (this.#send(selection, effect)) return true;
    this.#fail(selection, 'backpressure');
    return false;
  }

  /** Return the generated correlation ID, or undefined when no request was sent. */
  media(route: string): RequestId | undefined {
    const selection = this.#selection;
    if (
      this.#closed ||
      !selection ||
      selection.phase !== 'ready' ||
      typeof route !== 'string'
    )
      return undefined;
    const live = this.#registry.lookup(
      selection.instanceId,
      selection.connectionId,
    );
    if (!live?.capabilities.includes('media.v1')) return undefined;
    const requestId = this.#request('media', selection);
    if (!requestId) return undefined;
    const effect = { type: 'media.get' as const, requestId, route };
    if (!this.#validEffect(selection, effect)) {
      this.#pending.delete(requestId);
      return undefined;
    }
    if (this.#send(selection, effect)) return requestId;
    this.#pending.delete(requestId);
    this.#fail(selection, 'backpressure');
    return undefined;
  }

  /** Deselect while keeping the browser viewer reusable. */
  deselect(): void {
    const selection = this.#selection;
    if (!selection) return;
    this.#retire(selection, 'deselected');
  }

  /** Browser disconnect is terminal and idempotently cleans the remote viewer. */
  disconnect(): void {
    if (this.#closed) return;
    const selection = this.#selection;
    // Retire while the generation is still current; closing the local state first
    // would fence the very remote cleanup this method promises.
    if (selection) this.#retire(selection, null);
    this.#closed = true;
    this.#pending.clear();
    this.#requestHistory.clear();
    this.#unsubscribe();
    this.#notify('disconnected');
  }

  stop(): void {
    this.disconnect();
  }

  #handleResidentEvent(event: Readonly<GatewayResidentLinkEvent>): void {
    if (this.#closed) return;
    if (event.type === 'removed') {
      this.#dropLink(event.link);
      const selection = this.#selection;
      if (selection && this.#sameLink(selection, event.link)) {
        this.#selection = undefined;
        this.#notify('link_removed');
      }
      return;
    }
    if (event.type !== 'frame' || event.frame.type === 'hello') return;
    this.#handleResidentFrame(event.link, event.frame);
  }

  #handleResidentFrame(
    link: GatewayResidentLinkSummary,
    frame: ResidentToGatewayFrame,
  ): void {
    if (this.#closed || frame.type === 'hello') return;
    if (frame.type === 'console.output') {
      this.#console(link, frame);
      return;
    }
    if (frame.type === 'operation.result') {
      const pending = this.#take(frame.requestId, link);
      if (!pending || pending.kind === 'media') return;
      const selection = this.#selection;
      if (!selection || selection.generation !== pending.generation) return;
      selection.operationRequestId = undefined;
      if (pending.kind === 'close') return;
      if (!frame.ok) {
        if (pending.kind === 'open')
          this.#abandon(selection, 'operation_failed');
        else this.#fail(selection, 'operation_failed');
        return;
      }
      if (pending.kind === 'open') this.#beginSnapshot(selection);
      else if (pending.kind === 'snapshot') this.#completeSnapshot(selection);
      return;
    }
    if (frame.type === 'media.result') {
      const pending = this.#take(frame.requestId, link);
      if (!pending || pending.kind !== 'media') return;
      const selection = this.#selection;
      if (
        !selection ||
        selection.generation !== pending.generation ||
        selection.phase !== 'ready'
      )
        return;
      if (!this.#deliverMedia(frame, selection))
        this.#fail(selection, 'backpressure');
      return;
    }
    if (frame.type === 'error' && frame.requestId !== undefined) {
      const pending = this.#take(frame.requestId, link);
      if (!pending || pending.kind === 'close') return;
      const selection = this.#selection;
      if (selection?.generation === pending.generation) {
        selection.operationRequestId = undefined;
        if (pending.kind === 'open')
          this.#abandon(selection, 'operation_failed');
        else this.#fail(selection, 'operation_failed');
      }
    }
  }

  #beginSnapshot(selection: ActiveSelection): void {
    if (!this.#current(selection)) return;
    selection.phase = 'snapshotting';
    selection.buffered = [];
    selection.bufferedBytes = 0;
    const requestId = this.#request('snapshot', selection);
    if (!requestId) {
      this.#fail(selection, 'operation_failed');
      return;
    }
    selection.operationRequestId = requestId;
    this.#notify('snapshot');
    if (
      !this.#send(selection, {
        type: 'viewer.snapshot',
        requestId,
        viewerId: selection.viewerId,
      })
    ) {
      this.#pending.delete(requestId);
      this.#fail(selection, 'backpressure');
    }
  }

  #completeSnapshot(selection: ActiveSelection): void {
    if (!this.#current(selection) || selection.phase !== 'snapshotting') return;
    let flushedFrames = 0;
    let flushedBytes = 0;
    while (flushedFrames < selection.buffered.length) {
      const frame = selection.buffered[flushedFrames];
      if (!frame || !this.#current(selection)) return;
      const bytes = utf8.encode(frame.payload).byteLength;
      if (
        flushedFrames >= this.#maxSnapshotBufferFrames ||
        bytes > this.#maxSnapshotBufferBytes - flushedBytes
      ) {
        this.#fail(selection, 'backpressure');
        return;
      }
      flushedFrames += 1;
      flushedBytes += bytes;
      if (!this.#deliverConsole(frame, selection)) {
        this.#fail(selection, 'backpressure');
        return;
      }
    }
    if (!this.#current(selection)) return;
    selection.buffered = [];
    selection.bufferedBytes = 0;
    selection.phase = 'ready';
    this.#notify('ready');
  }

  #console(link: GatewayResidentLinkSummary, frame: ConsoleOutputFrame): void {
    const selection = this.#selection;
    if (
      !selection ||
      !this.#sameLink(selection, link) ||
      frame.viewerId !== selection.viewerId
    )
      return;
    if (selection.phase === 'snapshotting') {
      const bytes = utf8.encode(frame.payload).byteLength;
      if (
        selection.buffered.length >= this.#maxSnapshotBufferFrames ||
        bytes > this.#maxSnapshotBufferBytes - selection.bufferedBytes
      ) {
        this.#fail(selection, 'backpressure');
        return;
      }
      selection.buffered.push(frame);
      selection.bufferedBytes += bytes;
      return;
    }
    if (selection.phase === 'ready' && !this.#deliverConsole(frame, selection))
      this.#fail(selection, 'backpressure');
  }

  #retire(selection: ActiveSelection, reason: 'deselected' | null): void {
    if (!this.#current(selection)) return;
    this.#selection = undefined;
    this.#dropGeneration(selection.generation);
    // The protocol permits only one outstanding viewer operation. If selection
    // changes during open/snapshot, fail the exact link closed so its resident
    // bridge deterministically detaches the otherwise uncloseable viewer.
    if (selection.operationRequestId !== undefined) {
      this.#registry.disconnect(
        selection.instanceId,
        selection.connectionId,
        'viewer_generation_replaced',
      );
    } else {
      const requestId = this.#request('close', selection);
      const sent =
        requestId !== undefined &&
        this.#send(selection, {
          type: 'viewer.close',
          requestId,
          viewerId: selection.viewerId,
        });
      if (!sent) {
        if (requestId !== undefined) this.#pending.delete(requestId);
        this.#registry.disconnect(
          selection.instanceId,
          selection.connectionId,
          'viewer_cleanup_backpressure',
        );
      }
    }
    if (reason !== null) this.#notify(reason);
  }

  #abandon(selection: ActiveSelection, reason: 'operation_failed'): void {
    if (!this.#current(selection)) return;
    // A failed open (including a correlated request error) causes the inbound
    // session to forget the provisional viewer, so no remote close is needed.
    this.#selection = undefined;
    this.#dropGeneration(selection.generation);
    this.#notify(reason);
  }

  #fail(
    selection: ActiveSelection,
    reason: 'operation_failed' | 'backpressure',
  ): void {
    if (!this.#current(selection) || this.#cleaning) return;
    this.#cleaning = true;
    try {
      this.#selection = undefined;
      this.#dropGeneration(selection.generation);
      if (selection.operationRequestId !== undefined) {
        this.#registry.disconnect(
          selection.instanceId,
          selection.connectionId,
          'viewer_operation_failed',
        );
      } else {
        const requestId = this.#request('close', selection);
        let sent = false;
        try {
          sent =
            requestId !== undefined &&
            this.#send(selection, {
              type: 'viewer.close',
              requestId,
              viewerId: selection.viewerId,
            });
        } catch {}
        if (!sent)
          this.#registry.disconnect(
            selection.instanceId,
            selection.connectionId,
            'viewer_cleanup_backpressure',
          );
      }
      this.#notify(reason);
    } finally {
      this.#cleaning = false;
    }
  }

  #request(
    kind: PendingRequest['kind'],
    selection: ActiveSelection,
  ): RequestId | undefined {
    if (this.#pending.size >= LIMITS.pendingRequestsPerConnection)
      return undefined;
    let requestId: RequestId;
    try {
      requestId = this.#createRequestId();
    } catch {
      return undefined;
    }
    const historyKey = this.#linkKey(selection);
    let history = this.#requestHistory.get(historyKey);
    if (!history) {
      history = { used: new Set<RequestId>(), order: [] };
      this.#requestHistory.set(historyKey, history);
    }
    if (!REQUEST_ID.test(requestId) || history.used.has(requestId))
      return undefined;
    history.used.add(requestId);
    history.order.push(requestId);
    if (history.order.length > LIMITS.requestHistoryPerConnection) {
      const oldest = history.order.shift();
      if (oldest !== undefined) history.used.delete(oldest);
    }
    this.#pending.set(requestId, {
      generation: selection.generation,
      instanceId: selection.instanceId,
      connectionId: selection.connectionId,
      linkGeneration: selection.linkGeneration,
      kind,
    });
    return requestId;
  }

  #freshViewerId(): ViewerId {
    const viewerId = this.#createViewerId();
    if (!VIEWER_ID.test(viewerId)) throw new Error('invalid viewer id');
    return viewerId;
  }

  #take(
    requestId: RequestId,
    link: GatewayResidentLinkSummary,
  ): PendingRequest | undefined {
    const pending = this.#pending.get(requestId);
    if (!pending) return undefined;
    this.#pending.delete(requestId);
    return pending.instanceId === link.instanceId &&
      pending.connectionId === link.connectionId &&
      pending.linkGeneration === link.generation
      ? pending
      : undefined;
  }

  #dropGeneration(generation: number): void {
    for (const [requestId, pending] of this.#pending)
      if (pending.generation === generation) this.#pending.delete(requestId);
  }

  #dropLink(link: GatewayResidentLinkSummary): void {
    for (const [requestId, pending] of this.#pending)
      if (
        pending.instanceId === link.instanceId &&
        pending.connectionId === link.connectionId &&
        pending.linkGeneration === link.generation
      )
        this.#pending.delete(requestId);
    this.#requestHistory.delete(
      this.#linkKey({
        instanceId: link.instanceId,
        connectionId: link.connectionId,
        linkGeneration: link.generation,
      }),
    );
  }

  #linkKey(
    link: Pick<
      ActiveSelection,
      'instanceId' | 'connectionId' | 'linkGeneration'
    >,
  ): string {
    return `${link.instanceId}\u0000${link.connectionId}\u0000${link.linkGeneration}`;
  }

  #validEffect(
    selection: ActiveSelection,
    effect: Parameters<GatewayResidentLinkRegistry['sendEffect']>[2],
  ): boolean {
    try {
      serializeGatewayFrame({
        ...effect,
        version: PROTOCOL_VERSION,
        connectionId: selection.connectionId,
        seq: 1,
      } as Parameters<typeof serializeGatewayFrame>[0]);
      return true;
    } catch {
      return false;
    }
  }

  #send(
    selection: ActiveSelection,
    effect: Parameters<GatewayResidentLinkRegistry['sendEffect']>[2],
  ): boolean {
    if (
      this.#registry.lookup(selection.instanceId, selection.connectionId)
        ?.generation !== selection.linkGeneration
    )
      return false;
    try {
      return this.#registry.sendEffect(
        selection.instanceId,
        selection.connectionId,
        effect,
      );
    } catch {
      return false;
    }
  }

  #deliverConsole(
    frame: ConsoleOutputFrame,
    selection: ActiveSelection,
  ): boolean {
    try {
      return this.#onConsoleOutput(frame, this.#state(selection)) !== false;
    } catch {
      return false;
    }
  }

  #deliverMedia(frame: MediaResultFrame, selection: ActiveSelection): boolean {
    if (!this.#onMediaResult) return true;
    try {
      return this.#onMediaResult(frame, this.#state(selection)) !== false;
    } catch {
      return false;
    }
  }

  #sameLink(
    selection: ActiveSelection,
    link: GatewayResidentLinkSummary,
  ): boolean {
    return (
      selection.instanceId === link.instanceId &&
      selection.connectionId === link.connectionId &&
      selection.linkGeneration === link.generation
    );
  }

  #current(selection: ActiveSelection): boolean {
    return this.#selection === selection && !this.#closed;
  }

  #state(selection = this.#selection): GatewaySelectedViewerState {
    if (this.#closed)
      return Object.freeze({ generation: this.#generation, phase: 'closed' });
    if (!selection)
      return Object.freeze({ generation: this.#generation, phase: 'idle' });
    return Object.freeze({
      generation: selection.generation,
      phase: selection.phase,
      instanceId: selection.instanceId,
      connectionId: selection.connectionId,
      linkGeneration: selection.linkGeneration,
      viewerId: selection.viewerId,
    });
  }

  #notify(reason: GatewaySelectedViewerSelectionReason): void {
    if (!this.#onSelection) return;
    try {
      this.#onSelection(Object.freeze({ ...this.#state(), reason }));
    } catch {
      /* state notifications cannot alter broker authority */
    }
  }
}

export function createGatewaySelectedViewerBroker(
  options: GatewaySelectedViewerBrokerOptions,
): GatewaySelectedViewerBroker {
  return new GatewaySelectedViewerBroker(options);
}
