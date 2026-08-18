import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMotorController, extractMotorJson, parseMotorAction } from '../src/sandbox/motor.js';
import { RetriableError, type ChatMessage, type StandaloneCompleteOptions } from '../src/llm/llm.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };

const motorIdentity = {
  providerType: 'codex-oauth' as const,
  model: 'gpt-5.6-luna',
  apiSurface: 'codex-responses' as const,
  apiEndpoint: 'https://chatgpt.com/backend-api/codex/responses',
};

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-motor-test-'));
}

test('motor JSON extraction respects braces inside strings and validates bounded actions', () => {
  const text = 'noise {"keys":["Up","f"],"duration_ms":250,"wait_ms":100,"done":false,"reason":"door {ahead}","confidence":0.8} tail';
  assert.equal(extractMotorJson(text), text.slice(6, -5));
  assert.deepEqual(parseMotorAction(text), {
    keys: ['Up', 'f'], durationMs: 250, waitMs: 100, done: false, reason: 'door {ahead}', confidence: 0.8,
  });
  assert.throws(() => parseMotorAction('{"keys":["Control_L"],"duration_ms":20,"wait_ms":0,"done":false,"reason":"no"}'), /not allowed/);
  assert.throws(() => parseMotorAction('{"keys":[],"duration_ms":0,"wait_ms":0,"done":false,"reason":"no"}'), /requires at least one key/);
  assert.deepEqual(parseMotorAction('{"keys":[],"duration_ms":0,"wait_ms":0,"done":true,"reason":"objective visible"}'), {
    keys: [], durationMs: 0, waitMs: 0, done: true, reason: 'objective visible',
  });
});

