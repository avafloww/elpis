import { createHash } from 'node:crypto';
import type { ChatMessage, CompleteResult } from '../llm/llm.js';
import { applyKernelTurn } from './turn.js';
import { WorkerJournal } from './worker-journal.js';

export interface WorkerMandate {
  id: string;
  title: string;
  body: string;
  status: string;
  dependencies?: unknown[];
  comments?: unknown[];
}

export interface WorkerGuidance {
  id: number;
  sender: string;
  body: string;
}

export interface WorkerEpisodeBroker {
  getMandate(signal?: AbortSignal): Promise<WorkerMandate>;
  pullGuidance(signal?: AbortSignal): Promise<WorkerGuidance[]>;
  acknowledgeGuidance(ids: number[], signal?: AbortSignal): Promise<void>;
  complete(
    messages: ChatMessage[],
    signal?: AbortSignal,
  ): Promise<CompleteResult>;
  finish(key: string, body: string, signal?: AbortSignal): Promise<void>;
}

export interface WorkerRunResult {
  ok: boolean;
  preview?: string;
  savedAs?: '_';
  logs?: string;
  error?: string;
  failureKind?: 'preparse' | 'runtime';
  detached?: boolean;
  bgId?: string;
  note?: string;
}

export interface WorkerEpisodeSandbox {
  run(code: string): Promise<WorkerRunResult>;
}

export interface WorkerEpisodeOptions {
  broker: WorkerEpisodeBroker;
  sandbox: WorkerEpisodeSandbox;
  journal: WorkerJournal;
  beforeFinish?: (
    value: { key: string; body: string },
    signal?: AbortSignal,
  ) => Promise<void>;
  maxTurns?: number;
  maxMessages?: number;
}

export interface WorkerEpisodeResult {
  body: string;
  finishKey: string;
  turns: number;
  resumed: boolean;
}

export class WorkerEpisodeError extends Error {
  constructor(
    public readonly code:
      'ambiguous_tool' | 'empty_finish' | 'message_limit' | 'turn_limit',
    message: string,
  ) {
    super(message);
    this.name = 'WorkerEpisodeError';
  }
}

const WORKER_SYSTEM_PROMPT = `You are an ephemeral Elpis worker executing one bounded delegated task.
Your original mandate is the linked Mind item supplied below. It is the only original prompt.
You have task-local transcript and workspace continuity, not resident identity, SOUL, autobiographical MEMORY, people history, Discord, Scheduler, or autonomous wake machinery.
Use run for concrete work in your isolated workspace. Continue until the mandate is complete, then answer with a concise result for the dispatcher.`;

function mandateMessage(mandate: WorkerMandate): ChatMessage {
  return {
    role: 'user',
    content: `<worker-mandate id=${JSON.stringify(mandate.id)} status=${JSON.stringify(mandate.status)}>
<title>${mandate.title}</title>
<body>${mandate.body}</body>
<dependencies>${JSON.stringify(mandate.dependencies ?? [])}</dependencies>
<comments>${JSON.stringify(mandate.comments ?? [])}</comments>
</worker-mandate>`,
  };
}

function guidanceMessage(guidance: WorkerGuidance): ChatMessage {
  return {
    role: 'user',
    content: `<worker-guidance sender=${JSON.stringify(guidance.sender)}>${guidance.body}</worker-guidance>`,
  };
}

function parseObject(raw: string): Record<string, unknown> {
  const value = JSON.parse(raw) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('tool arguments must be an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`tool arguments must contain exactly ${wanted.join(', ')}`);
  }
}

function runArguments(raw: string): { code: string; detail: string } {
  const value = parseObject(raw);
  exactKeys(value, ['code', 'detail']);
  if (typeof value.code !== 'string' || value.code.length === 0) {
    throw new Error('run.code must be a non-empty string');
  }
  if (
    typeof value.detail !== 'string' ||
    value.detail.includes('\n') ||
    value.detail.length > 120
  ) {
    throw new Error('run.detail must be one line of at most 120 characters');
  }
  const words = value.detail.trim().split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 10) {
    throw new Error('run.detail must contain 1 to 10 words');
  }
  return { code: value.code, detail: value.detail };
}

function thinkArguments(raw: string): void {
  const value = parseObject(raw);
  exactKeys(value, ['thoughts']);
  if (
    typeof value.thoughts !== 'string' ||
    value.thoughts.trim().length === 0
  ) {
    throw new Error('think.thoughts must be a non-empty string');
  }
}

