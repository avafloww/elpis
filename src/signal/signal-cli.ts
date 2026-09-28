import { isUtf8 } from 'node:buffer';
import { spawn as nodeSpawn } from 'node:child_process';
import type { SignalTextStyle } from './format.js';

export type SignalCliState = 'running' | 'stopping' | 'stopped' | 'unavailable';
export type SignalCliDiagnostic =
  | 'invalid_frame'
  | 'oversized_frame'
  | 'stderr_received'
  | 'unknown_response'
  | 'unexpected_exit'
  | 'process_error'
  | 'receive_handler_error';

export interface SignalCliReceiveNotification {
  envelope: Record<string, unknown>;
}
export interface SignalCliAccepted {
  status: 'accepted';
}
export type SignalCliErrorCode =
  | 'invalid_request'
  | 'request_too_large'
  | 'request_timeout'
  | 'request_rejected'
  | 'transport_unavailable'
  | 'write_failed';

/** Metadata-only: daemon error text can contain identifiers or message data. */
export class SignalCliError extends Error {
  constructor(
    public readonly code: SignalCliErrorCode,
    public readonly issuanceUncertain: boolean,
    public readonly rpcCode?: number,
  ) {
    super(errorMessage(code, issuanceUncertain));
    this.name = 'SignalCliError';
  }
}

function errorMessage(code: SignalCliErrorCode, uncertain: boolean): string {
  if (uncertain)
    return 'signal-cli request outcome is uncertain; it will not be retried';
  switch (code) {
    case 'invalid_request':
      return 'signal-cli request is invalid';
    case 'request_too_large':
      return 'signal-cli request exceeds the configured limit';
    case 'request_timeout':
      return 'signal-cli request timed out';
    case 'request_rejected':
      return 'signal-cli rejected the request';
    case 'transport_unavailable':
      return 'signal-cli transport is unavailable';
    case 'write_failed':
      return 'signal-cli request could not be written';
  }
}

export interface SignalCliWritable {
  on(event: 'error', callback: (error: Error) => void): unknown;
  write(data: string, callback: (error?: Error | null) => void): boolean;
  end(): void;
}
export interface SignalCliReadable {
  on(event: 'data', callback: (chunk: Buffer | string) => void): unknown;
  on(event: 'error', callback: (error: Error) => void): unknown;
}
export interface SignalCliProcess {
  stdin: SignalCliWritable;
  stdout: SignalCliReadable;
  stderr: SignalCliReadable;
  once(event: 'error', callback: (error: Error) => void): unknown;
  once(
    event: 'exit',
    callback: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  kill(signal: NodeJS.Signals): boolean;
}
export type SignalCliSpawn = (
  command: string,
  args: readonly string[],
  options: { shell: false; stdio: ['pipe', 'pipe', 'pipe'] },
) => SignalCliProcess;
export interface SignalCliTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}
export interface SignalCliOptions {
  dataDir: string;
  account: string;
  command?: string;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxFrameBytes?: number;
  maxRequestBytes?: number;
  spawn?: SignalCliSpawn;
  timers?: SignalCliTimers;
  diagnostic?: (event: SignalCliDiagnostic) => void;
}
interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: SignalCliError) => void;
  timer: unknown;
  issued: boolean;
}

const defaultTimers: SignalCliTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
const defaultSpawn: SignalCliSpawn = (command, args, options) =>
  nodeSpawn(command, [...args], options) as unknown as SignalCliProcess;
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new TypeError(name + ' must be a positive integer');
  return value;
}

function styleRanges(
  message: string,
  styles: readonly SignalTextStyle[],
): string[] {
  if (!Array.isArray(styles) || styles.length > 128)
    throw new SignalCliError('invalid_request', false);
  const ranges: string[] = [];
  for (let index = 0; index < styles.length; index++) {
    const entry: unknown = styles[index];
    if (entry === null || typeof entry !== 'object') {
      throw new SignalCliError('invalid_request', false);
    }
    const { style, start, length } = entry as Partial<SignalTextStyle>;
    const end = (start ?? Number.NaN) + (length ?? Number.NaN);
    if (
      !style ||
      !['BOLD', 'ITALIC', 'SPOILER', 'STRIKETHROUGH', 'MONOSPACE'].includes(style) ||
      !Number.isSafeInteger(start) ||
      (start ?? -1) < 0 ||
      !Number.isSafeInteger(length) ||
      (length ?? 0) <= 0 ||
      !Number.isSafeInteger(end) ||
      end > message.length
    ) {
      throw new SignalCliError('invalid_request', false);
    }
    ranges.push(`${start}:${length}:${style}`);
  }
  return ranges;
}