test('motor step sends an ephemeral screenshot, acts once, waits, and appends a trace', async () => {
  const dir = tempDir();
  const holds: Array<{ keys: string[]; durationMs: number }> = [];
  const waits: number[] = [];
  let received: ChatMessage[] = [];
  let receivedOpts: StandaloneCompleteOptions = {};
  const motor: any = createMotorController({
    dataDirectory: dir,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async (keys: string[], durationMs: number) => { holds.push({ keys, durationMs }); return { ok: true }; },
    sleep: async (ms: number) => { waits.push(ms); },
    completeStandalone: async (messages: ChatMessage[], opts?: StandaloneCompleteOptions) => {
      received = messages; receivedOpts = opts ?? {};
      return { content: '{"keys":["Up","f"],"duration_ms":250,"wait_ms":50,"done":false,"reason":"advance and fire"}', usage, requestId: 'resp_1', model: opts?.model, reasoningEffort: opts?.reasoningEffort }; 
    },
  });
  const result = await motor.step('reach the exit', { traceId: 'step-case', settleMs: 25, reasoningEffort: 'low' });
  assert.deepEqual(holds, [{ keys: ['Up', 'f'], durationMs: 250 }]);
  assert.deepEqual(waits, [75]);
  assert.equal(receivedOpts.cacheKey, 'motor-step-case');
  assert.equal(receivedOpts.reasoningEffort, 'low');
  assert.ok(receivedOpts.signal instanceof AbortSignal);
  assert.equal(received[0].role, 'system');
  assert.match(received[0].content ?? '', /not a conversational agent and not a person/);
  assert.match(received[0].content ?? '', /f = fire; space = use\/open/);
  assert.equal(received[1].contentParts?.[1].type, 'image_url');
  assert.match((received[1].contentParts?.[1] as any).image_url.url, /^data:image\/png;base64,/);
  assert.equal(result.action.reason, 'advance and fire');
  assert.equal(result.requestId, 'resp_1');
  assert.equal(result.reasoningEffort, 'low');
  const lines = fs.readFileSync(result.traceFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, 'step');
  assert.equal(lines[0].acted, true);
  assert.equal(lines[0].actualWaitMs, 75);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor carries encrypted reasoning from one screenshot decision into the next', async () => {
  const dir = tempDir();
  const calls: ChatMessage[][] = [];
  let completion = 0;
  const reasoningItem = {
    id: 'rs_motor', type: 'reasoning' as const, status: 'completed', summary: [], encrypted_content: 'opaque-spatial-state',
  };
  const motor: any = createMotorController({
    dataDirectory: dir,
    replayIdentity: motorIdentity,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async () => {},
    sleep: async () => {},
    completeStandalone: async (messages: ChatMessage[]) => {
      calls.push(messages);
      if (completion++ === 0) {
        return {
          content: '{"keys":["Right"],"duration_ms":100,"wait_ms":0,"done":false,"reason":"remember this turn"}',
          reasoningItems: [reasoningItem], usage, ...motorIdentity,
        };
      }
      return { content: '{"keys":[],"duration_ms":0,"wait_ms":0,"done":true,"reason":"continued"}', usage, ...motorIdentity };
    },
  });
  const result = await motor.run('continue spatial reasoning', { traceId: 'reasoning-carry', maxSteps: 2, dryRun: true, settleMs: 0 });
  assert.equal(result.done, true);
  assert.equal(calls[0].length, 2);
  assert.equal(calls[1].length, 3);
  assert.equal(calls[1][1].role, 'assistant');
  assert.equal(calls[1][1].content, '{"keys":["Right"],"duration_ms":100,"wait_ms":0,"done":false,"reason":"remember this turn"}');
  assert.deepEqual(calls[1][1].reasoning_items, [reasoningItem]);
  assert.equal(calls[1][2].role, 'user');
  const events = fs.readFileSync(result.traceFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events[0].reasoningItems, [reasoningItem]);
  assert.equal(events[0].reasoningItemsIn, 0);
  assert.equal(events[0].reasoningBytesOut, 'opaque-spatial-state'.length);
  assert.match(events[0].replaySourceId, /^[0-9a-f]{64}$/);
  assert.notEqual(events[0].replaySourceId, fs.readFileSync(path.join(resolveDataLayout(dir).motor, 'traces', '.source-id'), 'utf8').trim());
  assert.equal(events[0].providerType, motorIdentity.providerType);
  assert.equal(events[0].apiSurface, motorIdentity.apiSurface);
  assert.equal(events[0].apiEndpoint, motorIdentity.apiEndpoint);
  assert.equal(events[1].reasoningItemsIn, 1);
  assert.equal(events[1].reasoningBytesIn, 'opaque-spatial-state'.length);
  fs.rmSync(dir, { recursive: true, force: true });
});


