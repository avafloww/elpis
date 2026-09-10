import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  RealtimeVoiceTransport,
  type RealtimeVoiceSocket,
  type RealtimeVoiceSocketHandlers,
} from '../src/voice/realtime.js';

class FakeSocket extends EventEmitter implements RealtimeVoiceSocket {
  bufferedAmount = 0;
  sent: string[] = [];
  closed: Array<[number, string]> = [];
  terminated = 0;
  detachCalls = 0;
  throwOnSend = false;
  throwOnDetach = false;
  throwOnClose = false;
  throwOnTerminate = false;
  duringAttach?: (handlers: RealtimeVoiceSocketHandlers) => void;
  afterSend?: (text: string) => void;

  attach(handlers: RealtimeVoiceSocketHandlers): () => void {
    this.on('open-event', handlers.open);
    this.on('message-event', handlers.message);
    this.on('error-event', handlers.error);
    this.on('close-event', handlers.close);
    this.duringAttach?.(handlers);
    return () => {
      this.detachCalls++;
      this.off('open-event', handlers.open);
      this.off('message-event', handlers.message);
      this.off('error-event', handlers.error);
      this.off('close-event', handlers.close);
      if (this.throwOnDetach) throw new Error('synthetic detach failure');
    };
  }

  sendText(text: string): void {
    if (this.throwOnSend) throw new Error('synthetic send failure');
    this.sent.push(text);
    this.afterSend?.(text);
  }

  close(code: number, reason: string): void {
    this.closed.push([code, reason]);
    if (this.throwOnClose) throw new Error('synthetic close failure');
  }

  terminate(): void {
    this.terminated += 1;
    if (this.throwOnTerminate) throw new Error('synthetic terminate failure');
  }

  open(): void {
    this.emit('open-event');
  }

  message(event: unknown): void {
    this.emit('message-event', Buffer.from(JSON.stringify(event)), false);
  }
}

function effectiveSession(instructions = 'You are Aster.') {
  return {
    type: 'realtime',
    model: 'resolved-model-alias',
    instructions,
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24_000 },
        turn_detection: {
          type: 'semantic_vad',
          create_response: false,
          interrupt_response: false,
        },
      },
      output: {
        format: { type: 'audio/pcm', rate: 24_000 },
      },
    },
  };
}

