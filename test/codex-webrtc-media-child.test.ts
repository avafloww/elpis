import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

/**
 * Red contract for the deliberately absent media-child runtime. Every external
 * boundary is injected below: these tests start no process, socket, timer,
 * WebRTC implementation, audio device, or other I/O.
 */
const FUTURE_MODULE_URL = new URL(
  '../src/voice/codex-webrtc-media-child.js',
  import.meta.url,
).href;

const CALL_ID = 'call-test-1';
const OFFER_SDP = 'v=0\r\ns=fake-offer';
const ANSWER_SDP = 'v=0\r\ns=fake-answer';

interface PeerCallbacks {
  onAudio(audio: Uint8Array): void;
  onEvent(text: string): void;
  onError(error: Error): void;
}

interface MediaPeer {
  createOffer(): string | Promise<string>;
  applyAnswer(sdp: string): void | Promise<void>;
  appendAudio(audio: Uint8Array): void | Promise<void>;
  sendEvent(text: string): void | Promise<void>;
  close(): void | Promise<void>;
}

interface Runtime {
  receive(message: unknown): void;
  terminate(error: Error): void;
}

interface RuntimeLimits {
  maxIpcMessageBytes: number;
  maxCallIdBytes: number;
  maxSdpBytes: number;
  maxAudioBytes: number;
  maxInputAudioBytes: number;
  maxEventBytes: number;
}

type IpcSend = (
  message: Record<string, unknown>,
  callback: (error: Error | null) => void,
) => boolean;

type CreateRuntime = (options: {
  createPeer(callbacks: PeerCallbacks): MediaPeer;
  send: IpcSend;
  exit(code: 0 | 1): void;
  limits: RuntimeLimits;
}) => Runtime;

let createRuntime: CreateRuntime;

const tick = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

const wireBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), 'utf8');

class FakePeer implements MediaPeer {
  readonly calls: Array<{ method: string; value?: unknown }> = [];
  offer = OFFER_SDP;
  closeError: Error | null = null;
  closePromise: Promise<void> | undefined;
  applyAnswerHook: (() => void) | undefined;
  appendAudioPromise: Promise<void> | undefined;

  constructor(
    readonly callbacks: PeerCallbacks,
    readonly trace: string[],
  ) {}

  async createOffer(): Promise<string> {
    this.calls.push({ method: 'createOffer' });
    this.trace.push('peer:createOffer');
    return this.offer;
  }

  async applyAnswer(sdp: string): Promise<void> {
    this.calls.push({ method: 'applyAnswer', value: sdp });
    this.trace.push('peer:applyAnswer');
    this.applyAnswerHook?.();
  }

  async appendAudio(audio: Uint8Array): Promise<void> {
    this.calls.push({ method: 'appendAudio', value: [...audio] });
    this.trace.push('peer:appendAudio');
    if (this.appendAudioPromise) await this.appendAudioPromise;
  }

  async sendEvent(text: string): Promise<void> {
    this.calls.push({ method: 'sendEvent', value: text });
    this.trace.push('peer:sendEvent');
  }

  async close(): Promise<void> {
    this.calls.push({ method: 'close' });
    this.trace.push('peer:close');
    if (this.closeError) throw this.closeError;
    if (this.closePromise) await this.closePromise;
  }

  audio(bytes: number[]): void {
    this.callbacks.onAudio(Uint8Array.from(bytes));
  }

  event(text: string): void {
    this.callbacks.onEvent(text);
  }

  error(error: Error): void {
    this.callbacks.onError(error);
  }
}

class FakeIpcSender {
  readonly messages: Array<Record<string, unknown>> = [];
  readonly callbacks: Array<(error: Error | null) => void> = [];
  readonly trace: string[];
  returnValue = true;

  constructor(trace: string[]) {
    this.trace = trace;
  }

  readonly send: IpcSend = (message, callback) => {
    this.messages.push(structuredClone(message));
    this.callbacks.push(callback);
    this.trace.push('send:' + String(message.type));
    return this.returnValue;
  };

  succeed(index = this.callbacks.length - 1): void {
    const callback = this.callbacks[index];
    assert.ok(callback, 'expected a pending IPC send callback');
    callback(null);
  }

  fail(error = new Error('synthetic IPC send failure')): void {
    const callback = this.callbacks.at(-1);
    assert.ok(callback, 'expected a pending IPC send callback');
    callback(error);
  }
}

