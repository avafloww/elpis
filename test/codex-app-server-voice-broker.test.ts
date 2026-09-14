import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import {
  ANSWER_SDP,
  FakeAppServerChild,
  FakeMediaChild,
  ManualTimers,
  OFFER_SDP,
  type JsonObject,
} from './fixtures/codex-app-server-voice-broker.js';

/**
 * Test-only red anchor. The imported module intentionally does not exist yet;
 * every boundary below is injected and no process, device, or network is used.
 */
const FUTURE_MODULE_URL = new URL(
  '../src/voice/codex-app-server-broker.js',
  import.meta.url,
).href;

interface VoiceBroker {
  start(): Promise<{ threadId: string }>;
  appendSpeech(text: string): void;
  appendAudio(audio: Uint8Array): void;
  sendEvent(text: string): void;
  close(): Promise<void>;
}

type VoiceBrokerConstructor = new (options: {
  appServerFactory: () => FakeAppServerChild;
  mediaChildFactory: () => FakeMediaChild;
  clientInfo: { name: string; title: string; version: string };
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  killTimeoutMs: number;
  maxJsonLineBytes: number;
  maxIpcMessageBytes: number;
  maxAudioFrameBytes: number;
  callIdFactory: () => string;
  setTimeout: ManualTimers['setTimeout'];
  clearTimeout: ManualTimers['clearTimeout'];
  onAudio: (audio: Uint8Array) => void;
  onEvent: (text: string) => void;
  onError: (error: Error) => void;
}) => VoiceBroker;

let Broker: VoiceBrokerConstructor;

const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

function messageByMethod(
  child: FakeAppServerChild,
  method: string,
): JsonObject {
  const message = child
    .requests()
    .find((candidate) => candidate.method === method);
  assert.ok(message, 'expected JSON-RPC message ' + method);
  return message;
}

function requestId(message: JsonObject): number {
  assert.equal(typeof message.id, 'number');
  return message.id as number;
}

function startedParams(threadId: string): JsonObject {
  return {
    threadId,
    realtimeSessionId: 'realtime-' + threadId,
    version: 'v3',
  };
}

function setup(
  overrides: {
    maxAudioFrameBytes?: number;
    onAppServerFactory?: (
      broker: () => VoiceBroker,
      child: FakeAppServerChild,
    ) => void;
    onMediaChildFactory?: (broker: () => VoiceBroker) => void;
  } = {},
) {
  const timers = new ManualTimers();
  const appServers: FakeAppServerChild[] = [];
  const mediaChildren: FakeMediaChild[] = [];
  const audio: Buffer[] = [];
  const events: string[] = [];
  const errors: Error[] = [];
  let nextCall = 1;
  let broker!: VoiceBroker;
  broker = new Broker({
    appServerFactory: () => {
      const child = new FakeAppServerChild();
      appServers.push(child);
      overrides.onAppServerFactory?.(() => broker, child);
      return child;
    },
    mediaChildFactory: () => {
      const child = new FakeMediaChild();
      mediaChildren.push(child);
      overrides.onMediaChildFactory?.(() => broker);
      return child;
    },
    clientInfo: {
      name: 'elpis',
      title: 'Elpis subscription voice broker',
      version: 'fixture-version',
    },
    startupTimeoutMs: 100,
    shutdownTimeoutMs: 50,
    killTimeoutMs: 25,
    maxJsonLineBytes: 1_048_576,
    maxIpcMessageBytes: 131_072,
    maxAudioFrameBytes: overrides.maxAudioFrameBytes ?? 960,
    callIdFactory: () => 'call-' + nextCall++,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onAudio: (value) => audio.push(Buffer.from(value)),
    onEvent: (value) => events.push(value),
    onError: (error) => errors.push(error),
  });
  return { broker, timers, appServers, mediaChildren, audio, events, errors };
}

