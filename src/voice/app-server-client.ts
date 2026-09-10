import { types as utilTypes } from 'node:util';
export const APP_SERVER_MAX_LINE_BYTES = 1024 * 1024;
type InputEvents = { drain: () => void; error: (error: Error) => void };
type OutputEvents = {
  data: (chunk: string | Uint8Array) => void;
  error: (error: Error) => void;
};
type ProcessEvents = {
  error: (error: Error) => void;
  exit: (code: number | null, signal: string | null) => void;
};
interface Events<E> {
  on<K extends keyof E>(event: K, listener: E[K]): unknown;
  removeListener<K extends keyof E>(event: K, listener: E[K]): unknown;
}
// prettier-ignore
export interface AppServerProcess extends Events<ProcessEvents> {
  stdin: Events<InputEvents> & { write(data: string, callback: (error?: Error | null) => void): boolean; end(): void };
  stdout: Events<OutputEvents>; kill(signal: 'SIGTERM' | 'SIGKILL'): boolean;
}
export interface AppServerTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
// prettier-ignore
export interface AppServerClientOptions {
  onNotification?: (method: string, params: unknown) => void; timers?: AppServerTimers;
  sigtermAfterMs?: number; sigkillAfterMs?: number; reapAfterMs?: number;
}
// prettier-ignore
export class AppServerRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'AppServerRpcError';
  }
}
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Reply = { result: Json } | { error: AppServerRpcError };
// prettier-ignore
type Pending = { resolve(value: unknown): void; reject(error: Error): void; written: boolean; reply?: Reply };
type Job = { line: string; written(): void; failed(error: Error): void };
const nativeTimers: AppServerTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
const own = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const asError = (value: unknown, label: string): Error =>
  value instanceof Error ? value : new Error(`${label}: ${String(value)}`);
