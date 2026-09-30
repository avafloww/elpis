import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  RUN_TOOL,
  toApiMessage,
  type ChatMessage,
  type CompleteResult,
  type LLM,
} from '../src/llm/llm.js';
import {
  createResidentRunAuthority,
  type ResidentRunIssuer,
} from '../src/kernel/resident-run-provenance.js';
import {
  createTranscriptStore,
  loadMostRecentMain,
  type TranscriptStore,
} from '../src/store/sessions.js';
import type { Agent } from '../src/agent.js';
import { buildTestAgent, EMPTY_WAKE } from './helpers.js';

function runCall(): CompleteResult {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'run-1',
          type: 'function',
          function: {
            name: 'run',
            arguments: JSON.stringify({ code: '', detail: 'test' }),
          },
        },
      ],
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function scriptedLLM(responses: CompleteResult[]): LLM {
  let index = 0;
  return {
    model: 'test',
    runTool: RUN_TOOL,
    async complete() {
      return responses[Math.min(index++, responses.length - 1)];
    },
    async summarize() {
      return 'SUMMARY';
    },
  };
}

function inbound(): Parameters<Agent['enqueue']>[0] {
  return {
    id: 'message-1',
    channelId: '100',
    channelName: 'general',
    author: 'Bramble',
    authorId: 'user-1',
    content: 'run the check',
    createdAt: '2026-01-01T00:00:00Z',
    replyTo: null,
    forwarded: null,
    mentions: [],
    attachments: [],
    kind: 'discord',
  };
}

function recordingIssuer(
  base: ResidentRunIssuer,
  events: string[],
): ResidentRunIssuer {
  return {
    prepare(calls) {
      events.push('prepare');
      return base.prepare(calls);
    },
    commit(prepared) {
      events.push('commit');
      base.commit(prepared);
    },
    issue(prepared, callIndex) {
      events.push(`issue-${callIndex}`);
      return base.issue(prepared, callIndex);
    },
  };
}

function recordingTranscript(
  base: TranscriptStore,
  events: string[],
  failAssistant = false,
): TranscriptStore {
  return {
    append(channelId, message) {
      if (message.role === 'assistant' && message.residentToolBatch) {
        events.push('append-assistant');
        if (failAssistant) throw new Error('assistant append failed');
      }
      base.append(channelId, message);
    },
    rotate: (channelId, sentinel) => base.rotate(channelId, sentinel),
    flush: (channelId) => base.flush(channelId),
    adopt: (channelId, filePath) => base.adopt(channelId, filePath),
  };
}

test('Agent persists a forensic batch before committing and executing tools', async () => {
  const events: string[] = [];
  const authority = createResidentRunAuthority();
  const ranTwice = Promise.withResolvers<void>();
  let runCount = 0;
  let transcriptRoot = '';
  const built = buildTestAgent({
    llm: scriptedLLM([runCall(), EMPTY_WAKE]),
    agentDeps: (ctx) => {
      transcriptRoot = path.join(ctx.tmpDir, 'recorded-sessions');
      return {
        residentRunIssuer: recordingIssuer(authority.issuer, events),
        transcript: recordingTranscript(
          createTranscriptStore(transcriptRoot),
          events,
        ),
        sandbox: {
          async run(request) {
            events.push('sandbox');
            assert.ok(request.residentRunToken);
            const handle = authority.verifier.accept(request.residentRunToken);
            assert.equal(
              authority.verifier.resolveActive(handle).toolName,
              'run',
            );
            authority.verifier.close(handle);
            runCount += 1;
            if (runCount === 2) ranTwice.resolve();
            return { ok: true, preview: 'ok' };
          },
        },
      };
    },
  });
  try {
    void built.agent.loop();
    built.agent.enqueue(inbound());
    await ranTwice.promise;
    await new Promise((resolve) => setImmediate(resolve));
    built.agent.stop();

    const prepare = events.indexOf('prepare');
    const append = events.indexOf('append-assistant');
    const commit = events.indexOf('commit');
    const issue = events.indexOf('issue-0');
    const sandbox = events.indexOf('sandbox');
    assert.ok(prepare >= 0 && prepare < append);
    assert.ok(append < commit);
    assert.ok(commit < issue);
    assert.ok(issue < sandbox);

    const loaded = loadMostRecentMain(transcriptRoot);
    const assistant = loaded?.messages.find(
      (message) => message.role === 'assistant' && message.tool_calls?.length,
    );
    assert.ok(assistant?.residentToolBatch);
    const wire = toApiMessage(assistant!);
    assert.ok(!Object.hasOwn(wire, 'residentToolBatch'));
  } finally {
    built.agent.stop();
    built.cleanup();
  }
});

