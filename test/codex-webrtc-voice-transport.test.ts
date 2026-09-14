import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CodexWebRtcVoiceTransport } from '../src/voice/codex-webrtc-voice-transport.js';
import { VoiceSession } from '../src/voice/session.js';
import type { RealtimeVoiceEvent } from '../src/voice/realtime.js';

class FakeBroker {
  readonly speech: string[] = [];
  readonly wire: Record<string, unknown>[] = [];
  closeCount = 0;
  appendSpeech(text: string): void {
    this.speech.push(text);
  }
  sendEvent(text: string): void {
    this.wire.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(): void {
    this.closeCount += 1;
  }
}

const raw = (value: unknown): string => JSON.stringify(value);
const created = (id: string): string =>
  raw({ type: 'response.created', response: { id } });
const started = (id: string): string =>
  raw({ type: 'output_audio_buffer.started', response_id: id });
const item = (responseId: string, itemId = 'item-a'): string =>
  raw({
    type: 'response.output_item.added',
    response_id: responseId,
    item: {
      id: itemId,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_audio' }],
    },
  });
const functionItem = (responseId: string, itemId: string): string =>
  raw({
    type: 'response.output_item.added',
    response_id: responseId,
    item: { id: itemId, type: 'function_call' },
  });
const done = (id: string, status = 'completed'): string =>
  raw({ type: 'response.done', response: { id, status } });
const stopped = (id: string): string =>
  raw({ type: 'output_audio_buffer.stopped', response_id: id });
const cleared = (id: string): string =>
  raw({ type: 'output_audio_buffer.cleared', response_id: id });

function setup(overrides: { maxPreIdentityAudioBytes?: number } = {}) {
  const broker = new FakeBroker();
  const events: RealtimeVoiceEvent[] = [];
  const transport = new CodexWebRtcVoiceTransport({
    broker,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return { broker, events, transport };
}

function eventTypes(events: RealtimeVoiceEvent[]): string[] {
  return events.map((event) => event.type);
}

describe('Codex WebRTC response correlation', () => {
  it('binds the first response to the exact pending token and stops only after provider completion', () => {
    const { broker, events, transport } = setup();
    transport.speakText('hello', 'token-a');
    transport.handleAudio(Uint8Array.of(1, 2));
    transport.handleEvent(created('response-a'));
    transport.handleEvent(started('response-a'));
    transport.handleEvent(item('response-a'));
    transport.handleAudio(Uint8Array.of(3, 4));
    transport.handleEvent(
      raw({
        type: 'response.output_audio_transcript.done',
        response_id: 'response-a',
        item_id: 'item-a',
        transcript: 'hello',
      }),
    );
    transport.handleEvent(done('response-a'));

    assert.deepEqual(broker.speech, ['hello']);
    assert.deepEqual(eventTypes(events), [
      'responseCreated',
      'audio',
      'audio',
      'outputTranscript',
    ]);
    assert.deepEqual(
      events
        .filter((event) => event.type === 'audio')
        .map((event) => [event.responseId, event.itemId, [...event.pcm]]),
      [
        ['response-a', 'item-a', [1, 2]],
        ['response-a', 'item-a', [3, 4]],
      ],
    );

    transport.handleEvent(stopped('response-a'));
    assert.deepEqual(events.at(-1), {
      type: 'responseDone',
      responseId: 'response-a',
      status: 'completed',
    });
  });

  it('retains PCM until a typed assistant output-audio item proves ownership', () => {
    const references = [
      (transport: CodexWebRtcVoiceTransport) =>
        transport.handleEvent(
          raw({
            type: 'output_audio_buffer.started',
            response_id: 'response-1',
            item_id: 'item-1',
          }),
        ),
      (transport: CodexWebRtcVoiceTransport) => {
        transport.handleEvent(started('response-1'));
        transport.handleEvent(
          raw({
            type: 'response.output_audio_transcript.delta',
            response_id: 'response-1',
            item_id: 'item-1',
            delta: 'one',
          }),
        );
      },
      (transport: CodexWebRtcVoiceTransport) => {
        transport.handleEvent(started('response-1'));
        transport.handleEvent(
          raw({
            type: 'response.output_audio.done',
            response_id: 'response-1',
            item_id: 'item-1',
          }),
        );
      },
    ];

    for (const reference of references) {
      const { broker, events, transport } = setup();
      transport.speakText('one', 'token-1');
      transport.handleAudio(Uint8Array.of(5));
      transport.handleEvent(created('response-1'));
      reference(transport);
      assert.equal(events.filter((event) => event.type === 'audio').length, 0);
      assert.equal(broker.closeCount, 0);

      transport.handleEvent(item('response-1', 'item-1'));
      assert.deepEqual(
        events.find((event) => event.type === 'audio'),
        {
          type: 'audio',
          responseId: 'response-1',
          itemId: 'item-1',
          pcm: Buffer.of(5),
        },
      );
    }
  });

  it('discards failed-response tail PCM until the exact media terminal', () => {
    const { broker, events, transport } = setup();
    transport.speakText('one', 'token-1');
    transport.handleEvent(created('response-1'));
    transport.handleEvent(item('response-1', 'item-1'));
    transport.handleEvent(started('response-1'));
    transport.handleAudio(Uint8Array.of(1));
    transport.handleEvent(done('response-1', 'failed'));
    transport.handleAudio(Uint8Array.of(2));

    assert.equal(broker.closeCount, 0);
    assert.equal(events.filter((event) => event.type === 'audio').length, 1);
    assert.deepEqual(events.at(-1), {
      type: 'responseDone',
      responseId: 'response-1',
      status: 'failed',
    });

    transport.handleEvent(stopped('response-1'));
    transport.speakText('two', 'token-2');
    assert.deepEqual(broker.speech, ['one', 'two']);
  });

  it('keeps benign call events and compatible retired events inert across a new response', () => {
    const { broker, events, transport } = setup();
    transport.speakText('one', 'token-1');
    transport.handleEvent(created('response-1'));
    transport.handleEvent(item('response-1', 'item-1'));
    transport.handleEvent(started('response-1'));
    transport.handleAudio(Uint8Array.of(1));
    transport.handleEvent(done('response-1'));
    transport.handleEvent(stopped('response-1'));
    transport.handleEvent(
      raw({ type: 'rate_limits.updated', rate_limits: [] }),
    );

    transport.speakText('two', 'token-2');
    transport.handleEvent(created('response-2'));
    transport.handleEvent(done('response-1'));
    transport.handleEvent(stopped('response-1'));
    transport.handleEvent(
      raw({
        type: 'response.output_audio_transcript.done',
        response_id: 'response-1',
        item_id: 'item-1',
        transcript: 'late',
      }),
    );
    transport.handleEvent(item('response-2', 'item-2'));
    transport.handleEvent(started('response-2'));
    transport.handleAudio(Uint8Array.of(2));

    assert.equal(broker.closeCount, 0);
    assert.equal(
      events.filter((event) => event.type === 'responseCreated').length,
      2,
    );
    assert.deepEqual(events.at(-1), {
      type: 'audio',
      responseId: 'response-2',
      itemId: 'item-2',
      pcm: Buffer.of(2),
    });
  });

  it('accepts both cancellation terminal orderings and tombstones stale events', () => {
    for (const terminalOrder of ['clear-first', 'done-first'] as const) {
      const { broker, events, transport } = setup();
      transport.speakText('one', 'token-1');
      transport.handleEvent(created('response-1'));
      transport.cancelResponse('response-1');
      assert.equal(broker.wire.length, 2);
      const cancel = broker.wire[0];
      assert.equal(typeof cancel?.event_id, 'string');
      assert.deepEqual(cancel, {
        type: 'response.cancel',
        event_id: cancel?.event_id,
        response_id: 'response-1',
      });
      assert.deepEqual(broker.wire[1], {
        type: 'output_audio_buffer.clear',
      });
      if (terminalOrder === 'clear-first') {
        transport.handleEvent(cleared('response-1'));
        transport.handleEvent(done('response-1', 'cancelled'));
      } else {
        transport.handleEvent(done('response-1', 'cancelled'));
        transport.handleEvent(cleared('response-1'));
      }
      transport.handleEvent(cleared('response-1'));
      transport.speakText('two', 'token-2');
      transport.handleEvent(created('response-2'));
      transport.handleEvent(done('response-1', 'cancelled'));
      assert.equal(broker.closeCount, 0, terminalOrder);
      assert.equal(
        events.filter(
          (event) =>
            event.type === 'responseDone' && event.responseId === 'response-1',
        ).length,
        1,
      );
    }
  });

  it('blocks a new handoff until cancelled media reaches an exact terminal', () => {
    const unresolved = setup();
    unresolved.transport.speakText('one', 'token-1');
    unresolved.transport.handleEvent(created('response-1'));
    unresolved.transport.cancelResponse('response-1');
    unresolved.transport.handleEvent(done('response-1', 'cancelled'));

    assert.throws(
      () => unresolved.transport.speakText('two', 'token-2'),
      /ambiguous|terminal/i,
    );
    assert.deepEqual(unresolved.broker.speech, ['one']);
    assert.equal(unresolved.broker.closeCount, 1);

    const failed = setup();
    failed.transport.speakText('one', 'token-1');
    failed.transport.handleEvent(created('response-1'));
    failed.transport.handleEvent(done('response-1', 'failed'));
    assert.throws(
      () => failed.transport.speakText('two', 'token-2'),
      /ambiguous|terminal/i,
    );
    assert.deepEqual(failed.broker.speech, ['one']);
    assert.equal(failed.broker.closeCount, 1);

    const terminal = setup();
    terminal.transport.speakText('one', 'token-1');
    terminal.transport.handleEvent(created('response-1'));
    terminal.transport.cancelResponse('response-1');
    terminal.transport.handleEvent(cleared('response-1'));
    terminal.transport.speakText('two', 'token-2');
    terminal.transport.handleEvent(created('response-2'));
    terminal.transport.handleAudio(Uint8Array.of(7, 8));
    terminal.transport.handleEvent(done('response-1', 'cancelled'));
    terminal.transport.handleEvent(cleared('response-1'));
    terminal.transport.handleEvent(item('response-2', 'item-2'));
    terminal.transport.handleEvent(started('response-2'));

    assert.equal(terminal.broker.closeCount, 0);
    assert.deepEqual(terminal.events.at(-1), {
      type: 'audio',
      responseId: 'response-2',
      itemId: 'item-2',
      pcm: Buffer.of(7, 8),
    });
  });

  it('does not send an uncovered clear after a reentrant exact terminal', () => {
    class TerminalDuringCancelBroker extends FakeBroker {
      transport?: CodexWebRtcVoiceTransport;
      override sendEvent(text: string): void {
        super.sendEvent(text);
        if (this.wire.at(-1)?.type === 'response.cancel')
          this.transport?.handleEvent(cleared('response-1'));
      }
    }

    const broker = new TerminalDuringCancelBroker();
    const events: RealtimeVoiceEvent[] = [];
    const transport = new CodexWebRtcVoiceTransport({
      broker,
      onEvent: (event) => events.push(event),
    });
    broker.transport = transport;
    transport.speakText('one', 'token-1');
    transport.handleEvent(created('response-1'));
    transport.cancelResponse('response-1');

    assert.equal(broker.wire.length, 1);
    assert.equal(broker.wire[0]?.type, 'response.cancel');
    assert.equal(typeof broker.wire[0]?.event_id, 'string');
    assert.deepEqual(events.at(-1), {
      type: 'responseDone',
      responseId: 'response-1',
      status: 'cancelled',
    });
    assert.equal(broker.closeCount, 0);

    transport.speakText('two', 'token-2');
    assert.deepEqual(broker.speech, ['one', 'two']);
  });

  it('cannot reenter speech between response cancel and global buffer clear', () => {
    class ReentrantBroker extends FakeBroker {
      transport?: CodexWebRtcVoiceTransport;
      override sendEvent(text: string): void {
        super.sendEvent(text);
        const event = this.wire.at(-1);
        if (event?.type === 'response.cancel')
          this.transport?.handleEvent(cleared('response-1'));
      }
    }

    const broker = new ReentrantBroker();
    let transport!: CodexWebRtcVoiceTransport;
    let reentrantError = '';
    const events: RealtimeVoiceEvent[] = [];
    transport = new CodexWebRtcVoiceTransport({
      broker,
      onEvent(event) {
        events.push(event);
        if (
          event.type === 'responseDone' &&
          event.responseId === 'response-1'
        ) {
          try {
            transport.speakText('two', 'token-2');
          } catch (error) {
            reentrantError = (error as Error).message;
          }
        }
      },
    });
    broker.transport = transport;

    transport.speakText('one', 'token-1');
    transport.handleEvent(created('response-1'));
    transport.cancelResponse('response-1');

    assert.match(reentrantError, /ambiguous|terminal|cancel/i);
    assert.deepEqual(broker.speech, ['one']);
    assert.equal(broker.wire.length, 1);
    const cancel = broker.wire[0];
    assert.equal(typeof cancel?.event_id, 'string');
    assert.deepEqual(cancel, {
      type: 'response.cancel',
      event_id: cancel?.event_id,
      response_id: 'response-1',
    });
    assert.equal(broker.closeCount, 1);
  });

  it('binds only assistant output-audio items and tombstones IDs call-wide', () => {
    const typed = setup();
    typed.transport.speakText('one', 'token-1');
    typed.transport.handleEvent(created('response-1'));
    typed.transport.handleEvent(functionItem('response-1', 'function-1'));
    typed.transport.handleAudio(Uint8Array.of(4));
    typed.transport.handleEvent(item('response-1', 'audio-1'));
    typed.transport.handleEvent(started('response-1'));
    assert.equal(typed.broker.closeCount, 0);
    assert.deepEqual(typed.events.at(-1), {
      type: 'audio',
      responseId: 'response-1',
      itemId: 'audio-1',
      pcm: Buffer.of(4),
    });
    typed.transport.handleEvent(done('response-1'));
    typed.transport.handleEvent(stopped('response-1'));
    typed.transport.speakText('two', 'token-2');
    typed.transport.handleEvent(created('response-2'));
    typed.transport.handleEvent(item('response-2', 'function-1'));
    assert.equal(typed.broker.closeCount, 1);

    const reused = setup();
    reused.transport.speakText('one', 'token-1');
    reused.transport.handleEvent(created('response-1'));
    reused.transport.handleEvent(item('response-1', 'shared-item'));
    reused.transport.handleEvent(done('response-1'));
    reused.transport.handleEvent(stopped('response-1'));
    reused.transport.speakText('two', 'token-2');
    reused.transport.handleEvent(created('response-2'));
    reused.transport.handleEvent(item('response-2', 'shared-item'));
    assert.equal(reused.broker.closeCount, 1);
    assert.equal(
      reused.events.some(
        (event) => event.type === 'audio' && event.responseId === 'response-2',
      ),
      false,
    );
  });

  it('correlates benign completed-cancel races and makes cancellation dominate success', () => {
    const hiddenCompletion = setup();
    hiddenCompletion.transport.speakText('one', 'token-1');
    hiddenCompletion.transport.handleEvent(created('response-1'));
    hiddenCompletion.transport.cancelResponse('response-1');
    const cancel = hiddenCompletion.broker.wire[0];
    assert.equal(typeof cancel?.event_id, 'string');
    const eventId = cancel?.event_id as string;
    hiddenCompletion.transport.handleEvent(done('response-1', 'completed'));
    hiddenCompletion.transport.handleEvent(
      raw({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          code: 'response_cancel_not_active',
          event_id: eventId,
          message: 'the response was already complete',
        },
      }),
    );
    hiddenCompletion.transport.handleEvent(stopped('response-1'));
    assert.equal(hiddenCompletion.broker.closeCount, 0);
    assert.deepEqual(hiddenCompletion.events.at(-1), {
      type: 'responseDone',
      responseId: 'response-1',
      status: 'cancelled',
    });

    const knownCompletion = setup();
    knownCompletion.transport.speakText('one', 'token-1');
    knownCompletion.transport.handleEvent(created('response-1'));
    knownCompletion.transport.handleEvent(done('response-1', 'completed'));
    knownCompletion.transport.cancelResponse('response-1');
    assert.deepEqual(knownCompletion.broker.wire, [
      { type: 'output_audio_buffer.clear' },
    ]);
    knownCompletion.transport.handleEvent(stopped('response-1'));
    assert.deepEqual(knownCompletion.events.at(-1), {
      type: 'responseDone',
      responseId: 'response-1',
      status: 'cancelled',
    });
  });

  it('treats cleared after completed generation as interruption, never success', () => {
    const { events, transport } = setup();
    transport.speakText('one', 'token-1');
    transport.handleEvent(created('response-1'));
    transport.handleEvent(done('response-1', 'completed'));
    transport.handleEvent(cleared('response-1'));
    assert.deepEqual(events.at(-1), {
      type: 'responseDone',
      responseId: 'response-1',
      status: 'cancelled',
    });
  });

  it('requires exact owned response IDs and rejects response ID reuse', () => {
    for (const invalid of [
      (transport: CodexWebRtcVoiceTransport) =>
        transport.handleEvent(stopped('wrong')),
      (transport: CodexWebRtcVoiceTransport) =>
        transport.handleEvent(raw({ type: 'output_audio_buffer.stopped' })),
      (transport: CodexWebRtcVoiceTransport) =>
        transport.handleEvent(created('response-a')),
    ]) {
      const { broker, transport } = setup();
      transport.speakText('hello', 'token-a');
      transport.handleEvent(created('response-a'));
      invalid(transport);
      assert.equal(broker.closeCount, 1);
    }
  });

  it('rejects unsolicited creation and bounded pre-identity PCM overflow', () => {
    const unsolicited = setup();
    unsolicited.transport.handleEvent(created('response-a'));
    assert.equal(unsolicited.broker.closeCount, 1);

    const bounded = setup({ maxPreIdentityAudioBytes: 2 });
    bounded.transport.speakText('hello', 'token-a');
    bounded.transport.handleAudio(Uint8Array.of(1, 2));
    bounded.transport.handleAudio(Uint8Array.of(3));
    assert.equal(bounded.broker.closeCount, 1);
    assert.equal(bounded.events.at(-1)?.type, 'error');
  });

  it('makes post-stopped and pre-next-identity PCM fatal', () => {
    for (const speakNext of [false, true]) {
      const { broker, transport } = setup();
      transport.speakText('one', 'token-1');
      transport.handleEvent(created('response-1'));
      transport.handleEvent(done('response-1'));
      transport.handleEvent(stopped('response-1'));
      if (speakNext) transport.speakText('two', 'token-2');
      transport.handleAudio(Uint8Array.of(9));
      assert.equal(broker.closeCount, 1);
    }
  });

  it('makes post-cleared PCM fatal until a newer exact response binds', () => {
    const fatal = setup();
    fatal.transport.speakText('one', 'token-1');
    fatal.transport.handleEvent(created('response-1'));
    fatal.transport.cancelResponse('response-1');
    fatal.transport.handleEvent(cleared('response-1'));
    fatal.transport.speakText('two', 'token-2');
    fatal.transport.handleAudio(Uint8Array.of(9));
    assert.equal(fatal.broker.closeCount, 1);

    const accepted = setup();
    accepted.transport.speakText('one', 'token-1');
    accepted.transport.handleEvent(created('response-1'));
    accepted.transport.cancelResponse('response-1');
    accepted.transport.handleEvent(cleared('response-1'));
    accepted.transport.speakText('two', 'token-2');
    accepted.transport.handleEvent(created('response-2'));
    accepted.transport.handleAudio(Uint8Array.of(4));
    accepted.transport.handleEvent(item('response-2', 'item-2'));
    accepted.transport.handleEvent(started('response-2'));
    assert.equal(accepted.broker.closeCount, 0);
    assert.deepEqual(accepted.events.at(-1), {
      type: 'audio',
      responseId: 'response-2',
      itemId: 'item-2',
      pcm: Buffer.of(4),
    });
  });

  it('sends exact bounded conversation deletion events', () => {
    const { broker, transport } = setup();
    transport.deleteInput('input-a');
    assert.deepEqual(broker.wire, [
      { type: 'conversation.item.delete', item_id: 'input-a' },
    ]);
    assert.throws(() => transport.deleteInput('x'.repeat(257)), /bounded/);
  });

  it('closes before invoking a reentrant fatal callback', () => {
    const broker = new FakeBroker();
    let transport!: CodexWebRtcVoiceTransport;
    let reentrantError = '';
    transport = new CodexWebRtcVoiceTransport({
      broker,
      onEvent(event) {
        if (event.type === 'error') {
          try {
            transport.speakText('unsafe', 'new-token');
          } catch (error) {
            reentrantError = (error as Error).message;
          }
        }
      },
    });
    transport.handleEvent('{');
    assert.match(reentrantError, /closed/);
    assert.deepEqual(broker.speech, []);
    assert.equal(broker.closeCount, 1);
  });

  it('preserves finalized ingress events', () => {
    const { events, transport } = setup();
    transport.handleEvent(
      raw({
        type: 'input_audio_buffer.committed',
        item_id: 'input-1',
        previous_item_id: 'input-0',
      }),
    );
    transport.handleEvent(
      raw({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'input-1',
        transcript: 'final words',
      }),
    );
    assert.deepEqual(events, [
      {
        type: 'inputCommitted',
        itemId: 'input-1',
        previousItemId: 'input-0',
      },
      { type: 'inputTranscript', itemId: 'input-1', transcript: 'final words' },
    ]);
  });

  it('waits for the matching stop and then the local player drain before played', async () => {
    const broker = new FakeBroker();
    const writes: Buffer[] = [];
    let finish!: (playedMs: number) => void;
    const finished = new Promise<number>((resolve) => (finish = resolve));
    let session!: VoiceSession;
    const transport = new CodexWebRtcVoiceTransport({
      broker,
      onEvent: (event) => {
        if (event.type !== 'assistantAudioTruncated') session.handle(event);
      },
    });
    session = new VoiceSession({
      transport,
      playback: {
        write: (pcm) => writes.push(Buffer.from(pcm)),
        finish: () => finished,
        interrupt: () => 0,
        close: () => undefined,
      },
      canReceive: () => true,
      canSend: () => true,
      onUtterance: () => undefined,
      onNotice: () => undefined,
    });

    let settled = false;
    const delivery = session.speak('hello').then((value) => {
      settled = true;
      return value;
    });
    transport.handleEvent(created('response-a'));
    transport.handleEvent(item('response-a'));
    transport.handleEvent(started('response-a'));
    transport.handleAudio(Uint8Array.of(1, 2));
    transport.handleEvent(done('response-a'));
    await Promise.resolve();
    assert.equal(settled, false, 'raw response.done is not playback terminal');
    transport.handleEvent(stopped('response-a'));
    await Promise.resolve();
    assert.equal(settled, false, 'local player must drain');
    finish(25);
    assert.deepEqual(await delivery, {
      status: 'played',
      transcript: '',
      playedMs: 25,
    });
    assert.deepEqual(writes, [Buffer.of(1, 2)]);
  });

  it('poisons a second VoiceSession speech after an unresolved pre-creation interrupt', async () => {
    const broker = new FakeBroker();
    let session!: VoiceSession;
    const transport = new CodexWebRtcVoiceTransport({
      broker,
      onEvent: (event) => {
        if (event.type !== 'assistantAudioTruncated') session.handle(event);
      },
    });
    session = new VoiceSession({
      transport,
      playback: {
        write: () => undefined,
        finish: async () => 0,
        interrupt: () => 0,
        close: () => undefined,
      },
      canReceive: () => true,
      canSend: () => true,
      onUtterance: () => undefined,
      onNotice: () => undefined,
    });

    const first = session.speak('first');
    session.interrupt();
    assert.equal((await first).status, 'interrupted');
    const second = session.speak('second');
    assert.equal((await second).status, 'failed');
    assert.deepEqual(broker.speech, ['first']);
    assert.equal(broker.closeCount, 1);
    transport.handleEvent(created('delayed-first'));
    assert.deepEqual(broker.speech, ['first']);
  });
});