async function reachNotificationWait(
  harness: ReturnType<typeof setup>,
  threadId = 'thread-a',
) {
  const opening = harness.broker.start();
  assert.equal(harness.appServers.length, 1);
  const app = harness.appServers[0];

  const initialize = messageByMethod(app, 'initialize');
  assert.deepEqual(initialize, {
    jsonrpc: '2.0',
    id: initialize.id,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'elpis',
        title: 'Elpis subscription voice broker',
        version: 'fixture-version',
      },
      capabilities: { experimentalApi: true },
    },
  });
  app.result(requestId(initialize), {});
  await tick();

  assert.deepEqual(messageByMethod(app, 'initialized'), {
    jsonrpc: '2.0',
    method: 'initialized',
  });
  const threadStart = messageByMethod(app, 'thread/start');
  assert.deepEqual(threadStart, {
    jsonrpc: '2.0',
    id: threadStart.id,
    method: 'thread/start',
    params: { ephemeral: true },
  });
  app.result(requestId(threadStart), { thread: { id: threadId } });
  await tick();

  assert.equal(harness.mediaChildren.length, 1);
  const media = harness.mediaChildren[0];
  assert.deepEqual(media.sent, [{ type: 'offer.create', callId: 'call-1' }]);
  media.receive({ type: 'offer', callId: 'call-1', sdp: OFFER_SDP });
  await tick();

  const realtimeStart = messageByMethod(app, 'thread/realtime/start');
  assert.deepEqual(realtimeStart, {
    jsonrpc: '2.0',
    id: realtimeStart.id,
    method: 'thread/realtime/start',
    params: {
      threadId,
      clientManagedHandoffs: true,
      delegationAckFiller: null,
      flushTranscriptTailOnSessionEnd: null,
      codexResponsesAsItems: null,
      codexResponseItemPrefix: null,
      codexResponseHandoffMode: null,
      codexResponseHandoffChannelPrefixes: null,
      model: null,
      outputModality: 'audio',
      includeStartupContext: false,
      initialItems: null,
      realtimeStartInstructions: null,
      realtimeEndInstructions: null,
      realtimeSessionId: null,
      transport: { type: 'webrtc', sdp: OFFER_SDP },
      version: 'v3',
      voice: null,
    },
  });
  const wire = JSON.stringify(realtimeStart);
  for (const forbidden of [
    'prompt',
    'history',
    'messages',
    'instructions',
    'developerInstructions',
    'tools',
    'SOUL',
    'MEMORY',
  ]) {
    assert.equal(
      wire.includes(forbidden),
      false,
      'realtime startup must not serialize ' + forbidden,
    );
  }

  app.result(requestId(realtimeStart), {});
  await tick();

  return { opening, app, media, realtimeStart, threadId };
}

async function finishOpen(
  state: Awaited<ReturnType<typeof reachNotificationWait>>,
) {
  state.app.notification(
    'thread/realtime/started',
    startedParams(state.threadId),
  );
  state.app.notification('thread/realtime/sdp', {
    threadId: state.threadId,
    sdp: ANSWER_SDP,
  });
  await tick();
  assert.deepEqual(state.media.sent.at(-1), {
    type: 'answer.apply',
    callId: 'call-1',
    sdp: ANSWER_SDP,
  });
  state.media.receive({ type: 'ready', callId: 'call-1' });
  assert.deepEqual(await state.opening, {
    threadId: state.threadId,
  });
}

async function terminate(
  harness: ReturnType<typeof setup>,
  app: FakeAppServerChild,
  threadId: string,
  media?: FakeMediaChild,
): Promise<void> {
  const closing = harness.broker.close();
  const stop = messageByMethod(app, 'thread/realtime/stop');
  assert.deepEqual(stop, {
    jsonrpc: '2.0',
    id: stop.id,
    method: 'thread/realtime/stop',
    params: { threadId },
  });
  const closeMessage = media?.sent.findLast(
    (message) => message.type === 'close',
  );
  if (media && closeMessage)
    media.receive({ type: 'closed', callId: closeMessage.callId });
  media?.exit(0, null);
  app.exit(0, null);
  await closing;
  assert.equal(harness.timers.activeCount, 0);
}

