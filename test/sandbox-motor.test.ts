import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createMotorController,
  parseMotorToolCall,
  trimMotorImages,
  type MotorControllerDeps,
  type MotorOversightPacket,
} from '../src/sandbox/motor.js';
import type { ChatMessage, StandaloneCompleteOptions, StandaloneCompleteResult } from '../src/llm/llm.js';
import { resolveDataLayout } from '../src/store/data-layout.js';

const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-resident-motor-test-'));
}

function fakePng(file: string, width = 1280, height = 800): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  fs.writeFileSync(file, header);
}

function completion(name: string, args: Record<string, unknown>, extra: Partial<StandaloneCompleteResult> = {}): StandaloneCompleteResult {
  return {
    content: '', usage,
    toolCalls: [{ id: `call-${name}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    model: 'holo-test', providerType: 'openai-compatible', apiSurface: 'chat-completions', apiEndpoint: 'http://local/v1/chat/completions',
    ...extra,
  };
}

async function until(read: () => any, predicate: (value: any) => boolean, timeoutMs = 2_000): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not reached; last=${JSON.stringify(read())}`);
}

function fixture(dir: string, completeStandalone: MotorControllerDeps['completeStandalone'], overrides: Partial<MotorControllerDeps> = {}) {
  const calls = { click: [] as any[], drag: [] as any[], type: [] as any[], key: [] as any[], scroll: [] as any[] };
  const deps: MotorControllerDeps = {
    dataDirectory: dir,
    completeStandalone,
    screenshot: async (file) => { fakePng(file); return { file }; },
    click: async (x, y, opts) => { calls.click.push({ x, y, opts }); return { ok: true }; },
    drag: async (fromX, fromY, toX, toY) => { calls.drag.push({ fromX, fromY, toX, toY }); return { ok: true }; },
    type: async (text) => { calls.type.push(text); return { ok: true }; },
    key: async (keys) => { calls.key.push(keys); return { ok: true }; },
    scroll: async (clicks) => { calls.scroll.push(clicks); return { ok: true }; },
    sleep: async () => {},
    ...overrides,
  };
  return { motor: createMotorController(deps) as any, calls, deps };
}

test('native motor tool parser requires exactly one closed function call', () => {
  assert.deepEqual(parseMotorToolCall([{ id: 'c', type: 'function', function: { name: 'click', arguments: '{"x":1}' } }]), {
    call: { id: 'c', type: 'function', function: { name: 'click', arguments: '{"x":1}' } }, args: { x: 1 },
  });
  assert.throws(() => parseMotorToolCall(undefined), /exactly one/);
  assert.throws(() => parseMotorToolCall([
    { id: 'a', type: 'function', function: { name: 'click', arguments: '{}' } },
    { id: 'b', type: 'function', function: { name: 'write', arguments: '{}' } },
  ]), /exactly one/);
  assert.throws(() => parseMotorToolCall([{ id: 'c', type: 'function', function: { name: 'click', arguments: '{' } }]), /invalid JSON/);
});

test('motor image metabolism preserves only the newest three screenshots', () => {
  const messages: ChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
    role: 'user' as const, content: `observation ${index}`,
    contentParts: [
      { type: 'text' as const, text: '<observation>' },
      { type: 'image_url' as const, image_url: { url: `data:image/png;base64,${index}` } },
      { type: 'text' as const, text: '</observation>' },
    ],
  }));
  trimMotorImages(messages);
  const images = messages.flatMap((message) => message.contentParts ?? []).filter((part) => part.type === 'image_url');
  const evicted = messages.flatMap((message) => message.contentParts ?? []).filter((part) => part.type === 'text' && part.text === '[screenshot evicted]');
  assert.equal(images.length, 3);
  assert.equal(evicted.length, 2);
  assert.equal((images[0] as any).image_url.url.endsWith('2'), true);
});

