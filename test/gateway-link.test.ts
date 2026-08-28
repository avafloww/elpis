import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import {
  LIMITS,
  RESIDENT_CONTROL_PATHS,
  createGatewayHelloAck,
  createNodeCredential,
  serializeGatewayFrame,
  type GatewayToResidentFrame,
} from '@elpis/gateway-protocol';
import {
  GatewayLinkController,
  type GatewayLinkClock,
  type GatewayLinkEffectSink,
  type GatewayLinkSocket,
  type GatewayLinkSocketHandlers,
  type GatewayLinkStatus,
} from '../src/gateway-link.js';
import type { GatewayResidentSnapshot } from '../src/store/gateway-resident.js';

const INSTANCE = 'egi1.AAAAAAAAAAAAAAAAAAAAAA';
const CONNECTION = 'egx1.AAAAAAAAAAAAAAAAAAAAAA';
const ORIGIN = 'https://gateway.example';
const OFFERED_CAPABILITIES = ['identity.v1'] as const;
const credential = createNodeCredential((size) => Buffer.alloc(size, 7));

function snapshot(
  phase: GatewayResidentSnapshot['phase'],
): GatewayResidentSnapshot {
  const active = phase === 'active' || phase === 'rotating';
  return Object.freeze({
    instanceId: INSTANCE,
    phase,
    endpoint: phase === 'idle' ? null : ORIGIN,
    displayName: phase === 'idle' ? null : 'Resident',
    requestId:
      phase === 'enrolling' || phase === 'rotating'
        ? 'egr1.AAAAAAAAAAAAAAAAAAAAAA'
        : null,
    activeCredentialId: active ? credential.id : null,
    pendingCredentialId:
      phase === 'enrolling' || phase === 'rotating'
        ? 'egc1.AAAAAAAAAAAAAAAAAAAAAA'
        : null,
    createdAt: 1,
    updatedAt: 1,
    enrollmentStartedAt: phase === 'idle' ? null : 1,
    activatedAt: active ? 1 : null,
    rotationStartedAt: phase === 'rotating' ? 1 : null,
  });
}

