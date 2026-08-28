import assert from 'node:assert/strict';
import test from 'node:test';
import { createStandaloneConsoleTransport } from '../src/console/client/websocket-transport.js';

test('standalone Console transport preserves same-origin /ws framing and retries', () => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(
    globalThis,
    'WebSocket',
  );
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    'location',
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const timers: Array<{ callback: () => void; delay: number }> = [];

  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly url: string;
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;

    constructor(url: string) {
      this.url = url;
      sockets.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = 3;
      this.onclose?.();
    }
  }

  const sockets: FakeWebSocket[] = [];
  const restore = (
    key: 'WebSocket' | 'location' | 'window',
    descriptor: PropertyDescriptor | undefined,
  ): void => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  };

  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'https:', host: 'console.example.com' },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      setTimeout(callback: () => void, delay: number): number {
        timers.push({ callback, delay });
        return timers.length;
      },
      clearTimeout(): void {},
    },
  });

  try {
    const events: unknown[] = [];
    const transport = createStandaloneConsoleTransport();
    const unsubscribe = transport.subscribe((event) => events.push(event));
    assert.equal(sockets[0]?.url, 'wss://console.example.com/ws');
    assert.deepEqual(events, [{ type: 'connection', value: 'connecting' }]);
    assert.equal(transport.send({ t: 'context', reqId: 1 }), false);

    sockets[0].readyState = FakeWebSocket.OPEN;
    sockets[0].onopen?.();
    assert.equal(transport.send({ t: 'context', reqId: 1 }), true);
    assert.deepEqual(sockets[0].sent, ['{"t":"context","reqId":1}']);
    sockets[0].onmessage?.({ data: '{"t":"rooms","participants":2}' });
    sockets[0].onmessage?.({ data: '{not json' });
    assert.deepEqual(events.slice(1), [
      { type: 'connection', value: 'connected' },
      {
        type: 'frame',
        frame: { t: 'rooms', participants: 2 },
      },
      { type: 'malformed' },
    ]);

    sockets[0].close();
    assert.deepEqual(events.at(-1), {
      type: 'connection',
      value: 'reconnecting',
    });
    assert.equal(timers[0]?.delay, 500);
    timers[0]?.callback();
    assert.equal(sockets.length, 2);
    assert.equal(sockets[1]?.url, 'wss://console.example.com/ws');
    assert.deepEqual(events.at(-1), {
      type: 'connection',
      value: 'reconnecting',
    });

    assert.throws(
      () => transport.subscribe(() => {}),
      /already has an active subscriber/,
    );
    unsubscribe();
    assert.equal(transport.send({ t: 'context', reqId: 2 }), false);
  } finally {
    restore('WebSocket', originalWebSocket);
    restore('location', originalLocation);
    restore('window', originalWindow);
  }
});
test('standalone transport contains send races and never relabels listener failure', () => {
  const originalWebSocket = Object.getOwnPropertyDescriptor(
    globalThis,
    'WebSocket',
  );
  const originalLocation = Object.getOwnPropertyDescriptor(
    globalThis,
    'location',
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  class ThrowingWebSocket {
    static readonly OPEN = 1;
    readyState = ThrowingWebSocket.OPEN;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(_url: string) {
      socket = this;
    }
    send(): void {
      throw new Error('closing race');
    }
    close(): void {}
  }
  let socket!: ThrowingWebSocket;
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    value: ThrowingWebSocket,
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'https:', host: 'console.example' },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { setTimeout: () => 1, clearTimeout: () => {} },
  });
  try {
    const transport = createStandaloneConsoleTransport();
    const error = new Error('listener owns this failure');
    const unsubscribe = transport.subscribe((event) => {
      if (event.type === 'frame') throw error;
    });
    assert.equal(transport.send({ t: 'chat' }), false);
    assert.throws(
      () => socket.onmessage?.({ data: '{"t":"snapshot"}' }),
      error,
    );
    unsubscribe();
  } finally {
    for (const [key, descriptor] of [
      ['WebSocket', originalWebSocket],
      ['location', originalLocation],
      ['window', originalWindow],
    ] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
