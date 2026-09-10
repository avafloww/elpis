import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  APP_SERVER_MAX_LINE_BYTES,
  AppServerClient,
  AppServerRpcError,
  type AppServerProcess,
  type AppServerTimers,
} from '../src/voice/app-server-client.js';
type WriteCallback = (error?: Error | null) => void;
class Input extends EventEmitter {
  writes: string[] = [];
  ends = 0;
  writeImpl: (line: string, callback: WriteCallback) => boolean = (
    _line,
    callback,
  ) => {
    callback();
    return true;
  };
  write(line: string, callback: WriteCallback): boolean {
    this.writes.push(line);
    return this.writeImpl(line, callback);
  }
  end(): void {
    this.ends += 1;
  }
}
class FakeProcess extends EventEmitter implements AppServerProcess {
  stdin = new Input();
  stdout = new EventEmitter();
  signals: string[] = [];
  killImpl: (signal: 'SIGTERM' | 'SIGKILL') => boolean = () => true;
  kill(signal: 'SIGTERM' | 'SIGKILL'): boolean {
    this.signals.push(signal);
    return this.killImpl(signal);
  }
  exit(code: number | null = 0, signal: string | null = null): void {
    this.emit('exit', code, signal);
  }
}
class ManualTimers implements AppServerTimers {
  nextId = 1;
  active = new Map<number, () => void>();
  setTimeout(callback: () => void): unknown {
    const id = this.nextId++;
    this.active.set(id, callback);
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.active.delete(handle as number);
  }
  runNext(): void {
    const item = this.active.entries().next().value as
      [number, () => void] | undefined;
    assert.ok(item, 'expected an active timer');
    this.active.delete(item[0]);
    item[1]();
  }
}
const options = (timers: AppServerTimers) => ({
  timers,
  sigtermAfterMs: 1,
  sigkillAfterMs: 2,
  reapAfterMs: 3,
});
const send = (process: FakeProcess, value: unknown): void => {
  process.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
};
const settle = async (): Promise<void> => void (await Promise.resolve());
// Drive a normal close through TERM, KILL and the observed-exit requirement.
async function closeByExit(
  client: AppServerClient,
  process: FakeProcess,
  timers: ManualTimers,
) {
  const closing = client.close();
  timers.runNext();
  timers.runNext();
  process.exit(null, 'SIGKILL');
  await closing;
}
test('writes exact JSON-RPC methods, monotonic IDs, results, errors and notifications', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const notices: unknown[] = [];
  const client = new AppServerClient(process, {
    ...options(timers),
    onNotification: (method, params) => notices.push([method, params]),
  });
  const first = client.request('method\n"quoted', { a: 1 });
  const second = client.request('two', []);
  assert.deepEqual(
    process.stdin.writes.map((line) => JSON.parse(line)),
    [
      { jsonrpc: '2.0', method: 'method\n"quoted', id: 1, params: { a: 1 } },
      { jsonrpc: '2.0', method: 'two', id: 2, params: [] },
    ],
  );
  send(process, { jsonrpc: '2.0', id: 2, result: { ok: true } });
  send(process, {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -1, message: 'no', data: [1] },
  });
  await assert.rejects(
    first,
    (error: unknown) => error instanceof AppServerRpcError && error.code === -1,
  );
  assert.deepEqual(await second, { ok: true });
  send(process, { jsonrpc: '2.0', method: 'event', params: { x: 2 } });
  assert.deepEqual(notices, [['event', { x: 2 }]]);
  await closeByExit(client, process, timers);
});
test('stages a synchronous response until write success and cannot resurrect it', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  process.stdin.writeImpl = (_line, callback) => {
    send(process, { jsonrpc: '2.0', id: 1, result: 'premature' });
    callback(new Error('write lost'));
    return true;
  };
  const client = new AppServerClient(process, options(timers));
  await assert.rejects(client.request('work', {}), /write lost/);
  assert.equal(process.stdin.ends, 1);
  timers.runNext();
  timers.runNext();
  process.exit(null, 'SIGKILL');
  await assert.rejects(client.close(), /write lost/);
});