test('motor strips opaque reasoning when attribution is missing or a trace lacks the local source nonce', async () => {
  const dir = tempDir();
  const calls: ChatMessage[][] = [];
  let completion = 0;
  const reasoningItem = { type: 'reasoning' as const, summary: [], encrypted_content: 'untrusted-opaque' };
  const makeMotor = (dataDirectory: string) => createMotorController({
    dataDirectory,
    replayIdentity: motorIdentity,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async () => {},
    sleep: async () => {},
    completeStandalone: async (messages: ChatMessage[]) => {
      calls.push(messages);
      if (completion++ === 0) return {
        content: '{"keys":["Right"],"duration_ms":100,"wait_ms":0,"done":false,"reason":"first"}',
        reasoningItems: [reasoningItem], usage,
      };
      return { content: '{"keys":[],"duration_ms":0,"wait_ms":0,"done":true,"reason":"done"}', usage, ...motorIdentity };
    },
  }) as any;
  await makeMotor(dir).run('missing attribution', { traceId: 'untrusted', maxSteps: 2, dryRun: true, settleMs: 0 });
  assert.equal(calls[1].length, 2, 'missing provider identity must not replay opaque state');

  const sourceDir = tempDir();
  completion = 0;
  calls.length = 0;
  const sourceMotor = createMotorController({
    dataDirectory: sourceDir, replayIdentity: motorIdentity,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async () => {}, sleep: async () => {},
    completeStandalone: async () => ({
      content: '{"keys":["Right"],"duration_ms":100,"wait_ms":0,"done":false,"reason":"source"}',
      reasoningItems: [reasoningItem], usage, ...motorIdentity,
    }),
  }) as any;
  const source = await sourceMotor.run('source trace', { traceId: 'copied', maxSteps: 1, dryRun: true, settleMs: 0 });
  const importedDir = tempDir();
  const importedTraceDir = path.join(resolveDataLayout(importedDir).motor, 'traces');
  fs.mkdirSync(importedTraceDir, { recursive: true });
  fs.copyFileSync(source.traceFile, path.join(importedTraceDir, 'copied.jsonl'));
  let importedMessages: ChatMessage[] = [];
  const importedMotor: any = createMotorController({
    dataDirectory: importedDir, replayIdentity: motorIdentity,
    screenshot: async (file: string) => { fs.writeFileSync(file, 'png'); return { file }; },
    hold: async () => {}, sleep: async () => {},
    completeStandalone: async (messages: ChatMessage[]) => {
      importedMessages = messages;
      return { content: '{"keys":[],"duration_ms":0,"wait_ms":0,"done":true,"reason":"imported"}', usage, ...motorIdentity };
    },
  });
  await importedMotor.run('imported trace', { traceId: 'copied', resume: true, maxSteps: 1, dryRun: true, settleMs: 0 });
  assert.equal(importedMessages.length, 2, 'copying the trace without its local source nonce must not replay opaque state');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(importedDir, { recursive: true, force: true });
});