const DEFAULT_LIMITS: RuntimeLimits = {
  maxIpcMessageBytes: 256,
  maxCallIdBytes: 32,
  maxSdpBytes: 64,
  maxAudioBytes: 4,
  maxInputAudioBytes: 4,
  maxEventBytes: 32,
};

function setup(options?: {
  limits?: Partial<RuntimeLimits>;
  offer?: string;
  closeError?: Error;
  closePromise?: Promise<void>;
  onApplyAnswer?: (peer: FakePeer) => void;
  appendAudioPromise?: Promise<void>;
  onCreatePeer?: (peer: FakePeer) => void;
  sendReturnValue?: boolean;
}) {
  const trace: string[] = [];
  const sender = new FakeIpcSender(trace);
  sender.returnValue = options?.sendReturnValue ?? true;
  const exits: number[] = [];
  let peer: FakePeer | undefined;
  let factoryCalls = 0;
  const runtime = createRuntime({
    createPeer(callbacks) {
      factoryCalls += 1;
      assert.equal(factoryCalls, 1, 'one runtime creates exactly one peer');
      peer = new FakePeer(callbacks, trace);
      peer.offer = options?.offer ?? OFFER_SDP;
      peer.closeError = options?.closeError ?? null;
      peer.closePromise = options?.closePromise;
      peer.applyAnswerHook = () => options?.onApplyAnswer?.(peer!);
      peer.appendAudioPromise = options?.appendAudioPromise;
      options?.onCreatePeer?.(peer);
      return peer;
    },
    send: sender.send,
    exit(code) {
      exits.push(code);
      trace.push('exit:' + code);
    },
    limits: { ...DEFAULT_LIMITS, ...options?.limits },
  });
  assert.ok(peer, 'the runtime creates its sole injected peer eagerly');
  return { runtime, peer, sender, exits, trace };
}

async function offer(harness: ReturnType<typeof setup>): Promise<void> {
  harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
  await tick();
  assert.deepEqual(harness.sender.messages.at(-1), {
    type: 'offer',
    callId: CALL_ID,
    sdp: OFFER_SDP,
  });
  harness.sender.succeed();
  await tick();
}

async function ready(harness: ReturnType<typeof setup>): Promise<void> {
  await offer(harness);
  harness.runtime.receive({
    type: 'answer.apply',
    callId: CALL_ID,
    sdp: ANSWER_SDP,
  });
  await tick();
  assert.deepEqual(harness.sender.messages.at(-1), {
    type: 'ready',
    callId: CALL_ID,
  });
  harness.sender.succeed();
  await tick();
}

async function assertTerminalFence(
  harness: ReturnType<typeof setup>,
  expectedCode = 1,
): Promise<void> {
  await tick();
  assert.equal(
    harness.peer.calls.filter((call) => call.method === 'close').length,
    1,
    'terminal cleanup closes the peer exactly once',
  );
  assert.deepEqual(harness.exits, [expectedCode]);

  const messages = structuredClone(harness.sender.messages);
  const calls = structuredClone(harness.peer.calls);
  harness.runtime.receive({ type: 'offer.create', callId: 'late-call' });
  harness.runtime.receive({
    type: 'event.send',
    callId: CALL_ID,
    text: 'late parent input',
  });
  harness.peer.audio([9]);
  harness.peer.event('late peer callback');
  await tick();
  assert.deepEqual(
    harness.sender.messages,
    messages,
    'terminal state fences sends',
  );
  assert.deepEqual(harness.peer.calls, calls, 'terminal state fences peer use');
  assert.deepEqual(harness.exits, [expectedCode], 'terminal state exits once');
}

