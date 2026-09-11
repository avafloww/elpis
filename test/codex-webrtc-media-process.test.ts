import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

interface PeerCallbacks {
  onAudio(audio: Uint8Array): void;
  onEvent(text: string): void;
  onError(error: Error): void;
}

class FakePeer {
  readonly callbacks: PeerCallbacks;
  closeCalls = 0;

  constructor(callbacks: PeerCallbacks) {
    this.callbacks = callbacks;
  }

  createOffer(): string {
    return 'v=0\r\na=x-fixture:offer\r\n';
  }

  applyAnswer(): void {}
  appendAudio(): void {}
  sendEvent(): void {}

  close(): void {
    this.closeCalls += 1;
  }
}

class FakeProcess extends EventEmitter {
  connected = true;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly exitCodes: number[] = [];
  nextSendError: Error | null = null;

  send(
    message: Record<string, unknown>,
    callback: (error: Error | null) => void,
  ): boolean {
    this.sent.push(structuredClone(message));
    const error = this.nextSendError;
    this.nextSendError = null;
    queueMicrotask(() => callback(error));
    return true;
  }

  exit(code: number): void {
    this.exitCodes.push(code);
    this.connected = false;
  }
}

type StartProcess = (options: Record<string, unknown>) => void;
let startCodexWebRtcMediaProcess: StartProcess;
let CODEX_WEBRTC_MEDIA_CHILD_LIMITS: Record<string, number>;
try {
  ({ startCodexWebRtcMediaProcess, CODEX_WEBRTC_MEDIA_CHILD_LIMITS } =
    (await import('../src/voice/codex-webrtc-media-process.js')) as {
      startCodexWebRtcMediaProcess: StartProcess;
      CODEX_WEBRTC_MEDIA_CHILD_LIMITS: Record<string, number>;
    });
} catch (error) {
  assert.fail(
    'missing future module src/voice/codex-webrtc-media-process.ts: ' +
      (error instanceof Error ? error.message : String(error)),
  );
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function setup() {
  const child = new FakeProcess();
  let peer: FakePeer | undefined;
  startCodexWebRtcMediaProcess({
    process: child,
    createPeer: (callbacks: PeerCallbacks) => {
      assert.equal(peer, undefined);
      peer = new FakePeer(callbacks);
      return peer;
    },
  });
  return {
    child,
    get peer() {
      return peer!;
    },
  };
}

describe('Codex WebRTC media subprocess entrypoint', () => {
  it('uses one-frame input and bounded decoded-output audio defaults', () => {
    assert.equal(CODEX_WEBRTC_MEDIA_CHILD_LIMITS.maxInputAudioBytes, 960);
    assert.equal(CODEX_WEBRTC_MEDIA_CHILD_LIMITS.maxAudioBytes, 5_760);
  });

  it('wires one IPC call through a closed receipt and explicit exit zero', async () => {
    const harness = setup();
    assert.equal(harness.child.listenerCount('message'), 1);
    assert.equal(harness.child.listenerCount('disconnect'), 1);
    assert.equal(harness.child.listenerCount('SIGTERM'), 1);
    assert.equal(harness.child.listenerCount('SIGINT'), 1);
    assert.equal(harness.child.listenerCount('uncaughtException'), 1);
    assert.equal(harness.child.listenerCount('unhandledRejection'), 1);

    harness.child.emit('message', {
      type: 'offer.create',
      callId: 'call-process-fixture',
    });
    await flush();
    assert.deepEqual(harness.child.sent, [
      {
        type: 'offer',
        callId: 'call-process-fixture',
        sdp: 'v=0\r\na=x-fixture:offer\r\n',
      },
    ]);

    harness.child.emit('message', {
      type: 'answer.apply',
      callId: 'call-process-fixture',
      sdp: 'v=0\r\na=x-fixture:answer\r\n',
    });
    await flush();
    assert.deepEqual(harness.child.sent[1], {
      type: 'ready',
      callId: 'call-process-fixture',
    });

    harness.child.emit('message', {
      type: 'close',
      callId: 'call-process-fixture',
    });
    await flush();
    assert.deepEqual(harness.child.sent[2], {
      type: 'closed',
      callId: 'call-process-fixture',
    });
    assert.equal(harness.peer.closeCalls, 1);
    assert.deepEqual(harness.child.exitCodes, [0]);
    assert.equal(harness.child.listenerCount('message'), 0);
    assert.equal(harness.child.listenerCount('disconnect'), 0);
    assert.equal(harness.child.listenerCount('SIGTERM'), 0);
    assert.equal(harness.child.listenerCount('SIGINT'), 0);
    assert.equal(harness.child.listenerCount('uncaughtException'), 0);
    assert.equal(harness.child.listenerCount('unhandledRejection'), 0);
  });

  it('fails closed on parent disconnect and fences stale messages', async () => {
    const harness = setup();
    harness.child.emit('disconnect');
    await flush();
    assert.equal(harness.peer.closeCalls, 1);
    assert.deepEqual(harness.child.exitCodes, [1]);
    harness.child.emit('message', {
      type: 'offer.create',
      callId: 'late-call',
    });
    await flush();
    assert.deepEqual(harness.child.sent, []);
    assert.equal(harness.peer.closeCalls, 1);
  });

  it('fails closed on termination signals and uncaught faults exactly once', async () => {
    for (const event of [
      'SIGTERM',
      'SIGINT',
      'uncaughtException',
      'unhandledRejection',
    ]) {
      const harness = setup();
      if (event === 'uncaughtException' || event === 'unhandledRejection')
        harness.child.emit(event, new Error(`synthetic ${event}`));
      else harness.child.emit(event);
      harness.child.emit('disconnect');
      await flush();
      assert.equal(harness.peer.closeCalls, 1, event);
      assert.deepEqual(harness.child.exitCodes, [1], event);
    }
  });

  it('turns an IPC send callback failure into terminal exit one', async () => {
    const harness = setup();
    harness.child.nextSendError = new Error('synthetic IPC callback failure');
    harness.child.emit('message', {
      type: 'offer.create',
      callId: 'call-send-failure',
    });
    await flush();
    assert.equal(harness.peer.closeCalls, 1);
    assert.deepEqual(harness.child.exitCodes, [1]);
  });

  it('removes a listener when injected on registers and then throws', () => {
    const child = new FakeProcess();
    const inheritedOn = child.on.bind(child);
    child.on = ((event: string, listener: (...args: unknown[]) => void) => {
      const result = inheritedOn(event, listener);
      if (event === 'SIGTERM')
        throw new Error('synthetic post-registration failure');
      return result;
    }) as typeof child.on;
    let peer: FakePeer | undefined;
    startCodexWebRtcMediaProcess({
      process: child,
      createPeer: (callbacks: PeerCallbacks) => {
        peer = new FakePeer(callbacks);
        return peer;
      },
    });
    assert.ok(peer);
    assert.equal(peer.closeCalls, 1);
    assert.deepEqual(child.exitCodes, [1]);
    for (const event of [
      'message',
      'disconnect',
      'SIGTERM',
      'SIGINT',
      'uncaughtException',
      'unhandledRejection',
    ])
      assert.equal(child.listenerCount(event), 0, event);
  });

  it('stops attaching listeners after a synchronous subscription callback exits', () => {
    const child = new FakeProcess();
    const inheritedOn = child.on.bind(child);
    let fired = false;
    child.on = ((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'disconnect' && !fired) {
        fired = true;
        listener();
      }
      return inheritedOn(event, listener);
    }) as typeof child.on;
    let peer: FakePeer | undefined;
    startCodexWebRtcMediaProcess({
      process: child,
      createPeer: (callbacks: PeerCallbacks) => {
        peer = new FakePeer(callbacks);
        return peer;
      },
    });
    assert.ok(peer);
    assert.equal(peer.closeCalls, 1);
    assert.deepEqual(child.exitCodes, [1]);
    for (const event of [
      'message',
      'disconnect',
      'SIGTERM',
      'SIGINT',
      'uncaughtException',
      'unhandledRejection',
    ])
      assert.equal(child.listenerCount(event), 0, event);
  });

  it('does not attach listeners after synchronous constructor-callback exit', () => {
    const child = new FakeProcess();
    let peer: FakePeer | undefined;
    startCodexWebRtcMediaProcess({
      process: child,
      createPeer: (callbacks: PeerCallbacks) => {
        peer = new FakePeer(callbacks);
        callbacks.onError(new Error('synthetic synchronous peer failure'));
        return peer;
      },
    });
    assert.ok(peer);
    assert.equal(peer.closeCalls, 1);
    assert.deepEqual(child.exitCodes, [1]);
    for (const event of [
      'message',
      'disconnect',
      'SIGTERM',
      'SIGINT',
      'uncaughtException',
      'unhandledRejection',
    ])
      assert.equal(child.listenerCount(event), 0, event);
  });

  it('exits one explicitly when peer construction fails', () => {
    const child = new FakeProcess();
    const failure = new Error('synthetic peer construction failure');
    assert.doesNotThrow(() =>
      startCodexWebRtcMediaProcess({
        process: child,
        createPeer: () => {
          throw failure;
        },
      }),
    );
    assert.deepEqual(child.exitCodes, [1]);
    assert.equal(child.listenerCount('message'), 0);
    assert.equal(child.listenerCount('disconnect'), 0);
  });

  it('refuses a non-IPC process before constructing a peer', () => {
    const child = new FakeProcess();
    child.connected = false;
    let constructed = false;
    assert.throws(
      () =>
        startCodexWebRtcMediaProcess({
          process: child,
          createPeer: () => {
            constructed = true;
            throw new Error('must not construct');
          },
        }),
      /IPC|connected|fork/i,
    );
    assert.equal(constructed, false);
    assert.equal(child.listenerCount('message'), 0);
  });
});