test('motor validation failure never acts and leaves an append-only error event', async () => {
  const dir = tempDir();
  let holds = 0;
  const motor: any = createMotorController({
    dataDirectory: dir,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async () => { holds++; },
    completeStandalone: async () => ({ content: '{"keys":["Control_L"],"duration_ms":20,"wait_ms":0,"done":false,"reason":"escape sandbox"}', usage }),
  });
  await assert.rejects(motor.step('stay safe', { traceId: 'bad-key' }), /not allowed/);
  assert.equal(holds, 0);
  const trace = path.join(resolveDataLayout(dir).motor, 'traces', 'bad-key.jsonl');
  const event = JSON.parse(fs.readFileSync(trace, 'utf8').trim());
  assert.equal(event.type, 'error');
  assert.equal(event.stage, 'validate');
  assert.match(event.response, /Control_L/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor aborts a hung standalone request and leaves a bounded timeout cut', async () => {
  const dir = tempDir();
  let aborts = 0;
  const motor: any = createMotorController({
    dataDirectory: dir,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async () => {},
    sleep: async () => {},
    completeStandalone: async (_messages: ChatMessage[], opts?: StandaloneCompleteOptions) => new Promise((_resolve, reject) => {
      assert.ok(opts?.signal);
      opts.signal.addEventListener('abort', () => {
        aborts++;
        reject(Object.assign(new Error('transport aborted'), { name: 'AbortError' }));
      }, { once: true });
    }),
  });
  await assert.rejects(
    motor.step('timeout test', { traceId: 'timeout-case', dryRun: true, retries: 1, completionTimeoutMs: 20 }),
    /timed out after 20ms/,
  );
  assert.equal(aborts, 1);
  const event = JSON.parse(fs.readFileSync(path.join(resolveDataLayout(dir).motor, 'traces', 'timeout-case.jsonl'), 'utf8').trim());
  assert.equal(event.type, 'error');
  assert.equal(event.stage, 'complete');
  assert.equal(event.completionAttempts, 1);
  assert.equal(event.completionTimeoutMs, 20);
  assert.deepEqual(event.completionErrors, ['motor completion timed out after 20ms']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor retries transient completion failures and records the interruption in the successful step', async () => {
  const dir = tempDir();
  let attempts = 0;
  const waits: number[] = [];
  const motor: any = createMotorController({
    dataDirectory: dir,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async () => {},
    sleep: async (ms: number) => { waits.push(ms); },
    completeStandalone: async () => {
      if (attempts++ === 0) throw new RetriableError(new Error('503 upstream reset'));
      return { content: '{"keys":["Up"],"duration_ms":100,"wait_ms":0,"done":false,"reason":"continue"}', usage };
    },
  });
  const result = await motor.step('continue', { traceId: 'retry-case', dryRun: true, retries: 2, settleMs: 0 });
  assert.equal(result.completionAttempts, 2);
  assert.deepEqual(result.completionErrors, ['503 upstream reset']);
  assert.deepEqual(waits, [500]);
  const event = JSON.parse(fs.readFileSync(result.traceFile, 'utf8').trim());
  assert.equal(event.completionAttempts, 2);
  assert.deepEqual(event.completionErrors, ['503 upstream reset']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor run resumes after a marked error without overwriting frame or step indices', async () => {
  const dir = tempDir();
  let calls = 0;
  let recovered = false;
  const motor: any = createMotorController({
    dataDirectory: dir,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, file); return { file }; },
    hold: async () => {},
    sleep: async () => {},
    completeStandalone: async () => {
      calls++;
      if (!recovered && calls === 1) return { content: '{"keys":["Up"],"duration_ms":100,"wait_ms":0,"done":false,"reason":"first"}', usage };
      if (!recovered) throw new Error('non-retriable cut');
      return { content: '{"keys":[],"duration_ms":0,"wait_ms":0,"done":true,"reason":"recovered"}', usage };
    },
  });
  await assert.rejects(motor.run('resume test', { traceId: 'resume-case', maxSteps: 3, settleMs: 0 }), /non-retriable cut/);
  const file = path.join(resolveDataLayout(dir).motor, 'traces', 'resume-case.jsonl');
  let events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => [event.type, event.step]), [['step', 0], ['error', 1]]);
  assert.equal(fs.existsSync(path.join(resolveDataLayout(dir).motor, 'traces', 'resume-case-0001.png')), true);
  recovered = true;
  const resumed = await motor.run('resume test', { traceId: 'resume-case', resume: true, maxSteps: 3, settleMs: 0 });
  assert.equal(resumed.resumedFrom, 2);
  assert.equal(resumed.done, true);
  assert.equal(resumed.steps[0].step, 2);
  events = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => [event.type, event.step]), [['step', 0], ['error', 1], ['step', 2]]);
  assert.equal(fs.existsSync(path.join(resolveDataLayout(dir).motor, 'traces', 'resume-case-0002.png')), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor run stops on done and replay is dry unless execute is explicit', async () => {
  const dir = tempDir();
  let completion = 0;
  const holds: Array<{ keys: string[]; durationMs: number }> = [];
  const motor: any = createMotorController({
    dataDirectory: dir,
    screenshot: async (file: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { file }; },
    hold: async (keys: string[], durationMs: number) => { holds.push({ keys, durationMs }); },
    sleep: async () => {},
    completeStandalone: async () => ({
      content: completion++ === 0
        ? '{"keys":["Right"],"duration_ms":100,"wait_ms":0,"done":false,"reason":"turn toward corridor"}'
        : '{"keys":[],"duration_ms":0,"wait_ms":0,"done":true,"reason":"exit reached"}',
      usage,
    }),
  });
  const result = await motor.run('reach exit', { traceId: 'run-case', maxSteps: 10, settleMs: 0 });
  assert.equal(result.done, true);
  assert.equal(result.steps.length, 2);
  assert.equal(holds.length, 1);
  const dry = await motor.replay(result.traceFile);
  assert.equal(dry.execute, false);
  assert.equal(holds.length, 1);
  const live = await motor.replay(result.traceFile, { execute: true });
  assert.equal(live.execute, true);
  assert.equal(holds.length, 2);
  assert.equal((await motor.list())[0].traceId, 'run-case');
  fs.rmSync(dir, { recursive: true, force: true });
});
