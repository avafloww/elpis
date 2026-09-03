import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  RUN_TOOL,
  type ChatMessage,
  type CompleteOptions,
  type CompleteResult,
  type LLM,
} from '../src/llm/llm.js';
import type { Agent } from '../src/agent.js';
import { ContextResources } from '../src/context-resources.js';
import { buildTestAgent, EMPTY_WAKE } from './helpers.js';

function scriptedLLM(responses: CompleteResult[]): LLM & {
  requests: ChatMessage[][];
  options: CompleteOptions[];
} {
  let index = 0;
  const requests: ChatMessage[][] = [];
  const options: CompleteOptions[] = [];
  return {
    model: 'test',
    runTool: RUN_TOOL,
    requests,
    options,
    async complete(messages, completeOptions = {}) {
      requests.push(messages.map((message) => structuredClone(message)));
      options.push(completeOptions);
      const response = responses[Math.min(index++, responses.length - 1)];
      await new Promise((resolve) => setImmediate(resolve));
      return response;
    },
    async summarize() {
      return 'SUMMARY';
    },
  };
}

function toolCalls(
  calls: Array<{ id: string; name: string; arguments: unknown }>,
): CompleteResult {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function userMessage(): Parameters<Agent['enqueue']>[0] {
  return {
    id: 'm1',
    channelId: '100',
    channelName: '100',
    author: 'u',
    authorId: 'u',
    content: 'use the workflow',
    createdAt: '2026-01-01T00:00:00Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    kind: 'discord',
  };
}

async function settle(ms = 120): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function skillFixture(): { dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-agent-skill-'));
  const file = path.join(dir, '.agents', 'skills', 'alpha', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    '---\nname: alpha\ndescription: Alpha workflow\n---\n\nALPHA_BODY_SENTINEL\n',
  );
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('skill result enters the next model request before later run calls', async () => {
  const f = skillFixture();
  const llm = scriptedLLM([
    toolCalls([
      { id: 'skill-1', name: 'skill', arguments: { names: ['alpha'] } },
    ]),
    EMPTY_WAKE,
  ]);
  const built = buildTestAgent({ dir: f.dir, llm });
  try {
    void built.agent.loop();
    built.agent.enqueue(userMessage());
    await settle();
    built.agent.stop();

    assert.equal(llm.options[0].skillTool?.function.name, 'skill');
    assert.ok(llm.requests.length >= 2);
    const loaded = llm.requests[1].find(
      (message) =>
        message.role === 'tool' && message.tool_call_id === 'skill-1',
    );
    assert.match(loaded?.content ?? '', /ALPHA_BODY_SENTINEL/);
    assert.deepEqual(
      loaded?.contextResources?.map(({ kind, key }) => ({ kind, key })),
      [{ kind: 'skill', key: 'alpha' }],
    );
    assert.deepEqual(built.contextResources.snapshot().skills, ['alpha']);
  } finally {
    built.agent.stop();
    built.cleanup();
    f.cleanup();
  }
});

test('restart restores only resource descriptors whose files still match', () => {
  const f = skillFixture();
  const sourceResources = new ContextResources({
    dataDirectory: f.dir,
    harnessRoot: f.dir,
    homeDirectory: null,
  });
  const loaded = sourceResources.loadSkillContext(['alpha']);
  const initialMessages: ChatMessage[] = [
    {
      role: 'tool',
      tool_call_id: 'skill-1',
      content: loaded.content,
      contextResources: loaded.resources,
    },
  ];
  const first = buildTestAgent({
    dir: f.dir,
    agentDeps: { initialMessages },
  });
  try {
    assert.deepEqual(first.contextResources.snapshot().skills, ['alpha']);
  } finally {
    first.cleanup();
  }

  const skillFile = path.join(f.dir, '.agents', 'skills', 'alpha', 'SKILL.md');
  fs.appendFileSync(skillFile, '\nchanged after transcript\n');
  const changed = buildTestAgent({
    dir: f.dir,
    agentDeps: { initialMessages },
  });
  try {
    assert.deepEqual(changed.contextResources.snapshot().skills, []);
  } finally {
    changed.cleanup();
    f.cleanup();
  }
});

test('mixed skill and run batch returns balanced failures without effects', async () => {
  const f = skillFixture();
  const llm = scriptedLLM([
    toolCalls([
      { id: 'skill-1', name: 'skill', arguments: { names: ['alpha'] } },
      {
        id: 'run-1',
        name: 'run',
        arguments: {
          code: "elpis.channel('console').send('MIXED_BATCH_EFFECT')",
          detail: 'Attempt forbidden mixed effect',
        },
      },
    ]),
    EMPTY_WAKE,
  ]);
  const built = buildTestAgent({ dir: f.dir, llm });
  try {
    void built.agent.loop();
    built.agent.enqueue(userMessage());
    await settle();
    built.agent.stop();

    assert.equal(
      built.sent.some(({ text }) => text.includes('MIXED_BATCH_EFFECT')),
      false,
    );
    assert.deepEqual(built.contextResources.snapshot().skills, []);
    const failures = llm.requests[1].filter(
      (message) =>
        message.role === 'tool' &&
        (message.tool_call_id === 'skill-1' ||
          message.tool_call_id === 'run-1'),
    );
    assert.equal(failures.length, 2);
    for (const failure of failures) {
      assert.match(
        failure.content,
        /No tool calls in this batch were executed/,
      );
    }
  } finally {
    built.agent.stop();
    built.cleanup();
    f.cleanup();
  }
});
