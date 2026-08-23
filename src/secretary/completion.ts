import { configForLlmRef, type Config } from '../config.js';
import {
  createLLM,
  type ChatMessage,
  type CompleteResult,
  type LLM,
  type RunTool,
} from '../llm/llm.js';
import type { Database } from '../store/db.js';
import {
  parseWorkerMessages,
  WorkerCompletionError,
} from '../worker/completion.js';
import {
  resolveSecretarySession,
  type SecretarySessionBinding,
} from './session.js';
import { SECRETARY_MIND_TOOL } from './tool.js';

const SECRETARY_MESSAGE_TOOLS = new Set(['mind', 'think']);
const DEFAULT_MAX_CONCURRENT = 4;

export class SecretaryCompletionError extends Error {
  constructor(
    public readonly code:
      | 'unauthorized'
      | 'invalid_request'
      | 'busy'
      | 'capacity'
      | 'binding_changed'
      | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'SecretaryCompletionError';
  }
}

export interface SecretaryCompletionReply {
  binding: SecretarySessionBinding;
  result: CompleteResult;
}

export interface SecretaryCompletionBrokerOptions {
  db: Database;
  config: Config;
  maxConcurrent?: number;
  create?: typeof createLLM;
}

function parseSecretaryMessages(value: unknown): ChatMessage[] {
  try {
    return parseWorkerMessages(value, SECRETARY_MESSAGE_TOOLS);
  } catch (error) {
    if (error instanceof WorkerCompletionError) {
      throw new SecretaryCompletionError(
        error.code,
        error.message.replace(/^worker /, 'secretary '),
      );
    }
    throw error;
  }
}

export class SecretaryCompletionBroker {
  private readonly create: typeof createLLM;
  private readonly maxConcurrent: number;
  private readonly clients = new Map<string, { modelRef: string; llm: LLM }>();
  private readonly active = new Set<string>();

  constructor(private readonly options: SecretaryCompletionBrokerOptions) {
    this.create = options.create ?? createLLM;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1)
      throw new Error(
        'secretary completion capacity must be a positive integer',
      );
  }

  async complete(
    token: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<SecretaryCompletionReply> {
    const binding = resolveSecretarySession(this.options.db, token);
    if (!binding)
      throw new SecretaryCompletionError(
        'unauthorized',
        'secretary session is unavailable',
      );
    const messages = parseSecretaryMessages(input);
    if (this.active.has(binding.sessionId))
      throw new SecretaryCompletionError(
        'busy',
        'secretary session already has a completion in flight',
      );
    if (this.active.size >= this.maxConcurrent)
      throw new SecretaryCompletionError(
        'capacity',
        'secretary completion capacity is full',
      );

    let cached = this.clients.get(binding.sessionId);
    if (cached && cached.modelRef !== binding.modelRef)
      throw new SecretaryCompletionError(
        'binding_changed',
        'secretary model binding changed after client creation',
      );
    if (!cached) {
      const llm = this.create(
        configForLlmRef(this.options.config, binding.modelRef),
        undefined,
        this.options.db,
      );
      cached = { modelRef: binding.modelRef, llm };
      this.clients.set(binding.sessionId, cached);
    }

    this.active.add(binding.sessionId);
    try {
      return {
        binding,
        result: await cached.llm.complete(messages, {
          signal,
          runTool: SECRETARY_MIND_TOOL as unknown as RunTool,
          toolChoice: 'auto',
        }),
      };
    } finally {
      this.active.delete(binding.sessionId);
    }
  }
}
