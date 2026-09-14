import type { RealtimeVoiceEvent } from './realtime.js';

const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_AUDIO_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_PRE_IDENTITY_AUDIO_BYTES = 512 * 1024;
const MAX_ID_LENGTH = 256;
const MAX_REQUEST_TOKEN_LENGTH = 128;
const MAX_RESPONSE_RECORDS = 1_024;
const MAX_PENDING_CANCEL_EVENTS = 64;
const BENIGN_CANCEL_ERROR_CODES = new Set(['response_cancel_not_active']);

export interface CodexWebRtcVoiceBroker {
  appendSpeech(text: string): void;
  sendEvent(text: string): void;
  close(): void | Promise<void>;
}

export interface CodexWebRtcVoiceTransportOptions {
  broker: CodexWebRtcVoiceBroker;
  onEvent?: (event: RealtimeVoiceEvent) => void;
  maxEventBytes?: number;
  maxAudioChunkBytes?: number;
  maxPreIdentityAudioBytes?: number;
}

type ResponseRecord = {
  id: string;
  requestToken: string;
  itemId?: string;
  referencedItemId?: string;
  started: boolean;
  cancelRequested: boolean;
  mediaTerminal?: 'stopped' | 'cleared';
  providerStatus?: string;
  terminalEmitted: boolean;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function objectField(
  object: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = object[key];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${key} must be an object`);
  return value as Record<string, unknown>;
}

function stringField(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== 'string') throw new TypeError(`${key} must be a string`);
  return value;
}

function boundedString(
  object: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  const value = stringField(object, key);
  if (!value || value.length > maxLength)
    throw new TypeError(`${key} must contain 1..${maxLength} characters`);
  return value;
}

function idField(object: Record<string, unknown>, key: string): string {
  return boundedString(object, key, MAX_ID_LENGTH);
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

function nonNegativeInteger(
  object: Record<string, unknown>,
  key: string,
): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${key} must be a non-negative integer`);
  return value as number;
}

/**
 * Correlates Codex' ordered oai-events and bare WebRTC PCM with VoiceSession's
 * exact response ownership model. This adapter is intentionally inert: its
 * broker, callbacks, and lifecycle are supplied by a future activation layer.
 */
export class CodexWebRtcVoiceTransport {
  readonly #broker: CodexWebRtcVoiceBroker;
  readonly #onEvent: (event: RealtimeVoiceEvent) => void;
  readonly #maxEventBytes: number;
  readonly #maxAudioChunkBytes: number;
  readonly #maxPreIdentityAudioBytes: number;
  readonly #responses = new Map<string, ResponseRecord>();
  readonly #itemOwners = new Map<string, string>();
  readonly #pendingCancelEvents = new Map<string, string>();
  readonly #preIdentityAudio: Buffer[] = [];
  #preIdentityAudioBytes = 0;
  #clientEventSequence = 0;
  #waitingToken?: string;
  #current?: ResponseRecord;
  #mediaBoundary = false;
  #cancellationSending = false;
  #closed = false;

