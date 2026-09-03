// Regression test: the streaming completion path must pass `signal` as a
// fetch request option (the SDK's second `options` argument), NOT inside the
// API request body. Placing it in the body causes JSON.stringify to emit
// `"signal":{}` (AbortSignal has no enumerable own keys), which the server
// rejects: `400 Extra inputs are not permitted, field: 'signal'`.
//
// This reproduces the production 400 at 03:44:52 that silenced the
// agent for 10h. The code bug is constant; the server began enforcing strict
// schema validation mid-boot.
//
// We build a real LLM via createLLM (the production path), then spy on the
// client's chat.completions.create to capture (body, options) separately.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLLM } from '../src/llm/llm.js';
import { ensureFile } from '../src/store/memory.js';
import { makeConfig } from './helpers.js';

const stubConfig = (tmpDir: string, api: 'chat' | 'responses') =>
  makeConfig({
    paths: {
      dataDirectory: tmpDir,
      soulPath: path.join(tmpDir, 'SOUL.md'),
      memoryPath: path.join(tmpDir, 'MEMORY.md'),
      harnessRoot: tmpDir,
    },
    // Pin the API surface: each test spies on exactly one create method, and
    // 'auto' would route to the Responses path first.
    llm: { ...makeConfig().llm, api },
    heartbeat: { ...makeConfig().heartbeat, reflectionMinMessages: 99 },
  });

/** A minimal async-iterable that yields one empty chunk then ends, so the
 * streaming for-await loop in streamComplete completes immediately. */
function emptyStream() {
  const chunks = [
    {
      choices: [{ delta: {} }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ];
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          i < chunks.length
            ? { value: chunks[i++], done: false }
            : { value: undefined, done: true },
      };
    },
  };
}

test('llm: signal is passed as a request option, not in the API body', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-llm-sig-'));
  ensureFile(path.join(tmpDir, 'SOUL.md'), '# Soul');
  ensureFile(path.join(tmpDir, 'MEMORY.md'), '# Memory');
  const config = stubConfig(tmpDir, 'chat');
  const llm = createLLM(config);

  // Spy on the client's create: capture (body, options) separately.
  let capturedBody: any = null;
  let capturedOpts: any = undefined;
  const origCreate = llm.client.chat.completions.create;
  (llm.client.chat.completions as any).create = async (
    body: any,
    opts?: any,
  ) => {
    capturedBody = body;
    capturedOpts = opts;
    return emptyStream() as any;
  };

  await llm.complete([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);

  // Restore.
  (llm.client.chat.completions as any).create = origCreate;

  // The body (API payload) must NOT contain `signal`.
  assert.ok(capturedBody, 'create() was called with a body');
  assert.equal(
    capturedBody.parallel_tool_calls,
    false,
    'generic Chat requests must keep model tool dispatch serial',
  );
  assert.ok(
    !('signal' in capturedBody),
    'signal must NOT be in the API request body — it serializes to "signal":{} ' +
      'and triggers a 400 "Extra inputs are not permitted"',
  );

  // The signal must be in the request options (second argument).
  assert.ok(capturedOpts, 'create() was called with a second options argument');
  assert.ok(
    'signal' in capturedOpts,
    'signal must be in the request options (SDK second arg) so it controls fetch, not the API body',
  );
  assert.equal(
    typeof (capturedOpts as any).signal?.addEventListener,
    'function',
    'the options.signal is a real AbortSignal',
  );
});

/** Responses-path stream: one terminal `response.completed` event so the
 * for-await loop in streamResponsesComplete completes immediately. */
function emptyResponsesStream() {
  const events = [
    {
      type: 'response.completed',
      response: {
        output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  let i = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () =>
          i < events.length
            ? { value: events[i++], done: false }
            : { value: undefined, done: true },
      };
    },
  };
}

