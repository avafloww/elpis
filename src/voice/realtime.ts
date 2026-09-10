import WebSocket, { type RawData } from 'ws';

export const DEFAULT_REALTIME_VOICE_MODEL = 'gpt-realtime-2.1';
export const REALTIME_PCM_SAMPLE_RATE = 24_000;

const DEFAULT_MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_SERVER_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SOCKET_BUFFERED_BYTES = 4 * 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_UPDATE_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const MAX_ID_LENGTH = 256;
const MAX_REQUEST_TOKEN_LENGTH = 128;
const MAX_RESPONSE_OWNERSHIPS = 1_024;
const BENIGN_CANCEL_ERROR_CODES = new Set(['response_cancel_not_active']);

export interface RealtimeVoiceSocketHandlers {
  open(): void;
  message(data: Uint8Array, binary: boolean): void;
  error(): void;
  close(): void;
}

export interface RealtimeVoiceSocket {
  readonly bufferedAmount: number;
  attach(handlers: RealtimeVoiceSocketHandlers): () => void;
  sendText(text: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
}

export interface RealtimeVoiceSocketOptions {
  url: string;
  authorization: string;
  maxPayload: number;
}

export type RealtimeVoiceSocketFactory = (
  options: RealtimeVoiceSocketOptions,
) => RealtimeVoiceSocket;

export type RealtimeVoiceEvent =
  | { type: 'ready' }
  | { type: 'speechStarted'; itemId: string; audioStartMs: number }
  | { type: 'speechStopped'; itemId: string; audioEndMs: number }
  | {
      type: 'inputCommitted';
      itemId: string;
      previousItemId?: string;
    }
  | { type: 'inputTranscript'; itemId: string; transcript: string }
  | {
      type: 'inputTranscriptFailed';
      itemId: string;
      message: string;
    }
  | {
      type: 'responseCreated';
      responseId: string;
      requestToken: string;
    }
  | {
      type: 'audio';
      responseId: string;
      itemId: string;
      pcm: Buffer;
    }
  | {
      type: 'audioDone';
      responseId: string;
      itemId: string;
    }
  | {
      type: 'outputTranscript';
      responseId: string;
      itemId: string;
      transcript: string;
      final: boolean;
    }
  | {
      type: 'responseDone';
      responseId: string;
      status: string;
    }
  | {
      type: 'assistantAudioTruncated';
      itemId: string;
      audioEndMs: number;
    }
  | { type: 'error'; message: string; code?: string; eventId?: string }
  | { type: 'closed' };

export interface RealtimeVoiceTransportOptions {
  apiKey: string;
  instructions: string;
  model?: string;
  voice?: string;
  transcriptionModel?: string;
  vadEagerness?: 'low' | 'medium' | 'high' | 'auto';
  maxAudioChunkBytes?: number;
  maxServerEventBytes?: number;
  maxSocketBufferedBytes?: number;
  connectTimeoutMs?: number;
  updateTimeoutMs?: number;
  closeGraceMs?: number;
  socketFactory?: RealtimeVoiceSocketFactory;
  onEvent?: (event: RealtimeVoiceEvent) => void;
}

type PendingUpdate = {
  resolve(): void;
  reject(error: Error): void;
  initial: boolean;
  session: Record<string, unknown>;
  expectedInstructions: string;
  sent: boolean;
  timer: NodeJS.Timeout | null;
};

type ResponseOwnership = {
  requestToken: string;
  terminal: boolean;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function rawDataBytes(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return Uint8Array.from(data);
  if (Array.isArray(data)) return Uint8Array.from(Buffer.concat(data));
  return Uint8Array.from(Buffer.from(data));
}

/** Production adapter for the server-to-server Realtime WebSocket API. */
export class WsRealtimeVoiceSocket implements RealtimeVoiceSocket {
  readonly #socket: WebSocket;

  constructor(options: RealtimeVoiceSocketOptions) {
    this.#socket = new WebSocket(options.url, {
      headers: { authorization: options.authorization },
      followRedirects: false,
      maxPayload: options.maxPayload,
      perMessageDeflate: false,
    });
    // Closing or detaching must not leave a late socket error unhandled.
    this.#socket.on('error', () => undefined);
  }