  constructor(options: CodexWebRtcVoiceTransportOptions) {
    this.#broker = options.broker;
    this.#onEvent = options.onEvent ?? (() => undefined);
    this.#maxEventBytes = positiveInteger(
      options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES,
      'maxEventBytes',
    );
    this.#maxAudioChunkBytes = positiveInteger(
      options.maxAudioChunkBytes ?? DEFAULT_MAX_AUDIO_CHUNK_BYTES,
      'maxAudioChunkBytes',
    );
    this.#maxPreIdentityAudioBytes = positiveInteger(
      options.maxPreIdentityAudioBytes ?? DEFAULT_MAX_PRE_IDENTITY_AUDIO_BYTES,
      'maxPreIdentityAudioBytes',
    );
  }

  speakText(text: string, requestToken: string): void {
    this.#requireOpen();
    if (typeof text !== 'string' || !text.length)
      throw new TypeError('spoken text must not be empty');
    if (
      typeof requestToken !== 'string' ||
      !requestToken ||
      requestToken.length > MAX_REQUEST_TOKEN_LENGTH
    )
      throw new TypeError('requestToken must be a bounded string');
    if (
      this.#waitingToken ||
      this.#current ||
      this.#cancellationSending ||
      this.#hasUnterminatedMediaOwner()
    ) {
      const error = new Error(
        'a prior Codex speech handoff is still response-ambiguous or media-terminal pending',
      );
      this.#fatal(error.message);
      throw error;
    }

    // Install ownership before the broker call: injected boundaries may invoke
    // response callbacks synchronously from appendSpeech.
    this.#waitingToken = requestToken;
    try {
      this.#broker.appendSpeech(text);
    } catch (error) {
      this.#fatal('Codex speech handoff failed.');
      throw error;
    }
  }

  cancelResponse(responseId: string): void {
    this.#requireOpen();
    if (
      typeof responseId !== 'string' ||
      !responseId ||
      responseId.length > MAX_ID_LENGTH
    )
      throw new TypeError('responseId must be a bounded string');
    const response = this.#responses.get(responseId);
    if (
      !response ||
      response.terminalEmitted ||
      response.cancelRequested ||
      response.mediaTerminal
    )
      return;

    // Retire local playback ownership before crossing either reentrant send.
    response.cancelRequested = true;
    this.#mediaBoundary = true;
    if (this.#current === response) this.#current = undefined;
    this.#discardPreIdentityAudio();
    this.#cancellationSending = true;
    let cancelEventId: string | undefined;
    try {
      if (response.providerStatus !== 'completed') {
        cancelEventId = `elpis_voice_cancel_${++this.#clientEventSequence}`;
        this.#pendingCancelEvents.set(cancelEventId, responseId);
        while (this.#pendingCancelEvents.size > MAX_PENDING_CANCEL_EVENTS) {
          const oldest = this.#pendingCancelEvents.keys().next().value;
          if (typeof oldest === 'string')
            this.#pendingCancelEvents.delete(oldest);
          else break;
        }
        this.#send({
          type: 'response.cancel',
          event_id: cancelEventId,
          response_id: responseId,
        });
      }
      if (!this.#closed && !response.mediaTerminal)
        this.#send({ type: 'output_audio_buffer.clear' });
    } catch (error) {
      if (cancelEventId) this.#pendingCancelEvents.delete(cancelEventId);
      this.#fatal('Codex response cancellation failed.');
      throw error;
    } finally {
      this.#cancellationSending = false;
    }
  }

  deleteInput(itemId: string): void {
    this.#requireOpen();
    if (typeof itemId !== 'string' || !itemId || itemId.length > MAX_ID_LENGTH)
      throw new TypeError('itemId must be a bounded string');
    try {
      this.#send({ type: 'conversation.item.delete', item_id: itemId });
    } catch (error) {
      this.#fatal('Codex input deletion failed.');
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#waitingToken = undefined;
    this.#current = undefined;
    this.#discardPreIdentityAudio();
    this.#closeBroker();
  }

  /** Accept one call-correlated decoded PCM chunk from the broker. */
  handleAudio(audio: Uint8Array): void {
    if (this.#closed) return;
    try {
      if (!(audio instanceof Uint8Array))
        throw new TypeError('audio must be bytes');
      if (audio.byteLength === 0) return;
      if (audio.byteLength > this.#maxAudioChunkBytes)
        throw new RangeError('Codex audio chunk exceeded its limit');

      const response = this.#current;
      if (response?.cancelRequested) return;
      if (response && this.#mediaEligible(response)) {
        this.#emitAudio(response, Buffer.from(audio));
        return;
      }
      if (response || (this.#waitingToken && !this.#mediaBoundary)) {
        this.#bufferAudio(Buffer.from(audio));
        return;
      }

      // Audio after a stopped/cleared boundary and before a new exact response
      // cannot safely be attributed. In-flight audio from a cancelled or failed
      // owner is discarded until its exact media terminal arrives.
      if (this.#hasUnterminatedMediaOwner() && !this.#waitingToken) return;
      throw new Error('unowned or post-terminal Codex audio');
    } catch (error) {
      this.#fatal(
        error instanceof Error ? error.message : 'invalid Codex audio callback',
      );
    }
  }

  /** Accept one ordered oai-events data-channel message from the broker. */
  handleEvent(text: string): void {
    if (this.#closed) return;
    let event: Record<string, unknown>;
    try {
      if (typeof text !== 'string') throw new TypeError('event must be text');
      if (Buffer.byteLength(text, 'utf8') > this.#maxEventBytes)
        throw new RangeError('Codex event exceeded its limit');
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new TypeError('event must be a JSON object');
      event = parsed as Record<string, unknown>;
      this.#handleParsedEvent(event);
    } catch (error) {
      this.#fatal(
        error instanceof Error ? error.message : 'invalid Codex event callback',
      );
    }
  }

  /** Broker error hook for activation code without granting broker ownership. */
  handleError(error: unknown): void {
    if (this.#closed) return;
    this.#fatal(
      error instanceof Error ? error.message : 'Codex voice broker failed',
    );
  }

  handleClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#waitingToken = undefined;
    this.#current = undefined;
    this.#discardPreIdentityAudio();
    this.#emit({ type: 'closed' });
  }

  // Callback aliases make the broker closure at a future wiring site explicit.
  onAudio(audio: Uint8Array): void {
    this.handleAudio(audio);
  }

  onEvent(text: string): void {
    this.handleEvent(text);
  }

  onError(error: unknown): void {
    this.handleError(error);
  }

  #handleParsedEvent(event: Record<string, unknown>): void {
    const type = boundedString(event, 'type', 256);

    if (type === 'input_audio_buffer.speech_started') {
      this.#emit({
        type: 'speechStarted',
        itemId: idField(event, 'item_id'),
        audioStartMs: nonNegativeInteger(event, 'audio_start_ms'),
      });
      return;
    }
    if (type === 'input_audio_buffer.speech_stopped') {
      this.#emit({
        type: 'speechStopped',
        itemId: idField(event, 'item_id'),
        audioEndMs: nonNegativeInteger(event, 'audio_end_ms'),
      });
      return;
    }
    if (type === 'input_audio_buffer.committed') {
      const previousItemId = optionalId(event, 'previous_item_id');
      this.#emit({
        type: 'inputCommitted',
        itemId: idField(event, 'item_id'),
        ...(previousItemId ? { previousItemId } : {}),
      });
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.completed') {
      this.#emit({
        type: 'inputTranscript',
        itemId: idField(event, 'item_id'),
        transcript: stringField(event, 'transcript'),
      });
      return;
    }
    if (type === 'conversation.item.input_audio_transcription.failed') {
      const error = objectField(event, 'error');
      this.#emit({
        type: 'inputTranscriptFailed',
        itemId: idField(event, 'item_id'),
        message: boundedString(error, 'message', 4_096),
      });
      return;
    }
    if (type === 'response.created') {
      this.#responseCreated(event);
      return;
    }
    if (type === 'output_audio_buffer.started') {
      this.#outputStarted(event);
      return;
    }
    if (
      type === 'response.output_item.added' ||
      type === 'response.output_item.done'
    ) {
      const response = this.#ownedResponse(event, 'response_id');
      const item = objectField(event, 'item');
      const itemId = idField(item, 'id');
      this.#recordItemOwner(response, itemId);
      if (this.#isRetired(response) || !this.#isAssistantAudioItem(item))
        return;
      this.#bindItem(response, itemId);
      this.#flushAudio(response);
      return;
    }
    if (
      type === 'response.output_audio_transcript.delta' ||
      type === 'response.output_audio_transcript.done'
    ) {
      const response = this.#ownedResponse(event, 'response_id');
      const itemId = idField(event, 'item_id');
      const transcript = stringField(
        event,
        type.endsWith('.done') ? 'transcript' : 'delta',
      );
      if (this.#isRetired(response)) return;
      this.#referenceItem(response, itemId);
      this.#flushAudio(response);
      if (this.#closed || this.#isRetired(response)) return;
      this.#emit({
        type: 'outputTranscript',
        responseId: response.id,
        itemId,
        transcript,
        final: type.endsWith('.done'),
      });
      return;
    }
    if (type === 'response.output_audio.done') {
      const response = this.#ownedResponse(event, 'response_id');
      const itemId = idField(event, 'item_id');
      if (this.#isRetired(response)) return;
      this.#referenceItem(response, itemId);
      this.#flushAudio(response);
      if (!this.#closed && !this.#isRetired(response))
        this.#emit({
          type: 'audioDone',
          responseId: response.id,
          itemId,
        });
      return;
    }
    if (type === 'response.done') {
      this.#responseDone(event);
      return;
    }
    if (type === 'output_audio_buffer.stopped') {
      this.#outputTerminal(event, 'stopped');
      return;
    }
    if (type === 'output_audio_buffer.cleared') {
      this.#outputTerminal(event, 'cleared');
      return;
    }
    if (type === 'error') {
      const error = objectField(event, 'error');
      boundedString(error, 'type', 128);
      const message = boundedString(error, 'message', 4_096);
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
      throw new Error(message);
    }

    // Call-level telemetry and forward-compatible unknown events are inert.
  }

  #responseCreated(event: Record<string, unknown>): void {
    const responseObject = objectField(event, 'response');
    const responseId = idField(responseObject, 'id');
    if (this.#responses.has(responseId))
      throw new Error('Codex reused a response identity');
    const requestToken = this.#waitingToken;
    if (!requestToken || this.#current)
      throw new Error('Codex created an unsolicited response');
    if (this.#responses.size >= MAX_RESPONSE_RECORDS)
      throw new Error('Codex response identity limit reached');

    const response: ResponseRecord = {
      id: responseId,
      requestToken,
      started: false,
      cancelRequested: false,
      terminalEmitted: false,
    };
    this.#responses.set(responseId, response);
    this.#waitingToken = undefined;
    this.#current = response;
    // Once a newer exact response exists, the trusted terminal contract makes
    // any subsequent bare PCM attributable to it rather than a retired owner.
    this.#mediaBoundary = false;
    this.#bindOutputFromDoneObject(response, responseObject);
    this.#emit({ type: 'responseCreated', responseId, requestToken });
    if (!this.#closed && this.#current === response) this.#flushAudio(response);
  }

  #outputStarted(event: Record<string, unknown>): void {
    const response = this.#ownedResponse(event, 'response_id');
    const itemId = optionalId(event, 'item_id');
    if (response.mediaTerminal)
      throw new Error('Codex restarted terminal response audio');
    if (response.cancelRequested || this.#current !== response) return;
    if (itemId) this.#referenceItem(response, itemId);
    response.started = true;
    this.#flushAudio(response);
  }

  #responseDone(event: Record<string, unknown>): void {
    const responseObject = objectField(event, 'response');
    const responseId = idField(responseObject, 'id');
    const response = this.#responses.get(responseId);
    if (!response) throw new Error('Codex completed an unowned response');
    const status = boundedString(responseObject, 'status', 64);
    if (response.providerStatus && response.providerStatus !== status)
      throw new Error('Codex changed a terminal response status');
    response.providerStatus = status;
    this.#bindOutputFromDoneObject(response, responseObject);

    // Completed generation is not application delivery. The exact matching
    // output buffer stop remains the sole successful terminal authorization.
    if (status === 'completed') {
      if (response.mediaTerminal === 'stopped')
        this.#emitTerminal(
          response,
          response.cancelRequested ? 'cancelled' : 'completed',
        );
      return;
    }
    if (!response.mediaTerminal && this.#current === response) {
      this.#mediaBoundary = true;
      this.#current = undefined;
      this.#discardPreIdentityAudio();
    }
    this.#emitTerminal(response, status);
  }

  #outputTerminal(
    event: Record<string, unknown>,
    terminal: 'stopped' | 'cleared',
  ): void {
    const response = this.#ownedResponse(event, 'response_id');
    if (response.mediaTerminal) return;
    response.mediaTerminal = terminal;
    if (this.#current === response) {
      this.#mediaBoundary = true;
      this.#current = undefined;
      this.#discardPreIdentityAudio();
    }

    if (terminal === 'cleared') {
      this.#emitTerminal(
        response,
        response.providerStatus && response.providerStatus !== 'completed'
          ? response.providerStatus
          : 'cancelled',
      );
    } else if (response.providerStatus === 'completed') {
      this.#emitTerminal(
        response,
        response.cancelRequested ? 'cancelled' : 'completed',
      );
    } else if (response.providerStatus) {
      this.#emitTerminal(response, response.providerStatus);
    }
  }

  #ownedResponse(event: Record<string, unknown>, key: string): ResponseRecord {
    const responseId = idField(event, key);
    const response = this.#responses.get(responseId);
    if (!response)
      throw new Error('Codex event referenced an unowned response');
    return response;
  }

  #bindOutputFromDoneObject(
    response: ResponseRecord,
    responseObject: Record<string, unknown>,
  ): void {
    const output = responseObject.output;
    if (output === undefined) return;
    if (!Array.isArray(output)) throw new TypeError('output must be an array');
    for (const value of output) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('output item must be an object');
      const item = value as Record<string, unknown>;
      const itemId = idField(item, 'id');
      this.#recordItemOwner(response, itemId);
      if (this.#isAssistantAudioItem(item)) this.#bindItem(response, itemId);
    }
    if (!this.#isRetired(response)) this.#flushAudio(response);
  }

  #isAssistantAudioItem(item: Record<string, unknown>): boolean {
    if (item.type !== 'message' || item.role !== 'assistant') return false;
    if (!Array.isArray(item.content))
      throw new TypeError('assistant message content must be an array');
    return item.content.some((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('assistant message content item must be an object');
      return (value as Record<string, unknown>).type === 'output_audio';
    });
  }

  #recordItemOwner(response: ResponseRecord, itemId: string): void {
    const owner = this.#itemOwners.get(itemId);
    if (owner !== undefined && owner !== response.id)
      throw new Error('Codex reused an output item identity');
    if (owner === undefined) {
      if (this.#itemOwners.size >= MAX_RESPONSE_RECORDS)
        throw new Error('Codex output item identity limit reached');
      this.#itemOwners.set(itemId, response.id);
    }
  }

  #referenceItem(response: ResponseRecord, itemId: string): void {
    this.#recordItemOwner(response, itemId);
    if (
      (response.referencedItemId && response.referencedItemId !== itemId) ||
      (response.itemId && response.itemId !== itemId)
    )
      throw new Error('Codex changed the output item identity');
    response.referencedItemId = itemId;
  }

  #bindItem(response: ResponseRecord, itemId: string): void {
    this.#referenceItem(response, itemId);
    response.itemId = itemId;
  }

  #mediaEligible(response: ResponseRecord): response is ResponseRecord & {
    itemId: string;
  } {
    return (
      this.#current === response &&
      response.started &&
      !response.cancelRequested &&
      !response.mediaTerminal &&
      typeof response.itemId === 'string'
    );
  }

  #isRetired(response: ResponseRecord): boolean {
    return (
      response.cancelRequested ||
      response.mediaTerminal !== undefined ||
      (response.providerStatus !== undefined &&
        response.providerStatus !== 'completed')
    );
  }

  #hasUnterminatedMediaOwner(): boolean {
    // appendSpeech and output-buffer control cross different transports. Bare
    // PCM cannot acquire a new owner until the prior one reaches its exact
    // stopped/cleared terminal.
    return [...this.#responses.values()].some(
      (response) =>
        !response.mediaTerminal &&
        (response.cancelRequested ||
          (response.providerStatus !== undefined &&
            response.providerStatus !== 'completed')),
    );
  }

  #bufferAudio(audio: Buffer): void {
    if (
      this.#preIdentityAudioBytes + audio.byteLength >
      this.#maxPreIdentityAudioBytes
    )
      throw new RangeError('Codex pre-identity audio exceeded its limit');
    this.#preIdentityAudio.push(audio);
    this.#preIdentityAudioBytes += audio.byteLength;
  }

  #flushAudio(response: ResponseRecord): void {
    if (!this.#mediaEligible(response)) return;
    while (this.#preIdentityAudio.length && this.#mediaEligible(response)) {
      const audio = this.#preIdentityAudio.shift()!;
      this.#preIdentityAudioBytes -= audio.byteLength;
      this.#emitAudio(response, audio);
      if (this.#closed) return;
    }
  }

  #emitAudio(response: ResponseRecord & { itemId: string }, pcm: Buffer): void {
    this.#emit({
      type: 'audio',
      responseId: response.id,
      itemId: response.itemId,
      pcm,
    });
  }

  #emitTerminal(response: ResponseRecord, status: string): void {
    if (response.terminalEmitted) return;
    response.terminalEmitted = true;
    this.#emit({ type: 'responseDone', responseId: response.id, status });
  }

  #discardPreIdentityAudio(): void {
    this.#preIdentityAudio.length = 0;
    this.#preIdentityAudioBytes = 0;
  }

  #send(event: Record<string, unknown>): void {
    this.#broker.sendEvent(JSON.stringify(event));
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error('Codex voice transport is closed');
  }

  #fatal(message: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#waitingToken = undefined;
    this.#current = undefined;
    this.#discardPreIdentityAudio();
    this.#closeBroker();
    this.#emit({ type: 'error', message });
  }

  #closeBroker(): void {
    try {
      const closed = this.#broker.close();
      if (closed && typeof closed.then === 'function')
        void closed.catch(() => undefined);
    } catch {
      // Correlation state is already terminal; broker cleanup is best effort.
    }
  }

  #emit(event: RealtimeVoiceEvent): void {
    try {
      this.#onEvent(event);
    } catch {
      // Consumer callbacks cannot compromise transport ownership or cleanup.
    }
  }
}