class FakeClock implements GatewayLinkClock {
  now(): number {
    return 1;
  }
  next = 1;
  timers = new Map<number, { callback: () => void; delay: number }>();
  setTimeout(callback: () => void, delay: number): unknown {
    const id = this.next++;
    this.timers.set(id, { callback, delay });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  fire(): void {
    const item = [...this.timers.entries()][0];
    assert.ok(item);
    this.timers.delete(item[0]);
    item[1].callback();
  }
}

class FakeSocket extends EventEmitter implements GatewayLinkSocket {
  bufferedAmount = 0;
  onSend?: (text: string) => void;
  throwOnSend = false;
  handlers?: GatewayLinkSocketHandlers;
  sent: string[] = [];
  closed: Array<[number, string]> = [];
  terminated = 0;
  attach(handlers: GatewayLinkSocketHandlers): () => void {
    this.handlers = handlers;
    this.on('open', handlers.open);
    this.on('message', handlers.message);
    this.on('error-event', handlers.error);
    this.on('close-event', handlers.close);
    return () => {
      this.off('open', handlers.open);
      this.off('message', handlers.message);
      this.off('error-event', handlers.error);
      this.off('close-event', handlers.close);
    };
  }
  sendText(text: string): void {
    if (this.throwOnSend) throw new Error('send failed');
    // Deliberately invoke before recording to model a hostile reentrant adapter.
    this.onSend?.(text);
    this.sent.push(text);
  }
  close(code: number, reason: string): void {
    this.closed.push([code, reason]);
  }
  terminate(): void {
    this.terminated += 1;
  }
  message(data: string | Uint8Array, binary = false): void {
    this.emit('message', data, binary);
  }
}

function ack(connectionId = CONNECTION): string {
  return serializeGatewayFrame(
    createGatewayHelloAck({
      connectionId: connectionId as typeof CONNECTION,
      seq: 1,
      instanceId: INSTANCE,
      capabilities: OFFERED_CAPABILITIES,
    }),
  );
}

function base(
  overrides: Partial<
    ConstructorParameters<typeof GatewayLinkController>[0]
  > = {},
) {
  const clock = new FakeClock();
  const socket = new FakeSocket();
  let current = snapshot('active');
  let tokenReads = 0;
  const statuses: GatewayLinkStatus[] = [];
  const frames: GatewayToResidentFrame[] = [];
  const options: ConstructorParameters<typeof GatewayLinkController>[0] = {
    remote: { url: ORIGIN, enrollmentToken: null },
    store: {
      read: () => current,
      activeNodeToken: () => {
        tokenReads += 1;
        return credential.token;
      },
    },
    identity: { name: 'Aster' },
    build: { version: '1.2.3', revision: 'abc', state: 'dirty' },
    offeredCapabilities: OFFERED_CAPABILITIES,
    clock,
    random: () => 0,
    randomBytes: () => Buffer.alloc(16),
    socketFactory: () => socket,
    events: { status: (status) => statuses.push(status) },
    onFrame: (frame) => frames.push(frame),
    ...overrides,
  };
  return {
    controller: new GatewayLinkController(options),
    clock,
    socket,
    statuses,
    frames,
    setSnapshot: (value: GatewayResidentSnapshot) => {
      current = value;
    },
    tokenReads: () => tokenReads,
  };
}

describe('GatewayLinkController', () => {
  it('waits for enrollment, reads the token only on attempt, and requires ack', () => {
    const fixture = base();
    fixture.setSnapshot(snapshot('enrolling'));
    fixture.controller.start();
    assert.equal(fixture.controller.status.state, 'waiting_for_enrollment');
    assert.equal(fixture.tokenReads(), 0);
    assert.equal(fixture.clock.timers.size, 1);

    fixture.setSnapshot(snapshot('active'));
    fixture.clock.fire();
    assert.equal(fixture.controller.status.state, 'connecting');
    assert.equal(fixture.tokenReads(), 1);
    fixture.socket.emit('open');
    assert.equal(fixture.controller.status.state, 'handshaking');
    assert.equal(fixture.socket.sent.length, 1);
    const hello = JSON.parse(fixture.socket.sent[0]!);
    assert.equal(hello.connectionId, CONNECTION);
    assert.deepEqual(hello.capabilities, OFFERED_CAPABILITIES);
    assert.equal(hello.identity.name, 'Aster');

    fixture.socket.message(ack());
    assert.deepEqual(fixture.controller.status, {
      state: 'ready',
      failures: 0,
    });
    assert.deepEqual(fixture.frames, []);

    const frame = {
      version: 1,
      connectionId: CONNECTION,
      seq: 2,
      type: 'error',
      error: { code: 'invalid_frame', message: 'bounded' },
      fatal: false,
    } as const;
    fixture.socket.message(serializeGatewayFrame(frame));
    assert.deepEqual(fixture.frames, [frame]);
  });

  it('uses the exact WSS path and strict production socket options', () => {
    let captured: unknown[] = [];
    const fixture = base({
      socketFactory: (url, options) => {
        captured = [url, options];
        return new FakeSocket();
      },
    });
    fixture.controller.start();
    assert.equal(
      captured[0],
      'wss://gateway.example' + RESIDENT_CONTROL_PATHS.link,
    );
    const options = captured[1] as Record<string, unknown>;
    assert.equal(options.connectionId, CONNECTION);
    assert.equal(options.maxPayload, LIMITS.frameBytes);
    assert.equal(options.perMessageDeflate, false);
    assert.equal(
      Object.keys(options).sort().join(','),
      'authorization,connectionId,maxPayload,perMessageDeflate',
    );
    assert.equal(
      JSON.stringify(fixture.controller.status).includes(credential.token),
      false,
    );
  });

  it('rejects binary, invalid UTF-8, oversize, and shared-session errors', () => {
    for (const sendBad of [
      (socket: FakeSocket) => socket.message(Buffer.from('{}'), true),
      (socket: FakeSocket) => socket.message(Uint8Array.from([0xc3, 0x28])),
      (socket: FakeSocket) =>
        socket.message(new Uint8Array(LIMITS.frameBytes + 1)),
      (socket: FakeSocket) =>
        socket.message(ack('egx1.BBBBBBBBBBBBBBBBBBBBBB')),
    ]) {
      const fixture = base();
      fixture.controller.start();
      fixture.socket.emit('open');
      sendBad(fixture.socket);
      assert.equal(fixture.controller.status.state, 'backoff');
      assert.equal(fixture.controller.status.failures, 1);
      assert.equal(fixture.socket.terminated, 0);
      assert.equal(fixture.clock.timers.size, 1);
    }
  });

  it('applies bounded exponential equal jitter and resets only on ack', () => {
    const clock = new FakeClock();
    const sockets: FakeSocket[] = [];
    const fixture = base({
      clock,
      retryBaseMs: 100,
      retryMaxMs: 250,
      random: () => 0,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });
    fixture.controller.start();
    sockets[0]!.emit('error-event');
    assert.equal([...clock.timers.values()][0]!.delay, 50);
    clock.fire();
    sockets[1]!.emit('error-event');
    assert.equal([...clock.timers.values()][0]!.delay, 100);
    clock.fire();
    sockets[2]!.emit('open');
    sockets[2]!.message(ack());
    assert.equal(fixture.controller.status.failures, 0);
    sockets[2]!.emit('close-event');
    assert.equal([...clock.timers.values()][0]!.delay, 50);
  });

  it('contains synchronous status reentry, stale callbacks, and injected throws', () => {
    const clock = new FakeClock();
    const socket = new FakeSocket();
    let controller!: GatewayLinkController;
    controller = base({
      clock,
      socketFactory: () => socket,
      events: {
        status: (value) => {
          if (value.state === 'handshaking') controller.stop();
        },
      },
    }).controller;
    controller.start();
    socket.emit('open');
    assert.equal(controller.status.state, 'stopped');
    assert.equal(socket.sent.length, 0);
    socket.handlers?.message(ack(), false);
    assert.equal(controller.status.state, 'stopped');
    assert.equal(clock.timers.size, 0);

    const setupFault = base({
      socketFactory: () => {
        throw new Error(credential.token);
      },
    });
    assert.doesNotThrow(() => setupFault.controller.start());
    assert.deepEqual(setupFault.controller.status, {
      state: 'faulted',
      failures: 0,
    });
    assert.equal(setupFault.clock.timers.size, 0);

    const randomFallback = base({
      random: () => {
        throw new Error(credential.token);
      },
    });
    randomFallback.controller.start();
    randomFallback.socket.emit('error-event');
    assert.deepEqual(randomFallback.controller.status, {
      state: 'backoff',
      failures: 1,
    });
    assert.equal([...randomFallback.clock.timers.values()][0]!.delay, 750);
    assert.equal(
      JSON.stringify([
        ...setupFault.statuses,
        ...randomFallback.statuses,
      ]).includes(credential.token),
      false,
    );
  });

  it('validates and copies hello inputs before any attempt', () => {
    const identity = { name: 'Aster' };
    const build = { version: '1.2.3' };
    const fixture = base({ identity, build });
    identity.name = 'mutated';
    build.version = 'mutated';
    fixture.controller.start();
    fixture.socket.emit('open');
    const hello = JSON.parse(fixture.socket.sent[0]!);
    assert.equal(hello.identity.name, 'Aster');
    assert.equal(hello.build.version, '1.2.3');
    assert.deepEqual(hello.capabilities, OFFERED_CAPABILITIES);
    assert.throws(() =>
      base({ identity: { name: 'x'.repeat(LIMITS.identityNameBytes + 1) } }),
    );
  });

  it('faults durable local reads without retry or secret-bearing status', () => {
    const fixture = base({
      store: {
        read: () => {
          throw new Error(credential.token);
        },
        activeNodeToken: () => credential.token,
      },
    });
    fixture.controller.start();
    assert.deepEqual(fixture.controller.status, {
      state: 'faulted',
      failures: 0,
    });
    assert.equal(fixture.clock.timers.size, 0);
    assert.equal(
      JSON.stringify(fixture.statuses).includes(credential.token),
      false,
    );

    let reads = 0;
    const recheck = base({
      store: {
        read: () => {
          reads += 1;
          if (reads > 2) throw new Error(credential.token);
          return snapshot('active');
        },
        activeNodeToken: () => credential.token,
      },
    });
    recheck.controller.start();
    recheck.socket.emit('error-event');
    assert.deepEqual(recheck.controller.status, {
      state: 'faulted',
      failures: 1,
    });
    assert.equal(recheck.clock.timers.size, 0);
  });

  it('suppresses duplicate waiting status and contains synchronous timers', () => {
    const waiting = base();
    waiting.setSnapshot(snapshot('enrolling'));
    waiting.controller.start();
    const firstCount = waiting.statuses.length;
    waiting.clock.fire();
    assert.equal(waiting.statuses.length, firstCount);

    const synchronousClock: GatewayLinkClock = {
      now: () => 1,
      setTimeout: (callback) => {
        callback();
        return 1;
      },
      clearTimeout: () => undefined,
    };
    const enrollment = base({ clock: synchronousClock });
    enrollment.setSnapshot(snapshot('enrolling'));
    assert.doesNotThrow(() => enrollment.controller.start());
    assert.equal(enrollment.controller.status.state, 'faulted');

    const handshake = base({ clock: synchronousClock });
    handshake.controller.start();
    assert.equal(handshake.controller.status.state, 'faulted');
    assert.equal(handshake.socket.closed.length, 1);
  });

  it('stop cancels connect, handshake, and backoff and suppresses retries', () => {
    for (const phase of ['connect', 'handshake', 'backoff'] as const) {
      const fixture = base();
      fixture.controller.start();
      if (phase !== 'connect') fixture.socket.emit('open');
      if (phase === 'backoff') fixture.socket.emit('error-event');
      fixture.controller.stop();
      assert.equal(fixture.controller.status.state, 'stopped');
      assert.equal(fixture.clock.timers.size, 0);
      assert.ok(fixture.socket.closed.length >= 1);
      assert.equal(fixture.socket.terminated, 0);
      fixture.socket.emit('close-event');
      assert.equal(fixture.controller.status.state, 'stopped');
    }
  });
});

describe('GatewayLinkController resident effect sink', () => {
  const effectsCapabilities = [
    'console.v1',
    'identity.v1',
    'media.v1',
  ] as const;
  const viewerId = 'egv1.AAAAAAAAAAAAAAAAAAAAAA' as const;
  const requestId = 'egr1.AAAAAAAAAAAAAAAAAAAAAA' as const;

  function effectsAck(capabilities = effectsCapabilities): string {
    return serializeGatewayFrame(
      createGatewayHelloAck({
        connectionId: CONNECTION,
        seq: 1,
        instanceId: INSTANCE,
        capabilities,
      }),
    );
  }

  function viewerOpen(seq = 2): string {
    return serializeGatewayFrame({
      version: 1,
      connectionId: CONNECTION,
      seq,
      type: 'viewer.open',
      requestId,
      viewerId,
    });
  }

  it('writes contiguous session-owned effects during transport reentrancy', () => {
    const fixture = base({
      offeredCapabilities: effectsCapabilities,
      onFrame: (frame, effects) => {
        if (frame.type === 'viewer.open') {
          assert.equal(
            effects.operationResult({
              requestId: frame.requestId,
              viewerId: frame.viewerId,
              operation: frame.type,
              ok: true,
            }),
            true,
          );
        } else if (frame.type === 'console.input') {
          const output = {
            viewerId: frame.viewerId,
            payload: '{"echo":true}',
          };
          assert.equal(effects.consoleOutput(output), true);
          output.payload = '{"mutated":true}';
        }
      },
    });
    fixture.controller.start();
    fixture.socket.emit('open');
    fixture.socket.message(effectsAck());

    let reentered = false;
    fixture.socket.onSend = (text) => {
      const sent = JSON.parse(text) as { type?: string };
      if (sent.type !== 'operation.result' || reentered) return;
      reentered = true;
      fixture.socket.message(
        serializeGatewayFrame({
          version: 1,
          connectionId: CONNECTION,
          seq: 3,
          type: 'console.input',
          viewerId,
          payload: '{}',
        }),
      );
    };
    fixture.socket.message(viewerOpen());

    const sent = fixture.socket.sent.map(
      (text) => JSON.parse(text) as { type: string; seq: number; payload?: string },
    );
    assert.deepEqual(
      sent.map((frame) => [frame.type, frame.seq]),
      [
        ['hello', 1],
        ['operation.result', 2],
        ['console.output', 3],
      ],
    );
    assert.equal(sent[2]?.payload, '{"echo":true}');
  });

  it('closes on bounded backpressure and rejects a stale reconnect generation', () => {
    let currentSink: GatewayLinkEffectSink | undefined;
    const fixture = base({
      offeredCapabilities: effectsCapabilities,
      onFrame: (_frame, effects) => {
        currentSink = effects;
      },
    });
    fixture.controller.start();
    fixture.socket.emit('open');
    fixture.socket.message(effectsAck());
    fixture.socket.message(viewerOpen());
    const stale = currentSink;
    assert.ok(stale);

    fixture.socket.bufferedAmount = LIMITS.frameBytes;
    assert.equal(
      stale.operationResult({
        requestId,
        viewerId,
        operation: 'viewer.open',
        ok: true,
      }),
      false,
    );
    assert.deepEqual(fixture.socket.closed.at(-1), [1011, 'backpressure']);
    assert.equal(fixture.controller.status.state, 'backoff');

    fixture.socket.bufferedAmount = 0;
    fixture.clock.fire();
    fixture.socket.emit('open');
    fixture.socket.message(effectsAck());
    fixture.socket.message(viewerOpen());
    const replacement = currentSink;
    assert.ok(replacement);
    assert.notEqual(replacement, stale);
    assert.equal(
      stale.operationResult({
        requestId,
        viewerId,
        operation: 'viewer.open',
        ok: true,
      }),
      false,
    );
    assert.equal(
      replacement.operationResult({
        requestId,
        viewerId,
        operation: 'viewer.open',
        ok: true,
      }),
      true,
    );
    const last = JSON.parse(fixture.socket.sent.at(-1)!) as {
      type: string;
      seq: number;
    };
    assert.deepEqual(last, {
      type: 'operation.result',
      seq: 2,
      version: 1,
      connectionId: CONNECTION,
      requestId,
      viewerId,
      operation: 'viewer.open',
      ok: true,
    });
  });

  it('closes the current attempt when an effect send throws', () => {
    let sink: GatewayLinkEffectSink | undefined;
    const fixture = base({
      offeredCapabilities: effectsCapabilities,
      onFrame: (_frame, effects) => {
        sink = effects;
      },
    });
    fixture.controller.start();
    fixture.socket.emit('open');
    fixture.socket.message(effectsAck());
    fixture.socket.message(viewerOpen());
    fixture.socket.throwOnSend = true;
    assert.equal(
      sink?.operationResult({
        requestId,
        viewerId,
        operation: 'viewer.open',
        ok: true,
      }),
      false,
    );
    assert.deepEqual(fixture.socket.closed.at(-1), [1011, 'transport_error']);
  });
});