  get bufferedAmount(): number {
    return this.#socket.bufferedAmount;
  }

  attach(handlers: RealtimeVoiceSocketHandlers): () => void {
    const onOpen = (): void => handlers.open();
    const onMessage = (data: RawData, binary: boolean): void =>
      handlers.message(rawDataBytes(data), binary);
    const onError = (): void => handlers.error();
    const onClose = (): void => handlers.close();
    this.#socket.on('open', onOpen);
    this.#socket.on('message', onMessage);
    this.#socket.on('error', onError);
    this.#socket.on('close', onClose);
    return () => {
      this.#socket.off('open', onOpen);
      this.#socket.off('message', onMessage);
      this.#socket.off('error', onError);
      this.#socket.off('close', onClose);
    };
  }

  sendText(text: string): void {
    if (this.#socket.readyState !== WebSocket.OPEN)
      throw new Error('realtime voice socket is not open');
    this.#socket.send(text, { binary: false, compress: false });
  }

  close(code: number, reason: string): void {
    if (this.#socket.readyState === WebSocket.OPEN) {
      this.#socket.close(code, reason);
    } else if (this.#socket.readyState === WebSocket.CONNECTING) {
      this.#socket.terminate();
    }
  }

  terminate(): void {
    if (this.#socket.readyState !== WebSocket.CLOSED) this.#socket.terminate();
  }
}

export function createWsRealtimeVoiceSocket(
  options: RealtimeVoiceSocketOptions,
): RealtimeVoiceSocket {
  return new WsRealtimeVoiceSocket(options);
}

/**
 * Low-level, bounded Realtime transport. It detects and transcribes incoming
 * turns, but only speaks text explicitly supplied by Elpis' ordered main loop.
 */
export class RealtimeVoiceTransport {
  readonly #apiKey: string;
  readonly #instructions: string;
  readonly #model: string;
  readonly #voice: string;
  readonly #transcriptionModel: string;
  readonly #vadEagerness: 'low' | 'medium' | 'high' | 'auto';
  readonly #maxAudioChunkBytes: number;
  readonly #maxServerEventBytes: number;
  readonly #maxSocketBufferedBytes: number;
  readonly #connectTimeoutMs: number;
  readonly #updateTimeoutMs: number;
  readonly #closeGraceMs: number;
  readonly #socketFactory: RealtimeVoiceSocketFactory;
  readonly #onEvent: (event: RealtimeVoiceEvent) => void;
  readonly #pendingUpdates: PendingUpdate[] = [];
  readonly #responseOwnership = new Map<string, ResponseOwnership>();
  readonly #pendingCancelEvents = new Map<string, string>();
  #socket: RealtimeVoiceSocket | null = null;
  #detach: (() => void) | null = null;
  #state: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle';
  #connectPromise: Promise<void> | null = null;
  #connectResolve: (() => void) | null = null;
  #connectReject: ((error: Error) => void) | null = null;
  #connectTimer: NodeJS.Timeout | null = null;
  #closeTimer: NodeJS.Timeout | null = null;
  #clientEventSequence = 0;

  constructor(options: RealtimeVoiceTransportOptions) {
    if (!options.apiKey.trim()) throw new TypeError('apiKey must not be empty');
    this.#apiKey = options.apiKey;
    this.#instructions = options.instructions;
    this.#model = options.model ?? DEFAULT_REALTIME_VOICE_MODEL;
    this.#voice = options.voice ?? 'marin';
    this.#transcriptionModel =
      options.transcriptionModel ?? 'gpt-4o-mini-transcribe';
    this.#vadEagerness = options.vadEagerness ?? 'auto';
    this.#maxAudioChunkBytes = positiveInteger(
      options.maxAudioChunkBytes ?? DEFAULT_MAX_AUDIO_CHUNK_BYTES,
      'maxAudioChunkBytes',
    );
    this.#maxServerEventBytes = positiveInteger(
      options.maxServerEventBytes ?? DEFAULT_MAX_SERVER_EVENT_BYTES,
      'maxServerEventBytes',
    );
    this.#maxSocketBufferedBytes = positiveInteger(
      options.maxSocketBufferedBytes ?? DEFAULT_MAX_SOCKET_BUFFERED_BYTES,
      'maxSocketBufferedBytes',
    );
    this.#connectTimeoutMs = positiveInteger(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      'connectTimeoutMs',
    );
    this.#updateTimeoutMs = positiveInteger(
      options.updateTimeoutMs ?? DEFAULT_UPDATE_TIMEOUT_MS,
      'updateTimeoutMs',
    );
    this.#closeGraceMs = positiveInteger(
      options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
      'closeGraceMs',
    );
    this.#socketFactory = options.socketFactory ?? createWsRealtimeVoiceSocket;
    this.#onEvent = options.onEvent ?? (() => undefined);
  }

  get ready(): boolean {
    return this.#state === 'ready';
  }

  connect(): Promise<void> {
    if (this.#state === 'closed')
      return Promise.reject(new Error('realtime voice transport is closed'));
    if (this.#connectPromise) return this.#connectPromise;

    this.#state = 'connecting';
    this.#connectPromise = new Promise<void>((resolve, reject) => {
      this.#connectResolve = resolve;
      this.#connectReject = reject;
    });
    try {
      const model = encodeURIComponent(this.#model);
      this.#socket = this.#socketFactory({
        url: `wss://api.openai.com/v1/realtime?model=${model}`,
        authorization: `Bearer ${this.#apiKey}`,
        maxPayload: this.#maxServerEventBytes,
      });
      const detach = this.#socket.attach({
        open: () => this.#onOpen(),
        message: (data, binary) => this.#onMessage(data, binary),
        error: () => this.#onSocketError(),
        close: () => this.#onClose(),
      });
      if (this.#isClosed()) {
        this.#callSafely(detach);
      } else {
        this.#detach = detach;
        if (this.#state === 'connecting') {
          this.#connectTimer = setTimeout(() => {
            this.#terminalFailure(
              new Error('realtime voice connection timed out'),
              { terminate: true },
            );
          }, this.#connectTimeoutMs);
          this.#connectTimer.unref?.();
        }
      }
    } catch (error) {
      this.#terminalFailure(
        error instanceof Error
          ? error
          : new Error('realtime voice setup failed'),
        { terminate: true },
      );
    }
    return this.#connectPromise;
  }

  appendAudio(pcm: Uint8Array): void {
    this.#requireReady();
    if (pcm.byteLength === 0) return;
    if (pcm.byteLength > this.#maxAudioChunkBytes) {
      throw new RangeError(
        `audio chunk exceeds ${this.#maxAudioChunkBytes} bytes`,
      );
    }
    this.#send({
      type: 'input_audio_buffer.append',
      audio: Buffer.from(pcm).toString('base64'),
    });
  }

  commitInput(): void {
    this.#requireReady();
    this.#send({ type: 'input_audio_buffer.commit' });
  }

  clearInput(): void {
    this.#requireReady();
    this.#send({ type: 'input_audio_buffer.clear' });
  }

  deleteInput(itemId: string): void {
    this.#requireReady();
    if (!itemId) throw new TypeError('itemId must not be empty');
    this.#send({ type: 'conversation.item.delete', item_id: itemId });
  }

  updateInstructions(instructions: string): Promise<void> {
    this.#requireReady();
    return this.#queueSessionUpdate(
      { type: 'realtime', instructions },
      instructions,
    );
  }

  speakText(
    text: string,
    requestToken: string,
    styleInstructions?: string,
  ): void {
    this.#requireReady();
    if (!text) throw new TypeError('spoken text must not be empty');
    const token = boundedRequiredString(
      { requestToken },
      'requestToken',
      MAX_REQUEST_TOKEN_LENGTH,
    );
    const style = styleInstructions?.trim();
    this.#send({
      type: 'response.create',
      response: {
        conversation: 'none',
        output_modalities: ['audio'],
        instructions: [
          'Read the supplied text exactly as written. Do not add, remove, or change words.',
          style,
        ]
          .filter(Boolean)
          .join(' '),
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text }],
          },
        ],
        metadata: { elpis_voice_request: token },
      },
    });
  }

  cancelResponse(responseId: string): void {
    this.#requireReady();
    const ownership = this.#responseOwnership.get(responseId);
    if (!ownership || ownership.terminal) return;
    const eventId = `elpis_voice_cancel_${++this.#clientEventSequence}`;
    this.#pendingCancelEvents.set(eventId, responseId);
    while (this.#pendingCancelEvents.size > 64) {
      const oldest = this.#pendingCancelEvents.keys().next().value;
      if (typeof oldest === 'string') this.#pendingCancelEvents.delete(oldest);
      else break;
    }
    try {
      this.#send({
        type: 'response.cancel',
        event_id: eventId,
        response_id: responseId,
      });
    } catch (error) {
      this.#pendingCancelEvents.delete(eventId);
      throw error;
    }
  }

  truncateAssistantAudio(itemId: string, audioEndMs: number): void {
    this.#requireReady();
    if (!itemId) throw new TypeError('itemId must not be empty');
    if (!Number.isSafeInteger(audioEndMs) || audioEndMs < 0)
      throw new TypeError('audioEndMs must be a non-negative integer');
    this.#send({
      type: 'conversation.item.truncate',
      item_id: itemId,
      content_index: 0,
      audio_end_ms: audioEndMs,
    });
  }

  close(): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#clearConnectTimer();
    this.#rejectPending(new Error('realtime voice transport closed'));
    this.#connectReject?.(new Error('realtime voice transport closed'));
    this.#connectReject = null;
    this.#connectResolve = null;
    this.#detachSocket();
    const socket = this.#socket;
    this.#closeSocket(socket, 1000, 'voice session ended');
    this.#scheduleTermination(socket);
    this.#emit({ type: 'closed' });
  }

  #onOpen(): void {
    if (this.#state !== 'connecting') return;
    void this.#queueSessionUpdate(
      {
        type: 'realtime',
        model: this.#model,
        output_modalities: ['audio'],
        instructions: this.#instructions,
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: REALTIME_PCM_SAMPLE_RATE },
            transcription: { model: this.#transcriptionModel },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: this.#vadEagerness,
              // The ordered resident loop alone authorizes speech and interruption.
              create_response: false,
              interrupt_response: false,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: REALTIME_PCM_SAMPLE_RATE },
            voice: this.#voice,
          },
        },
      },
      this.#instructions,
      true,
    ).catch((error: unknown) => {
      this.#terminalFailure(
        error instanceof Error ? error : new Error('session update failed'),
        { terminate: true },
      );
    });
  }

  #queueSessionUpdate(
    session: Record<string, unknown>,
    expectedInstructions: string,
    initial = false,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#pendingUpdates.push({
        resolve,
        reject,
        initial,
        session,
        expectedInstructions,
        sent: false,
        timer: null,
      });
      this.#pumpSessionUpdate();
    });
  }

  #pumpSessionUpdate(): void {
    const pending = this.#pendingUpdates[0];
    if (!pending || pending.sent || this.#state === 'closed') return;
    pending.sent = true;
    try {
      this.#send({ type: 'session.update', session: pending.session }, true);
    } catch (error) {
      this.#terminalFailure(
        error instanceof Error ? error : new Error('session update failed'),
        { terminate: true },
      );
      return;
    }
    // A test adapter or unusual socket can synchronously deliver the
    // acknowledgement from sendText. Do not arm a stale timer after it did.
    if (this.#isClosed() || this.#pendingUpdates[0] !== pending) return;
    pending.timer = setTimeout(() => {
      this.#terminalFailure(
        new Error('realtime voice session update timed out'),
        { terminate: true },
      );
    }, this.#updateTimeoutMs);
    pending.timer.unref?.();
  }

  #send(event: Record<string, unknown>, connecting = false): void {
    if (!connecting) this.#requireReady();
    const socket = this.#socket;
    if (!socket) throw new Error('realtime voice socket is unavailable');
    const text = JSON.stringify(event);
    const bytes = Buffer.byteLength(text);
    if (bytes > this.#maxSocketBufferedBytes) {
      throw new RangeError(
        'realtime voice event exceeds outbound buffer limit',
      );
    }
    if (socket.bufferedAmount + bytes > this.#maxSocketBufferedBytes) {
      throw new Error('realtime voice socket outbound buffer is full');
    }
    socket.sendText(text);
  }

  #onMessage(data: Uint8Array, binary: boolean): void {
    if (this.#state === 'closed') return;
    if (binary) {
      this.#protocolError('Realtime server sent an unexpected binary event.');
      return;
    }
    if (data.byteLength > this.#maxServerEventBytes) {
      this.#protocolError(
        `Realtime server event exceeded ${this.#maxServerEventBytes} bytes.`,
        1009,
        'realtime event too large',
      );
      return;
    }
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object');
      event = parsed as Record<string, unknown>;
    } catch {
      this.#protocolError('Realtime server sent malformed JSON.');
      return;
    }
    try {
      this.#handleServerEvent(event);
    } catch {
      const type = typeof event.type === 'string' ? event.type : 'unknown';
      this.#protocolError(`Realtime server sent invalid ${type} fields.`);
    }
  }

  #handleServerEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'session.updated') {
      const session = requiredObject(event, 'session');
      const pending = this.#pendingUpdates[0];
      if (!pending || pending.initial !== (this.#state === 'connecting')) {
        throw new Error('unexpected session update acknowledgement');
      }
      this.#validateAcknowledgedSession(session, pending);
      this.#pendingUpdates.shift();
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve();
      if (this.#state === 'connecting') {
        this.#state = 'ready';
        this.#clearConnectTimer();
        this.#connectResolve?.();
        this.#connectResolve = null;
        this.#connectReject = null;
        this.#emit({ type: 'ready' });
      }
      this.#pumpSessionUpdate();
      return;
    }

    if (type === 'input_audio_buffer.speech_started') {
      this.#emit({
        type: 'speechStarted',
        itemId: requiredId(event, 'item_id'),
        audioStartMs: requiredNumber(event, 'audio_start_ms'),
      });
    } else if (type === 'input_audio_buffer.speech_stopped') {
      this.#emit({
        type: 'speechStopped',
        itemId: requiredId(event, 'item_id'),
        audioEndMs: requiredNumber(event, 'audio_end_ms'),
      });
    } else if (type === 'input_audio_buffer.committed') {
      const previousItemId = optionalId(event, 'previous_item_id');
      this.#emit({
        type: 'inputCommitted',
        itemId: requiredId(event, 'item_id'),
        ...(previousItemId ? { previousItemId } : {}),
      });
    } else if (
      type === 'conversation.item.input_audio_transcription.completed'
    ) {
      this.#emit({
        type: 'inputTranscript',
        itemId: requiredId(event, 'item_id'),
        transcript: requiredString(event, 'transcript'),
      });
    } else if (type === 'conversation.item.input_audio_transcription.failed') {
      const error = requiredObject(event, 'error');
      this.#emit({
        type: 'inputTranscriptFailed',
        itemId: requiredId(event, 'item_id'),
        message: boundedRequiredString(error, 'message', 4_096),
      });
    } else if (type === 'response.created') {
      const response = requiredObject(event, 'response');
      const responseId = requiredId(response, 'id');
      const metadata = requiredObject(response, 'metadata');
      const requestToken = boundedRequiredString(
        metadata,
        'elpis_voice_request',
        MAX_REQUEST_TOKEN_LENGTH,
      );
      const existing = this.#responseOwnership.get(responseId);
      if (existing) {
        if (existing.requestToken !== requestToken || existing.terminal)
          throw new Error('response ownership conflict');
      } else {
        if (this.#responseOwnership.size >= MAX_RESPONSE_OWNERSHIPS)
          throw new Error('too many response ownership records');
        this.#responseOwnership.set(responseId, {
          requestToken,
          terminal: false,
        });
      }
      this.#emit({
        type: 'responseCreated',
        responseId,
        requestToken,
      });
    } else if (type === 'response.output_audio.delta') {
      const encoded = boundedRequiredString(
        event,
        'delta',
        Math.ceil((this.#maxAudioChunkBytes * 4) / 3) + 4,
      );
      const pcm = decodeBase64(encoded, this.#maxAudioChunkBytes);
      if (!pcm) {
        this.#protocolError('Realtime server sent an invalid audio delta.');
        return;
      }
      this.#emit({
        type: 'audio',
        responseId: requiredId(event, 'response_id'),
        itemId: requiredId(event, 'item_id'),
        pcm,
      });
    } else if (type === 'response.output_audio.done') {
      this.#emit({
        type: 'audioDone',
        responseId: requiredId(event, 'response_id'),
        itemId: requiredId(event, 'item_id'),
      });
    } else if (
      type === 'response.output_audio_transcript.delta' ||
      type === 'response.output_audio_transcript.done'
    ) {
      this.#emit({
        type: 'outputTranscript',
        responseId: requiredId(event, 'response_id'),
        itemId: requiredId(event, 'item_id'),
        transcript: requiredString(
          event,
          type.endsWith('.done') ? 'transcript' : 'delta',
        ),
        final: type.endsWith('.done'),
      });
    } else if (type === 'response.done') {
      const response = requiredObject(event, 'response');
      const responseId = requiredId(response, 'id');
      const status = boundedRequiredString(response, 'status', 64);
      const ownership = this.#responseOwnership.get(responseId);
      if (!ownership) throw new Error('unknown response completion');
      if (ownership.terminal) return;
      ownership.terminal = true;
      this.#emit({
        type: 'responseDone',
        responseId,
        status,
      });
    } else if (type === 'conversation.item.truncated') {
      this.#emit({
        type: 'assistantAudioTruncated',
        itemId: requiredId(event, 'item_id'),
        audioEndMs: requiredNumber(event, 'audio_end_ms'),
      });
    } else if (type === 'error') {
      const error = requiredObject(event, 'error');
      boundedRequiredString(error, 'type', 128);
      const message = boundedRequiredString(error, 'message', 4_096);
      const eventId = optionalId(error, 'event_id');
      const code = optionalId(error, 'code');
      if (
        eventId &&
        this.#pendingCancelEvents.has(eventId) &&
        code &&
        BENIGN_CANCEL_ERROR_CODES.has(code)
      ) {
        this.#pendingCancelEvents.delete(eventId);
        return;
      }
      const normalized: RealtimeVoiceEvent = {
        type: 'error',
        message,
        ...(code ? { code } : {}),
        ...(eventId ? { eventId } : {}),
      };
      this.#terminalFailure(new Error(normalized.message), {
        event: normalized,
        closeCode: 1011,
        closeReason: 'realtime provider error',
      });
    }
  }

  #protocolError(
    message: string,
    code = 1002,
    reason = 'protocol error',
  ): void {
    this.#terminalFailure(new Error(message), {
      event: { type: 'error', message },
      closeCode: code,
      closeReason: reason,
    });
  }

  #onSocketError(): void {
    this.#terminalFailure(new Error('realtime voice socket error'), {
      event: { type: 'error', message: 'Realtime voice socket error.' },
      terminate: true,
    });
  }

  #onClose(): void {
    this.#terminalFailure(new Error('realtime voice socket closed'), {
      event: { type: 'closed' },
    });
  }

  #terminalFailure(
    error: Error,
    options: {
      event?: RealtimeVoiceEvent;
      closeCode?: number;
      closeReason?: string;
      terminate?: boolean;
    } = {},
  ): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#clearConnectTimer();
    this.#detachSocket();
    this.#connectReject?.(error);
    this.#connectReject = null;
    this.#connectResolve = null;
    this.#rejectPending(error);
    const socket = this.#socket;
    if (options.terminate) this.#terminateSocket(socket);
    else if (options.closeCode !== undefined) {
      this.#closeSocket(
        socket,
        options.closeCode,
        options.closeReason ?? 'voice error',
      );
      this.#scheduleTermination(socket);
    }
    this.#emit(
      options.event ?? {
        type: 'error',
        message: 'Realtime voice transport ended.',
      },
    );
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pendingUpdates.splice(0)) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #validateAcknowledgedSession(
    session: Record<string, unknown>,
    pending: PendingUpdate,
  ): void {
    if (
      requiredString(session, 'instructions') !== pending.expectedInstructions
    )
      throw new Error('session instructions were not acknowledged');
    const audio = requiredObject(session, 'audio');
    const input = requiredObject(audio, 'input');
    const output = requiredObject(audio, 'output');
    const inputFormat = requiredObject(input, 'format');
    const outputFormat = requiredObject(output, 'format');
    const turnDetection = requiredObject(input, 'turn_detection');
    if (
      requiredString(inputFormat, 'type') !== 'audio/pcm' ||
      requiredNumber(inputFormat, 'rate') !== REALTIME_PCM_SAMPLE_RATE ||
      requiredString(outputFormat, 'type') !== 'audio/pcm' ||
      requiredNumber(outputFormat, 'rate') !== REALTIME_PCM_SAMPLE_RATE ||
      requiredString(turnDetection, 'type') !== 'semantic_vad' ||
      turnDetection.create_response !== false ||
      turnDetection.interrupt_response !== false
    ) {
      throw new Error('session safety settings were not acknowledged');
    }
  }

  #detachSocket(): void {
    const detach = this.#detach;
    this.#detach = null;
    if (detach) this.#callSafely(detach);
  }

  #closeSocket(
    socket: RealtimeVoiceSocket | null,
    code: number,
    reason: string,
  ): void {
    if (socket) this.#callSafely(() => socket.close(code, reason));
  }

  #terminateSocket(socket: RealtimeVoiceSocket | null): void {
    if (socket) this.#callSafely(() => socket.terminate());
  }

  #callSafely(operation: () => void): void {
    try {
      operation();
    } catch {
      /* terminal cleanup continues through independent best-effort steps */
    }
  }

  #scheduleTermination(socket: RealtimeVoiceSocket | null): void {
    if (!socket) return;
    this.#closeTimer = setTimeout(() => {
      this.#closeTimer = null;
      this.#terminateSocket(socket);
    }, this.#closeGraceMs);
    this.#closeTimer.unref?.();
  }

  #emit(event: RealtimeVoiceEvent): void {
    try {
      this.#onEvent(event);
    } catch {
      /* consumer callbacks cannot compromise transport cleanup */
    }
  }

  #clearConnectTimer(): void {
    if (!this.#connectTimer) return;
    clearTimeout(this.#connectTimer);
    this.#connectTimer = null;
  }

  // Socket adapters may invoke callbacks synchronously; re-read state after
  // their calls instead of relying on TypeScript's pre-callback narrowing.
  #isClosed(): boolean {
    return this.#state === 'closed';
  }

  #requireReady(): void {
    if (this.#state !== 'ready')
      throw new Error('realtime voice transport is not ready');
  }
}

function requiredObject(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = object[key];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
  return value;
}

function boundedRequiredString(
  object: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = requiredString(object, key);
  if (!value || value.length > maxLength)
    throw new TypeError(`${key} must contain 1..${maxLength} characters`);
  return value;
}

function requiredId(object: Record<string, unknown>, key: string): string {
  return boundedRequiredString(object, key, MAX_ID_LENGTH);
}

function optionalId(
  object: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = object[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > MAX_ID_LENGTH)
    throw new TypeError(`${key} must be a bounded string`);
  return value;
}

function requiredNumber(object: Record<string, unknown>, key: string): number {
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new TypeError(`${key} must be a non-negative integer`);
  return value;
}

function decodeBase64(value: string, maxBytes: number): Buffer | null {
  if (!value || value.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0)
    return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.byteLength <= maxBytes ? decoded : null;
}
