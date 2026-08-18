// Watch-mode ephemeral frames (elpis.watch pipeline).
//
// - a 'watch' channelName message with image attachments arrives as one
// multimodal user message (contentParts) for exactly ONE generation;
// - after the successful generation the parts strip from live history;
// - the transcript never carries the image parts (text-only line).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLM, CompleteResult } from '../src/llm/llm.js';
import { buildTestAgent, EMPTY_WAKE } from './helpers.js';

/** Returns the shared empty-run one-shot wake every call. It has to be a
 * real terminating run call: since a bare no-tool-call reply is
 * nudged instead of ending the turn, so the old `{ content: 'nice frames' }`
 * stub generated forever and the second generation clobbered `lastMessages`
 * after the ephemeral parts had already been stripped. */
function oneShotLLM(): LLM & { calls: number; lastMessages: unknown[] } {
  let calls = 0;
  const holder = { calls: 0, lastMessages: [] as unknown[] };
  return Object.assign(holder, {
    client: {} as unknown as LLM['client'], model: 'test', runTool: {} as unknown as LLM['runTool'],
    complete(messages: unknown[]): Promise<CompleteResult> {
      holder.calls++;
      holder.lastMessages = messages.map((m) => JSON.parse(JSON.stringify(m)));
      return Promise.resolve(EMPTY_WAKE as unknown as CompleteResult);
    },
    summarize(): Promise<string> { return Promise.resolve('SUMMARY'); },
  }) as LLM & { calls: number; lastMessages: unknown[] };
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

test('watch message: parts reach one generation, then strip from history and transcript', async () => {
  const llm = oneShotLLM();
  const { agent, tmpDir } = buildTestAgent({
    llm,
    config: { heartbeat: { intervalMs: 60_000, maxIntervalMs: 4 * 60 * 60 * 1000, reflectionMinMessages: 99, socialNudgeMs: 12 * 60 * 60 * 1000 } },
    tmpPrefix: 'harness-watch-',
  });

 // a tiny real image file on disk
  const imgPath = path.join(tmpDir, 'frame.png');
  fs.writeFileSync(imgPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

  void agent.loop();
  agent.enqueue({
 // kind 'watch' is what marks the frame ephemeral in the drain now
 // (channelName is display only).
    id: 'watch-1', channelId: 'internal', channelName: 'watch', kind: 'watch', author: 'harness', authorId: 'harness',
    content: '[watch] demo frames 1/1', createdAt: new Date().toISOString(),
    replyTo: null, forwarded: null, mentions: [],
    attachments: [{ url: '', name: 'frame.png', contentType: 'image/png', localPath: imgPath, size: fs.statSync(imgPath).size }],
  });

 // let the loop drain + generate
  for (let i = 0; i < 200 && llm.calls === 0; i++) await sleep(20);
  for (let i = 0; i < 50; i++) await sleep(20);
  agent.stop();

  assert.equal(llm.calls, 1, 'exactly one generation');
  const sent = llm.lastMessages as { contentParts?: unknown[]; content: string }[];
  const watchMsg = sent.find((m) => typeof m.content === 'string' && m.content.includes('[watch]'));
  assert.ok(watchMsg, 'watch message reached the LLM');
  assert.ok(watchMsg.contentParts && watchMsg.contentParts.length > 1, 'image parts present for the generation');

 // live history: stripped after the generation
  const history = agent.messagesForTest as { contentParts?: unknown[]; ephemeral?: boolean; content: string }[];
  const histWatch = history.find((m) => m.content.includes('[watch]'));
  assert.ok(histWatch, 'watch message in history');
  assert.equal(histWatch.contentParts, undefined, 'parts stripped from live history');
  assert.equal(histWatch.ephemeral, undefined, 'ephemeral flag cleared');

 // transcript: text-only
  const sessionsDir = path.join(tmpDir, 'sessions', 'discord', 'main');
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length > 0, 'transcript exists');
  const lines = fs.readFileSync(path.join(sessionsDir, files[0]!), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const txWatch = lines.find((l: { content?: string }) => l.content?.includes('[watch]'));
  assert.ok(txWatch, 'watch line in transcript');
  assert.equal(txWatch.contentParts, undefined, 'transcript never holds the image parts');
  assert.equal(txWatch.ephemeral, undefined, 'no ephemeral flag in transcript');
});