test('preserves wire order across synchronous notification reentry', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  let nested: Promise<unknown> | undefined;
  let client: AppServerClient;
  process.stdin.writeImpl = (line, callback) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id === 2) {
      process.stdout.emit('data', '{"jsonrpc":"2.0","id":2,');
    }
    callback();
    return true;
  };
  client = new AppServerClient(process, {
    ...options(timers),
    onNotification: () => {
      nested = client.request('nested');
    },
  });
  const first = client.request('first');
  process.stdout.emit(
    'data',
    '{"jsonrpc":"2.0","method":"note"}\n' +
      '{"jsonrpc":"2.0","id":1,"result":"one"}\n',
  );
  process.stdout.emit('data', '"result":"two"}\n');
  assert.equal(await first, 'one');
  assert.equal(await nested, 'two');
  await closeByExit(client, process, timers);
});
test('serializes writes across backpressure and callback completion', async () => {
  const process = new FakeProcess();
  const callbacks: WriteCallback[] = [];
  process.stdin.writeImpl = (_line, callback) => {
    callbacks.push(callback);
    return callbacks.length !== 1;
  };
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  const one = client.notify('one');
  const two = client.notify('two');
  assert.equal(process.stdin.writes.length, 1);
  callbacks[0]!();
  await settle();
  assert.equal(process.stdin.writes.length, 1);
  process.stdin.emit('drain');
  assert.equal(process.stdin.writes.length, 2);
  callbacks[1]!();
  await Promise.all([one, two]);
  await closeByExit(client, process, timers);
  assert.equal(process.stdin.listenerCount('drain'), 0);
});

test('drains a large synchronous write queue without stack recursion', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  let firstCallback: WriteCallback | undefined;
  let first = true;
  process.stdin.writeImpl = (_line, callback) => {
    if (first) {
      first = false;
      firstCallback = callback;
      return false;
    }
    callback();
    return true;
  };
  const client = new AppServerClient(process, options(timers));
  const writes = Array.from({ length: 20_000 }, (_, index) =>
    client.notify('queued', { index }),
  );
  firstCallback!();
  process.stdin.emit('drain');
  await Promise.all(writes);
  assert.equal(process.stdin.writes.length, 20_000);
  await closeByExit(client, process, timers);
});

