import { EventEmitter } from 'node:events';

export const OFFER_SDP = [
  'v=0',
  'o=- 101 1 IN IP4 127.0.0.1',
  's=Aster synthetic voice offer',
  't=0 0',
].join('\r\n');

export const ANSWER_SDP = [
  'v=0',
  'o=- 202 1 IN IP4 127.0.0.1',
  's=Aster synthetic voice answer',
  't=0 0',
].join('\r\n');

export type JsonObject = Record<string, unknown>;

class FakeInput extends EventEmitter {
  readonly writes: string[] = [];
  ended = false;

  write(value: string | Uint8Array): boolean {
    if (this.ended) throw new Error('write after end');
    this.writes.push(Buffer.from(value).toString('utf8'));
    return true;
  }

  end(): void {
    this.ended = true;
    this.emit('finish');
  }
}

/** A process-shaped JSONL boundary. It never starts an executable. */
export class FakeAppServerChild extends EventEmitter {
  readonly stdin = new FakeInput();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: NodeJS.Signals[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoExitOnSigkill = true;

  requests(): JsonObject[] {
    return this.stdin.writes.flatMap((write) =>
      write
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as JsonObject),
    );
  }

  receive(value: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
  }

  receiveRaw(value: string): void {
    this.stdout.emit('data', Buffer.from(value));
  }

  result(id: number, result: unknown): void {
    this.receive({ jsonrpc: '2.0', id, result });
  }

  notification(method: string, params: unknown): void {
    this.receive({ jsonrpc: '2.0', method, params });
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    if (signal === 'SIGKILL' && this.autoExitOnSigkill) this.exit(null, signal);
    return true;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

/** A process-shaped Node IPC boundary. It never opens media or a device. */
export class FakeMediaChild extends EventEmitter {
  readonly sent: JsonObject[] = [];
  readonly kills: NodeJS.Signals[] = [];
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  autoExitOnSigkill = true;

  send(value: JsonObject, callback?: (error: Error | null) => void): boolean {
    if (!this.connected) {
      callback?.(new Error('IPC is disconnected'));
      return false;
    }
    this.sent.push(structuredClone(value));
    callback?.(null);
    return true;
  }

  receive(value: unknown): void {
    this.emit('message', structuredClone(value));
  }

  disconnect(): void {
    this.connected = false;
    this.emit('disconnect');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.kills.push(signal);
    if (signal === 'SIGKILL' && this.autoExitOnSigkill) this.exit(null, signal);
    return true;
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.connected = false;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}

type TimerRecord = {
  id: number;
  at: number;
  callback: () => void;
};

/** Injectable monotonic timers for deadline tests; no wall-clock sleeps occur. */
export class ManualTimers {
  now = 0;
  #nextId = 1;
  #timers = new Map<number, TimerRecord>();

  readonly setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.#nextId++;
    this.#timers.set(id, {
      id,
      at: this.now + Math.max(0, delayMs),
      callback,
    });
    return id;
  };

  readonly clearTimeout = (id: number): void => {
    this.#timers.delete(id);
  };

  advance(delayMs: number): void {
    const target = this.now + delayMs;
    for (;;) {
      const due = [...this.#timers.values()]
        .filter((timer) => timer.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      this.#timers.delete(due.id);
      this.now = due.at;
      due.callback();
    }
    this.now = target;
  }

  get activeCount(): number {
    return this.#timers.size;
  }
}
