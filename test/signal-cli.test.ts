import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  SignalCliClient,
  SignalCliError,
  type SignalCliDiagnostic,
  type SignalCliProcess,
  type SignalCliSpawn,
  type SignalCliTimers,
} from '../src/signal/signal-cli.js';

const LOCAL_ACI = '00000000-0000-4000-8000-000000000001';

class FakeReadable extends EventEmitter {
  data(value: Buffer | string): void {
    this.emit('data', value);
  }
}

class FakeProcess extends EventEmitter implements SignalCliProcess {
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly writes: string[] = [];
  readonly actions: string[] = [];
  writeError: Error | undefined;
  throwOnWrite = false;
  stdin = {
    on: (_event: 'error', _callback: (error: Error) => void): void => {},
    write: (
      data: string,
      callback: (error?: Error | null) => void,
    ): boolean => {
      if (this.throwOnWrite) throw new Error('private synchronous failure');
      this.writes.push(data);
      this.actions.push('write');
      callback(this.writeError);
      return true;
    },
    end: (): void => {
      this.actions.push('end');
    },
  };
  kill(signal: NodeJS.Signals): boolean {
    this.actions.push(signal);
    return true;
  }
  output(value: unknown): void {
    this.stdout.data(JSON.stringify(value) + '\n');
  }
}

class FakeTimers implements SignalCliTimers {
  private nextId = 1;
  readonly scheduled: Array<{
    id: number;
    callback: () => void;
    delayMs: number;
  }> = [];
  readonly cleared = new Set<number>();
  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.scheduled.push({ id, callback, delayMs });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.cleared.add(handle as number);
  }
  fire(id: number): void {
    const timer = this.scheduled.find((entry) => entry.id === id);
    assert.ok(timer, 'timer exists');
    if (!this.cleared.has(id)) timer.callback();
  }
}

function harness(
  overrides: Partial<ConstructorParameters<typeof SignalCliClient>[0]> = {},
) {
  const child = new FakeProcess();
  const timers = new FakeTimers();
  const spawnCalls: Array<{
    command: string;
    args: readonly string[];
    options: unknown;
  }> = [];
  const spawn: SignalCliSpawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    return child;
  };
  const diagnostics: SignalCliDiagnostic[] = [];
  const client = new SignalCliClient({
    dataDir: '/tmp/synthetic-signal-data',
    account: LOCAL_ACI,
    spawn,
    timers,
    diagnostic: (event) => diagnostics.push(event),
    ...overrides,
  });
  return { child, timers, spawnCalls, diagnostics, client };
}