test('resident motor completes a native click-write-done episode with parsed receipts', async () => {
  const dir = tempDir();
  const modelCalls: Array<{ messages: ChatMessage[]; opts: StandaloneCompleteOptions }> = [];
  const outputs = [
    completion('click', { element: 'search field', x: 500, y: 250 }, { reasoningContent: 'focus it' }),
    completion('write', { text: 'ACME-1042' }),
    completion('done', { summary: 'visible success' }),
  ];
  const notifications: MotorOversightPacket[] = [];
  const { motor, calls, deps } = fixture(dir, async (messages, opts = {}) => {
    modelCalls.push({ messages: structuredClone(messages), opts });
    return outputs.shift()!;
  }, { notifyOversight: (packet) => { notifications.push(packet); } });
  const started = motor.start('search and finish', { episodeId: 'native-flow', settleMs: 0 });
  assert.equal(started.status, 'running');
  const ended = await until(() => motor.status('native-flow'), (value) => value.status === 'completed');
  assert.equal(ended.turns, 3);
  assert.deepEqual(calls.click, [{ x: 640, y: 200, opts: { count: 1 } }]);
  assert.deepEqual(calls.type, ['ACME-1042']);
  assert.equal(modelCalls.length, 3);
  assert.equal(modelCalls[0].opts.toolChoice, 'required');
  assert.equal(modelCalls[0].opts.reasoningEffort, 'medium');
  assert.equal(modelCalls[0].opts.temperature, 0.8);
  assert.equal(modelCalls[0].opts.topK, 20);
  assert.deepEqual(modelCalls[0].opts.chatTemplateKwargs, { enable_thinking: true });
  assert.equal(modelCalls[0].messages[1].contentParts?.[0].type, 'text');
  assert.match((modelCalls[0].messages[1].contentParts?.[0] as any).text, /^<observation>/);
  assert.equal(modelCalls[1].messages.some((message) => message.role === 'tool' && message.tool_call_id), true);
  assert.deepEqual(Object.keys(motor).sort(), ['continue', 'guide', 'interrupt', 'start', 'status']);
  const sameResident = createMotorController(deps) as any;
  assert.equal(sameResident.status('native-flow').status, 'completed');
  const events = fs.readFileSync(ended.traceFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => event.type), ['start', 'action_prepared', 'action_completed', 'turn', 'action_prepared', 'action_completed', 'turn', 'turn', 'completed']);
  for (const prepared of events.filter((event) => event.type === 'action_prepared')) {
    const completed = events.find((event) => event.type === 'action_completed' && event.effectId === prepared.effectId);
    assert.ok(completed, `missing completion for ${prepared.effectId}`);
    assert.ok(events.indexOf(prepared) < events.indexOf(completed));
  }
  assert.equal(events.find((event) => event.type === 'turn')?.reasoning, 'focus it');
  assert.equal(notifications.at(-1)?.status, 'completed');
  assert.equal(notifications.at(-1)?.recent.some((entry) => entry.reasoning === 'focus it'), true);
  assert.equal(notifications.at(-1)?.recent.at(-1)?.tool, 'done');
  const frames = fs.readdirSync(path.dirname(ended.traceFile)).filter((name) => name.endsWith('.png'));
  assert.ok(frames.length > 0);
  for (const frame of frames) assert.equal(fs.statSync(path.join(path.dirname(ended.traceFile), frame)).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor trace custody hardens files, drops orphan frames, and prunes only terminal history', () => {
  const dir = tempDir();
  const episodesDir = path.join(resolveDataLayout(dir).motor, 'episodes');
  fs.mkdirSync(episodesDir, { recursive: true, mode: 0o755 });
  for (let index = 0; index < 101; index++) {
    const id = `retained-${String(index).padStart(3, '0')}`;
    const trace = path.join(episodesDir, `${id}.jsonl`);
    fs.writeFileSync(trace, `${JSON.stringify({ type: 'start' })}\n${JSON.stringify({ type: index === 1 ? 'awaiting_oversight' : 'completed' })}\n`, { mode: 0o644 });
    fs.writeFileSync(path.join(episodesDir, `${id}-0000.png`), Buffer.alloc(24), { mode: 0o664 });
    const at = new Date(1_000 + index * 1_000);
    fs.utimesSync(trace, at, at);
  }
  fs.writeFileSync(path.join(episodesDir, 'orphan-0000.png'), Buffer.alloc(24), { mode: 0o664 });

  fixture(dir, async () => completion('done', { summary: 'unused' }));

  const files = fs.readdirSync(episodesDir);
  assert.equal(files.filter((name) => name.endsWith('.jsonl')).length, 100);
  assert.equal(files.includes('retained-000.jsonl'), false);
  assert.equal(files.includes('retained-001.jsonl'), true, 'nonterminal trace is never pruned');
  assert.equal(files.includes('orphan-0000.png'), false);
  assert.equal(fs.statSync(episodesDir).mode & 0o777, 0o700);
  for (const name of files) assert.equal(fs.statSync(path.join(episodesDir, name)).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('authority validation fails closed before an ungranted action', async () => {
  const dir = tempDir();
  const { motor, calls } = fixture(dir, async () => completion('press', { key: 'ENTER' }));
  motor.start('click only', { episodeId: 'authority-cut', settleMs: 0, authority: { allowedTools: ['click'] } });
  const ended = await until(() => motor.status('authority-cut'), (value) => value.status === 'failed');
  assert.match(ended.lastError, /outside authority/);
  assert.equal(calls.key.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('soft oversight continues, hard oversight pauses, and stale continuation is rejected', async () => {
  const dir = tempDir();
  const notifications: MotorOversightPacket[] = [];
  const outputs = [
    completion('scroll', { direction: 'down', amount: 'small' }),
    completion('scroll', { direction: 'down', amount: 'small' }),
    completion('done', { summary: 'finished after supervision' }),
  ];
  const { motor } = fixture(dir, async () => outputs.shift()!, { notifyOversight: (packet) => { notifications.push(packet); } });
  motor.start('bounded browse', { episodeId: 'oversight', settleMs: 0, softTurnBudget: 1, hardTurnBudget: 2 });
  const paused = await until(() => motor.status('oversight'), (value) => value.status === 'awaiting_oversight');
  assert.equal(paused.turns, 2);
  assert.ok(notifications.some((packet) => packet.turns === 1));
  assert.ok(notifications.some((packet) => packet.status === 'awaiting_oversight'));
  assert.throws(() => motor.continue('oversight', paused.checkpointSeq - 1), /stale checkpoint/);
  motor.continue('oversight', paused.checkpointSeq);
  const ended = await until(() => motor.status('oversight'), (value) => value.status === 'completed');
  assert.equal(ended.turns, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('needs_guidance pauses and matching guidance enters the next observation', async () => {
  const dir = tempDir();
  const seen: ChatMessage[][] = [];
  const outputs = [
    completion('needs_guidance', { reason: 'two plausible buttons' }),
    completion('done', { summary: 'used guidance and succeeded' }),
  ];
  const { motor } = fixture(dir, async (messages) => { seen.push(structuredClone(messages)); return outputs.shift()!; });
  motor.start('choose safely', { episodeId: 'guided', settleMs: 0 });
  const paused = await until(() => motor.status('guided'), (value) => value.status === 'needs_guidance');
  motor.guide('guided', paused.checkpointSeq, 'choose the blue Continue button');
  await until(() => motor.status('guided'), (value) => value.status === 'completed');
  const latestObservation = seen[1].filter((message) => message.role === 'user').at(-1)!;
  assert.match(latestObservation.content, /Supervisor guidance: choose the blue Continue button/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an active episode keeps its origin provider and oversight route across later sandbox globals', async () => {
  const dir = tempDir();
  const firstNotifications: MotorOversightPacket[] = [];
  const secondNotifications: MotorOversightPacket[] = [];
  let release!: (value: StandaloneCompleteResult) => void;
  const pending = new Promise<StandaloneCompleteResult>((resolve) => { release = resolve; });
  const first = fixture(dir, async () => pending, { originChannelId: () => 'origin-channel', notifyOversight: (packet) => { firstNotifications.push(packet); } });
  first.motor.start('stay in origin room', { episodeId: 'origin-bound', settleMs: 0 });
  await until(() => first.motor.status('origin-bound').frame, Boolean);
  fixture(dir, async () => { throw new Error('later provider must not be used'); }, { originChannelId: () => 'later-channel', notifyOversight: (packet) => { secondNotifications.push(packet); } });
  release(completion('done', { summary: 'origin route retained' }));
  await until(() => first.motor.status('origin-bound'), (value) => value.status === 'completed');
  assert.equal(firstNotifications.at(-1)?.status, 'completed');
  assert.equal(firstNotifications.at(-1)?.originChannelId, 'origin-channel');
  assert.equal(secondNotifications.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('interrupt aborts an in-flight provider call without executing an action', async () => {
  const dir = tempDir();
  let entered = false;
  const { motor, calls } = fixture(dir, async (_messages, opts) => {
    entered = true;
    return await new Promise<StandaloneCompleteResult>((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  });
  motor.start('stop safely', { episodeId: 'interrupt', settleMs: 0 });
  await until(() => entered, Boolean);
  const current = motor.status('interrupt');
  motor.interrupt('interrupt', current.checkpointSeq);
  const ended = await until(() => motor.status('interrupt'), (value) => value.status === 'interrupted');
  assert.equal(ended.lastError, null);
  assert.equal(calls.click.length + calls.drag.length + calls.type.length + calls.key.length + calls.scroll.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
