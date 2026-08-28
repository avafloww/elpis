import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  createGatewayConsoleTransport,
  decodeGatewayConsoleRelayFrame,
  isGatewayConsoleMediaRoute,
} from '../client/console-transport.ts';

const INSTANCE = 'egi1.Abcdefghijklmnopqrstu_';

type MessageHandler = (event: { data: unknown }) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  closes: Array<[number | undefined, string | undefined]> = [];
  onopen: (() => void) | null = null;
  onmessage: MessageHandler | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(value: unknown): void {
    this.onmessage?.({ data: value });
  }

  send(value: string): void {
    if (this.readyState !== 1) throw new Error('not open');
    this.sent.push(value);
  }

  close(code?: number, reason?: string): void {
    this.closes.push([code, reason]);
    this.readyState = 3;
  }
}

function selection(
  reason: string,
  generation: number,
  phase: string,
  withInstance = true,
): string {
  return JSON.stringify({
    type: 'viewer.selection',
    reason,
    generation,
    phase,
    ...(withInstance ? { instanceId: INSTANCE } : {}),
  });
}

function crossSnapshotBarrier(socket: FakeWebSocket): void {
  socket.message(selection('selected', 1, 'opening'));
  socket.message(selection('snapshot', 1, 'snapshotting'));
  socket.message(
    JSON.stringify({
      type: 'console.output',
      payload: JSON.stringify({ t: 'snapshot', messages: [] }),
    }),
  );
  socket.message(selection('ready', 1, 'ready'));
}

function installBrowser(): () => void {
  FakeWebSocket.instances = [];
  const previous = {
    WebSocket: globalThis.WebSocket,
    location: Object.getOwnPropertyDescriptor(globalThis, 'location'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
  };
  Object.defineProperty(globalThis, 'WebSocket', {
    configurable: true,
    writable: true,
    value: FakeWebSocket,
  });
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { protocol: 'https:', host: 'gateway.example:8443' },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: globalThis,
  });
  return () => {
    if (previous.WebSocket === undefined) delete (globalThis as any).WebSocket;
    else globalThis.WebSocket = previous.WebSocket;
    if (previous.location)
      Object.defineProperty(globalThis, 'location', previous.location);
    else delete (globalThis as any).location;
    if (previous.window)
      Object.defineProperty(globalThis, 'window', previous.window);
    else delete (globalThis as any).window;
  };
}

test('relay decoder and media routes reject non-exact or untyped input', () => {
  const valid = selection('ready', 1, 'ready');
  assert.equal(decodeGatewayConsoleRelayFrame(valid).type, 'viewer.selection');
  assert.equal(
    decodeGatewayConsoleRelayFrame(selection('unavailable', 1, 'ready')).type,
    'viewer.selection',
  );
  for (const value of [
    { ...JSON.parse(valid), extra: true },
    { ...JSON.parse(valid), phase: 'idle' },
    { ...JSON.parse(valid), generation: 1.5 },
    { type: 'console.output', payload: 3 },
    {
      type: 'media.result',
      requestId: 'egr1.Abcdefghijklmnopqrstu_',
      ok: true,
      mediaType: 'image/png',
      byteLength: 1,
      sha256: '0'.repeat(64),
      data: 'Zh==',
    },
  ])
    assert.throws(() => decodeGatewayConsoleRelayFrame(JSON.stringify(value)));

  for (const route of [
    '/identity/avatar',
    '/attachments/channel/file.pdf',
    '/frames/watch/file.png',
    '/frames/computer/day/file.webp',
  ])
    assert.equal(isGatewayConsoleMediaRoute(route), true, route);
  for (const route of [
    'https://resident.invalid/frames/watch/file.png',
    '/private/file',
    '/attachments/only-one-part',
    '/frames/other/file.png',
    '/frames/watch/../secret',
    '/identity/avatar?size=2',
  ])
    assert.equal(isGatewayConsoleMediaRoute(route), false, route);
});