test('Agent rejects an oversized provenance batch without crashing or executing it', async () => {
  const authority = createResidentRunAuthority();
  const oversized: CompleteResult = {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: Array.from({ length: 65 }, (_, index) => ({
        id: `oversized-${index}`,
        type: 'function' as const,
        function: {
          name: 'run',
          arguments: JSON.stringify({
            code: `oversized-${index}`,
            detail: 'test',
          }),
        },
      })),
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const wakeRan = Promise.withResolvers<void>();
  const sandboxCode: string[] = [];
  let loopError: unknown = null;
  const built = buildTestAgent({
    llm: scriptedLLM([oversized, EMPTY_WAKE]),
    agentDeps: {
      residentRunIssuer: authority.issuer,
      sandbox: {
        async run(request) {
          sandboxCode.push(request.code);
          wakeRan.resolve();
          return { ok: true, preview: 'ok' };
        },
      },
    },
  });
  try {
    void built.agent.loop().catch((error) => {
      loopError = error;
    });
    built.agent.enqueue(inbound());
    await wakeRan.promise;
    await new Promise((resolve) => setImmediate(resolve));
    built.agent.stop();

    assert.equal(loopError, null);
    assert.deepEqual(sandboxCode, ['']);
    const oversizedAssistant = built.agent.messagesForTest.find(
      (message) =>
        message.role === 'assistant' &&
        message.tool_calls?.[0]?.id === 'oversized-0',
    );
    assert.equal(oversizedAssistant?.residentToolBatch, undefined);
    const rejected = built.agent.messagesForTest.filter(
      (message) =>
        message.role === 'tool' &&
        message.tool_call_id?.startsWith('oversized-'),
    );
    assert.equal(rejected.length, 65);
    assert.ok(
      rejected.every((message) =>
        message.content.includes('No tool calls in this batch were executed'),
      ),
    );
  } finally {
    built.agent.stop();
    built.cleanup();
  }
});

test('Agent issues tokens only for parsed run ordinals in a committed batch', async () => {
  const authority = createResidentRunAuthority();
  const events: string[] = [];
  const snapshots: Array<{
    callIndex: number;
    toolName: string;
    argumentsSha256: string;
  }> = [];
  const ranThree = Promise.withResolvers<void>();
  const multi: CompleteResult = {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'think-0',
          type: 'function',
          function: {
            name: 'think',
            arguments: JSON.stringify({ thoughts: 'check' }),
          },
        },
        {
          id: 'run-1',
          type: 'function',
          function: {
            name: 'run',
            arguments: JSON.stringify({ code: '1', detail: 'first run' }),
          },
        },
        {
          id: 'unknown-2',
          type: 'function',
          function: { name: 'unknown', arguments: '{}' },
        },
        {
          id: 'run-3',
          type: 'function',
          function: {
            name: 'run',
            arguments: JSON.stringify({ code: '3', detail: 'second run' }),
          },
        },
        {
          id: 'run-invalid-4',
          type: 'function',
          function: {
            name: 'run',
            arguments: JSON.stringify({ detail: 'invalid run' }),
          },
        },
      ],
    },
    stripped: false,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const built = buildTestAgent({
    llm: scriptedLLM([multi, EMPTY_WAKE]),
    agentDeps: {
      residentRunIssuer: recordingIssuer(authority.issuer, events),
      sandbox: {
        async run(request) {
          events.push('sandbox');
          assert.ok(request.residentRunToken);
          const handle = authority.verifier.accept(request.residentRunToken);
          const snapshot = authority.verifier.resolveActive(handle);
          snapshots.push({
            callIndex: snapshot.callIndex,
            toolName: snapshot.toolName,
            argumentsSha256: snapshot.argumentsSha256,
          });
          authority.verifier.close(handle);
          if (snapshots.length === 3) ranThree.resolve();
          return { ok: true, preview: 'ok' };
        },
      },
    },
  });
  try {
    void built.agent.loop();
    built.agent.enqueue(inbound());
    await ranThree.promise;
    await new Promise((resolve) => setImmediate(resolve));
    built.agent.stop();

    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.callIndex),
      [1, 3, 0],
    );
    assert.deepEqual(
      snapshots.slice(0, 2).map((snapshot) => snapshot.toolName),
      ['run', 'run'],
    );
    assert.equal(
      snapshots[0]?.argumentsSha256,
      createHash('sha256')
        .update(multi.message.tool_calls?.[1]?.function.arguments ?? '', 'utf8')
        .digest('hex'),
    );
    assert.equal(
      snapshots[1]?.argumentsSha256,
      createHash('sha256')
        .update(multi.message.tool_calls?.[3]?.function.arguments ?? '', 'utf8')
        .digest('hex'),
    );
    assert.equal(events.filter((event) => event === 'issue-4').length, 0);
    const firstCommit = events.indexOf('commit');
    assert.ok(firstCommit >= 0 && firstCommit < events.indexOf('issue-1'));
    assert.ok(events.indexOf('issue-1') < events.indexOf('sandbox'));
  } finally {
    built.agent.stop();
    built.cleanup();
  }
});

test('Agent does not commit or execute a batch when assistant append fails', async () => {
  const events: string[] = [];
  const authority = createResidentRunAuthority();
  let sandboxRuns = 0;
  const built = buildTestAgent({
    llm: scriptedLLM([runCall()]),
    agentDeps: (ctx) => ({
      residentRunIssuer: recordingIssuer(authority.issuer, events),
      transcript: recordingTranscript(
        createTranscriptStore(path.join(ctx.tmpDir, 'failed-sessions')),
        events,
        true,
      ),
      sandbox: {
        async run() {
          sandboxRuns += 1;
          return { ok: true, preview: 'unexpected' };
        },
      },
    }),
  });
  try {
    const loop = built.agent.loop();
    built.agent.enqueue(inbound());
    await assert.rejects(loop, /assistant append failed/);
    assert.deepEqual(events, ['prepare', 'append-assistant']);
    assert.equal(sandboxRuns, 0);
  } finally {
    built.agent.stop();
    built.cleanup();
  }
});