test('stale snapshotted drain listeners are inert after reentrant failure', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  process.stdin.on('drain', () => {
    process.stdin.emit('error', new Error('reentrant transport failure'));
  });
  process.stdin.writeImpl = (_line, callback) => {
    callback();
    return false;
  };
  const pending = client.notify('blocked');
  assert.doesNotThrow(() => process.stdin.emit('drain'));
  await assert.rejects(pending, /reentrant transport failure/);
  timers.runNext();
  timers.runNext();
  process.exit(null, 'SIGKILL');
  await assert.rejects(client.close(), /reentrant transport failure/);
});
test('rejects active work on unknown or duplicate response IDs', async () => {
  for (const id of [99, 1]) {
    const process = new FakeProcess();
    const timers = new ManualTimers();
    const client = new AppServerClient(process, options(timers));
    const request = client.request('wait');
    send(process, { jsonrpc: '2.0', id, result: 1 });
    if (id === 1) send(process, { jsonrpc: '2.0', id, result: 2 });
    if (id === 99) await assert.rejects(request, /unknown or duplicate/);
    else assert.equal(await request, 1);
    assert.equal(process.stdin.ends, 1);
    timers.runNext();
    timers.runNext();
    process.exit();
    await assert.rejects(client.close(), /unknown or duplicate/);
  }
});
test('malformed or inexact protocol is terminal and automatically cleans up', async () => {
  for (const line of [
    '{bad}\n',
    JSON.stringify({ jsonrpc: '2.0', method: '', params: {} }) + '\n',
    JSON.stringify({ jsonrpc: '2.0', method: 'n', id: 1 }) + '\n',
  ]) {
    const process = new FakeProcess();
    const timers = new ManualTimers();
    const client = new AppServerClient(process, options(timers));
    process.stdout.emit('data', line);
    assert.equal(process.stdin.ends, 1);
    timers.runNext();
    timers.runNext();
    process.exit();
    await assert.rejects(client.close());
  }
});
test('bounds fragmented inbound lines before parsing', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  process.stdout.emit('data', Buffer.alloc(APP_SERVER_MAX_LINE_BYTES, 32));
  assert.equal(process.stdin.ends, 0);
  process.stdout.emit('data', Buffer.from('x'));
  assert.equal(process.stdin.ends, 1);
  timers.runNext();
  timers.runNext();
  process.exit();
  await assert.rejects(client.close(), /exceeds 1 MiB/);
});
test('enforces the exact outbound line boundary before writing', async () => {
  const base = Buffer.byteLength(
    JSON.stringify({ jsonrpc: '2.0', method: 'm', params: { x: '' } }) + '\n',
  );
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  await client.notify('m', { x: 'a'.repeat(APP_SERVER_MAX_LINE_BYTES - base) });
  assert.equal(
    Buffer.byteLength(process.stdin.writes[0]!),
    APP_SERVER_MAX_LINE_BYTES,
  );
  await assert.rejects(
    client.notify('m', { x: 'a'.repeat(APP_SERVER_MAX_LINE_BYTES - base + 1) }),
    /exceeds 1 MiB/,
  );
  assert.equal(process.stdin.writes.length, 1);
  await closeByExit(client, process, timers);
});
test('copies only recursively inert own JSON data without invoking getters', async () => {
  const process = new FakeProcess();
  const client = new AppServerClient(process, options(new ManualTimers()));
  let invoked = false;
  const getter = {
    nested: Object.defineProperty({}, 'x', {
      enumerable: true,
      get: () => ((invoked = true), 1),
    }),
  };
  const inherited = {
    nested: Object.assign(Object.create({ inherited: 1 }), { own: 2 }),
  };
  const toJSON = { nested: { toJSON: () => ({ escaped: true }) } };
  const sparse = { nested: Array(1) };
  const proxied = { nested: new Proxy({}, {}) };
  for (const value of [getter, inherited, toJSON, sparse, proxied]) {
    await assert.rejects(client.notify('bad', value));
  }
  assert.equal(invoked, false);
  assert.equal(process.stdin.writes.length, 0);
  const safe = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(safe, '__proto__', {
    enumerable: true,
    value: { inert: true },
  });
  await client.notify('safe', safe);
  const parsed = JSON.parse(process.stdin.writes[0]!).params;
  assert.equal(Object.hasOwn(parsed, '__proto__'), true);
  assert.deepEqual(parsed.__proto__, { inert: true });
});
test('process exit and owned process/stdout errors reject work without uncaught events', async () => {
  const exited = new FakeProcess();
  const pending = new AppServerClient(exited).request('pending');
  exited.exit(7, null);
  await assert.rejects(pending, /exited/);
  assert.equal(exited.listenerCount('error'), 0);
  assert.equal(exited.stdout.listenerCount('error'), 0);
  for (const source of ['process', 'stdout'] as const) {
    const process = new FakeProcess();
    const timers = new ManualTimers();
    new AppServerClient(process, options(timers));
    (source === 'process' ? process : process.stdout).emit(
      'error',
      new Error(source),
    );
    assert.equal(process.stdin.ends, 1);
  }
});
test('close observes synchronous SIGKILL exit and is the same promise', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  process.killImpl = (signal) => {
    if (signal === 'SIGKILL') process.exit(null, signal);
    return true;
  };
  const closing = client.close();
  assert.strictEqual(client.close(), closing);
  timers.runNext();
  timers.runNext();
  await closing;
  assert.equal(timers.active.size, 0);
  assert.equal(process.listenerCount('exit'), 0);
});
test('close waits for delayed exit after SIGKILL and clears stale callbacks', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  const closing = client.close();
  timers.runNext();
  timers.runNext();
  assert.equal(timers.active.size, 1);
  process.exit(null, 'SIGKILL');
  await closing;
  assert.equal(timers.active.size, 0);
  assert.equal(process.stdout.listenerCount('data'), 0);
  assert.throws(() => timers.runNext(), /expected an active timer/);
});
test('close rejects when no exit is observed after SIGKILL', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  const closing = client.close();
  timers.runNext();
  timers.runNext();
  timers.runNext();
  await assert.rejects(closing, /did not exit after SIGKILL/);
  assert.equal(process.listenerCount('exit'), 0);
});
test('kill false and kill throw are owned and end in bounded rejection', async () => {
  for (const behavior of ['false', 'throw']) {
    const process = new FakeProcess();
    const timers = new ManualTimers();
    process.killImpl = () => {
      if (behavior === 'throw') throw new Error('kill broke');
      return false;
    };
    const closing = new AppServerClient(process, options(timers)).close();
    timers.runNext();
    timers.runNext();
    await assert.rejects(closing, /did not exit after SIGKILL/);
  }
});
test('validates deadlines and owns a throwing timer API', async () => {
  const process = new FakeProcess();
  assert.throws(
    () => new AppServerClient(process, { sigtermAfterMs: -1 }),
    /deadline/,
  );
  const throwing: AppServerTimers = {
    setTimeout: () => {
      throw new Error('timer broke');
    },
    clearTimeout: () => undefined,
  };
  await assert.rejects(
    new AppServerClient(new FakeProcess(), options(throwing)).close(),
    /did not exit/,
  );
});