describe('Codex WebRTC media child runtime contract', () => {
  before(async () => {
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(FUTURE_MODULE_URL)) as Record<string, unknown>;
    } catch (error) {
      assert.fail(
        'missing future module src/voice/codex-webrtc-media-child.ts: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    assert.equal(
      typeof loaded.createCodexWebRtcMediaChildRuntime,
      'function',
      'future module must export createCodexWebRtcMediaChildRuntime',
    );
    createRuntime = loaded.createCodexWebRtcMediaChildRuntime as CreateRuntime;
  });

  it('runs one correlated call in exact order and forwards opaque media', async () => {
    const harness = setup();

    harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
    await tick();
    assert.deepEqual(harness.peer.calls, [{ method: 'createOffer' }]);
    assert.deepEqual(harness.sender.messages, [
      { type: 'offer', callId: CALL_ID, sdp: OFFER_SDP },
    ]);
    harness.sender.succeed();
    await tick();

    harness.runtime.receive({
      type: 'answer.apply',
      callId: CALL_ID,
      sdp: ANSWER_SDP,
    });
    await tick();
    assert.deepEqual(harness.peer.calls.at(-1), {
      method: 'applyAnswer',
      value: ANSWER_SDP,
    });
    assert.deepEqual(harness.sender.messages.at(-1), {
      type: 'ready',
      callId: CALL_ID,
    });
    harness.sender.succeed();
    await tick();

    const opaqueText = '{ definitely-not-json \u0000 💥';
    harness.runtime.receive({
      type: 'audio.append',
      callId: CALL_ID,
      audio: 'AAEC',
    });
    harness.runtime.receive({
      type: 'event.send',
      callId: CALL_ID,
      text: opaqueText,
    });
    await tick();
    assert.deepEqual(harness.peer.calls.slice(-2), [
      { method: 'appendAudio', value: [0, 1, 2] },
      { method: 'sendEvent', value: opaqueText },
    ]);

    harness.peer.audio([3, 2, 1]);
    harness.peer.event(opaqueText);
    await tick();
    assert.deepEqual(harness.sender.messages.slice(-2), [
      { type: 'audio', callId: CALL_ID, audio: 'AwIB' },
      { type: 'event', callId: CALL_ID, text: opaqueText },
    ]);
    assert.equal(
      harness.peer.calls.some((call) => call.method === 'parseEvent'),
      false,
      'the media child never parses or copies Realtime JSON',
    );
    harness.sender.succeed(harness.sender.callbacks.length - 2);
    harness.sender.succeed();
    await tick();

    harness.runtime.receive({ type: 'close', callId: CALL_ID });
    await tick();
    assert.equal(harness.peer.calls.at(-1)?.method, 'close');
    assert.deepEqual(harness.sender.messages.at(-1), {
      type: 'closed',
      callId: CALL_ID,
    });
    assert.deepEqual(harness.exits, [], 'exit waits for the closed receipt');

    const sendCountAtClose = harness.sender.messages.length;
    harness.peer.audio([1]);
    harness.peer.event('during close');
    await tick();
    assert.equal(harness.sender.messages.length, sendCountAtClose);
    harness.sender.succeed();
    await tick();
    assert.deepEqual(harness.exits, [0]);
    assert.deepEqual(harness.trace.slice(-3), [
      'peer:close',
      'send:closed',
      'exit:0',
    ]);

    const finalMessages = structuredClone(harness.sender.messages);
    harness.runtime.receive({ type: 'offer.create', callId: 'new-call' });
    harness.peer.audio([2]);
    harness.peer.event('after close');
    await tick();
    assert.deepEqual(harness.sender.messages, finalMessages);
    assert.deepEqual(harness.exits, [0]);
    assert.deepEqual(harness.trace, [
      'peer:createOffer',
      'send:offer',
      'peer:applyAnswer',
      'send:ready',
      'peer:appendAudio',
      'peer:sendEvent',
      'send:audio',
      'send:event',
      'peer:close',
      'send:closed',
      'exit:0',
    ]);
  });

  it('buffers peer media during answer readiness and forwards it after ready in order', async () => {
    const opaque = '{early-event: "neutral ✓"}';
    const harness = setup({
      onApplyAnswer(peer) {
        peer.audio([3, 2, 1]);
        peer.event(opaque);
      },
    });
    await offer(harness);
    harness.runtime.receive({
      type: 'answer.apply',
      callId: CALL_ID,
      sdp: ANSWER_SDP,
    });
    await tick();
    assert.deepEqual(harness.sender.messages.at(-1), {
      type: 'ready',
      callId: CALL_ID,
    });
    harness.sender.succeed();
    await tick();
    assert.deepEqual(harness.sender.messages.slice(-3), [
      { type: 'ready', callId: CALL_ID },
      { type: 'audio', callId: CALL_ID, audio: 'AwIB' },
      { type: 'event', callId: CALL_ID, text: opaque },
    ]);
  });

  it('treats a false process.send result as advisory and waits for callback', async () => {
    const harness = setup({ sendReturnValue: false });
    harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
    await tick();
    assert.deepEqual(harness.sender.messages, [
      { type: 'offer', callId: CALL_ID, sdp: OFFER_SDP },
    ]);
    assert.deepEqual(harness.exits, []);
    assert.equal(
      harness.peer.calls.some((call) => call.method === 'close'),
      false,
    );

    // Backpressure is not delivery failure. Only this callback settles send.
    harness.sender.succeed();
    await tick();
    harness.runtime.receive({
      type: 'answer.apply',
      callId: CALL_ID,
      sdp: ANSWER_SDP,
    });
    await tick();
    assert.deepEqual(harness.peer.calls.at(-1), {
      method: 'applyAnswer',
      value: ANSWER_SDP,
    });
    assert.deepEqual(harness.sender.messages.at(-1), {
      type: 'ready',
      callId: CALL_ID,
    });
  });

  it('rejects malformed, oversized, and noncanonical base64 before peer use', async (t) => {
    const cases = [
      { name: 'invalid alphabet', audio: 'AA*=' },
      { name: 'missing canonical padding', audio: 'AAA' },
      { name: 'nonzero discarded bits', audio: 'AB==' },
      { name: 'decoded payload over limit', audio: 'AQIDBAU=' },
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const harness = setup();
        await ready(harness);
        const callsBefore = harness.peer.calls.length;
        harness.runtime.receive({
          type: 'audio.append',
          callId: CALL_ID,
          audio: fixture.audio,
        });
        await tick();
        assert.equal(
          harness.peer.calls
            .slice(callsBefore)
            .some((call) => call.method === 'appendAudio'),
          false,
        );
        await assertTerminalFence(harness);
      });
    }
  });

  it('bounds SDP, audio, events, and complete IPC messages in UTF-8 bytes', async (t) => {
    await t.test('offer SDP before IPC send', async () => {
      const harness = setup({
        offer: 'é'.repeat(5),
        limits: { maxSdpBytes: 9 },
      });
      harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
      await tick();
      assert.deepEqual(harness.sender.messages, []);
      await assertTerminalFence(harness);
    });

    await t.test('complete offer IPC before IPC send', async () => {
      const createBytes = wireBytes({ type: 'offer.create', callId: CALL_ID });
      const harness = setup({
        limits: { maxIpcMessageBytes: createBytes + 1 },
      });
      harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
      await tick();
      assert.deepEqual(harness.sender.messages, []);
      await assertTerminalFence(harness);
    });

    await t.test('answer SDP before peer use', async () => {
      const harness = setup({
        offer: 'v=0',
        limits: { maxSdpBytes: 9 },
      });
      harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
      await tick();
      harness.sender.succeed();
      await tick();
      harness.runtime.receive({
        type: 'answer.apply',
        callId: CALL_ID,
        sdp: 'é'.repeat(5),
      });
      await tick();
      assert.equal(
        harness.peer.calls.some((call) => call.method === 'applyAnswer'),
        false,
      );
      await assertTerminalFence(harness);
    });

    await t.test('complete answer IPC before peer use', async () => {
      const offerMessage = { type: 'offer', callId: CALL_ID, sdp: OFFER_SDP };
      const maxIpcMessageBytes = wireBytes(offerMessage);
      const harness = setup({ limits: { maxIpcMessageBytes } });
      await offer(harness);
      const answerMessage = {
        type: 'answer.apply',
        callId: CALL_ID,
        sdp: ANSWER_SDP,
      };
      assert.ok(wireBytes(answerMessage) > maxIpcMessageBytes);
      harness.runtime.receive(answerMessage);
      await tick();
      assert.equal(
        harness.peer.calls.some((call) => call.method === 'applyAnswer'),
        false,
      );
      await assertTerminalFence(harness);
    });

    await t.test('audio and event ingress before peer use', async () => {
      const audioHarness = setup({ limits: { maxInputAudioBytes: 2 } });
      await ready(audioHarness);
      audioHarness.runtime.receive({
        type: 'audio.append',
        callId: CALL_ID,
        audio: 'AAEC',
      });
      await tick();
      assert.equal(
        audioHarness.peer.calls.some((call) => call.method === 'appendAudio'),
        false,
      );
      await assertTerminalFence(audioHarness);

      const eventHarness = setup({ limits: { maxEventBytes: 5 } });
      await ready(eventHarness);
      eventHarness.runtime.receive({
        type: 'event.send',
        callId: CALL_ID,
        text: '💥💥',
      });
      await tick();
      assert.equal(
        eventHarness.peer.calls.some((call) => call.method === 'sendEvent'),
        false,
      );
      await assertTerminalFence(eventHarness);
    });

    await t.test('audio and event peer callbacks before IPC send', async () => {
      const audioHarness = setup({ limits: { maxAudioBytes: 2 } });
      await ready(audioHarness);
      const audioSends = audioHarness.sender.messages.length;
      audioHarness.peer.audio([0, 1, 2]);
      await tick();
      assert.equal(audioHarness.sender.messages.length, audioSends);
      await assertTerminalFence(audioHarness);

      const eventHarness = setup({ limits: { maxEventBytes: 5 } });
      await ready(eventHarness);
      const eventSends = eventHarness.sender.messages.length;
      eventHarness.peer.event('💥💥');
      await tick();
      assert.equal(eventHarness.sender.messages.length, eventSends);
      await assertTerminalFence(eventHarness);
    });
  });

  it('rejects proxy and toJSON input before executing traps', async () => {
    const proxyHarness = setup();
    let proxyTrapCalls = 0;
    const proxy = new Proxy(
      { type: 'offer.create', callId: CALL_ID },
      {
        get(target, key, receiver) {
          proxyTrapCalls += 1;
          return Reflect.get(target, key, receiver);
        },
      },
    );
    proxyHarness.runtime.receive(proxy);
    await tick();
    assert.equal(proxyTrapCalls, 0);
    await assertTerminalFence(proxyHarness);

    const accessorHarness = setup();
    let accessorCalls = 0;
    const message = { type: 'offer.create', callId: CALL_ID } as Record<
      string,
      unknown
    >;
    Object.defineProperty(message, 'toJSON', {
      enumerable: true,
      get() {
        accessorCalls += 1;
        return () => ({ type: 'offer.create', callId: CALL_ID });
      },
    });
    accessorHarness.runtime.receive(message);
    await tick();
    assert.equal(accessorCalls, 0);
    await assertTerminalFence(accessorHarness);
  });

  it('rejects malformed, duplicate, out-of-order, and cross-call input', async (t) => {
    const cases: Array<{
      name: string;
      prepare(harness: ReturnType<typeof setup>): Promise<void>;
      message: unknown;
    }> = [
      { name: 'primitive', prepare: async () => {}, message: 'offer.create' },
      {
        name: 'extra field',
        prepare: async () => {},
        message: { type: 'offer.create', callId: CALL_ID, extra: true },
      },
      {
        name: 'empty call id',
        prepare: async () => {},
        message: { type: 'offer.create', callId: '' },
      },
      {
        name: 'answer before offer',
        prepare: async () => {},
        message: { type: 'answer.apply', callId: CALL_ID, sdp: ANSWER_SDP },
      },
      {
        name: 'duplicate offer',
        prepare: offer,
        message: { type: 'offer.create', callId: CALL_ID },
      },
      {
        name: 'media before ready',
        prepare: offer,
        message: { type: 'audio.append', callId: CALL_ID, audio: 'AA==' },
      },
      {
        name: 'cross-call answer',
        prepare: offer,
        message: {
          type: 'answer.apply',
          callId: 'call-other',
          sdp: ANSWER_SDP,
        },
      },
      {
        name: 'duplicate answer',
        prepare: ready,
        message: { type: 'answer.apply', callId: CALL_ID, sdp: ANSWER_SDP },
      },
      {
        name: 'cross-call media',
        prepare: ready,
        message: { type: 'event.send', callId: 'call-other', text: 'opaque' },
      },
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const harness = setup();
        await fixture.prepare(harness);
        harness.runtime.receive(fixture.message);
        await assertTerminalFence(harness);
      });
    }
  });

  it('uses distinct parent-input and peer-output audio limits', async () => {
    const harness = setup({
      limits: { maxInputAudioBytes: 1, maxAudioBytes: 4 },
    });
    await ready(harness);
    harness.peer.audio([1, 2, 3, 4]);
    await tick();
    assert.deepEqual(harness.sender.messages.at(-1), {
      type: 'audio',
      callId: CALL_ID,
      audio: 'AQIDBA==',
    });
    harness.sender.succeed();
    harness.runtime.receive({
      type: 'audio.append',
      callId: CALL_ID,
      audio: 'AQI=',
    });
    await assertTerminalFence(harness);
    assert.equal(
      harness.peer.calls.some((call) => call.method === 'appendAudio'),
      false,
    );
  });

  it('bounds inbound messages retained behind a blocked peer operation', async () => {
    const never = new Promise<void>(() => undefined);
    const harness = setup({
      limits: { maxIpcMessageBytes: 128 },
      appendAudioPromise: never,
    });
    await ready(harness);

    harness.runtime.receive({
      type: 'audio.append',
      callId: CALL_ID,
      audio: 'AA==',
    });
    await tick();
    assert.equal(
      harness.peer.calls.filter((call) => call.method === 'appendAudio').length,
      1,
    );
    for (let index = 1; index < 16; index += 1)
      harness.runtime.receive({
        type: 'audio.append',
        callId: CALL_ID,
        audio: 'AA==',
      });
    await tick();

    assert.equal(
      harness.peer.calls.filter((call) => call.method === 'appendAudio').length,
      1,
    );
    assert.deepEqual(harness.exits, [1]);
    assert.equal(
      harness.peer.calls.filter((call) => call.method === 'close').length,
      1,
    );
  });

  it('bounds unresolved outbound IPC callbacks by aggregate bytes', async () => {
    const harness = setup({ limits: { maxIpcMessageBytes: 128 } });
    await ready(harness);
    const sendsBeforeBurst = harness.sender.messages.length;

    for (let index = 0; index < 16; index += 1)
      harness.peer.audio([0, 1, 2, 3]);
    await tick();

    assert.ok(harness.sender.messages.length > sendsBeforeBurst);
    assert.ok(harness.sender.messages.length < sendsBeforeBurst + 16);
    await assertTerminalFence(harness);
  });

  it('closes gracefully after an offer while still awaiting the answer', async () => {
    const harness = setup();
    harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
    await tick();
    harness.sender.succeed();
    await tick();

    harness.runtime.receive({ type: 'close', callId: CALL_ID });
    await tick();
    assert.equal(harness.peer.calls.at(-1)?.method, 'close');
    assert.deepEqual(harness.sender.messages.at(-1), {
      type: 'closed',
      callId: CALL_ID,
    });
    assert.deepEqual(harness.exits, []);
    harness.sender.succeed();
    await tick();
    assert.deepEqual(harness.exits, [0]);
  });

  it('contains a synchronous peer-constructor failure after binding the peer', async () => {
    const failure = new Error('synthetic synchronous constructor callback');
    const harness = setup({
      onCreatePeer(peer) {
        peer.error(failure);
      },
    });
    await tick();
    assert.equal(
      harness.peer.calls.filter((call) => call.method === 'close').length,
      1,
    );
    assert.deepEqual(harness.exits, [1]);
  });

  it('exits terminal failure even when peer cleanup never settles', async () => {
    const never = new Promise<void>(() => undefined);
    const harness = setup({ closePromise: never });
    await ready(harness);
    harness.peer.error(new Error('synthetic terminal peer failure'));
    await tick();
    assert.equal(
      harness.peer.calls.filter((call) => call.method === 'close').length,
      1,
    );
    assert.deepEqual(harness.exits, [1]);
    const messages = structuredClone(harness.sender.messages);
    harness.peer.audio([9]);
    harness.runtime.receive({ type: 'offer.create', callId: 'late-call' });
    await tick();
    assert.deepEqual(harness.sender.messages, messages);
    assert.deepEqual(harness.exits, [1]);
  });

  it('fails closed when the parent IPC boundary terminates', async () => {
    const harness = setup();
    harness.runtime.terminate(new Error('synthetic parent disconnect'));
    await assertTerminalFence(harness);
  });

  it('fails closed when the media peer reports a transport fault', async () => {
    const harness = setup();
    await ready(harness);
    harness.peer.error(new Error('synthetic peer transport failure'));
    await assertTerminalFence(harness);
  });

  it('fails closed on send callback failure and fences every later source', async () => {
    const harness = setup();
    harness.runtime.receive({ type: 'offer.create', callId: CALL_ID });
    await tick();
    assert.equal(harness.sender.messages.length, 1);
    harness.sender.fail();
    await assertTerminalFence(harness);
  });

  it('fails closed when peer close fails and never claims closed', async () => {
    const harness = setup({
      closeError: new Error('synthetic peer close failure'),
    });
    await ready(harness);
    const messagesBeforeClose = harness.sender.messages.length;
    harness.runtime.receive({ type: 'close', callId: CALL_ID });
    await tick();
    assert.equal(harness.sender.messages.length, messagesBeforeClose);
    await assertTerminalFence(harness);
  });
});
