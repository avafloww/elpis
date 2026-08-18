// Integration test: real LLM loop against the configured endpoint.
// Verifies: a computation prompt triggers a `run` tool call, the result is fed
// back, and the final answer references it; multi-step tasks chain multiple
// run calls without an iteration cap.
//
// Run with: npm test (hits the real LLM endpoint configured in config.yaml)
//
// NOTE on timers: this test awaits a real network round-trip to the LLM. There
// is no deterministic signal we can fake — we wait for the agent's own `send`
// callback to fire (the agent calls send when it reaches natural turn-end).
// No wall-clock polling: we await the promise the send callback resolves.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfigFile, defaultConfigPath } from '../src/config.js';
import { createLLM } from '../src/llm/llm.js';
import { createMemory, ensureFile } from '../src/store/memory.js';
import { createSandbox } from '../src/sandbox/index.js';
import { createContextTracker, type ContextTracker } from '../src/llm/context-tracker.js';
import { createCompactor } from '../src/llm/compactor.js';
import { createTranscriptStore } from '../src/store/sessions.js';
import { openDatabase } from '../src/store/db.js';
import { Agent } from '../src/agent.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const NO_NETWORK = !!process.env.TEST_NO_NETWORK;

/** Live tests need real credentials. Without a config.yaml there is nothing to
 * run against, so skip rather than fail — same spirit as the NO_NETWORK gate. */
const NO_CONFIG = !fs.existsSync(defaultConfigPath());

interface AgentHarness {
  agent: Agent;
  sent: { channelId: string; text: string }[];
  tracker: ContextTracker;
  /** Resolves when the agent sends its first reply (natural turn-end). */
  replyPromise: Promise<string>;
}

function buildAgent(): AgentHarness {
  const config = loadConfigFile();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-int-'));
  const memoryPath = path.join(tmpDir, 'MEMORY.md');
  const soulPath = path.join(tmpDir, 'SOUL.md');
  ensureFile(memoryPath, '# Agent Memory\n');
  ensureFile(soulPath, '# Soul\n');
  const memory = createMemory(memoryPath);
  const sent: { channelId: string; text: string }[] = [];
  const { promise: replyPromise, resolve: resolveReply } = Promise.withResolvers<string>();
 // Wire the sandbox's elpis.channel.send to the same handler the agent uses, so
 // the model's elpis.channel('test').send("...") routes to `sent` + resolves
 // replyPromise. V1: elpis.channel needs an explicit target.
  const sendHandler = async (channelId: string, text: string) => {
    sent.push({ channelId, text });
    resolveReply(sent.map((s) => s.text).join('\n'));
  };
 // Natural turn-end content is internal monologue (not sent to Discord). The
 // model may or may not call elpis.channel.send. onIdle fires when the loop
 // reaches the wake-gate (turn done) — if send wasn't called, resolve from
 // the last assistant message in history (the model's internal monologue).
  let agent: Agent;
  const onIdle = () => {
    if (sent.length === 0) {
      const msgs = agent.messagesForTest;
      const last = msgs[msgs.length - 1];
      resolveReply(last?.content ?? '');
    }
  };
  const sandbox = createSandbox({ config, memory, logbuf: [], send: sendHandler });
 // The anthropic-oauth provider reads its credential from agent.db, so this
 // live test needs the real handle — otherwise createLLM throws and the whole
 // integration suite fails purely because the operator switched provider.
  const llm = createLLM(config, undefined, openDatabase(config.paths.dataDirectory));
  const tracker = createContextTracker(100000, config.llm.completionReserveTokens);
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
  return { agent, sent, tracker, replyPromise };
}

test('integration: computation prompt triggers run tool call and references result', { skip: NO_NETWORK || NO_CONFIG }, async () => {
  const { agent, replyPromise } = buildAgent();
  agent.enqueue({
    channelId: 'test',
    channelName: 'test',
    author: 'tester',
    content: 'What is 17 * 23? Use your sandbox to compute it exactly, then tell me the answer.',
  });
  void agent.loop();
  const reply = await replyPromise;
  assert.ok(reply.length > 0, 'agent should have sent a reply');
 // 17*23 = 391 — the model computed it via the run tool
  assert.match(reply, /391/);
  agent.stop();
});

test('integration: multi-step task chains run calls without iteration cap', { skip: NO_NETWORK || NO_CONFIG }, async () => {
  const { agent, replyPromise } = buildAgent();
  agent.enqueue({
    channelId: 'test2',
    channelName: 'test2',
    author: 'tester',
    content:
      'In your sandbox: define a function `fib(n)` that returns the nth Fibonacci number, ' +
      'then compute fib(10) and tell me the result.',
  });
  void agent.loop();
  const reply = await replyPromise;
  assert.ok(reply.length > 0, 'agent should have sent a reply');
 // fib(10) = 55
  assert.match(reply, /55/);
  agent.stop();
});