test('llm: responses stream aborts when no meaningful progress arrives before the idle timeout', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-llm-idle-'));
  ensureFile(path.join(tmpDir, 'SOUL.md'), '# Soul');
  ensureFile(path.join(tmpDir, 'MEMORY.md'), '# Memory');
  const base = stubConfig(tmpDir, 'responses');
  const config = makeConfig({
    ...base,
    llm: { ...base.llm, streamIdleTimeoutMs: 20 },
  });
  const llm = createLLM(config);
  const origCreate = llm.client.responses.create;
  let aborted = false;
  (llm.client.responses as any).create = async (_body: any, opts?: any) => ({
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((_resolve, reject) => {
            opts?.signal?.addEventListener(
              'abort',
              () => {
                aborted = true;
                reject(
                  Object.assign(new Error('aborted'), { name: 'AbortError' }),
                );
              },
              { once: true },
            );
          }),
      };
    },
  });

  const started = Date.now();
  await assert.rejects(
    llm.complete([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]),
    /responses stream idle for 20ms/,
  );
  assert.equal(
    aborted,
    true,
    'idle watchdog must abort the underlying request',
  );
  assert.ok(
    Date.now() - started < 1000,
    'idle timeout must not inherit the 20-minute SDK timeout',
  );
  (llm.client.responses as any).create = origCreate;
});

test('llm: non-progress SSE keepalives cannot postpone the idle timeout', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'harness-llm-idle-keepalive-'),
  );
  ensureFile(path.join(tmpDir, 'SOUL.md'), '# Soul');
  ensureFile(path.join(tmpDir, 'MEMORY.md'), '# Memory');
  const base = stubConfig(tmpDir, 'responses');
  const config = makeConfig({
    ...base,
    llm: { ...base.llm, streamIdleTimeoutMs: 35 },
  });
  const llm = createLLM(config);
  const origCreate = llm.client.responses.create;
  (llm.client.responses as any).create = async () => ({
    async *[Symbol.asyncIterator]() {
      while (true) {
        await new Promise((r) => setTimeout(r, 5));
        yield { type: 'response.in_progress' };
      }
    },
  });

  const started = Date.now();
  await assert.rejects(
    llm.complete([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]),
    /responses stream idle for 35ms/,
  );
  assert.ok(
    Date.now() - started < 500,
    'keepalives must not extend the meaningful-progress deadline',
  );
  (llm.client.responses as any).create = origCreate;
});

test('llm: responses stream idle timeout resets on each meaningful SSE event', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'harness-llm-idle-reset-'),
  );
  ensureFile(path.join(tmpDir, 'SOUL.md'), '# Soul');
  ensureFile(path.join(tmpDir, 'MEMORY.md'), '# Memory');
  const base = stubConfig(tmpDir, 'responses');
  const config = makeConfig({
    ...base,
    llm: { ...base.llm, streamIdleTimeoutMs: 35 },
  });
  const llm = createLLM(config);
  const origCreate = llm.client.responses.create;
  (llm.client.responses as any).create = async () => ({
    async *[Symbol.asyncIterator]() {
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'response.output_text.delta', delta: 'a' };
      await new Promise((r) => setTimeout(r, 20));
      yield { type: 'response.completed', response: { output: [], usage: {} } };
    },
  });

  await llm.complete([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);
  (llm.client.responses as any).create = origCreate;
});

test('llm: responses path passes signal as a request option, not in the API body', async () => {
  const tmpDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'harness-llm-sig-resp-'),
  );
  ensureFile(path.join(tmpDir, 'SOUL.md'), '# Soul');
  ensureFile(path.join(tmpDir, 'MEMORY.md'), '# Memory');
  const config = stubConfig(tmpDir, 'responses');
  const llm = createLLM(config);

  let capturedBody: any = null;
  let capturedOpts: any = undefined;
  const origCreate = llm.client.responses.create;
  (llm.client.responses as any).create = async (body: any, opts?: any) => {
    capturedBody = body;
    capturedOpts = opts;
    return emptyResponsesStream() as any;
  };

  await llm.complete([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ]);

  (llm.client.responses as any).create = origCreate;

  assert.ok(capturedBody, 'responses.create() was called with a body');
  assert.ok(
    !('signal' in capturedBody),
    'signal must NOT be in the API request body',
  );
  assert.equal(
    capturedBody.store,
    false,
    'stateless mode: store must be false',
  );
  assert.ok(
    Array.isArray(capturedBody.include) &&
      capturedBody.include.includes('reasoning.encrypted_content'),
    'encrypted reasoning must be requested via include',
  );
  assert.ok(
    capturedOpts && 'signal' in capturedOpts,
    'signal must be in the request options (SDK second arg)',
  );
  assert.equal(
    typeof (capturedOpts as any).signal?.addEventListener,
    'function',
    'the options.signal is a real AbortSignal',
  );
});
