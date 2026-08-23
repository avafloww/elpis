import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RUN_TOOL } from '../src/llm/llm.js';
import { TOOL_CONTRACT_VERSION } from '../src/llm/provenance.js';

test('run v4 schema requires concise detail with code, exact sandbox alias, and one-shot wake without end', () => {
  const parameters = RUN_TOOL.function.parameters;
  assert.deepEqual(Object.keys(parameters.properties), [
    'code',
    'detail',
    'sandbox',
    'wake',
  ]);
  assert.equal(Object.hasOwn(parameters.properties, 'end'), false);
  assert.deepEqual(parameters.required, ['code', 'detail']);
  assert.equal(parameters.properties.detail.maxLength, 120);
  assert.equal(parameters.additionalProperties, false);
  assert.deepEqual(parameters.properties.wake.oneOf, [
    { required: ['after'] },
    { required: ['at'] },
    { required: ['auto'] },
  ]);
  assert.deepEqual(parameters.properties.wake.properties.auto.enum, [true]);
  assert.equal(parameters.properties.wake.additionalProperties, false);
  assert.equal(TOOL_CONTRACT_VERSION, 'elpis-run-v4');
});

import type {
  CompleteOptions,
  CompleteResult,
  LLM,
  ChatMessage,
} from '../src/llm/llm.js';
import type { Agent } from '../src/agent.js';
import type { RunResult } from '../src/types.js';
import { buildTestAgent } from './helpers.js';
import {
  parseRunWakePayload,
  RUN_WAKE_TASK_PREFIX,
} from '../src/sandbox/wake.js';

function runResponse(
  args: Record<string, unknown>,
  id = 'run-1',
): CompleteResult {
  const v4Args = { detail: 'Exercise the run contract', ...args };
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id,
          type: 'function',
          function: { name: 'run', arguments: JSON.stringify(v4Args) },
        },
      ],
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  };
}

function scripted(responses: CompleteResult[]): LLM & { calls: number } {
  let index = 0;
  let calls = 0;
  return {
    client: {} as LLM['client'],
    model: 'test',
    runTool: {} as LLM['runTool'],
    get calls() {
      return calls;
    },
    async complete(
      _messages: ChatMessage[],
      _options?: CompleteOptions,
    ): Promise<CompleteResult> {
      calls++;
      const response = responses[Math.min(index++, responses.length - 1)];
      await new Promise<void>((resolve) => setImmediate(resolve));
      return response;
    },
    summarize: async () => 'SUMMARY',
  } as LLM & { calls: number };
}

function inbound(
  id = 'm1',
  wakeClass: 'wake' | 'ambient' = 'wake',
): Parameters<Agent['enqueue']>[0] {
  return {
    id,
    channelId: '100',
    channelName: '100',
    author: 'u',
    authorId: 'u',
    content: 'go',
    createdAt: new Date().toISOString(),
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    kind: 'discord',
    wakeClass,
  };
}

async function settle(ms = 100): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function success(code: string): RunResult {
  return {
    ok: true,
    preview: code,
    execution: {
      kind: 'persistent',
      lifecycle: 'ready',
      alias: 'quietly-crimson-ibis',
      mindId: 7,
      executorId: 'exec-1',
      generation: 2,
      runId: 'exec-1-g2-r3',
    },
  };
}

test('run v4 rejects invalid wake before execution and forwards exact sandbox aliases', async () => {
  const llm = scripted([
    runResponse({ code: 'missing', detail: undefined }, 'missing-detail'),
    runResponse({ code: 'never', wake: { after: '0s' } }, 'bad-wake'),
    runResponse(
      {
        code: 'second',
        sandbox: 'quietly-crimson-ibis',
        wake: { after: '1h' },
      },
      'good',
    ),
  ]);
  const requests: unknown[] = [];
  const h = buildTestAgent({
    llm,
    tmpPrefix: 'run-v4-validate-',
    agentDeps: {
      sandbox: {
        run: async (request) => {
          requests.push(request);
          return success(request.code);
        },
      },
    },
  });
  void h.agent.loop();
  h.agent.enqueue(inbound());
  await settle();
  h.agent.stop();
  assert.deepEqual(requests, [
    { code: 'second', sandbox: 'quietly-crimson-ibis' },
  ]);
  const tools = h.agent.messagesForTest.filter(
    (message) => message.role === 'tool',
  );
  assert.match(String(tools[0]?.content), /run\.detail must be a string/);
  assert.equal(tools[0]?.run?.detail, undefined);
  assert.match(String(tools[1]?.content), /greater than zero/);
  assert.equal(tools[2]?.run?.detail, 'Exercise the run contract');
  assert.equal(tools[2]?.run?.execution?.alias, 'quietly-crimson-ibis');
  assert.equal(tools[2]?.run?.wake?.state, 'armed');
  assert.match(String(tools[2]?.content), /detail="Exercise the run contract"/);
  assert.ok(tools[2]?.run?.wake?.taskId);
  const task = h.scheduler
    .list()
    .find((candidate) => candidate.id === tools[2]?.run?.wake?.taskId);
  assert.ok(task && task.doneAt == null);
  assert.equal(parseRunWakePayload(task.payload)?.state, 'armed');
  h.cleanup();
});