function toolError(error: unknown): string {
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

function finishKey(body: string): string {
  return `worker-finish-${createHash('sha256').update(body).digest('hex').slice(0, 24)}`;
}

export class WorkerEpisode {
  private readonly maxTurns: number;
  private readonly maxMessages: number;

  constructor(private readonly options: WorkerEpisodeOptions) {
    this.maxTurns = options.maxTurns ?? 64;
    this.maxMessages = options.maxMessages ?? 128;
  }

  async run(signal?: AbortSignal): Promise<WorkerEpisodeResult> {
    const initial = this.options.journal.state();
    if (initial.pendingTools.size > 0) {
      const ids = [...initial.pendingTools.keys()].join(', ');
      throw new WorkerEpisodeError(
        'ambiguous_tool',
        `worker journal has prepared tools without completion: ${ids}`,
      );
    }
    if (initial.finished) {
      return {
        body: initial.finished.body,
        finishKey: initial.finished.key,
        turns: 0,
        resumed: true,
      };
    }
    if (initial.pendingFinish) {
      await this.options.broker.finish(
        initial.pendingFinish.key,
        initial.pendingFinish.body,
        signal,
      );
      this.options.journal.completeFinish(
        initial.pendingFinish.key,
        initial.pendingFinish.body,
      );
      return {
        body: initial.pendingFinish.body,
        finishKey: initial.pendingFinish.key,
        turns: 0,
        resumed: true,
      };
    }

    const messages = [...initial.messages];
    const resumed = messages.length > 0;
    if (!resumed) {
      signal?.throwIfAborted();
      const mandate = await this.options.broker.getMandate(signal);
      const system: ChatMessage = {
        role: 'system',
        content: WORKER_SYSTEM_PROMPT,
      };
      const user = mandateMessage(mandate);
      this.options.journal.initialize([system, user]);
      messages.push(system, user);
    }

    for (let turns = 1; turns <= this.maxTurns; turns++) {
      signal?.throwIfAborted();
      const guidance = await this.options.broker.pullGuidance(signal);
      for (const entry of guidance) {
        const message = guidanceMessage(entry);
        if (this.options.journal.appendGuidance(entry.id, message)) {
          messages.push(message);
        }
      }
      if (guidance.length > 0) {
        await this.options.broker.acknowledgeGuidance(
          guidance.map((entry) => entry.id),
          signal,
        );
      }
      if (messages.length > this.maxMessages) {
        throw new WorkerEpisodeError(
          'message_limit',
          `worker episode exceeded ${this.maxMessages} messages`,
        );
      }

      const completion = await this.options.broker.complete(
        [...messages],
        signal,
      );
      const preparedRuns = new Set<string>();
      const turn = await applyKernelTurn(
        completion.message,
        async (call) => {
          try {
            if (call.function.name === 'think') {
              thinkArguments(call.function.arguments);
              return {
                content: JSON.stringify({ ok: true, recorded: true }),
              };
            }
            if (call.function.name !== 'run') {
              throw new Error(`unsupported worker tool ${call.function.name}`);
            }
            const args = runArguments(call.function.arguments);
            this.options.journal.prepareTool(call);
            preparedRuns.add(call.id);
            const result = await this.options.sandbox.run(args.code);
            if (result.detached) {
              throw new Error(
                'worker tool detached before completion; effect outcome is ambiguous',
              );
            }
            return { content: JSON.stringify(result) };
          } catch (error) {
            if (preparedRuns.has(call.id)) throw error;
            return { content: toolError(error) };
          }
        },
        {
          appendAssistant: (message) => {
            this.options.journal.appendMessage(message);
            messages.push(message);
          },
          appendTool: (message) => {
            const callId = message.tool_call_id;
            if (!callId) throw new Error('worker tool result has no call id');
            if (preparedRuns.delete(callId)) {
              this.options.journal.completeTool(callId, message);
            } else {
              this.options.journal.appendMessage(message);
            }
            messages.push(message);
          },
        },
      );

      if (turn.shouldContinue) continue;
      const body = completion.message.content.trim();
      if (!body) {
        throw new WorkerEpisodeError(
          'empty_finish',
          'worker ended without a finish body',
        );
      }
      const key = finishKey(body);
      await this.options.beforeFinish?.({ key, body }, signal);
      this.options.journal.prepareFinish(key, body);
      await this.options.broker.finish(key, body, signal);
      this.options.journal.completeFinish(key, body);
      return { body, finishKey: key, turns, resumed };
    }

    throw new WorkerEpisodeError(
      'turn_limit',
      `worker episode exceeded ${this.maxTurns} model turns`,
    );
  }
}
