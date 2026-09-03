import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createMotorController,
  resetResidentMotorForTest,
  parseMotorToolCall,
  trimMotorImages,
  writeMotorTraceRecord,
  type MotorControllerDeps,
  type MotorOversightPacket,
} from '../src/sandbox/motor.js';
import type {
  ChatMessage,
  StandaloneCompleteOptions,
  StandaloneCompleteResult,
} from '../src/llm/llm.js';
import { resolveDataLayout } from '../src/store/data-layout.js';
import { MotorSkills } from '../src/motor-skills.js';

const usage = { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 };

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-resident-motor-test-'));
}

function writeMotorSkill(
  dataDirectory: string,
  name: string,
  body: string,
): string {
  const file = path.join(
    resolveDataLayout(dataDirectory).motorSkills,
    name,
    'SKILL.md',
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---\nname: ${name}\ndescription: ${name} motor technique\n---\n\n${body}\n`,
  );
  return file;
}

function fakePng(file: string, width = 1280, height = 800): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header, 0);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  fs.writeFileSync(file, header);
}

function completion(
  name: string,
  args: Record<string, unknown>,
  extra: Partial<StandaloneCompleteResult> = {},
): StandaloneCompleteResult {
  return {
    content: '',
    usage,
    toolCalls: [
      {
        id: `call-${name}-${Math.random()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
    model: 'holo-test',
    providerType: 'openai-compatible',
    apiSurface: 'chat-completions',
    apiEndpoint: 'http://local/v1/chat/completions',
    ...extra,
  };
}

async function until(
  read: () => any,
  predicate: (value: any) => boolean,
  timeoutMs = 2_000,
): Promise<any> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition not reached; last=${JSON.stringify(read())}`);
}

function fixture(
  dir: string,
  completeStandalone: MotorControllerDeps['completeStandalone'],
  overrides: Partial<MotorControllerDeps> = {},
) {
  const calls = {
    click: [] as any[],
    drag: [] as any[],
    type: [] as any[],
    key: [] as any[],
    scroll: [] as any[],
  };
  const deps: MotorControllerDeps = {
    dataDirectory: dir,
    completeStandalone,
    screenshot: async (file) => {
      fakePng(file);
      return { file };
    },
    click: async (x, y, opts) => {
      calls.click.push({ x, y, opts });
      return { ok: true };
    },
    drag: async (fromX, fromY, toX, toY) => {
      calls.drag.push({ fromX, fromY, toX, toY });
      return { ok: true };
    },
    type: async (text) => {
      calls.type.push(text);
      return { ok: true };
    },
    key: async (keys) => {
      calls.key.push(keys);
      return { ok: true };
    },
    scroll: async (clicks) => {
      calls.scroll.push(clicks);
      return { ok: true };
    },
    sleep: async () => {},
    ...overrides,
  };
  return { motor: createMotorController(deps) as any, calls, deps };
}

test('motor trace writes loop until every byte is persisted', () => {
  const chunks: Buffer[] = [];
  const payload = Buffer.from('a deliberately larger trace record');
  writeMotorTraceRecord(7, payload, (_fd, buffer, offset, length) => {
    const written = Math.min(3, length);
    chunks.push(Buffer.from(buffer.subarray(offset, offset + written)));
    return written;
  });
  assert.equal(Buffer.concat(chunks).toString(), payload.toString());
  assert.throws(
    () => writeMotorTraceRecord(7, payload, () => 0),
    /made invalid progress/,
  );
});

test('native motor tool parser requires exactly one closed function call', () => {
  assert.deepEqual(
    parseMotorToolCall([
      {
        id: 'c',
        type: 'function',
        function: { name: 'click', arguments: '{"x":1}' },
      },
    ]),
    {
      call: {
        id: 'c',
        type: 'function',
        function: { name: 'click', arguments: '{"x":1}' },
      },
      args: { x: 1 },
    },
  );
  assert.throws(() => parseMotorToolCall(undefined), /exactly one/);
  assert.throws(
    () =>
      parseMotorToolCall([
        {
          id: 'a',
          type: 'function',
          function: { name: 'click', arguments: '{}' },
        },
        {
          id: 'b',
          type: 'function',
          function: { name: 'write', arguments: '{}' },
        },
      ]),
    /exactly one/,
  );
  assert.throws(
    () =>
      parseMotorToolCall([
        {
          id: 'c',
          type: 'function',
          function: { name: 'click', arguments: '{' },
        },
      ]),
    /invalid JSON/,
  );
});

test('motor image metabolism preserves only the newest three screenshots', () => {
  const messages: ChatMessage[] = Array.from({ length: 5 }, (_, index) => ({
    role: 'user' as const,
    content: `observation ${index}`,
    contentParts: [
      { type: 'text' as const, text: '<observation>' },
      {
        type: 'image_url' as const,
        image_url: { url: `data:image/png;base64,${index}` },
      },
      { type: 'text' as const, text: '</observation>' },
    ],
  }));
  trimMotorImages(messages);
  const images = messages
    .flatMap((message) => message.contentParts ?? [])
    .filter((part) => part.type === 'image_url');
  const evicted = messages
    .flatMap((message) => message.contentParts ?? [])
    .filter(
      (part) => part.type === 'text' && part.text === '[screenshot evicted]',
    );
  assert.equal(images.length, 3);
  assert.equal(evicted.length, 2);
  assert.equal((images[0] as any).image_url.url.endsWith('2'), true);
});

test('resident motor completes a native click-write-done episode with parsed receipts', async () => {
  const dir = tempDir();
  const modelCalls: Array<{
    messages: ChatMessage[];
    opts: StandaloneCompleteOptions;
  }> = [];
  const outputs = [
    completion(
      'click',
      { element: 'search field', x: 500, y: 250 },
      { reasoningContent: 'focus it' },
    ),
    completion('write', { text: 'ACME-1042' }),
    completion('done', { summary: 'visible success' }),
  ];
  const notifications: MotorOversightPacket[] = [];
  const { motor, calls, deps } = fixture(
    dir,
    async (messages, opts = {}) => {
      modelCalls.push({ messages: structuredClone(messages), opts });
      return outputs.shift()!;
    },
    {
      notifyOversight: (packet) => {
        notifications.push(packet);
      },
    },
  );
  const started = motor.start('search and finish', {
    episodeId: 'native-flow',
    settleMs: 0,
  });
  assert.equal(started.status, 'running');
  const ended = await until(
    () => motor.status('native-flow'),
    (value) => value.status === 'completed',
  );
  assert.equal(ended.turns, 3);
  assert.deepEqual(calls.click, [{ x: 640, y: 200, opts: { count: 1 } }]);
  assert.deepEqual(calls.type, ['ACME-1042']);
  assert.equal(modelCalls.length, 3);
  assert.equal(modelCalls[0].opts.toolChoice, 'required');
  assert.equal(modelCalls[0].opts.reasoningEffort, 'medium');
  assert.equal(modelCalls[0].opts.temperature, 0.8);
  assert.equal(modelCalls[0].opts.topK, 20);
  assert.deepEqual(modelCalls[0].opts.chatTemplateKwargs, {
    enable_thinking: true,
  });
  assert.equal(modelCalls[0].messages[1].contentParts?.[0].type, 'text');
  assert.match(
    (modelCalls[0].messages[1].contentParts?.[0] as any).text,
    /^<observation>/,
  );
  assert.equal(
    modelCalls[1].messages.some(
      (message) => message.role === 'tool' && message.tool_call_id,
    ),
    true,
  );
  assert.deepEqual(Object.keys(motor).sort(), [
    'continue',
    'guide',
    'inspectSkill',
    'interrupt',
    'start',
    'status',
  ]);
  const sameResident = createMotorController(deps) as any;
  assert.equal(sameResident.status('native-flow').status, 'completed');
  const events = fs
    .readFileSync(ended.traceFile, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'start',
      'action_prepared',
      'action_completed',
      'turn',
      'action_prepared',
      'action_completed',
      'turn',
      'turn',
      'completed',
    ],
  );
  for (const prepared of events.filter(
    (event) => event.type === 'action_prepared',
  )) {
    const completed = events.find(
      (event) =>
        event.type === 'action_completed' &&
        event.effectId === prepared.effectId,
    );
    assert.ok(completed, `missing completion for ${prepared.effectId}`);
    assert.ok(events.indexOf(prepared) < events.indexOf(completed));
  }
  assert.equal(
    events.find((event) => event.type === 'turn')?.reasoning,
    'focus it',
  );
  assert.equal(notifications.at(-1)?.status, 'completed');
  assert.equal(
    notifications
      .at(-1)
      ?.recent.some((entry) => entry.reasoning === 'focus it'),
    true,
  );
  assert.equal(notifications.at(-1)?.recent.at(-1)?.tool, 'done');
  const frames = fs
    .readdirSync(path.dirname(ended.traceFile))
    .filter((name) => name.endsWith('.png'));
  assert.ok(frames.length > 0);
  for (const frame of frames)
    assert.equal(
      fs.statSync(path.join(path.dirname(ended.traceFile), frame)).mode & 0o777,
      0o600,
    );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor trace custody hardens files, drops orphan frames, and prunes only terminal history', () => {
  const dir = tempDir();
  const episodesDir = path.join(resolveDataLayout(dir).motor, 'episodes');
  fs.mkdirSync(episodesDir, { recursive: true, mode: 0o755 });
  for (let index = 0; index < 101; index++) {
    const id = `retained-${String(index).padStart(3, '0')}`;
    const trace = path.join(episodesDir, `${id}.jsonl`);
    fs.writeFileSync(
      trace,
      `${JSON.stringify({ type: 'start' })}\n${JSON.stringify({ type: index === 1 ? 'awaiting_oversight' : 'completed' })}\n`,
      { mode: 0o644 },
    );
    fs.writeFileSync(
      path.join(episodesDir, `${id}-0000.png`),
      Buffer.alloc(24),
      { mode: 0o664 },
    );
    const at = new Date(1_000 + index * 1_000);
    fs.utimesSync(trace, at, at);
  }
  fs.writeFileSync(
    path.join(episodesDir, 'orphan-0000.png'),
    Buffer.alloc(24),
    { mode: 0o664 },
  );

  fixture(dir, async () => completion('done', { summary: 'unused' }));

  const files = fs.readdirSync(episodesDir);
  assert.equal(files.filter((name) => name.endsWith('.jsonl')).length, 100);
  assert.equal(files.includes('retained-000.jsonl'), false);
  assert.equal(
    files.includes('retained-001.jsonl'),
    true,
    'nonterminal trace is never pruned',
  );
  assert.equal(files.includes('orphan-0000.png'), false);
  assert.equal(fs.statSync(episodesDir).mode & 0o777, 0o700);
  for (const name of files)
    assert.equal(fs.statSync(path.join(episodesDir, name)).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('authority validation fails closed before an ungranted action', async () => {
  const dir = tempDir();
  const { motor, calls } = fixture(dir, async () =>
    completion('press', { key: 'ENTER' }),
  );
  motor.start('click only', {
    episodeId: 'authority-cut',
    settleMs: 0,
    authority: { allowedTools: ['click'] },
  });
  const ended = await until(
    () => motor.status('authority-cut'),
    (value) => value.status === 'failed',
  );
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
  const { motor } = fixture(dir, async () => outputs.shift()!, {
    notifyOversight: (packet) => {
      notifications.push(packet);
    },
  });
  motor.start('bounded browse', {
    episodeId: 'oversight',
    settleMs: 0,
    softTurnBudget: 1,
    hardTurnBudget: 2,
  });
  const paused = await until(
    () => motor.status('oversight'),
    (value) => value.status === 'awaiting_oversight',
  );
  assert.equal(paused.turns, 2);
  assert.ok(notifications.some((packet) => packet.turns === 1));
  assert.ok(
    notifications.some((packet) => packet.status === 'awaiting_oversight'),
  );
  assert.throws(
    () => motor.continue('oversight', paused.checkpointSeq - 1),
    /stale checkpoint/,
  );
  motor.continue('oversight', paused.checkpointSeq);
  const ended = await until(
    () => motor.status('oversight'),
    (value) => value.status === 'completed',
  );
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
  const { motor } = fixture(dir, async (messages) => {
    seen.push(structuredClone(messages));
    return outputs.shift()!;
  });
  motor.start('choose safely', { episodeId: 'guided', settleMs: 0 });
  const paused = await until(
    () => motor.status('guided'),
    (value) => value.status === 'needs_guidance',
  );
  motor.guide(
    'guided',
    paused.checkpointSeq,
    'choose the blue Continue button',
  );
  await until(
    () => motor.status('guided'),
    (value) => value.status === 'completed',
  );
  const latestObservation = seen[1]
    .filter((message) => message.role === 'user')
    .at(-1)!;
  assert.match(
    latestObservation.content,
    /Supervisor guidance: choose the blue Continue button/,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an active episode keeps its origin provider and oversight route across later sandbox globals', async () => {
  const dir = tempDir();
  const firstNotifications: MotorOversightPacket[] = [];
  const secondNotifications: MotorOversightPacket[] = [];
  let release!: (value: StandaloneCompleteResult) => void;
  const pending = new Promise<StandaloneCompleteResult>((resolve) => {
    release = resolve;
  });
  const first = fixture(dir, async () => pending, {
    originChannelId: () => 'origin-channel',
    notifyOversight: (packet) => {
      firstNotifications.push(packet);
    },
  });
  first.motor.start('stay in origin room', {
    episodeId: 'origin-bound',
    settleMs: 0,
  });
  await until(() => first.motor.status('origin-bound').frame, Boolean);
  fixture(
    dir,
    async () => {
      throw new Error('later provider must not be used');
    },
    {
      originChannelId: () => 'later-channel',
      notifyOversight: (packet) => {
        secondNotifications.push(packet);
      },
    },
  );
  release(completion('done', { summary: 'origin route retained' }));
  await until(
    () => first.motor.status('origin-bound'),
    (value) => value.status === 'completed',
  );
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
      opts?.signal?.addEventListener(
        'abort',
        () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        { once: true },
      );
    });
  });
  motor.start('stop safely', { episodeId: 'interrupt', settleMs: 0 });
  await until(() => entered, Boolean);
  const current = motor.status('interrupt');
  motor.interrupt('interrupt', current.checkpointSeq);
  const ended = await until(
    () => motor.status('interrupt'),
    (value) => value.status === 'interrupted',
  );
  assert.equal(ended.lastError, null);
  assert.equal(
    calls.click.length +
      calls.drag.length +
      calls.type.length +
      calls.key.length +
      calls.scroll.length,
    0,
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resident selects, reads resources, traces, and exactly restores motor packages', async () => {
  const dir = tempDir();
  const file = writeMotorSkill(dir, 'pixel-game', 'ORIGINAL MOTOR BODY');
  const rootPath = path.dirname(file);
  const resourceFile = path.join(rootPath, 'TROUBLESHOOTING.md');
  fs.writeFileSync(resourceFile, 'ORIGINAL RESOURCE BODY\n');
  const firstCatalog = new MotorSkills({
    dataDirectory: dir,
    bundledSkillsDirectory: null,
  });
  const firstSeen: Array<{
    messages: ChatMessage[];
    opts: StandaloneCompleteOptions;
  }> = [];
  const outputs = [
    completion('read_skill_resource', {
      path: 'skill:pixel-game/TROUBLESHOOTING.md',
    }),
    completion('needs_guidance', { reason: 'pause for restart' }),
  ];
  const first = fixture(
    dir,
    async (messages, opts = {}) => {
      firstSeen.push({ messages: structuredClone(messages), opts });
      return outputs.shift()!;
    },
    { motorSkills: firstCatalog },
  );
  const inspected = first.motor.inspectSkill('pixel-game');
  assert.equal(inspected.name, 'pixel-game');
  assert.equal(inspected.path, file);
  assert.equal(inspected.rootPath, rootPath);
  assert.equal(inspected.source, 'data');
  assert.equal(inspected.body, fs.readFileSync(file, 'utf8'));
  assert.deepEqual(inspected.resources, [
    {
      handle: 'skill:pixel-game/TROUBLESHOOTING.md',
      relativePath: 'TROUBLESHOOTING.md',
      path: resourceFile,
      sha256: createHash('sha256')
        .update('ORIGINAL RESOURCE BODY\n')
        .digest('hex'),
      bytes: 23,
    },
  ]);

  const started = first.motor.start('take one safe step', {
    episodeId: 'motor-skilled',
    skills: ['pixel-game'],
    settleMs: 0,
  });
  assert.deepEqual(started.skills, ['pixel-game']);
  const paused = await until(
    () => first.motor.status('motor-skilled'),
    (value) => value.status === 'needs_guidance',
  );
  const resourceReceipt = JSON.stringify({
    ok: true,
    path: 'skill:pixel-game/TROUBLESHOOTING.md',
    sha256: createHash('sha256')
      .update('ORIGINAL RESOURCE BODY\n')
      .digest('hex'),
    body: 'ORIGINAL RESOURCE BODY\n',
  });
  const resourceReceiptBytes = Buffer.byteLength(resourceReceipt);
  assert.equal(paused.counters.skillResourceReads, 1);
  assert.equal(paused.counters.skillResourceBytes, resourceReceiptBytes);
  const prompt = firstSeen[0].messages[0].content;
  assert.match(prompt, /ORIGINAL MOTOR BODY/);
  assert.match(prompt, /This SKILL\.md body is already loaded/);
  assert.doesNotMatch(prompt, /skill:pixel-game\/TROUBLESHOOTING\.md/);
  assert.doesNotMatch(prompt, /ORIGINAL RESOURCE BODY/);
  assert.ok(
    prompt.indexOf('ORIGINAL MOTOR BODY') <
      prompt.indexOf('Scoped goal: take one safe step'),
  );
  assert.doesNotMatch(
    prompt,
    new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.equal(
    firstSeen[0].opts.tools?.some(
      (tool) =>
        tool.type === 'function' &&
        tool.function.name === 'read_skill_resource',
    ),
    true,
  );
  assert.match(
    firstSeen[1].messages.find((message) => message.role === 'tool')?.content ??
      '',
    /ORIGINAL RESOURCE BODY/,
  );

  const traceFile = path.join(
    resolveDataLayout(dir).motor,
    'episodes',
    'motor-skilled.jsonl',
  );
  const trace = fs.readFileSync(traceFile, 'utf8').trim().split('\n');
  const traceStart = JSON.parse(trace[0]);
  assert.equal(traceStart.motorSkills[0].body, fs.readFileSync(file, 'utf8'));
  assert.equal(
    traceStart.motorSkills[0].resources[0].body,
    'ORIGINAL RESOURCE BODY\n',
  );

  fs.writeFileSync(
    file,
    '---\nname: pixel-game\ndescription: pixel-game motor technique\n---\n\nMUTATED BODY\n',
  );
  fs.writeFileSync(resourceFile, 'MUTATED RESOURCE\n');
  resetResidentMotorForTest(dir);
  const restoredSeen: ChatMessage[][] = [];
  const second = fixture(
    dir,
    async (messages) => {
      restoredSeen.push(structuredClone(messages));
      return completion('done', { summary: 'restored exact skill' });
    },
    {
      motorSkills: new MotorSkills({
        dataDirectory: dir,
        bundledSkillsDirectory: null,
      }),
    },
  );
  const restored = second.motor.status('motor-skilled');
  assert.deepEqual(restored.skills, ['pixel-game']);
  assert.equal(restored.counters.skillResourceReads, 1);
  assert.equal(restored.counters.skillResourceBytes, resourceReceiptBytes);
  second.motor.continue('motor-skilled', restored.checkpointSeq);
  await until(
    () => second.motor.status('motor-skilled'),
    (value) => value.status === 'completed',
  );
  assert.match(restoredSeen[0][0].content, /ORIGINAL MOTOR BODY/);
  assert.doesNotMatch(restoredSeen[0][0].content, /MUTATED BODY/);
  assert.match(
    restoredSeen[0].find((message) => message.role === 'tool')?.content ?? '',
    /ORIGINAL RESOURCE BODY/,
  );
  assert.doesNotMatch(
    restoredSeen[0].find((message) => message.role === 'tool')?.content ?? '',
    /MUTATED RESOURCE/,
  );
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor resource reads cannot cross the resident-selected package boundary', async () => {
  const dir = tempDir();
  const selectedFile = writeMotorSkill(dir, 'selected', 'SELECTED BODY');
  const hiddenFile = writeMotorSkill(dir, 'hidden', 'HIDDEN BODY');
  fs.writeFileSync(
    path.join(path.dirname(selectedFile), 'REFERENCE.md'),
    'selected reference',
  );
  fs.writeFileSync(
    path.join(path.dirname(hiddenFile), 'SECRET.md'),
    'hidden reference',
  );
  const calls = fixture(
    dir,
    async () =>
      completion('read_skill_resource', {
        path: 'skill:hidden/SECRET.md',
      }),
    {
      motorSkills: new MotorSkills({
        dataDirectory: dir,
        bundledSkillsDirectory: null,
      }),
    },
  );
  calls.motor.start('use only the selected package', {
    episodeId: 'resource-boundary',
    skills: ['selected'],
    settleMs: 0,
  });
  const ended = await until(
    () => calls.motor.status('resource-boundary'),
    (value) => value.status === 'failed',
  );
  assert.match(ended.lastError ?? '', /outside selected packages/);
  assert.equal(ended.counters.skillResourceReads, 0);
  assert.equal(ended.counters.skillResourceBytes, 0);
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor resource reads stop at the independent observation budget', async () => {
  const dir = tempDir();
  const file = writeMotorSkill(
    dir,
    'bounded',
    'Read the cited reference only when needed.',
  );
  fs.writeFileSync(path.join(path.dirname(file), 'REFERENCE.md'), 'small body');
  const motor = fixture(
    dir,
    async () =>
      completion('read_skill_resource', {
        path: 'skill:bounded/REFERENCE.md',
      }),
    {
      motorSkills: new MotorSkills({
        dataDirectory: dir,
        bundledSkillsDirectory: null,
      }),
    },
  ).motor;
  motor.start('exercise the bounded reference reader', {
    episodeId: 'resource-budget',
    skills: ['bounded'],
    settleMs: 0,
    softTurnBudget: 10,
    hardTurnBudget: 12,
  });
  const ended = await until(
    () => motor.status('resource-budget'),
    (value) => value.status === 'failed',
  );
  assert.match(ended.lastError ?? '', /resource-read budget exhausted/);
  const receiptBytes = Buffer.byteLength(
    JSON.stringify({
      ok: true,
      path: 'skill:bounded/REFERENCE.md',
      sha256: createHash('sha256').update('small body').digest('hex'),
      body: 'small body',
    }),
  );
  assert.equal(ended.counters.skillResourceReads, 8);
  assert.equal(ended.counters.skillResourceBytes, receiptBytes * 8);
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('motor resource byte budget charges the serialized tool receipt', async () => {
  const dir = tempDir();
  const file = writeMotorSkill(
    dir,
    'escaped',
    'Read the cited resource only when needed.',
  );
  fs.writeFileSync(
    path.join(path.dirname(file), 'CONTROL.txt'),
    '\0'.repeat(6_000),
  );
  const motor = fixture(
    dir,
    async () =>
      completion('read_skill_resource', {
        path: 'skill:escaped/CONTROL.txt',
      }),
    {
      motorSkills: new MotorSkills({
        dataDirectory: dir,
        bundledSkillsDirectory: null,
      }),
    },
  ).motor;
  motor.start('keep context bounded', {
    episodeId: 'escaped-budget',
    skills: ['escaped'],
    settleMs: 0,
  });
  const ended = await until(
    () => motor.status('escaped-budget'),
    (value) => value.status === 'failed',
  );
  assert.match(ended.lastError ?? '', /resource-byte budget exhausted/);
  assert.equal(ended.counters.skillResourceReads, 0);
  assert.equal(ended.counters.skillResourceBytes, 0);
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cold restart restores paused history and resumes only after matching oversight', async () => {
  const dir = tempDir();
  const outputs = [
    completion('scroll', { direction: 'down', amount: 'small' }),
    completion('scroll', { direction: 'down', amount: 'small' }),
    completion('done', { summary: 'finished after restart' }),
  ];
  const first = fixture(dir, async () => outputs.shift()!, {
    originChannelId: () => 'origin-room',
  });
  first.motor.start('resume safely', {
    episodeId: 'restart-paused',
    settleMs: 0,
    softTurnBudget: 1,
    hardTurnBudget: 2,
  });
  const paused = await until(
    () => first.motor.status('restart-paused'),
    (value) => value.status === 'awaiting_oversight',
  );
  assert.equal(paused.counters.scrolls, 2);
  fs.appendFileSync(paused.traceFile, '{\"type\":');

  resetResidentMotorForTest(dir);
  const seen: ChatMessage[][] = [];
  const notifications: MotorOversightPacket[] = [];
  const second = fixture(
    dir,
    async (messages) => {
      seen.push(structuredClone(messages));
      return outputs.shift()!;
    },
    {
      notifyOversight: (packet) => {
        notifications.push(packet);
      },
    },
  );
  const restored = second.motor.status('restart-paused');
  assert.equal(restored.status, 'awaiting_oversight');
  assert.equal(restored.turns, 2);
  assert.equal(restored.counters.scrolls, 2);
  assert.equal(restored.recent.length, 2);
  second.motor.continue('restart-paused', restored.checkpointSeq);
  const ended = await until(
    () => second.motor.status('restart-paused'),
    (value) => value.status === 'completed',
  );
  assert.equal(ended.turns, 3);
  assert.equal(seen[0].filter((message) => message.role === 'tool').length, 2);
  assert.equal(notifications.at(-1)?.originChannelId, 'origin-room');
  resetResidentMotorForTest(dir);
  const terminal = fixture(dir, async () => {
    throw new Error('terminal recovery must not call model');
  }).motor.status('restart-paused');
  assert.equal(terminal.status, 'completed');
  assert.equal(terminal.turns, 3);
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cold restart restores supervisor guidance inside prior observations', async () => {
  const dir = tempDir();
  const outputs = [
    completion('needs_guidance', { reason: 'ambiguous control' }),
    completion('needs_guidance', { reason: 'pause after guided look' }),
  ];
  const first = fixture(dir, async () => outputs.shift()!);
  first.motor.start('preserve guided history', {
    episodeId: 'restart-guidance',
    settleMs: 0,
  });
  const initialPause = await until(
    () => first.motor.status('restart-guidance'),
    (value) => value.status === 'needs_guidance',
  );
  first.motor.guide(
    'restart-guidance',
    initialPause.checkpointSeq,
    'use the lower neutral control',
  );
  await until(
    () => first.motor.status('restart-guidance'),
    (value) => value.status === 'needs_guidance' && value.turns === 2,
  );

  resetResidentMotorForTest(dir);
  const seen: ChatMessage[][] = [];
  const second = fixture(dir, async (messages) => {
    seen.push(structuredClone(messages));
    return completion('done', { summary: 'guidance survived restart' });
  });
  const restored = second.motor.status('restart-guidance');
  second.motor.continue('restart-guidance', restored.checkpointSeq);
  await until(
    () => second.motor.status('restart-guidance'),
    (value) => value.status === 'completed',
  );
  assert.equal(
    seen[0].some(
      (message) =>
        message.role === 'user' &&
        message.content.includes(
          'Supervisor guidance: use the lower neutral control',
        ),
    ),
    true,
  );
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cold restart rejects malformed interior trace records', async () => {
  const dir = tempDir();
  const first = fixture(dir, async () =>
    completion('needs_guidance', { reason: 'pause before corruption' }),
  );
  first.motor.start('reject interior corruption', {
    episodeId: 'restart-corrupt',
    settleMs: 0,
  });
  const paused = await until(
    () => first.motor.status('restart-corrupt'),
    (value) => value.status === 'needs_guidance',
  );
  const raw = fs.readFileSync(paused.traceFile, 'utf8');
  const boundary = raw.indexOf('\n') + 1;
  fs.writeFileSync(
    paused.traceFile,
    `${raw.slice(0, boundary)}{malformed interior}\n${raw.slice(boundary)}`,
  );
  resetResidentMotorForTest(dir);
  const second = fixture(dir, async () => {
    throw new Error('corrupt trace must not resume');
  });
  assert.throws(
    () => second.motor.status('restart-corrupt'),
    /unknown episode/,
  );
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cold restart interrupts running or unmatched-effect traces without retrying', () => {
  const dir = tempDir();
  const episodesDir = path.join(resolveDataLayout(dir).motor, 'episodes');
  fs.mkdirSync(episodesDir, { recursive: true });
  const trace = path.join(episodesDir, 'restart-ambiguous.jsonl');
  const start = {
    type: 'start',
    at: new Date(1_000).toISOString(),
    episodeId: 'restart-ambiguous',
    goal: 'do not duplicate',
    authority: {
      allowedTools: ['click'],
      maxPointerActions: 1,
      maxWrites: 0,
      maxTextChars: 0,
      maxKeyPresses: 0,
      maxScrolls: 0,
    },
    options: {
      dryRun: false,
      maxTurns: 4,
      softTurnBudget: 2,
      hardTurnBudget: 4,
      maxWallMs: 60_000,
      settleMs: 0,
      completionTimeoutMs: 1_000,
    },
    originChannelId: 'origin-room',
  };
  const prepared = {
    type: 'action_prepared',
    at: new Date(2_000).toISOString(),
    effectId: 'restart-ambiguous:0',
    checkpointSeq: 0,
    call: {
      id: 'c',
      type: 'function',
      function: { name: 'click', arguments: '{"element":"safe","x":1,"y":1}' },
    },
  };
  fs.writeFileSync(
    trace,
    `${JSON.stringify(start)}\n${JSON.stringify(prepared)}\n`,
    { mode: 0o600 },
  );
  let called = false;
  const restored = fixture(dir, async () => {
    called = true;
    return completion('click', { element: 'unsafe retry', x: 1, y: 1 });
  }).motor;
  const status = restored.status('restart-ambiguous');
  assert.equal(status.status, 'interrupted');
  assert.match(status.lastError, /ambiguous prepared effect/);
  assert.equal(called, false);
  const events = fs
    .readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(events.at(-1).type, 'interrupted');
  assert.equal(events.at(-1).reason, 'restart_recovery');
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('interrupt during an actuator settles that effect but records no turn or next action', async () => {
  const dir = tempDir();
  let entered = false;
  let release!: () => void;
  const actuator = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { motor } = fixture(
    dir,
    async () =>
      completion('click', { element: 'bounded target', x: 500, y: 500 }),
    {
      click: async () => {
        entered = true;
        await actuator;
        return { ok: true };
      },
    },
  );
  motor.start('interrupt actuator', {
    episodeId: 'interrupt-actuator',
    settleMs: 0,
    authority: { allowedTools: ['click'], maxPointerActions: 1 },
  });
  await until(() => entered, Boolean);
  const current = motor.status('interrupt-actuator');
  motor.interrupt('interrupt-actuator', current.checkpointSeq);
  release();
  const ended = motor.status('interrupt-actuator');
  assert.equal(ended.status, 'interrupted');
  assert.equal(ended.turns, 0);
  const events = await until(
    () =>
      fs
        .readFileSync(ended.traceFile, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse),
    (value) => value.some((event: any) => event.type === 'action_completed'),
  );
  assert.deepEqual(
    events.map((event: any) => event.type),
    ['start', 'action_prepared', 'interrupted', 'action_completed'],
  );
  resetResidentMotorForTest(dir);
  fs.rmSync(dir, { recursive: true, force: true });
});