/** Directly supervised stdio client. It never restarts or replays requests. */
export class SignalCliClient {
  private readonly child: SignalCliProcess;
  private readonly timers: SignalCliTimers;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly maxRequestBytes: number;
  private readonly diagnostic?: (event: SignalCliDiagnostic) => void;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly receiveHandlers = new Set<
    (value: SignalCliReceiveNotification) => void
  >();
  private readonly stateHandlers = new Set<(state: SignalCliState) => void>();
  private nextId = 1;
  private input = Buffer.alloc(0);
  private discardingOversizedFrame = false;
  private currentState: SignalCliState = 'running';
  private exited = false;
  private stopTimer: unknown | undefined;
  private stopPromise: Promise<void> | undefined;
  private resolveStop: (() => void) | undefined;

  constructor(options: SignalCliOptions) {
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? 30_000,
      'requestTimeoutMs',
    );
    this.stopTimeoutMs = positiveInteger(
      options.stopTimeoutMs ?? 5_000,
      'stopTimeoutMs',
    );
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes ?? 256 * 1024,
      'maxFrameBytes',
    );
    this.maxRequestBytes = positiveInteger(
      options.maxRequestBytes ?? 256 * 1024,
      'maxRequestBytes',
    );
    this.timers = options.timers ?? defaultTimers;
    this.diagnostic = options.diagnostic;
    const spawn = options.spawn ?? defaultSpawn;
    try {
      this.child = spawn(
        options.command ?? 'signal-cli',
        ['--data-dir', options.dataDir, '-a', options.account, 'jsonRpc'],
        { shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch {
      throw new SignalCliError('transport_unavailable', false);
    }
    this.child.stdout.on('data', (chunk) => this.consumeStdout(chunk));
    this.child.stdout.on('error', () => this.handleProcessError());
    this.child.stdin.on('error', () => this.handleProcessError());
    // Drain but never retain or expose stderr, which may contain private data.
    this.child.stderr.on('data', () => this.emitDiagnostic('stderr_received'));
    this.child.stderr.on('error', () => this.handleProcessError());
    this.child.once('error', () => this.handleProcessError());
    this.child.once('exit', () => this.handleExit());
  }

  get state(): SignalCliState {
    return this.currentState;
  }

  onReceive(
    handler: (value: SignalCliReceiveNotification) => void,
  ): () => void {
    this.receiveHandlers.add(handler);
    return () => this.receiveHandlers.delete(handler);
  }
  onStateChange(handler: (state: SignalCliState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Resolve means accepted by signal-cli, not delivered or read. */
  async sendText(
    recipient: string,
    message: string,
    styles: readonly SignalTextStyle[] = [],
  ): Promise<SignalCliAccepted> {
    const textStyle = styleRanges(message, styles);
    await this.request('send', {
      recipient: [recipient],
      message,
      ...(textStyle.length > 0 ? { textStyle } : {}),
    });
    return { status: 'accepted' };
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.currentState !== 'running')
      return Promise.reject(new SignalCliError('transport_unavailable', false));
    if (typeof method !== 'string' || method.length === 0 || !isObject(params))
      return Promise.reject(new SignalCliError('invalid_request', false));
    if (!Number.isSafeInteger(this.nextId))
      return Promise.reject(new SignalCliError('invalid_request', false));

    const id = this.nextId++;
    let frame: string;
    try {
      frame = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';
    } catch {
      return Promise.reject(new SignalCliError('invalid_request', false));
    }
    if (Buffer.byteLength(frame) > this.maxRequestBytes)
      return Promise.reject(new SignalCliError('request_too_large', false));

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        issued: false,
        timer: undefined,
      };
      pending.timer = this.timers.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        pending.reject(new SignalCliError('request_timeout', pending.issued));
      }, this.requestTimeoutMs);
      this.pending.set(id, pending);
      try {
        // Once write is invoked the daemon may have consumed the request.
        pending.issued = true;
        this.child.stdin.write(frame, (error) => {
          if (!error) return;
          const active = this.pending.get(id);
          if (!active) return;
          this.pending.delete(id);
          this.timers.clearTimeout(active.timer);
          active.reject(new SignalCliError('write_failed', true));
        });
      } catch {
        pending.issued = false;
        if (this.pending.delete(id)) {
          this.timers.clearTimeout(pending.timer);
          pending.reject(new SignalCliError('write_failed', false));
        }
      }
    });
  }

  /** Close stdin, TERM, then use a controlled bounded KILL fallback. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStop = resolve;
    });
    if (this.exited || this.currentState === 'stopped') {
      this.finishStop();
      return this.stopPromise;
    }
    this.setState('stopping');
    this.rejectPending();
    try {
      this.child.stdin.end();
    } catch {
      /* continue termination */
    }
    try {
      this.child.kill('SIGTERM');
    } catch {
      /* bounded fallback remains */
    }
    // Some injected or platform process surfaces can report exit synchronously.
    if (!this.exited) {
      this.stopTimer = this.timers.setTimeout(() => {
        try {
          this.child.kill('SIGKILL');
        } catch {
          /* already unavailable */
        }
        this.finishStop();
      }, this.stopTimeoutMs);
    }
    return this.stopPromise;
  }

  private consumeStdout(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      if (!this.discardingOversizedFrame) {
        if (this.input.length + segment.length > this.maxFrameBytes) {
          this.input = Buffer.alloc(0);
          this.discardingOversizedFrame = true;
          this.emitDiagnostic('oversized_frame');
        } else if (segment.length > 0) {
          this.input = Buffer.concat([this.input, segment]);
        }
      }
      if (newline === -1) return;
      if (this.discardingOversizedFrame) {
        this.discardingOversizedFrame = false;
      } else {
        let frame = this.input;
        this.input = Buffer.alloc(0);
        if (frame.length > 0 && frame[frame.length - 1] === 0x0d)
          frame = frame.subarray(0, frame.length - 1);
        if (!isUtf8(frame)) this.emitDiagnostic('invalid_frame');
        else this.handleFrame(frame.toString('utf8'));
      }
      offset = newline + 1;
    }
  }

  private handleFrame(frame: string): void {
    let value: unknown;
    try {
      value = JSON.parse(frame);
    } catch {
      this.emitDiagnostic('invalid_frame');
      return;
    }
    if (!isObject(value) || value.jsonrpc !== '2.0') {
      this.emitDiagnostic('invalid_frame');
      return;
    }
    if (hasOwn(value, 'id')) this.handleResponse(value);
    else this.handleNotification(value);
  }

  private handleResponse(value: Record<string, unknown>): void {
    const id = value.id;
    const hasResult = hasOwn(value, 'result');
    const hasError = hasOwn(value, 'error');
    if (
      !Number.isSafeInteger(id) ||
      (id as number) < 1 ||
      hasResult === hasError ||
      hasOwn(value, 'method') ||
      hasOwn(value, 'params')
    ) {
      this.emitDiagnostic('invalid_frame');
      return;
    }
    let rpcCode: number | undefined;
    if (hasError) {
      const error = value.error;
      if (
        !isObject(error) ||
        !Number.isInteger(error.code) ||
        typeof error.message !== 'string'
      ) {
        this.emitDiagnostic('invalid_frame');
        return;
      }
      rpcCode = error.code as number;
    }
    const pending = this.pending.get(id as number);
    if (!pending) {
      this.emitDiagnostic('unknown_response');
      return;
    }
    this.pending.delete(id as number);
    this.timers.clearTimeout(pending.timer);
    if (hasError)
      pending.reject(new SignalCliError('request_rejected', false, rpcCode));
    else pending.resolve(value.result);
  }

  private handleNotification(value: Record<string, unknown>): void {
    if (
      value.method !== 'receive' ||
      hasOwn(value, 'result') ||
      hasOwn(value, 'error') ||
      !isObject(value.params) ||
      !isObject(value.params.envelope)
    ) {
      this.emitDiagnostic('invalid_frame');
      return;
    }
    const notification = { envelope: value.params.envelope };
    for (const handler of this.receiveHandlers) {
      try {
        handler(notification);
      } catch {
        this.emitDiagnostic('receive_handler_error');
      }
    }
  }

  private handleProcessError(): void {
    this.emitDiagnostic('process_error');
    if (this.currentState === 'stopping') return;
    this.setState('unavailable');
    this.rejectPending();
  }
  private handleExit(): void {
    this.exited = true;
    if (this.currentState === 'stopping') {
      this.finishStop();
      return;
    }
    if (this.currentState !== 'stopped') {
      this.emitDiagnostic('unexpected_exit');
      this.setState('unavailable');
      this.rejectPending();
    }
  }
  private rejectPending(): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      this.timers.clearTimeout(pending.timer);
      pending.reject(
        new SignalCliError('transport_unavailable', pending.issued),
      );
    }
  }
  private finishStop(): void {
    if (this.stopTimer !== undefined) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    this.setState('stopped');
    this.resolveStop?.();
    this.resolveStop = undefined;
  }
  private setState(state: SignalCliState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch {
        /* observers do not supervise */
      }
    }
  }
  private emitDiagnostic(event: SignalCliDiagnostic): void {
    try {
      this.diagnostic?.(event);
    } catch {
      /* best effort */
    }
  }
}

export function createSignalCliClient(
  options: SignalCliOptions,
): SignalCliClient {
  return new SignalCliClient(options);
}
