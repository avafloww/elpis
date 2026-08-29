// Explicit live integration test: real LLM loop against the configured endpoint.
// Verifies that a computation prompt triggers a run tool call, the result is fed
// back, and multi-step tasks can chain tool calls without an iteration cap.
//
// Run deliberately with: npm run test:live-llm

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigFile, defaultConfigPath } from '../src/config.js';
import { createLLM } from '../src/llm/llm.js';
import { createMemory, ensureFile } from '../src/store/memory.js';
import { createSandbox } from '../src/sandbox/index.js';
import {
  createContextTracker,
  type ContextTracker,
} from '../src/llm/context-tracker.js';
import { createCompactor } from '../src/llm/compactor.js';
import { createTranscriptStore } from '../src/store/sessions.js';
import { openDatabase, type Database } from '../src/store/db.js';
import { resolveDataLayout } from '../src/store/data-layout.js';
import { Agent, type InboundMessage } from '../src/agent.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const LIVE_LLM = process.env.TEST_LIVE_LLM === '1';
const NO_NETWORK = !!process.env.TEST_NO_NETWORK;
const NO_CONFIG = !fs.existsSync(defaultConfigPath());
const SKIP_LIVE = !LIVE_LLM || NO_NETWORK || NO_CONFIG;
const LIVE_CALL_TIMEOUT_MS = 15_000;
const LIVE_REPLY_TIMEOUT_MS = 25_000;

interface AgentHarness {
  agent: Agent;
  sent: { channelId: string; text: string }[];
  tracker: ContextTracker;
  replyPromise: Promise<string>;
  database: Database;
  tmpDir: string;
}

function buildAgent(): AgentHarness {
  const config = loadConfigFile();
  config.llm.callTimeoutMs = LIVE_CALL_TIMEOUT_MS;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-int-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');
  const soulPath = path.join(tmpDir, 'SOUL.md');
  ensureFile(memoryPath, '# Agent Memory\n');
  ensureFile(soulPath, '# Soul\n');
  const memory = createMemory(memoryPath);
  const sent: { channelId: string; text: string }[] = [];
  const { promise: replyPromise, resolve: resolveReply } =
    Promise.withResolvers<string>();
  const sendHandler = async (channelId: string, text: string) => {
    sent.push({ channelId, text });
    resolveReply(sent.map((send) => send.text).join('\n'));
  };
  let agent: Agent;
  const onIdle = () => {
    if (sent.length === 0) {
      const messages = agent.messagesForTest;
      resolveReply(messages[messages.length - 1]?.content ?? '');
    }
  };
  const sandbox = createSandbox({
    config,
    memory,
    logbuf: [],
    send: sendHandler,
  });
  let database: Database | undefined;
  try {
    database = openDatabase(resolveDataLayout(config.paths.dataDirectory).root);
    const llm = createLLM(config, undefined, database);
    const tracker = createContextTracker(
      100000,
      config.llm.completionReserveTokens,
    );
    const compactor = createCompactor(llm, tracker);
    const transcript = createTranscriptStore(tmpDir);
    agent = new Agent({
      config,
      sandbox: { run: ({ code }) => sandbox.run(code) },
      memory,
      llm,
      tracker,
      compactor,
      transcript,
      send: sendHandler,
      onIdle,
    });
    agent.llmRetryDelays = [];
    return { agent, sent, tracker, replyPromise, database, tmpDir };
  } catch (error) {
    try {
      database?.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    throw error;
  }
}

async function runLiveCase(
  message: Pick<
    InboundMessage,
    'channelId' | 'channelName' | 'author' | 'content'
  >,
): Promise<string> {
  const harness = buildAgent();
  let timer: NodeJS.Timeout | undefined;
  let loop: Promise<void> | undefined;
  try {
    harness.agent.enqueue(message);
    loop = harness.agent.loop();
    return await Promise.race([
      harness.replyPromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('live LLM integration reply timed out')),
          LIVE_REPLY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      harness.agent.stop();
      await loop;
    } finally {
      try {
        harness.database.close();
      } finally {
        fs.rmSync(harness.tmpDir, { recursive: true, force: true });
      }
    }
  }
}

test(
  'integration: computation prompt triggers run tool call and references result',
  { skip: SKIP_LIVE },
  async () => {
    const reply = await runLiveCase({
      channelId: 'test',
      channelName: 'test',
      author: 'tester',
      content:
        'What is 17 * 23? Use your sandbox to compute it exactly, then tell me the answer.',
    });
    assert.ok(reply.length > 0, 'agent should have sent a reply');
    assert.match(reply, /391/);
  },
);

test(
  'integration: multi-step task chains run calls without iteration cap',
  { skip: SKIP_LIVE },
  async () => {
    const reply = await runLiveCase({
      channelId: 'test2',
      channelName: 'test2',
      author: 'tester',
      content:
        'In your sandbox: define a function `fib(n)` that returns the nth Fibonacci number, ' +
        'then compute fib(10) and tell me the result.',
    });
    assert.ok(reply.length > 0, 'agent should have sent a reply');
    assert.match(reply, /55/);
  },
);