test('failed and detached runs reject wake and continue until completed code arms one', async () => {
  const llm = scripted([
    runResponse({ code: 'fail', wake: { after: '1h' } }, 'fail'),
    runResponse({ code: 'detach', wake: { after: '1h' } }, 'detach'),
    runResponse({ code: 'done', wake: { after: '1h' } }, 'done'),
  ]);
  const h = buildTestAgent({
    llm,
    tmpPrefix: 'run-v4-reject-',
    agentDeps: {
      sandbox: {
        run: async ({ code }) => {
          if (code === 'fail')
            return { ok: false, error: 'boom', failureKind: 'runtime' };
          if (code === 'detach')
            return {
              ok: true,
              detached: true,
              bgId: 'bg-1',
              preview: 'detached',
            };
          return success(code);
        },
      },
    },
  });
  void h.agent.loop();
  h.agent.enqueue(inbound());
  await settle(150);
  h.agent.stop();
  const tools = h.agent.messagesForTest.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(llm.calls, 3);
  assert.deepEqual(
    tools.map((message) => message.run?.wake?.state),
    ['rejected', 'rejected', 'armed'],
  );
  assert.match(tools[0]?.run?.wake?.note ?? '', /did not succeed/);
  assert.match(tools[1]?.run?.wake?.note ?? '', /detached/);
  assert.equal(tools[1]?.run?.detached, true);
  h.cleanup();
});

test('absolute target elapsed during execution returns success without yielding', async () => {
  const at = new Date(Date.now() + 200).toISOString();
  const llm = scripted([
    runResponse({ code: 'slow', wake: { at } }, 'slow'),
    runResponse({ code: 'done', wake: { after: '1h' } }, 'done'),
  ]);
  const h = buildTestAgent({
    llm,
    tmpPrefix: 'run-v4-elapsed-',
    agentDeps: {
      sandbox: {
        run: async ({ code }) => {
          if (code === 'slow')
            await new Promise((resolve) => setTimeout(resolve, 260));
          return success(code);
        },
      },
    },
  });
  void h.agent.loop();
  h.agent.enqueue(inbound());
  await settle(400);
  h.agent.stop();
  const tools = h.agent.messagesForTest.filter(
    (message) => message.role === 'tool',
  );
  assert.equal(llm.calls, 2);
  assert.equal(tools[0]?.run?.wake?.state, 'elapsed');
  assert.match(String(tools[0]?.content), /choose a new wake/);
  assert.equal(tools[1]?.run?.wake?.state, 'armed');
  h.cleanup();
});

test('external wakes preempt an armed run wake while ambient traffic does not', async () => {
  const llm = scripted([runResponse({ code: 'done', wake: { after: '1h' } })]);
  const h = buildTestAgent({
    llm,
    tmpPrefix: 'run-v4-preempt-',
    agentDeps: { sandbox: { run: async ({ code }) => success(code) } },
  });
  void h.agent.loop();
  h.agent.enqueue(inbound());
  await settle();
  const task = h.scheduler
    .list()
    .find(
      (candidate) =>
        candidate.name.startsWith(RUN_WAKE_TASK_PREFIX) &&
        candidate.doneAt == null,
    );
  assert.ok(task);
  h.agent.enqueue(inbound('ambient', 'ambient'));
  assert.equal(
    h.scheduler.list().find((candidate) => candidate.id === task.id)?.doneAt,
    null,
  );
  h.agent.enqueue(inbound('external'));
  const preempted = h.scheduler
    .list()
    .find((candidate) => candidate.id === task.id);
  assert.ok(preempted?.doneAt);
  assert.equal(parseRunWakePayload(preempted!.payload)?.state, 'preempted');
  h.agent.stop();
  h.cleanup();
});

test('a due durable run wake fires through Scheduler and starts a new outer turn', async () => {
  const llm = scripted([
    runResponse({ code: 'first', wake: { after: '40ms' } }, 'first'),
    runResponse({ code: 'second', wake: { after: '1h' } }, 'second'),
  ]);
  const h = buildTestAgent({
    llm,
    tmpPrefix: 'run-v4-fire-',
    agentDeps: { sandbox: { run: async ({ code }) => success(code) } },
  });
  try {
    void h.agent.loop();
    h.scheduler.start();
    h.agent.enqueue(inbound());
    await settle(180);
    assert.equal(llm.calls, 2);
    const first = h.scheduler
      .list()
      .find(
        (task) =>
          task.name.startsWith(RUN_WAKE_TASK_PREFIX) &&
          parseRunWakePayload(task.payload)?.requestedAt ===
            h.agent.messagesForTest.find(
              (message) => message.tool_call_id === 'first',
            )?.run?.wake?.requestedAt,
      );
    assert.ok(first?.doneAt);
    assert.equal(parseRunWakePayload(first!.payload)?.state, 'fired');
    assert.ok(
      h.agent.messagesForTest.some(
        (message) =>
          message.role === 'user' &&
          /\[wake @ \d{4}-\d{2}-\d{2}T\d{2}:\d{2}[+-]\d{2}:\d{2}\]/.test(
            String(message.content),
          ),
      ),
    );
  } finally {
    h.agent.stop();
    h.scheduler.stop();
    h.cleanup();
  }
});