test('synchronous stdin-end exit leaves no stale cleanup timer', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  process.stdin.end = () => {
    process.stdin.ends += 1;
    process.exit(0, null);
  };
  const client = new AppServerClient(process, options(timers));
  await client.close();
  assert.equal(timers.active.size, 0);
  assert.equal(process.listenerCount('exit'), 0);
});

test('synchronously firing timers cannot overwrite newer cleanup state', async () => {
  const process = new FakeProcess();
  const returned: object[] = [];
  const cleared: object[] = [];
  const timers: AppServerTimers = {
    setTimeout(callback) {
      const handle = {};
      callback();
      returned.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      cleared.push(handle as object);
    },
  };
  process.killImpl = (signal) => {
    if (signal === 'SIGKILL') process.exit(null, signal);
    return true;
  };
  await new AppServerClient(process, options(timers)).close();
  assert.equal(returned.length, 2);
  assert.deepEqual(cleared, returned);
});

test('rejects malformed UTF-8 instead of accepting replacement characters', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const notices: unknown[] = [];
  const client = new AppServerClient(process, {
    ...options(timers),
    onNotification: (method, params) => notices.push([method, params]),
  });
  process.stdout.emit(
    'data',
    Buffer.concat([
      Buffer.from('{"jsonrpc":"2.0","method":"event","params":{"x":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}\n'),
    ]),
  );
  assert.deepEqual(notices, []);
  assert.equal(process.stdin.ends, 1);
  timers.runNext();
  timers.runNext();
  process.exit(null, 'SIGKILL');
  await assert.rejects(client.close(), /encoded|UTF|valid/i);
});

test('reports an unreaped child before the initiating protocol failure', async () => {
  const process = new FakeProcess();
  const timers = new ManualTimers();
  const client = new AppServerClient(process, options(timers));
  process.stdout.emit('data', '{bad}\n');
  timers.runNext();
  timers.runNext();
  timers.runNext();
  await assert.rejects(client.close(), /did not exit after SIGKILL/);
});