function setup(
  overrides: Partial<
    ConstructorParameters<typeof RealtimeVoiceTransport>[0]
  > = {},
) {
  const socket = new FakeSocket();
  let requested:
    { url: string; authorization: string; maxPayload: number } | undefined;
  const events: unknown[] = [];
  const transport = new RealtimeVoiceTransport({
    apiKey: 'synthetic-key',
    instructions: 'You are Aster.',
    socketFactory: (options) => {
      requested = options;
      return socket;
    },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { transport, socket, events, requested: () => requested };
}

describe('RealtimeVoiceTransport', () => {
  it('waits for explicit session readiness and disables automatic responses', async () => {
    const { transport, socket, requested } = setup();
    const connecting = transport.connect();
    socket.open();

    assert.equal(socket.sent.length, 1);
    const update = JSON.parse(socket.sent[0]);
    assert.deepEqual(update, {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: 'gpt-realtime-2.1',
        output_modalities: ['audio'],
        instructions: 'You are Aster.',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: {
              type: 'semantic_vad',
              eagerness: 'auto',
              create_response: false,
              interrupt_response: false,
            },
          },
          output: {
            format: { type: 'audio/pcm', rate: 24000 },
            voice: 'marin',
          },
        },
      },
    });
    assert.equal(
      socket.sent.some((text) => text.includes('response.create')),
      false,
    );
    assert.equal(
      requested()?.url,
      'wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1',
    );
    assert.equal(requested()?.authorization, 'Bearer synthetic-key');

    let settled = false;
    void connecting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    assert.equal(settled, true);
  });

  it('streams bounded audio and speaks only explicitly supplied resident text', async () => {
    const { transport, socket } = setup({ maxAudioChunkBytes: 4 });
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    socket.sent.length = 0;

    transport.appendAudio(Buffer.from([1, 2, 3, 4]));
    transport.commitInput();
    transport.speakText('Welcome back.', 'request-1', 'Sound warm.');

    assert.deepEqual(
      socket.sent.map((text) => JSON.parse(text)),
      [
        { type: 'input_audio_buffer.append', audio: 'AQIDBA==' },
        { type: 'input_audio_buffer.commit' },
        {
          type: 'response.create',
          response: {
            conversation: 'none',
            output_modalities: ['audio'],
            instructions:
              'Read the supplied text exactly as written. Do not add, remove, or change words. Sound warm.',
            input: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'Welcome back.' }],
              },
            ],
            metadata: { elpis_voice_request: 'request-1' },
          },
        },
      ],
    );
    assert.throws(
      () => transport.appendAudio(Buffer.alloc(5)),
      /audio chunk exceeds 4 bytes/,
    );
  });

  it('preserves utterance and response correlation without accumulating audio', async () => {
    const { transport, socket, events } = setup({ maxServerEventBytes: 1024 });
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;

    socket.message({
      type: 'input_audio_buffer.committed',
      item_id: 'user_1',
      previous_item_id: 'user_0',
    });
    socket.message({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'user_1',
      transcript: 'hello there',
    });
    socket.message({
      type: 'response.created',
      response: {
        id: 'resp_1',
        status: 'in_progress',
        metadata: { elpis_voice_request: 'request-1' },
      },
    });
    socket.message({
      type: 'response.output_audio.delta',
      response_id: 'resp_1',
      item_id: 'assistant_1',
      delta: Buffer.from([7, 8]).toString('base64'),
    });
    socket.message({
      type: 'response.output_audio_transcript.done',
      response_id: 'resp_1',
      item_id: 'assistant_1',
      transcript: 'Hello.',
    });
    socket.message({
      type: 'response.done',
      response: { id: 'resp_1', status: 'completed' },
    });

    assert.deepEqual(events, [
      {
        type: 'inputCommitted',
        itemId: 'user_1',
        previousItemId: 'user_0',
      },
      { type: 'inputTranscript', itemId: 'user_1', transcript: 'hello there' },
      {
        type: 'responseCreated',
        responseId: 'resp_1',
        requestToken: 'request-1',
      },
      {
        type: 'audio',
        responseId: 'resp_1',
        itemId: 'assistant_1',
        pcm: Buffer.from([7, 8]),
      },
      {
        type: 'outputTranscript',
        responseId: 'resp_1',
        itemId: 'assistant_1',
        transcript: 'Hello.',
        final: true,
      },
      { type: 'responseDone', responseId: 'resp_1', status: 'completed' },
    ]);
  });

  it('supports ordered instruction updates and explicit barge-in controls', async () => {
    const { transport, socket } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    socket.sent.length = 0;

    const updated = transport.updateInstructions('Updated resident context.');
    assert.deepEqual(JSON.parse(socket.sent[0]), {
      type: 'session.update',
      session: { type: 'realtime', instructions: 'Updated resident context.' },
    });
    let settled = false;
    void updated.then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false);
    socket.message({
      type: 'session.updated',
      event_id: 'evt_2',
      session: effectiveSession('Updated resident context.'),
    });
    await updated;

    transport.cancelResponse('unknown-response');
    socket.message({
      type: 'response.created',
      response: {
        id: 'resp_1',
        metadata: { elpis_voice_request: 'request-1' },
      },
    });
    transport.cancelResponse('resp_1');
    transport.truncateAssistantAudio('assistant_1', 640);
    transport.deleteInput('user_1');
    assert.deepEqual(
      socket.sent.slice(1).map((text) => JSON.parse(text)),
      [
        {
          type: 'response.cancel',
          event_id: 'elpis_voice_cancel_1',
          response_id: 'resp_1',
        },
        {
          type: 'conversation.item.truncate',
          item_id: 'assistant_1',
          content_index: 0,
          audio_end_ms: 640,
        },
        { type: 'conversation.item.delete', item_id: 'user_1' },
      ],
    );
  });

  it('closes on oversized or malformed server events without exposing payloads', async () => {
    const { transport, socket, events } = setup({ maxServerEventBytes: 1_024 });
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;

    socket.emit('message-event', Buffer.alloc(1_025, 1), false);
    assert.deepEqual(socket.closed, [[1009, 'realtime event too large']]);
    assert.deepEqual(events, [
      { type: 'error', message: 'Realtime server event exceeded 1024 bytes.' },
    ]);
  });

  it('fails closed on malformed recognized events and suppresses late socket input', async () => {
    const { transport, socket, events } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;

    socket.message({ type: 'response.created', response: { id: 'resp_1' } });
    assert.equal(transport.ready, false);
    assert.deepEqual(socket.closed, [[1002, 'protocol error']]);
    assert.deepEqual(events, [
      {
        type: 'error',
        message: 'Realtime server sent invalid response.created fields.',
      },
    ]);

    socket.message({
      type: 'response.created',
      response: {
        id: 'late',
        metadata: { elpis_voice_request: 'late-request' },
      },
    });
    assert.equal(events.length, 1);
  });

  it('accepts only an outstanding session update acknowledgement', async () => {
    const malformed = setup();
    const malformedConnecting = malformed.transport.connect();
    malformed.socket.open();
    malformed.socket.message({ type: 'session.updated', event_id: 'evt_bad' });
    await assert.rejects(
      malformedConnecting,
      /invalid session\.updated fields/,
    );
    assert.equal(malformed.transport.ready, false);

    const { transport, socket, events } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;

    socket.message({
      type: 'session.updated',
      event_id: 'evt_2',
      session: effectiveSession(),
    });
    assert.equal(transport.ready, false);
    assert.deepEqual(events, [
      {
        type: 'error',
        message: 'Realtime server sent invalid session.updated fields.',
      },
    ]);
  });

  it('requires acknowledged effective PCM and resident-owned VAD settings', async () => {
    const { transport, socket, events } = setup();
    const connecting = transport.connect();
    socket.open();
    const unsafe = effectiveSession();
    unsafe.audio.input.turn_detection.create_response = true;
    socket.message({
      type: 'session.updated',
      event_id: 'evt_unsafe',
      session: unsafe,
    });

    await assert.rejects(connecting, /invalid session\.updated fields/);
    assert.equal(transport.ready, false);
    assert.deepEqual(socket.closed, [[1002, 'protocol error']]);
    assert.equal((events.at(-1) as { type?: string }).type, 'error');
  });

  it('serializes later updates and validates each acknowledged instruction state', async () => {
    const { transport, socket } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    socket.sent.length = 0;

    const first = transport.updateInstructions('First update.');
    const second = transport.updateInstructions('Second update.');
    assert.equal(socket.sent.length, 1);
    assert.equal(
      JSON.parse(socket.sent[0]).session.instructions,
      'First update.',
    );

    socket.message({
      type: 'session.updated',
      event_id: 'evt_2',
      session: effectiveSession('First update.'),
    });
    await first;
    assert.equal(socket.sent.length, 2);
    assert.equal(
      JSON.parse(socket.sent[1]).session.instructions,
      'Second update.',
    );
    socket.message({
      type: 'session.updated',
      event_id: 'evt_3',
      session: effectiveSession('Second update.'),
    });
    await second;
    assert.equal(transport.ready, true);
    transport.close();
  });

  it('bounds update acknowledgements and notifies the owner on terminal timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { transport, socket, events } = setup({ updateTimeoutMs: 10 });
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;

    const updated = transport.updateInstructions('Updated context.');
    const rejected = assert.rejects(updated, /session update timed out/);
    t.mock.timers.tick(10);
    await rejected;

    assert.equal(transport.ready, false);
    assert.equal(socket.terminated, 1);
    assert.deepEqual(events, [
      { type: 'error', message: 'Realtime voice transport ended.' },
    ]);
  });

  it('uses bounded known-response cancellation and ignores only its benign race error', async () => {
    const { transport, socket, events } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;
    socket.sent.length = 0;

    transport.cancelResponse('not-known');
    assert.deepEqual(socket.sent, []);
    socket.message({
      type: 'response.created',
      response: {
        id: 'resp_1',
        metadata: { elpis_voice_request: 'request-1' },
      },
    });
    transport.cancelResponse('resp_1');
    const cancel = JSON.parse(socket.sent[0]);
    socket.message({
      type: 'response.done',
      response: { id: 'resp_1', status: 'cancelled' },
    });
    socket.message({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'response_cancel_not_active',
        message:
          'Cancellation failed because the response is no longer active.',
        event_id: cancel.event_id,
      },
    });

    assert.equal(transport.ready, true);
    assert.equal(socket.closed.length, 0);
    assert.equal(
      events.some((event) => (event as { type?: string }).type === 'error'),
      false,
    );

    socket.message({
      type: 'response.created',
      response: {
        id: 'resp_2',
        metadata: { elpis_voice_request: 'request-2' },
      },
    });
    transport.cancelResponse('resp_2');
    const secondCancel = JSON.parse(socket.sent.at(-1)!);
    socket.message({
      type: 'error',
      error: {
        type: 'authentication_error',
        code: 'invalid_api_key',
        message: 'Authentication failed.',
        event_id: secondCancel.event_id,
      },
    });
    assert.equal(transport.ready, false);
    assert.deepEqual(socket.closed, [[1011, 'realtime provider error']]);
    assert.equal(
      events.some(
        (event) =>
          (event as { type?: string; code?: string }).type === 'error' &&
          (event as { code?: string }).code === 'invalid_api_key',
      ),
      true,
    );
  });

  it('validates the complete error shape before benign cancellation handling', async () => {
    const { transport, socket, events } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;
    socket.sent.length = 0;

    socket.message({
      type: 'response.created',
      response: {
        id: 'resp_1',
        metadata: { elpis_voice_request: 'request-1' },
      },
    });
    transport.cancelResponse('resp_1');
    const cancel = JSON.parse(socket.sent[0]);
    socket.message({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        code: 'response_cancel_not_active',
        event_id: cancel.event_id,
      },
    });

    assert.equal(transport.ready, false);
    assert.deepEqual(socket.closed, [[1002, 'protocol error']]);
    assert.equal((events.at(-1) as { type?: string }).type, 'error');
  });

  it('keeps response ownership immutable through terminal tombstones', async () => {
    for (const terminal of [false, true]) {
      const { transport, socket, events } = setup();
      const connecting = transport.connect();
      socket.open();
      socket.message({
        type: 'session.updated',
        event_id: 'evt_1',
        session: effectiveSession(),
      });
      await connecting;
      events.length = 0;
      socket.message({
        type: 'response.created',
        response: {
          id: 'resp_reused',
          metadata: { elpis_voice_request: 'original-request' },
        },
      });
      if (terminal) {
        socket.message({
          type: 'response.done',
          response: { id: 'resp_reused', status: 'completed' },
        });
      }
      socket.message({
        type: 'response.created',
        response: {
          id: 'resp_reused',
          metadata: {
            elpis_voice_request: terminal
              ? 'original-request'
              : 'conflicting-request',
          },
        },
      });

      assert.equal(transport.ready, false);
      assert.deepEqual(socket.closed, [[1002, 'protocol error']]);
      assert.equal((events.at(-1) as { type?: string }).type, 'error');
    }
  });

  it('fails closed instead of retaining unbounded active response IDs', async () => {
    const { transport, socket, events } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;

    for (let index = 0; index < 1_025; index++) {
      socket.message({
        type: 'response.created',
        response: {
          id: `resp_${index}`,
          metadata: { elpis_voice_request: `request-${index}` },
        },
      });
    }

    assert.equal(transport.ready, false);
    assert.deepEqual(socket.closed, [[1002, 'protocol error']]);
    assert.equal(
      (events.at(-1) as { type?: string } | undefined)?.type,
      'error',
    );
  });

  it('terminalizes queued updates when a later serialized send throws', async () => {
    const { transport, socket, events } = setup();
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;
    socket.sent.length = 0;

    const first = transport.updateInstructions('First update.');
    const second = transport.updateInstructions('Second update.');
    const secondRejected = assert.rejects(second, /synthetic send failure/);
    socket.throwOnSend = true;
    socket.message({
      type: 'session.updated',
      event_id: 'evt_2',
      session: effectiveSession('First update.'),
    });

    await first;
    await secondRejected;
    assert.equal(transport.ready, false);
    assert.equal(socket.detachCalls, 1);
    assert.equal(socket.terminated, 1);
    assert.equal((events.at(-1) as { type?: string }).type, 'error');
    await assert.rejects(transport.connect(), /transport is closed/);
  });

  it('handles synchronous attach/update acknowledgements without stale timers', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { transport, socket } = setup({
      connectTimeoutMs: 10,
      updateTimeoutMs: 10,
    });
    socket.afterSend = (text) => {
      const sent = JSON.parse(text);
      if (sent.type !== 'session.update') return;
      socket.message({
        type: 'session.updated',
        event_id: 'evt_sync',
        session: effectiveSession(sent.session.instructions),
      });
    };
    socket.duringAttach = (handlers) => handlers.open();

    await transport.connect();
    const first = transport.updateInstructions('First sync update.');
    const second = transport.updateInstructions('Second sync update.');
    await Promise.all([first, second]);
    t.mock.timers.tick(100);
    assert.equal(transport.ready, true);
    transport.close();
  });

  it('detaches after a synchronous terminal callback during socket attach', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { transport, socket, events } = setup({ connectTimeoutMs: 10 });
    socket.duringAttach = (handlers) => handlers.error();

    await assert.rejects(transport.connect(), /socket error/);
    assert.equal(transport.ready, false);
    assert.equal(socket.detachCalls, 1);
    assert.equal(socket.terminated, 1);
    assert.deepEqual(events, [
      { type: 'error', message: 'Realtime voice socket error.' },
    ]);
    t.mock.timers.tick(100);
    assert.equal(socket.terminated, 1);
  });

  it('continues forced cleanup and owner notification through cleanup exceptions', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { transport, socket, events } = setup({ closeGraceMs: 10 });
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;
    socket.throwOnDetach = true;
    socket.throwOnClose = true;
    socket.throwOnTerminate = true;

    assert.doesNotThrow(() => transport.close());
    assert.deepEqual(events, [{ type: 'closed' }]);
    assert.equal(socket.detachCalls, 1);
    assert.equal(socket.closed.length, 1);
    t.mock.timers.tick(10);
    assert.equal(socket.terminated, 1);
  });

  it('terminates if graceful close does not finish and emits no late events', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { transport, socket, events } = setup({ closeGraceMs: 10 });
    const connecting = transport.connect();
    socket.open();
    socket.message({
      type: 'session.updated',
      event_id: 'evt_1',
      session: effectiveSession(),
    });
    await connecting;
    events.length = 0;

    transport.close();
    assert.deepEqual(socket.closed, [[1000, 'voice session ended']]);
    assert.deepEqual(events, [{ type: 'closed' }]);
    t.mock.timers.tick(9);
    assert.equal(socket.terminated, 0);
    t.mock.timers.tick(1);
    assert.equal(socket.terminated, 1);
    socket.message({ type: 'input_audio_buffer.committed', item_id: 'late' });
    assert.deepEqual(events, [{ type: 'closed' }]);
  });
});