// prettier-ignore
function must(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }
function jsonCopy(value: unknown, seen = new Set<object>()): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('nonfinite JSON number');
    return value;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new TypeError('value is not inert JSON data');
  }
  if (seen.has(value)) throw new TypeError('cyclic JSON data');
  seen.add(value);
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    // prettier-ignore
    must(prototype === (array ? Array.prototype : Object.prototype) || (!array && prototype === null), 'nonstandard JSON prototype');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (array) {
      // prettier-ignore
      must(Reflect.ownKeys(value).length === value.length + 1, 'extra array property');
      const result: Json[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        // prettier-ignore
        must(descriptor?.enumerable && 'value' in descriptor, 'invalid array slot');
        result.push(jsonCopy(descriptor.value, seen));
      }
      return result;
    }
    const result = Object.create(null) as { [key: string]: Json };
    for (const key of Reflect.ownKeys(descriptors)) {
      must(typeof key === 'string', 'symbol in JSON data');
      const descriptor = descriptors[key]!;
      // prettier-ignore
      must(descriptor.enumerable && 'value' in descriptor, 'non-data JSON property');
      result[key] = jsonCopy(descriptor.value, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}
// prettier-ignore
function jsonInput(value: unknown): Json { jsonCopy(value); return value as Json }
// prettier-ignore
function exact(value: object, keys: string[]): boolean { const actual = Reflect.ownKeys(value); return actual.length === keys.length && keys.every((key) => own(value, key)) }
export class AppServerClient {
  readonly #pending = new Map<number, Pending>();
  readonly #queue: Job[] = [];
  readonly #process: AppServerProcess;
  readonly #timers: AppServerTimers;
  readonly #notification?: (method: string, params: unknown) => void;
  readonly #deadlines: readonly number[];
  #nextId = 1;
  #input = Buffer.alloc(0);
  readonly #lines: Buffer[] = [];
  #dispatching = false;
  #pumping = false;
  #writing?: Job;
  #drain?: () => void;
  #accepting = true;
  #exited = false;
  #cleanupStarted = false;
  #cleanupDone = false;
  #terminalError?: Error;
  #cleanupError?: Error;
  #timer?: unknown;
  #timerVersion = 0;
  readonly #cleaned: Promise<void>;
  #resolveCleaned!: () => void;
  #closePromise?: Promise<void>;
  readonly #onData = (chunk: unknown): void => this.#consume(chunk);
  readonly #onError = (value: unknown): void =>
    this.#fail(asError(value, 'transport error'));
  readonly #onExit = (code: unknown, signal: unknown): void => {
    if (this.#exited) return;
    this.#exited = true;
    if (!this.#cleanupStarted) {
      // prettier-ignore
      this.#fail(new Error(`app-server exited (code ${String(code)}, signal ${String(signal)})`));
    }
    this.#finishCleanup();
  };
  constructor(process: AppServerProcess, options: AppServerClientOptions = {}) {
    this.#process = process;
    this.#timers = options.timers ?? nativeTimers;
    this.#notification = options.onNotification;
    this.#cleaned = new Promise((resolve) => (this.#resolveCleaned = resolve));
    // prettier-ignore
    this.#deadlines = [options.sigtermAfterMs ?? 1000, options.sigkillAfterMs ?? 1000, options.reapAfterMs ?? 1000];
    // prettier-ignore
    must(!this.#deadlines.some((n) => !Number.isSafeInteger(n) || n < 0), 'invalid close deadline');
    process.stdout.on('data', this.#onData);
    process.stdout.on('error', this.#onError);
    process.stdin.on('error', this.#onError);
    process.on('error', this.#onError);
    process.on('exit', this.#onExit);
  }
  request(method: string, params?: unknown): Promise<unknown> {
    let line: string;
    const id = this.#nextId;
    try {
      this.#assertMethod(method);
      if (!Number.isSafeInteger(id))
        throw new Error('request ID space exhausted');
      line = this.#encode(method, params, id);
    } catch (error) {
      return Promise.reject(asError(error, 'invalid request'));
    }
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const pending: Pending = { resolve, reject, written: false };
      this.#pending.set(id, pending);
      // Do not settle a staged response until this request's write succeeds.
      this.#enqueue({
        line,
        written: () => {
          pending.written = true;
          this.#settle(id, pending);
        },
        failed: reject,
      });
    });
  }
  notify(method: string, params?: unknown): Promise<void> {
    let line: string;
    try {
      this.#assertMethod(method);
      line = this.#encode(method, params);
    } catch (error) {
      return Promise.reject(asError(error, 'invalid notification'));
    }
    return new Promise((resolve, reject) =>
      this.#enqueue({ line, written: resolve, failed: reject }),
    );
  }
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (!this.#cleanupStarted) {
      this.#stop(new Error('app-server client closed'));
      this.#startCleanup();
    }
    this.#closePromise = this.#cleaned.then(() => {
      const error = this.#cleanupError ?? this.#terminalError;
      if (error) throw error;
    });
    return this.#closePromise;
  }
  #assertMethod(method: string): void {
    if (!this.#accepting)
      throw this.#terminalError ?? new Error('client closed');
    // prettier-ignore
    must(typeof method === 'string' && method.length > 0, 'invalid JSON-RPC method');
  }
  #encode(method: string, params: unknown, id?: number): string {
    const message: Record<string, Json | number | string> = {
      jsonrpc: '2.0',
      method,
    };
    if (id !== undefined) message.id = id;
    if (params !== undefined) {
      // prettier-ignore
      must(params !== null && typeof params === 'object', 'invalid JSON-RPC params');
      message.params = jsonCopy(params);
    }
    const line = JSON.stringify(message) + '\n';
    // prettier-ignore
    must(Buffer.byteLength(line) <= APP_SERVER_MAX_LINE_BYTES, 'outbound JSONL line exceeds 1 MiB');
    return line;
  }
  #enqueue(job: Job): void {
    if (!this.#accepting) {
      job.failed(this.#terminalError ?? new Error('client is closed'));
      return;
    }
    this.#queue.push(job);
    this.#pump();
  }
  #pump(): void {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#accepting && !this.#writing && this.#queue.length > 0) {
        this.#write(this.#queue.shift()!);
      }
    } finally {
      this.#pumping = false;
    }
  }
  #write(job: Job): void {
    this.#writing = job;
    let callbackDone = false;
    let callbackError: Error | undefined;
    let returned = false;
    let drained = false;
    const complete = (): void => {
      if (!returned || !callbackDone || this.#writing !== job) return;
      if (callbackError) {
        this.#fail(callbackError);
      } else if (drained) {
        this.#writing = undefined;
        job.written();
        this.#pump();
      }
    };
    try {
      const accepted = this.#process.stdin.write(job.line, (error) => {
        callbackDone = true;
        callbackError = error
          ? asError(error, 'app-server write failed')
          : undefined;
        complete();
      });
      returned = true;
      drained = accepted;
      if (!accepted && this.#writing === job) {
        const drain = () => {
          this.#process.stdin.removeListener('drain', drain);
          if (this.#drain !== drain) return;
          this.#drain = undefined;
          if (!this.#accepting || this.#writing !== job) return;
          drained = true;
          complete();
        };
        this.#drain = drain;
        this.#process.stdin.on('drain', drain);
      }
      complete();
    } catch (error) {
      this.#fail(asError(error, 'app-server write threw'));
    }
  }
  #consume(chunk: unknown): void {
    if (!this.#accepting) return;
    if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) {
      this.#fail(new TypeError('stdout data is not bytes'));
      return;
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (this.#accepting) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const length = this.#input.length + end - start;
      if (length > APP_SERVER_MAX_LINE_BYTES) {
        this.#fail(new RangeError('inbound JSONL line exceeds 1 MiB'));
        return;
      }
      if (end > start) {
        this.#input = Buffer.concat(
          [this.#input, bytes.subarray(start, end)],
          length,
        );
      }
      if (newline < 0) break;
      this.#lines.push(this.#input);
      this.#input = Buffer.alloc(0);
      start = newline + 1;
    }
    if (!this.#accepting || this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#accepting && this.#lines.length > 0) {
        this.#parse(this.#lines.shift()!);
      }
    } finally {
      this.#dispatching = false;
      if (!this.#accepting) this.#lines.length = 0;
    }
  }
  #parse(line: Buffer): void {
    try {
      const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(line),
      );
      // prettier-ignore
      must(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid JSON-RPC message');
      const message = value as Record<string, unknown>;
      // prettier-ignore
      must(own(message, 'jsonrpc') && message.jsonrpc === '2.0', 'invalid JSON-RPC version');
      if (own(message, 'method')) this.#notificationMessage(message);
      else this.#response(message);
    } catch (error) {
      this.#fail(asError(error, 'malformed app-server JSONL'));
    }
  }
  #notificationMessage(message: Record<string, unknown>): void {
    // prettier-ignore
    const keys = own(message, 'params') ? ['jsonrpc', 'method', 'params'] : ['jsonrpc', 'method'];
    // prettier-ignore
    must(exact(message, keys) && typeof message.method === 'string' && message.method, 'invalid notification');
    let params: Json | undefined;
    if (own(message, 'params')) {
      // prettier-ignore
      must(message.params !== null && typeof message.params === 'object', 'invalid notification params');
      params = jsonInput(message.params);
    }
    this.#notification?.(message.method, params);
  }
  #response(message: Record<string, unknown>): void {
    // prettier-ignore
    must(own(message, 'id') && Number.isSafeInteger(message.id), 'invalid response ID');
    const id = message.id as number;
    const pending = this.#pending.get(id);
    if (!pending || pending.reply)
      throw new Error(`unknown or duplicate response ID ${id}`);
    if (own(message, 'result')) {
      // prettier-ignore
      must(exact(message, ['jsonrpc', 'id', 'result']), 'invalid result response');
      pending.reply = { result: jsonInput(message.result) };
    } else {
      // prettier-ignore
      must(exact(message, ['jsonrpc', 'id', 'error']), 'invalid error response');
      const value = message.error;
      // prettier-ignore
      must(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid error object');
      const rpc = value as Record<string, unknown>;
      // prettier-ignore
      const keys = own(rpc, 'data') ? ['code', 'message', 'data'] : ['code', 'message'];
      if (
        !exact(rpc, keys) ||
        !Number.isSafeInteger(rpc.code) ||
        typeof rpc.message !== 'string'
      ) {
        throw new Error('invalid JSON-RPC error object');
      }
      const data = own(rpc, 'data') ? jsonInput(rpc.data) : undefined;
      pending.reply = {
        error: new AppServerRpcError(rpc.code as number, rpc.message, data),
      };
    }
    this.#settle(id, pending);
  }
  #settle(id: number, pending: Pending): void {
    if (!pending.written || !pending.reply || !this.#pending.has(id)) return;
    this.#pending.delete(id);
    if ('result' in pending.reply) pending.resolve(pending.reply.result);
    else pending.reject(pending.reply.error);
  }
  #fail(error: Error): void {
    this.#terminalError ??= error;
    this.#stop(this.#terminalError);
    this.#startCleanup();
  }
  #stop(error: Error): void {
    this.#accepting = false;
    this.#input = Buffer.alloc(0);
    this.#lines.length = 0;
    if (this.#drain) {
      this.#process.stdin.removeListener('drain', this.#drain);
      this.#drain = undefined;
    }
    const jobs = [...(this.#writing ? [this.#writing] : []), ...this.#queue];
    this.#writing = undefined;
    this.#queue.length = 0;
    for (const job of jobs) job.failed(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
  #startCleanup(): void {
    if (this.#cleanupStarted) return;
    this.#cleanupStarted = true;
    if (this.#exited) return this.#finishCleanup();
    try {
      this.#process.stdin.end();
    } catch (error) {
      this.#cleanupError ??= asError(error, 'app-server stdin end failed');
    }
    if (this.#cleanupDone || this.#exited) return;
    this.#schedule(() => this.#signal('SIGTERM'), this.#deadlines[0]!);
  }
  #signal(signal: 'SIGTERM' | 'SIGKILL'): void {
    if (this.#cleanupDone || this.#exited) return;
    let delivered = false;
    try {
      delivered = this.#process.kill(signal);
      if (!delivered)
        this.#cleanupError ??= new Error(`${signal} not delivered`);
    } catch (error) {
      this.#cleanupError ??= asError(error, `app-server ${signal} failed`);
    }
    if (this.#exited || this.#cleanupDone) return;
    if (signal === 'SIGTERM' && delivered) {
      this.#schedule(() => this.#signal('SIGKILL'), this.#deadlines[1]!);
    } else if (signal === 'SIGTERM') {
      this.#signal('SIGKILL');
    } else {
      this.#schedule(() => {
        this.#cleanupError = new Error('app-server did not exit after SIGKILL');
        this.#finishCleanup();
      }, this.#deadlines[2]!);
    }
  }
  #schedule(callback: () => void, delay: number): void {
    const version = ++this.#timerVersion;
    let fired = false;
    try {
      const handle = this.#timers.setTimeout(() => {
        fired = true;
        if (this.#cleanupDone || version !== this.#timerVersion) return;
        this.#timer = undefined;
        callback();
      }, delay);
      if (fired || this.#cleanupDone || version !== this.#timerVersion) {
        try {
          this.#timers.clearTimeout(handle);
        } catch (error) {
          this.#cleanupError ??= asError(
            error,
            'app-server timer clear failed',
          );
        }
      } else {
        this.#timer = handle;
      }
    } catch (error) {
      this.#cleanupError ??= asError(error, 'app-server timer failed');
      if (!fired && !this.#cleanupDone && version === this.#timerVersion) {
        callback();
      }
    }
  }
  #finishCleanup(): void {
    if (this.#cleanupDone) return;
    this.#cleanupDone = true;
    this.#timerVersion += 1;
    if (this.#timer !== undefined) {
      try {
        this.#timers.clearTimeout(this.#timer);
      } catch (error) {
        this.#cleanupError ??= asError(error, 'app-server timer clear failed');
      }
      this.#timer = undefined;
    }
    this.#detach();
    this.#resolveCleaned();
  }
  #detach(): void {
    this.#process.stdout.removeListener('data', this.#onData);
    this.#process.stdout.removeListener('error', this.#onError);
    this.#process.stdin.removeListener('error', this.#onError);
    this.#process.removeListener('error', this.#onError);
    this.#process.removeListener('exit', this.#onExit);
  }
}