function parsedWrites(child: FakeProcess): Array<Record<string, unknown>> {
  return child.writes.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

async function capturedError(
  promise: Promise<unknown>,
): Promise<SignalCliError> {
  try {
    await promise;
    assert.fail('expected rejection');
  } catch (error) {
    assert.ok(error instanceof SignalCliError);
    return error;
  }
}

test('spawns documented stdio mode and correlates monotonic requests', async () => {
  const { client, child, spawnCalls, timers } = harness();
  assert.deepEqual(spawnCalls, [
    {
      command: 'signal-cli',
      args: [
        '--data-dir',
        '/tmp/synthetic-signal-data',
        '-a',
        '00000000-0000-4000-8000-000000000001',
        'jsonRpc',
      ],
      options: { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
    },
  ]);

  const first = client.request('version', {});
  const second = client.sendText(
    '00000000-0000-4000-8000-000000000002',
    'hello',
    [{ style: 'BOLD', start: 0, length: 5 }],
    ['/tmp/synthetic.pdf'],
  );
  assert.deepEqual(parsedWrites(child), [
    { jsonrpc: '2.0', method: 'version', params: {}, id: 1 },
    {
      jsonrpc: '2.0',
      method: 'send',
      params: {
        recipient: ['00000000-0000-4000-8000-000000000002'],
        message: 'hello',
        textStyle: ['0:5:BOLD'],
        attachments: ['/tmp/synthetic.pdf'],
      },
      id: 2,
    },
  ]);

  child.output({ jsonrpc: '2.0', id: 2, result: { timestamp: 42 } });
  child.output({ jsonrpc: '2.0', id: 1, result: 'signal-cli 1.0' });
  assert.deepEqual(await second, { status: 'accepted' });
  assert.equal(await first, 'signal-cli 1.0');
  assert.ok(timers.cleared.has(1));
  assert.ok(timers.cleared.has(2));
});

test('rejects invalid text style and attachment arguments before dispatch', async () => {
  const { client, child, timers } = harness();
  const error = await capturedError(
    client.sendText('synthetic-recipient', 'hi', [
      { style: 'BOLD', start: 1, length: 2 },
    ]),
  );
  assert.equal(error.code, 'invalid_request');
  assert.equal(error.issuanceUncertain, false);
  assert.equal(child.writes.length, 0);
  assert.equal(timers.scheduled.length, 0);

  const sparse = new Array(1) as Parameters<typeof client.sendText>[2];
  const sparseError = await capturedError(
    client.sendText('synthetic-recipient', 'hi', sparse),
  );
  assert.equal(sparseError.code, 'invalid_request');
  assert.equal(sparseError.issuanceUncertain, false);

  const nullError = await capturedError(
    client.sendText('synthetic-recipient', 'hi', [null] as never),
  );
  assert.equal(nullError.code, 'invalid_request');
  assert.equal(nullError.issuanceUncertain, false);

  const emptyAttachment = await capturedError(
    client.sendText('synthetic-recipient', 'hi', [], ['']),
  );
  assert.equal(emptyAttachment.code, 'invalid_request');
  assert.equal(emptyAttachment.issuanceUncertain, false);

  const sparseAttachments = new Array(1) as string[];
  const sparseAttachment = await capturedError(
    client.sendText('synthetic-recipient', 'hi', [], sparseAttachments),
  );
  assert.equal(sparseAttachment.code, 'invalid_request');
  assert.equal(sparseAttachment.issuanceUncertain, false);
  assert.equal(child.writes.length, 0);
  assert.equal(timers.scheduled.length, 0);
});

test('parses fragmented receive notifications and recovers after bounded frames', () => {
  const { client, child, diagnostics } = harness({ maxFrameBytes: 256 });
  const received: unknown[] = [];
  client.onReceive((notification) => received.push(notification));
  const frame = JSON.stringify({
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      account: LOCAL_ACI,
      envelope: {
        sourceUuid: 'synthetic-sender',
        dataMessage: { message: 'hi' },
      },
    },
  });
  child.stdout.data(frame.slice(0, 17));
  child.stdout.data(frame.slice(17) + '\n');
  assert.deepEqual(received, [
    {
      account: LOCAL_ACI,
      envelope: {
        sourceUuid: 'synthetic-sender',
        dataMessage: { message: 'hi' },
      },
    },
  ]);

  child.stdout.data('x'.repeat(300) + '\n');
  child.stdout.data('{not json}\n');
  child.output({ jsonrpc: '2.0', method: 'other', params: {} });
  child.output({ jsonrpc: '1.0', method: 'receive', params: { envelope: {} } });
  child.output({
    jsonrpc: '2.0',
    method: 'receive',
    params: { account: LOCAL_ACI, envelope: {} },
  });
  assert.equal(
    received.length,
    2,
    'valid frame after oversized input still arrives',
  );
  assert.deepEqual(diagnostics, [
    'oversized_frame',
    'invalid_frame',
    'invalid_frame',
    'invalid_frame',
  ]);
});

test('receive notifications preserve the child-reported account and classify daemon errors', () => {
  const { client, child, diagnostics } = harness();
  const received: unknown[] = [];
  client.onReceive((notification) => received.push(notification));

  child.output({
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      account: '+15551234567',
      envelope: { sourceUuid: 'allowed-numbered-account' },
    },
  });
  child.output({
    jsonrpc: '2.0',
    method: 'receive',
    params: {
      account: LOCAL_ACI,
      exception: { type: 'private-daemon-error' },
      envelope: { sourceUuid: 'must-not-enter' },
    },
  });
  child.output({
    jsonrpc: '2.0',
    method: 'receive',
    params: { account: 'not-a-signal-account', envelope: {} },
  });

  assert.deepEqual(received, [
    {
      account: '+15551234567',
      envelope: { sourceUuid: 'allowed-numbered-account' },
    },
  ]);
  assert.deepEqual(diagnostics, ['receive_error', 'invalid_frame']);
  assert.equal(JSON.stringify({ received, diagnostics }).includes('private'), false);
});

test('strict responses reject malformed and daemon errors without private text', async () => {
  const secretBody = 'private-message-material';
  const secretAccount = '00000000-0000-4000-8000-000000000099';
  const { client, child, diagnostics } = harness();
  const pending = client.sendText(secretAccount, secretBody);
  child.output({
    jsonrpc: '2.0',
    id: 1,
    result: {},
    error: { code: -1, message: secretBody },
  });
  child.output({
    jsonrpc: '2.0',
    id: 1,
    error: { code: 'bad', message: secretBody },
  });
  child.output({
    jsonrpc: '2.0',
    id: 1,
    error: { code: -32000, message: secretBody, data: secretAccount },
  });
  const error = await capturedError(pending);
  assert.equal(error.code, 'request_rejected');
  assert.equal(error.rpcCode, -32000);
  assert.equal(error.issuanceUncertain, false);
  const observable = JSON.stringify({
    error: { message: error.message, stack: error.stack },
    diagnostics,
  });
  assert.equal(observable.includes(secretBody), false);
  assert.equal(observable.includes(secretAccount), false);
  assert.deepEqual(diagnostics, ['invalid_frame', 'invalid_frame']);
});

