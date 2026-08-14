// Unit tests for the native Chat Completions streaming path.
// Provider errors keep their retry classification and AbortSignal remains a
// transport option rather than leaking into the request body.
//
// These mock the OpenAI SDK client (no network): create returns an async
// iterable of streaming chunks, or throws to exercise error classification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { streamComplete, RetriableError, NonRetriableError } from '../src/llm/llm.js';
import type { Config } from '../src/config.js';

function stubConfig(dataDirectory: string): Config {
  return {
    llm: {
      apiKey: '', baseUrl: '', model: 'test-model',
      contextSize: null, reasoningEffort: undefined,
      completionReserveTokens: 8192,
    },
    discord: {
      botToken: '', applicationId: '',
      errorChannelId: null, attachmentInlineMaxBytes: 32768,
    },
    compaction: { triggerTokens: 100000, keepTokens: 20000, toolAgeKeepTokens: 20000 },
    heartbeat: { intervalMs: 0, maxIntervalMs: 0, reflectionMinMessages: 3, socialNudgeMs: 0 },
    sandbox: { syncTimeoutMs: 15000, asyncDeadlineMs: 120000, previewMaxBytes: 2048, logMaxBytes: 2048 },
    console: { enabled: false, port: 8787, host: '127.0.0.1' },
    kagi: { apiKey: null },
    paths: { dataDirectory, soulPath: '', memoryPath: '', harnessRoot: '' },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    logLevel: 'silent', log() {},
  } as unknown as Config;
}

type Chunk = {
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  choices: Array<{ delta: Record<string, unknown> }>;
};

/** A counting async-iterable of chunks: `consumed` reports how many chunks were
 * actually pulled, so a test can prove the outer loop stopped early. */
function countingStream(chunks: Chunk[]): { stream: AsyncIterable<Chunk>; consumed: () => number } {
  let count = 0;
  const stream = {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        count++;
        yield c;
      }
    },
  };
  return { stream, consumed: () => count };
}

/** Minimal mock of the OpenAI client surface streamComplete uses. */
function mockClient(opts: {
  chunks?: Chunk[];
  throwValue?: unknown;
  onCreate?: (params: unknown, options: unknown) => void;
  consumedRef?: { consumed: () => number };
}): any {
  return {
    chat: {
      completions: {
        async create(params: unknown, options: unknown) {
          opts.onCreate?.(params, options);
          if (opts.throwValue !== undefined) throw opts.throwValue;
          const { stream, consumed } = countingStream(opts.chunks ?? []);
          if (opts.consumedRef) opts.consumedRef.consumed = consumed;
          return stream;
        },
      },
    },
  };
}

function contentChunk(text: string): Chunk {
  return { choices: [{ delta: { content: text } }] };
}
function toolArgChunk(argsFragment: string, id = 'call_1'): Chunk {
  return {
    choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'run', arguments: argsFragment } }] } }],
  };
}
function usageChunk(): Chunk {
  return { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, choices: [{ delta: {} }] };
}

test('streamComplete: a 429 throw is classified RetriableError', async () => {
  const client = mockClient({ throwValue: { status: 429, message: 'rate limited' } });
  await assert.rejects(
    () => streamComplete(client, stubConfig(os.tmpdir()), [{ role: 'user', content: 'hi' }]),
    (e: unknown) => e instanceof RetriableError,
  );
});

test('streamComplete: a 5xx throw is classified RetriableError', async () => {
  const client = mockClient({ throwValue: { status: 503, message: 'unavailable' } });
  await assert.rejects(
    () => streamComplete(client, stubConfig(os.tmpdir()), [{ role: 'user', content: 'hi' }]),
    (e: unknown) => e instanceof RetriableError,
  );
});

test('streamComplete: a 400 throw is classified NonRetriableError', async () => {
  const client = mockClient({ throwValue: { status: 400, message: 'bad request' } });
  await assert.rejects(
    () => streamComplete(client, stubConfig(os.tmpdir()), [{ role: 'user', content: 'hi' }]),
    (e: unknown) => e instanceof NonRetriableError,
  );
});

test('streamComplete: signal goes to the options arg, not the request body params', async () => {
  let seenParams: any;
  let seenOptions: any;
  const client = mockClient({
    chunks: [contentChunk('ok'), usageChunk()],
    onCreate: (p, o) => { seenParams = p; seenOptions = o; },
  });
  await streamComplete(client, stubConfig(os.tmpdir()), [{ role: 'user', content: 'hi' }]);
  assert.ok(!('signal' in seenParams), 'params body must NOT carry a signal key');
  assert.ok(seenOptions && typeof seenOptions === 'object' && 'signal' in seenOptions,
    'the SDK options (second arg) must carry the abort signal');
  assert.ok(typeof seenOptions.signal.aborted === 'boolean', 'options.signal is an AbortSignal');
});