test('transport selects one instance and crosses connected barrier only at ready', () => {
  const restore = installBrowser();
  try {
    const transport = createGatewayConsoleTransport(INSTANCE);
    const events: unknown[] = [];
    const unsubscribe = transport.subscribe((event) => events.push(event));
    const socket = FakeWebSocket.instances[0]!;
    assert.equal(socket.url, 'wss://gateway.example:8443/api/v1/browser/relay');
    assert.deepEqual(events, [{ type: 'connection', value: 'connecting' }]);

    socket.open();
    assert.deepEqual(JSON.parse(socket.sent[0]!), {
      type: 'viewer.select',
      instanceId: INSTANCE,
    });
    socket.message(selection('selected', 1, 'opening'));
    socket.message(selection('snapshot', 1, 'snapshotting'));
    socket.message(
      JSON.stringify({
        type: 'console.output',
        payload: JSON.stringify({ t: 'snapshot', messages: [] }),
      }),
    );
    assert.equal(
      events.some(
        (event: any) =>
          event.type === 'connection' && event.value === 'connected',
      ),
      false,
    );
    assert.equal(transport.send({ t: 'chat', content: 'too soon' }), false);

    socket.message(selection('ready', 1, 'ready'));
    assert.equal((events.at(-1) as any).value, 'connected');
    assert.equal(transport.send({ t: 'chat', content: 'hello' }), true);
    assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
      type: 'console.input',
      payload: JSON.stringify({ t: 'chat', content: 'hello' }),
    });

    unsubscribe();
    assert.deepEqual(JSON.parse(socket.sent.at(-1)!), {
      type: 'viewer.deselect',
    });
    assert.deepEqual(socket.closes.at(-1), [1000, 'client_closed']);
  } finally {
    restore();
  }
});

test('media requests dedupe, verify bytes and digest, cache, and revoke on close', async () => {
  const restore = installBrowser();
  const created: Blob[] = [];
  const revoked: string[] = [];
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob: Blob): string => {
    created.push(blob);
    return 'blob:verified-' + created.length;
  };
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };
  try {
    const transport = createGatewayConsoleTransport(INSTANCE);
    transport.subscribe(() => undefined);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    crossSnapshotBarrier(socket);

    const first = transport.resolve('/attachments/channel/file.txt');
    const duplicate = transport.resolve('/attachments/channel/file.txt');
    assert.equal(first, duplicate);
    const request = JSON.parse(socket.sent.at(-1)!);
    assert.equal(request.type, 'media.get');
    assert.match(request.requestId, /^egr1\.[A-Za-z0-9_-]{22}$/);
    assert.equal(
      socket.sent.filter((wire) => JSON.parse(wire).type === 'media.get')
        .length,
      1,
    );

    const bytes = Buffer.from('verified media', 'utf8');
    socket.message(
      JSON.stringify({
        type: 'media.result',
        requestId: request.requestId,
        ok: true,
        mediaType: 'text/plain; charset=utf-8',
        byteLength: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        data: bytes.toString('base64'),
      }),
    );
    assert.equal(await first, 'blob:verified-1');
    assert.equal(created.length, 1);
    assert.equal(created[0]!.size, bytes.length);
    assert.equal(
      await transport.resolve('/attachments/channel/file.txt'),
      'blob:verified-1',
    );
    assert.equal(socket.sent.at(-1), JSON.stringify(request));

    transport.close();
    assert.deepEqual(revoked, ['blob:verified-1']);
  } finally {
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
    restore();
  }
});
test('terminal selection schedules a fresh exact-instance selection', () => {
  const restore = installBrowser();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: Array<{
    callback: () => void;
    delay: number;
    cleared: boolean;
  }> = [];
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    const timer = { callback, delay: delay ?? 0, cleared: false };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    (handle as unknown as { cleared: boolean }).cleared = true;
  }) as typeof clearTimeout;
  try {
    const transport = createGatewayConsoleTransport(INSTANCE);
    const events: any[] = [];
    transport.subscribe((event) => events.push(event));
    const first = FakeWebSocket.instances[0]!;
    first.open();
    crossSnapshotBarrier(first);
    first.message(selection('link_removed', 1, 'idle', false));
    assert.deepEqual(first.closes.at(-1), [1000, 'selection_lost']);
    assert.equal(events.at(-1)?.value, 'unavailable');
    assert.equal(timers.length, 1);
    assert.equal(timers[0]!.delay, 500);

    timers[0]!.callback();
    const second = FakeWebSocket.instances[1]!;
    second.open();
    assert.deepEqual(JSON.parse(second.sent[0]!), {
      type: 'viewer.select',
      instanceId: INSTANCE,
    });
    transport.close();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    restore();
  }
});