test('restart recovery adopts the armed wake and external input preempts it durably', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-v4-recover-'));
  const firstLlm = scripted([
    runResponse({ code: 'first', wake: { after: '1h' } }),
  ]);
  const first = buildTestAgent({
    dir,
    llm: firstLlm,
    agentDeps: { sandbox: { run: async ({ code }) => success(code) } },
  });
  void first.agent.loop();
  first.agent.enqueue(inbound());
  await settle();
  const armed = first.scheduler
    .list()
    .find(
      (task) =>
        task.name.startsWith(RUN_WAKE_TASK_PREFIX) && task.doneAt == null,
    );
  assert.ok(armed);
  first.agent.stop();
  first.scheduler.stop();
  first.db.close();

  const second = buildTestAgent({
    dir,
    llm: scripted([runResponse({ code: 'second', wake: { after: '1h' } })]),
    agentDeps: { sandbox: { run: async ({ code }) => success(code) } },
  });
  try {
    second.agent.enqueue(inbound('after-restart'));
    const recovered = second.scheduler.getById(armed!.id);
    assert.ok(recovered?.doneAt);
    assert.equal(parseRunWakePayload(recovered!.payload)?.state, 'preempted');
  } finally {
    second.agent.stop();
    second.scheduler.stop();
    second.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('auto wake consults the bounded advisor and persists its visible provenance', async () => {
  const llm = scripted([
    runResponse({ code: 'done', wake: { auto: true } }, 'auto'),
  ]);
  let turn: unknown;
  const h = buildTestAgent({
    llm,
    tmpPrefix: 'run-v4-auto-',
    agentDeps: {
      sandbox: {
        run: async ({ code }) => success(code),
        adviseWake: async (value) => {
          turn = value;
          return {
            delayMs: 120_000,
            reason: 'active-work',
            source: 'classifier' as const,
          };
        },
      },
    },
  });
  void h.agent.loop();
  h.agent.enqueue(inbound());
  await settle();
  h.agent.stop();
  const tool = h.agent.messagesForTest.find(
    (message) => message.tool_call_id === 'auto',
  );
  assert.deepEqual(turn, {
    turnKind: 'person',
    sendsThisTurn: 0,
    ranCode: true,
    continuedMindId: 7,
  });
  assert.equal(tool?.run?.wake?.kind, 'auto');
  assert.deepEqual(tool?.run?.wake?.advice, {
    delayMs: 120_000,
    reason: 'active-work',
    source: 'classifier',
  });
  assert.match(String(tool?.content), /advice=classifier:2m:active-work/);
  const task = h.scheduler
    .list()
    .find((candidate) => candidate.id === tool?.run?.wake?.taskId);
  assert.deepEqual(task && parseRunWakePayload(task.payload)?.advice, {
    delayMs: 120_000,
    reason: 'active-work',
    source: 'classifier',
  });
  h.cleanup();
});

test('zero-delay auto advice arms and fires an immediate continuation turn', async () => {
  const llm = scripted([
    runResponse({ code: 'continue', wake: { auto: true } }, 'auto-zero'),
    {
      message: { role: 'assistant', content: 'continued immediately' },
      stripped: false,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]);
  const h = buildTestAgent({
    llm,
    tmpPrefix: 'run-v4-auto-zero-',
    agentDeps: {
      sandbox: {
        run: async ({ code }) => success(code),
        adviseWake: async () => ({
          delayMs: 0,
          reason: 'active-work',
          source: 'classifier' as const,
        }),
      },
    },
  });
  void h.agent.loop();
  h.scheduler.start();
  h.agent.enqueue(inbound());
  await settle(200);
  h.agent.stop();
  h.scheduler.stop();
  const tool = h.agent.messagesForTest.find(
    (message) => message.tool_call_id === 'auto-zero',
  );
  assert.equal(tool?.run?.wake?.advice?.delayMs, 0);
  assert.equal(tool?.run?.wake?.state, 'fired');
  assert.ok(llm.calls >= 2, 'immediate wake starts the next model turn');
  const task = h.scheduler
    .list()
    .find((candidate) => candidate.id === tool?.run?.wake?.taskId);
  assert.equal(task && parseRunWakePayload(task.payload)?.state, 'fired');
  assert.ok(task?.doneAt);
  h.cleanup();
});