describe('Codex app-server subscription voice broker contract', () => {
  before(async () => {
    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(FUTURE_MODULE_URL)) as Record<string, unknown>;
    } catch (error) {
      assert.fail(
        'missing future module src/voice/codex-app-server-broker.ts: ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    assert.equal(
      typeof loaded.CodexAppServerVoiceBroker,
      'function',
      'future module must export CodexAppServerVoiceBroker',
    );
    Broker = loaded.CodexAppServerVoiceBroker as VoiceBrokerConstructor;
  });

  it('cancels startup when close is called reentrantly from the app factory', async () => {
    let closing: Promise<void> | undefined;
    const harness = setup({
      onAppServerFactory(getBroker) {
        closing = getBroker().close();
        void closing.catch(() => undefined);
      },
    });
    const opening = harness.broker.start();
    void opening.catch(() => undefined);
    assert.equal(harness.appServers.length, 1);
    assert.deepEqual(harness.appServers[0]!.requests(), []);
    assert.ok(closing);
    harness.appServers[0]!.exit(0, null);
    await closing;
    await assert.rejects(opening, /closed|cancel/i);
  });

  it('rejects nested start from returned app-process accessors', async () => {
    let reentered = false;
    let nested: Promise<{ threadId: string }> | undefined;
    const harness = setup({
      onAppServerFactory(getBroker, child) {
        const stdout = child.stdout;
        Object.defineProperty(child, 'stdout', {
          configurable: true,
          get() {
            if (!reentered) {
              reentered = true;
              nested = getBroker().start();
              void nested.catch(() => undefined);
            }
            return stdout;
          },
        });
      },
    });
    const opening = harness.broker.start();
    void opening.catch(() => undefined);
    assert.equal(harness.appServers.length, 1);
    assert.ok(nested);
    await assert.rejects(nested, /active|reentrant|starting|one call/i);
    const closing = harness.broker.close();
    harness.appServers[0]!.exit(0, null);
    await closing;
    await assert.rejects(opening, /closed|cancel/i);
  });

  it('rolls back broker listeners when later adoption registration throws', async () => {
    const harness = setup({
      onAppServerFactory(_getBroker, child) {
        const inheritedOn = child.on.bind(child);
        let registrations = 0;
        child.on = ((event: string, listener: (...args: unknown[]) => void) => {
          registrations += 1;
          const result = inheritedOn(event, listener);
          if (registrations === 4)
            throw new Error('synthetic broker listener registration failure');
          return result;
        }) as typeof child.on;
      },
    });
    const opening = harness.broker.start();
    await assert.rejects(opening, /adoption|registration|app-server/i);
    const child = harness.appServers[0]!;
    assert.deepEqual(child.kills, ['SIGKILL']);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
  });

  it('rejects pending close when app adoption fails before observed exit', async () => {
    let closing: Promise<void> | undefined;
    const harness = setup({
      onAppServerFactory(getBroker, child) {
        closing = getBroker().close();
        void closing.catch(() => undefined);
        child.stdout.on = () => {
          throw new Error('synthetic adoption failure after close');
        };
      },
    });
    const opening = harness.broker.start();
    await assert.rejects(opening, /adoption|app-server/i);
    assert.ok(closing);
    await assert.rejects(closing, /adoption|unobserved|disposal|close/i);
    assert.deepEqual(harness.appServers[0]!.kills, ['SIGKILL']);
  });

  it('kills an app child when post-factory subscription fails', async () => {
    const failure = new Error('synthetic stdout subscription failure');
    const harness = setup({
      onAppServerFactory(_getBroker, child) {
        child.stdout.on = () => {
          throw failure;
        };
      },
    });
    let opening: Promise<{ threadId: string }> | undefined;
    assert.doesNotThrow(() => {
      opening = harness.broker.start();
    });
    assert.ok(opening);
    await assert.rejects(opening, /subscription|adopt|app-server|stdout/i);
    assert.deepEqual(harness.appServers[0]!.kills, ['SIGKILL']);
    assert.equal(harness.timers.activeCount, 0);
  });

  it('rejects reentrant start from the app factory without orphaning a process', async () => {
    let reentered = false;
    let nested: Promise<{ threadId: string }> | undefined;
    const harness = setup({
      onAppServerFactory(getBroker) {
        if (reentered) return;
        reentered = true;
        nested = getBroker().start();
        void nested.catch(() => undefined);
      },
    });
    const opening = harness.broker.start();
    void opening.catch(() => undefined);
    assert.equal(harness.appServers.length, 1);
    assert.ok(nested);
    await assert.rejects(nested, /active|reentrant|starting|one call/i);
    const closing = harness.broker.close();
    harness.appServers[0]!.exit(0, null);
    await closing;
    await assert.rejects(opening, /closed|cancel/i);
  });

  it('owns a media child returned after reentrant close from its factory', async () => {
    let closing: Promise<void> | undefined;
    const harness = setup({
      onMediaChildFactory(getBroker) {
        closing = getBroker().close();
        void closing.catch(() => undefined);
      },
    });
    const opening = harness.broker.start();
    void opening.catch(() => undefined);
    const app = harness.appServers[0]!;
    const initialize = messageByMethod(app, 'initialize');
    app.result(requestId(initialize), {});
    await tick();
    const threadStart = messageByMethod(app, 'thread/start');
    app.result(requestId(threadStart), { thread: { id: 'thread-reentrant' } });
    await tick();

    assert.equal(harness.mediaChildren.length, 1);
    const media = harness.mediaChildren[0]!;
    assert.deepEqual(media.sent.at(-1), {
      type: 'close',
      callId: 'call-1',
    });
    media.receive({ type: 'closed', callId: 'call-1' });
    media.exit(0, null);
    app.exit(0, null);
    assert.ok(closing);
    await closing;
    await assert.rejects(opening, /closed|cancel/i);
    assert.equal(media.listenerCount('exit'), 0);
  });

  it('creates one ephemeral thread and starts only exact context-free V3 WebRTC', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    await assert.rejects(
      harness.broker.start(),
      /already|active|one call/i,
      'only one media child may exist for a call',
    );
    assert.equal(harness.appServers.length, 1);
    assert.equal(harness.mediaChildren.length, 1);

    let settled = false;
    void state.opening.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await tick();
    assert.equal(
      settled,
      false,
      'start waits for both correlated notifications',
    );

    await finishOpen(state);
    assert.equal(harness.appServers.length, 1);
    assert.equal(harness.mediaChildren.length, 1);
    await terminate(harness, state.app, state.threadId, state.media);
  });

  it('sends one exact appendSpeech request without serializing a resident token', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness, 'thread-speech');
    await finishOpen(state);

    harness.broker.appendSpeech('read this exactly');
    const append = messageByMethod(state.app, 'thread/realtime/appendSpeech');
    assert.deepEqual(append, {
      jsonrpc: '2.0',
      id: append.id,
      method: 'thread/realtime/appendSpeech',
      params: { threadId: 'thread-speech', text: 'read this exactly' },
    });
    assert.equal(
      state.app
        .requests()
        .filter((message) => message.method === 'thread/realtime/appendSpeech')
        .length,
      1,
    );
    assert.equal(JSON.stringify(append).includes('requestToken'), false);
    state.app.result(requestId(append), {});
    await tick();
    assert.deepEqual(harness.errors, []);
    await terminate(harness, state.app, state.threadId, state.media);
  });

  it('contains a response delivered reentrantly during appendSpeech write', async () => {
    const harness = setup();
    const state = await reachNotificationWait(
      harness,
      'thread-reentrant-speech',
    );
    await finishOpen(state);
    const input = state.app.stdin as unknown as {
      write(
        value: string | Uint8Array,
        callback?: (error?: Error | null) => void,
      ): boolean;
    };
    const originalWrite = input.write.bind(input);
    input.write = (value, callback?) => {
      const accepted = originalWrite(value);
      const message = JSON.parse(
        Buffer.from(value).toString('utf8'),
      ) as JsonObject;
      if (message.method === 'thread/realtime/appendSpeech')
        state.app.result(requestId(message), {});
      callback?.(null);
      return accepted;
    };

    assert.doesNotThrow(() => harness.broker.appendSpeech('reentrant reply'));
    await tick();
    assert.deepEqual(harness.errors, []);
    assert.equal(
      state.app
        .requests()
        .filter((message) => message.method === 'thread/realtime/appendSpeech')
        .length,
      1,
    );
    await terminate(harness, state.app, state.threadId, state.media);
  });

  it('contains appendSpeech rejection in the exact active broker generation', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness, 'thread-reject');
    await finishOpen(state);
    harness.broker.appendSpeech('reject me');
    const append = messageByMethod(state.app, 'thread/realtime/appendSpeech');
    state.app.receive({
      jsonrpc: '2.0',
      id: requestId(append),
      error: { code: -32000, message: 'synthetic append rejection' },
    });
    await tick();
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0]!.message, /append|synthetic/i);
    assert.deepEqual(state.media.sent.at(-1), {
      type: 'close',
      callId: 'call-1',
    });
    state.media.receive({ type: 'closed', callId: 'call-1' });
    state.media.exit(0, null);
    state.app.exit(0, null);
    await harness.broker.close();
  });

  it('enforces appendSpeech UTF-8 framing through AppServerClient', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness, 'thread-bound');
    await finishOpen(state);
    assert.doesNotThrow(() =>
      harness.broker.appendSpeech('💥'.repeat(300_000)),
    );
    await tick();
    assert.equal(
      state.app
        .requests()
        .some((message) => message.method === 'thread/realtime/appendSpeech'),
      false,
    );
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0]!.message, /1 MiB|line|append/i);
    state.media.receive({ type: 'closed', callId: 'call-1' });
    state.media.exit(0, null);
    state.app.exit(0, null);
    await harness.broker.close();
  });

  it('forwards bounded opaque audio and event media in both directions', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    await finishOpen(state);
    const opaque = '{not-json: true, value: "neutral ✓"}\n';

    harness.broker.appendAudio(Buffer.from([0, 1, 2]));
    harness.broker.sendEvent(opaque);
    assert.deepEqual(state.media.sent.slice(-2), [
      { type: 'audio.append', callId: 'call-1', audio: 'AAEC' },
      { type: 'event.send', callId: 'call-1', text: opaque },
    ]);

    state.media.receive({ type: 'audio', callId: 'call-1', audio: 'AwIB' });
    state.media.receive({ type: 'event', callId: 'call-1', text: opaque });
    assert.deepEqual(harness.audio, [Buffer.from([3, 2, 1])]);
    assert.deepEqual(harness.events, [opaque]);

    await terminate(harness, state.app, state.threadId, state.media);
  });

  it('rejects complete outbound IPC envelopes before affecting an open call', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    await finishOpen(state);
    const sentBefore = state.media.sent.length;

    assert.throws(
      () => harness.broker.appendAudio(Buffer.alloc(961)),
      /audio|frame|large|960/i,
    );
    assert.throws(
      () => harness.broker.appendAudio(Buffer.alloc(100_000)),
      /IPC|audio|large/i,
    );
    assert.throws(
      () => harness.broker.sendEvent('x'.repeat(131_050)),
      /IPC|event|large/i,
    );
    assert.equal(state.media.sent.length, sentBefore);
    assert.deepEqual(harness.errors, []);

    await terminate(harness, state.app, state.threadId, state.media);
  });

  it('bounds aggregate unresolved parent-to-child IPC callbacks', async () => {
    const harness = setup({ maxAudioFrameBytes: 70_000 });
    const state = await reachNotificationWait(harness);
    await finishOpen(state);
    const callbacks: Array<(error: Error | null) => void> = [];
    state.media.send = function (value, callback) {
      if (!this.connected) {
        callback?.(new Error('IPC is disconnected'));
        return false;
      }
      this.sent.push(structuredClone(value));
      if (callback) callbacks.push(callback);
      return true;
    };

    const audio = Buffer.alloc(70_000);
    harness.broker.appendAudio(audio);
    const sentAfterFirst = state.media.sent.length;
    assert.throws(
      () => harness.broker.appendAudio(audio),
      /IPC|backlog|buffer|large/i,
    );
    assert.equal(state.media.sent.length, sentAfterFirst + 1);
    assert.equal(state.media.sent.at(-1)?.type, 'close');
    assert.equal(harness.errors.length, 1);

    state.media.receive({ type: 'closed', callId: 'call-1' });
    state.media.exit(0, null);
    state.app.exit(0, null);
    await harness.broker.close();
    for (const callback of callbacks) callback(null);
  });

  it('reports an open-call media protocol failure exactly once', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    await finishOpen(state);
    state.media.receive({ type: 'audio', callId: 'call-1', audio: 'AAE' });
    state.media.receive({ type: 'audio', callId: 'call-1', audio: 'AAE' });
    await tick();
    assert.equal(harness.errors.length, 1);
    assert.match(harness.errors[0]!.message, /base64|media|protocol/i);
    assert.deepEqual(state.media.sent.at(-1), {
      type: 'close',
      callId: 'call-1',
    });

    state.media.receive({ type: 'closed', callId: 'call-1' });
    state.media.exit(0, null);
    state.app.exit(0, null);
    await harness.broker.close();
  });

  it('preserves an unexpected media exit as a rejected close result', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    await finishOpen(state);
    state.media.exit(1, null);
    state.app.exit(0, null);
    await tick();
    assert.equal(harness.errors.length, 1);
    await assert.rejects(
      harness.broker.close(),
      /media.*exit|code 1|closed receipt|shutdown/i,
    );
    assert.equal(harness.timers.activeCount, 0);
  });

  it('waits for a truthful closed receipt and observed media exit', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    await finishOpen(state);
    const closing = harness.broker.close();
    assert.equal(state.media.connected, true, 'close must not sever IPC first');
    assert.deepEqual(state.media.sent.at(-1), {
      type: 'close',
      callId: 'call-1',
    });

    let settled = false;
    void closing.finally(() => {
      settled = true;
    });
    state.media.receive({ type: 'closed', callId: 'call-1' });
    state.app.exit(0, null);
    await tick();
    assert.equal(settled, false, 'receipt alone is not observed process exit');
    state.media.exit(0, null);
    await closing;
    assert.equal(settled, true);
    assert.equal(harness.timers.activeCount, 0);
  });

  it('rejects graceful media exit zero without a closed receipt', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    await finishOpen(state);
    const closing = harness.broker.close();
    state.app.exit(0, null);
    state.media.exit(0, null);
    await assert.rejects(closing, /closed.*receipt|receipt.*closed/i);
    assert.equal(harness.timers.activeCount, 0);
  });

  it('fails closed on malformed, cross-thread, out-of-order, and duplicate notifications', async (t) => {
    const cases: Array<{
      name: string;
      deliver: (
        state: Awaited<ReturnType<typeof reachNotificationWait>>,
      ) => void;
    }> = [
      {
        name: 'malformed started',
        deliver: ({ app }) => app.notification('thread/realtime/started', {}),
      },
      {
        name: 'cross-thread started',
        deliver: ({ app }) =>
          app.notification(
            'thread/realtime/started',
            startedParams('thread-other'),
          ),
      },
      {
        name: 'wrong realtime version',
        deliver: ({ app, threadId }) =>
          app.notification('thread/realtime/started', {
            ...startedParams(threadId),
            version: 'v2',
          }),
      },
      {
        name: 'SDP before started',
        deliver: ({ app, threadId }) =>
          app.notification('thread/realtime/sdp', {
            threadId,
            sdp: ANSWER_SDP,
          }),
      },
      {
        name: 'duplicate started',
        deliver: ({ app, threadId }) => {
          const params = startedParams(threadId);
          app.notification('thread/realtime/started', params);
          app.notification('thread/realtime/started', params);
        },
      },
      {
        name: 'cross-thread SDP',
        deliver: ({ app, threadId }) => {
          app.notification('thread/realtime/started', startedParams(threadId));
          app.notification('thread/realtime/sdp', {
            threadId: 'thread-other',
            sdp: ANSWER_SDP,
          });
        },
      },
      {
        name: 'duplicate SDP',
        deliver: ({ app, threadId }) => {
          const started = startedParams(threadId);
          const sdp = { threadId, sdp: ANSWER_SDP };
          app.notification('thread/realtime/started', started);
          app.notification('thread/realtime/sdp', sdp);
          app.notification('thread/realtime/sdp', sdp);
        },
      },
    ];

    for (const fixture of cases) {
      await t.test(fixture.name, async () => {
        const harness = setup();
        const state = await reachNotificationWait(harness);
        fixture.deliver(state);
        await tick();
        state.app.notification(
          'thread/realtime/started',
          startedParams(state.threadId),
        );
        state.app.notification('thread/realtime/sdp', {
          threadId: state.threadId,
          sdp: ANSWER_SDP,
        });
        state.media.receive({ type: 'ready', callId: 'call-1' });
        state.media.receive({ type: 'closed', callId: 'call-1' });
        state.media.exit(0, null);
        state.app.exit(1, null);
        await assert.rejects(
          state.opening,
          /protocol|notification|correlation|duplicate|unexpected/i,
        );
        assert.equal(
          state.media.sent.some(
            (message) =>
              message.type === 'answer.apply' &&
              message.sdp === ANSWER_SDP &&
              fixture.name !== 'duplicate SDP',
          ),
          false,
          'late or mismatched signaling must not reach media IPC',
        );
        await harness.broker.close();
        assert.equal(harness.timers.activeCount, 0);
      });
    }
  });

  it('bounds JSONL and media IPC before accepting signaling data', async () => {
    const jsonHarness = setup();
    const jsonOpening = jsonHarness.broker.start();
    const jsonApp = jsonHarness.appServers[0];
    jsonApp.receiveRaw('x'.repeat(1_048_577));
    jsonApp.exit(1, null);
    await assert.rejects(jsonOpening, /JSON|too large/i);
    await jsonHarness.broker.close();

    const ipcHarness = setup();
    const state = await reachNotificationWait(ipcHarness);
    state.media.receive({
      type: 'offer',
      callId: 'call-1',
      sdp: 'x'.repeat(131_073),
    });
    state.media.receive({ type: 'closed', callId: 'call-1' });
    state.media.exit(0, null);
    state.app.exit(1, null);
    await assert.rejects(state.opening, /IPC|too large/i);
    await ipcHarness.broker.close();
    assert.equal(ipcHarness.timers.activeCount, 0);
  });

  it('does not let an exited old media child settle a newer session', async () => {
    const harness = setup();
    const first = await reachNotificationWait(harness, 'thread-one');
    await finishOpen(first);
    await terminate(harness, first.app, first.threadId, first.media);

    const secondOpening = harness.broker.start();
    const secondApp = harness.appServers[1];
    const initialize = messageByMethod(secondApp, 'initialize');
    secondApp.result(requestId(initialize), {});
    await tick();
    const threadStart = messageByMethod(secondApp, 'thread/start');
    secondApp.result(requestId(threadStart), { thread: { id: 'thread-two' } });
    await tick();
    const secondMedia = harness.mediaChildren[1];

    // These are deliberately emitted after the old child was detached.
    first.media.emit('exit', 9, null);
    first.media.emit('disconnect');
    first.app.emit('exit', 9, null);
    await tick();
    let secondSettled = false;
    void secondOpening.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    await tick();
    assert.equal(secondSettled, false);

    secondMedia.receive({
      type: 'offer',
      callId: 'call-2',
      sdp: OFFER_SDP,
    });
    await tick();
    secondApp.notification(
      'thread/realtime/started',
      startedParams('thread-two'),
    );
    secondApp.notification('thread/realtime/sdp', {
      threadId: 'thread-two',
      sdp: ANSWER_SDP,
    });
    secondMedia.receive({ type: 'ready', callId: 'call-2' });
    assert.deepEqual(await secondOpening, {
      threadId: 'thread-two',
    });
    await terminate(harness, secondApp, 'thread-two', secondMedia);
  });

  it('attempts realtime stop even while an earlier JSONL write is in flight', async () => {
    const harness = setup();
    const opening = harness.broker.start();
    const app = harness.appServers[0];
    const initialize = messageByMethod(app, 'initialize');
    app.result(requestId(initialize), {});
    await tick();
    const threadStart = messageByMethod(app, 'thread/start');
    app.result(requestId(threadStart), { thread: { id: 'thread-held' } });
    await tick();

    const media = harness.mediaChildren[0];
    app.stdin.write = function (
      value: string | Uint8Array,
      _callback?: (error?: Error | null) => void,
    ): boolean {
      this.writes.push(Buffer.from(value).toString('utf8'));
      return true;
    };
    media.receive({ type: 'offer', callId: 'call-1', sdp: OFFER_SDP });
    await tick();
    assert.ok(messageByMethod(app, 'thread/realtime/start'));

    const closing = harness.broker.close();
    assert.ok(
      messageByMethod(app, 'thread/realtime/stop'),
      'the terminal stop attempt must reach stdin before client teardown',
    );
    media.receive({ type: 'closed', callId: 'call-1' });
    media.exit(0, null);
    app.exit(0, null);
    await closing;
    await assert.rejects(opening, /cancel|closed/i);
    assert.equal(harness.timers.activeCount, 0);
  });

  it('rejects shutdown when SIGKILL is not followed by observed child exit', async () => {
    const harness = setup();
    const state = await reachNotificationWait(harness);
    state.app.autoExitOnSigkill = false;
    state.media.autoExitOnSigkill = false;

    const closing = harness.broker.close();
    harness.timers.advance(100);
    await assert.rejects(closing, /did not exit|SIGKILL/i);
    assert.equal(state.app.exitCode, null);
    assert.equal(state.media.exitCode, null);
    assert.equal(harness.timers.activeCount, 0);
    await assert.rejects(harness.broker.start(), /already|active|one call/i);
  });

  it('enforces startup, shutdown, and SIGKILL deadlines and leaves no child', async () => {
    const harness = setup();
    const opening = harness.broker.start();
    const app = harness.appServers[0];
    app.autoExitOnSigkill = true;

    harness.timers.advance(99);
    let rejected = false;
    void opening.catch(() => {
      rejected = true;
    });
    await tick();
    assert.equal(rejected, false);

    harness.timers.advance(1);
    await assert.rejects(opening, /startup.*100|100.*startup|deadline/i);
    assert.equal(
      app.stdin.ended,
      true,
      'startup timeout begins graceful shutdown',
    );

    harness.timers.advance(49);
    assert.deepEqual(app.kills, []);
    harness.timers.advance(1);
    assert.deepEqual(app.kills, ['SIGTERM']);
    harness.timers.advance(24);
    assert.deepEqual(app.kills, ['SIGTERM']);
    harness.timers.advance(1);
    assert.deepEqual(app.kills, ['SIGTERM', 'SIGKILL']);

    await harness.broker.close();
    assert.equal(app.signalCode, 'SIGKILL');
    assert.equal(app.listenerCount('exit'), 0);
    assert.equal(app.stdout.listenerCount('data'), 0);
    assert.equal(harness.mediaChildren.length, 0);
    assert.equal(harness.timers.activeCount, 0);

    const shutdownHarness = setup();
    const state = await reachNotificationWait(shutdownHarness);
    state.app.autoExitOnSigkill = true;
    state.media.autoExitOnSigkill = true;
    const closing = shutdownHarness.broker.close();
    const stop = messageByMethod(state.app, 'thread/realtime/stop');
    assert.deepEqual(stop, {
      jsonrpc: '2.0',
      id: stop.id,
      method: 'thread/realtime/stop',
      params: { threadId: state.threadId },
    });
    assert.equal(state.app.stdin.ended, true);
    assert.equal(state.media.connected, true);
    assert.deepEqual(state.media.sent.at(-1), {
      type: 'close',
      callId: 'call-1',
    });

    shutdownHarness.timers.advance(49);
    assert.deepEqual(state.app.kills, []);
    assert.deepEqual(state.media.kills, []);
    shutdownHarness.timers.advance(1);
    assert.deepEqual(state.app.kills, ['SIGTERM']);
    assert.deepEqual(state.media.kills, ['SIGTERM']);
    shutdownHarness.timers.advance(25);
    assert.deepEqual(state.app.kills, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(state.media.kills, ['SIGTERM', 'SIGKILL']);
    await assert.rejects(closing, /forced|graceful|receipt|SIGKILL/i);

    assert.equal(state.app.signalCode, 'SIGKILL');
    assert.equal(state.media.signalCode, 'SIGKILL');
    assert.equal(state.app.listenerCount('exit'), 0);
    assert.equal(state.app.stdout.listenerCount('data'), 0);
    assert.equal(state.media.listenerCount('exit'), 0);
    assert.equal(state.media.listenerCount('message'), 0);
    assert.equal(shutdownHarness.timers.activeCount, 0);
  });
});