test('timeout and unexpected exit are issuance-uncertain and never replay', async () => {
  const timeoutHarness = harness({ requestTimeoutMs: 77 });
  const timed = timeoutHarness.client.sendText(
    'synthetic-recipient',
    'synthetic body',
  );
  assert.equal(timeoutHarness.timers.scheduled[0]?.delayMs, 77);
  timeoutHarness.timers.fire(timeoutHarness.timers.scheduled[0]!.id);
  const timeoutError = await capturedError(timed);
  assert.equal(timeoutError.code, 'request_timeout');
  assert.equal(timeoutError.issuanceUncertain, true);
  assert.equal(timeoutHarness.child.writes.length, 1);
  assert.equal(timeoutHarness.spawnCalls.length, 1);

  const exitHarness = harness();
  const interrupted = exitHarness.client.sendText(
    'another-recipient',
    'another body',
  );
  exitHarness.child.emit('exit', 9, null);
  const exitError = await capturedError(interrupted);
  assert.equal(exitError.code, 'transport_unavailable');
  assert.equal(exitError.issuanceUncertain, true);
  assert.equal(exitHarness.client.state, 'unavailable');
  assert.equal(exitHarness.child.writes.length, 1);
  assert.equal(
    exitHarness.spawnCalls.length,
    1,
    'unexpected exit does not restart',
  );
  const later = await capturedError(exitHarness.client.request('version', {}));
  assert.equal(later.issuanceUncertain, false);
  assert.equal(exitHarness.child.writes.length, 1);
});

test('write failures distinguish pre-write certainty without exposing causes', async () => {
  const sync = harness();
  sync.child.throwOnWrite = true;
  const syncError = await capturedError(
    sync.client.sendText('private-recipient', 'private-body'),
  );
  assert.equal(syncError.code, 'write_failed');
  assert.equal(syncError.issuanceUncertain, false);
  assert.equal(syncError.message.includes('private'), false);

  const callback = harness();
  callback.child.writeError = new Error('private-recipient private-body');
  const callbackError = await capturedError(
    callback.client.sendText('private-recipient', 'private-body'),
  );
  assert.equal(callbackError.code, 'write_failed');
  assert.equal(callbackError.issuanceUncertain, true);
  assert.equal(callbackError.message.includes('private'), false);
});

test('stop closes stdin before TERM and uses bounded controlled KILL fallback', async () => {
  const { client, child, timers } = harness({ stopTimeoutMs: 123 });
  const stopping = client.stop();
  assert.equal(client.state, 'stopping');
  assert.deepEqual(child.actions, ['end', 'SIGTERM']);
  assert.equal(timers.scheduled[0]?.delayMs, 123);
  timers.fire(timers.scheduled[0]!.id);
  await stopping;
  assert.deepEqual(child.actions, ['end', 'SIGTERM', 'SIGKILL']);
  assert.equal(client.state, 'stopped');
  assert.strictEqual(client.stop(), stopping, 'stop is idempotent');
});

test('exit completes stop without fallback and stderr remains opaque', async () => {
  const privateStderr = 'account=private-id body=private-body';
  const { client, child, diagnostics, timers } = harness();
  child.stderr.data(privateStderr);
  const stopping = client.stop();
  child.emit('exit', 0, 'SIGTERM');
  await stopping;
  timers.fire(timers.scheduled[0]!.id);
  assert.deepEqual(child.actions, ['end', 'SIGTERM']);
  assert.deepEqual(diagnostics, ['stderr_received']);
  assert.equal(JSON.stringify(diagnostics).includes(privateStderr), false);
});

test('spawn errors are sanitized', () => {
  const privateAccount = 'private-account-id';
  assert.throws(
    () =>
      new SignalCliClient({
        dataDir: '/private/data/path',
        account: privateAccount,
        spawn: () => {
          throw new Error('failed for ' + privateAccount);
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof SignalCliError);
      assert.equal(error.code, 'transport_unavailable');
      assert.equal(error.message.includes(privateAccount), false);
      assert.equal(error.stack?.includes(privateAccount), false);
      return true;
    },
  );
});