test('verified cache survives reconnect, rejects overflow without evicting, and revokes on close', async () => {
  const restore = installBrowser();
  const revoked: string[] = [];
  const oldCreate = URL.createObjectURL;
  const oldRevoke = URL.revokeObjectURL;
  let created = 0;
  URL.createObjectURL = (): string => 'blob:cache-' + ++created;
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };
  try {
    const transport = createGatewayConsoleTransport(INSTANCE);
    transport.subscribe(() => undefined);
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    crossSnapshotBarrier(socket);
    const bytes = Buffer.from('x');
    const digest = createHash('sha256').update(bytes).digest('hex');
    for (let index = 0; index < 65; index += 1) {
      const route = `/attachments/channel/file-${index}.txt`;
      const result = transport.resolve(route);
      const request = JSON.parse(socket.sent.at(-1)!);
      socket.message(
        JSON.stringify({
          type: 'media.result',
          requestId: request.requestId,
          ok: true,
          mediaType: 'text/plain; charset=utf-8',
          byteLength: bytes.length,
          sha256: digest,
          data: bytes.toString('base64'),
        }),
      );
      assert.equal(await result, index < 64 ? `blob:cache-${index + 1}` : null);
    }
    assert.deepEqual(revoked, ['blob:cache-65']);
    socket.onclose?.();
    assert.deepEqual(revoked, ['blob:cache-65']);
    transport.close();
    assert.equal(revoked.length, 65);
    assert(revoked.includes('blob:cache-1'));
  } finally {
    URL.createObjectURL = oldCreate;
    URL.revokeObjectURL = oldRevoke;
    restore();
  }
});

test('media digest mismatch fails closed without creating a blob', async () => {
  const restore = installBrowser();
  const oldCreate = URL.createObjectURL;
  let created = 0;
  URL.createObjectURL = (): string => {
    created += 1;
    return 'blob:must-not-exist';
  };
  try {
    const transport = createGatewayConsoleTransport(INSTANCE);
    const events: any[] = [];
    transport.subscribe((event) => events.push(event));
    const socket = FakeWebSocket.instances[0]!;
    socket.open();
    crossSnapshotBarrier(socket);
    const result = transport.resolve('/attachments/channel/tampered.txt');
    const request = JSON.parse(socket.sent.at(-1)!);
    const bytes = Buffer.from('tampered');
    socket.message(
      JSON.stringify({
        type: 'media.result',
        requestId: request.requestId,
        ok: true,
        mediaType: 'text/plain; charset=utf-8',
        byteLength: bytes.length,
        sha256: '0'.repeat(64),
        data: bytes.toString('base64'),
      }),
    );
    assert.equal(await result, null);
    assert.equal(created, 0);
    assert.deepEqual(socket.closes.at(-1), [1008, 'invalid_frame']);
    assert.equal(events.at(-1)?.type, 'malformed');
    transport.close();
  } finally {
    URL.createObjectURL = oldCreate;
    restore();
  }
});
test('ready without a client-observed snapshot or after phase regression fails closed', () => {
  const restore = installBrowser();
  try {
    const missing = createGatewayConsoleTransport(INSTANCE);
    missing.subscribe(() => undefined);
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.message(selection('selected', 1, 'opening'));
    first.message(selection('snapshot', 1, 'snapshotting'));
    first.message(selection('ready', 1, 'ready'));
    assert.deepEqual(first.closes.at(-1), [1008, 'invalid_frame']);
    missing.close();

    const regressed = createGatewayConsoleTransport(INSTANCE);
    regressed.subscribe(() => undefined);
    const second = FakeWebSocket.instances[1]!;
    second.open();
    crossSnapshotBarrier(second);
    second.message(selection('snapshot', 1, 'snapshotting'));
    assert.deepEqual(second.closes.at(-1), [1008, 'invalid_frame']);
    regressed.close();
  } finally {
    restore();
  }
});
