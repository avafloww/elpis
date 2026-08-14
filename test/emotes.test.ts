// emotes.test.ts — the custom emote/sticker registry (src/discord/emotes.ts):
// markup parsing, CDN url building, keyframe index picking, and the registry's
// first-use-per-context-window semantics (seen-set, reset, disk-cache reuse,
// failure-is-retryable, per-message cap). The animated path runs real ffmpeg
// against a generated GIF and is skipped when ffmpeg is not installed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  parseCustomEmotes,
  stickerFormatOf,
  emoteCdnUrl,
  isAnimated,
  refKey,
  safeNameSlug,
  attachmentName,
  pickKeyframeIndices,
  ffmpegExtractArgs,
  createEmoteRegistry,
  type EmoteOrStickerRef,
} from '../src/discord/emotes.js';
import { noopLogger } from '../src/lib/log.js';
import { buildTestAgent, makeConfig, EMPTY_END } from './helpers.js';
import { createContextTracker } from '../src/llm/context-tracker.js';
import type { Agent } from '../src/agent.js';
import type { LLM } from '../src/llm/llm.js';

const HAS_FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('parseCustomEmotes: static, animated, dedup, order', () => {
  const refs = parseCustomEmotes(
    'hey <:blobheart:111111> and <a:partyparrot:222222> again <:blobheart:111111>',
  );
  assert.deepEqual(refs, [
    { kind: 'emote', id: '111111', name: 'blobheart', animated: false },
    { kind: 'emote', id: '222222', name: 'partyparrot', animated: true },
  ]);
});

test('parseCustomEmotes: ignores mentions, timestamps, urls, malformed markup', () => {
  assert.deepEqual(parseCustomEmotes('<@123456> <#654321> <@&111222>'), []);
  assert.deepEqual(parseCustomEmotes('<t:1753343555:R> and <t:1753343555>'), []);
  assert.deepEqual(parseCustomEmotes('<https://example.com/a:b:123456>'), []);
  assert.deepEqual(parseCustomEmotes('<ab:cd:123456> <::123456> <:name:abc>'), []);
});

test('stickerFormatOf maps the discord.js enum and rejects unknowns', () => {
  assert.equal(stickerFormatOf(1), 'png');
  assert.equal(stickerFormatOf(2), 'apng');
  assert.equal(stickerFormatOf(3), 'lottie');
  assert.equal(stickerFormatOf(4), 'gif');
  assert.equal(stickerFormatOf(5), null);
  assert.equal(stickerFormatOf(0), null);
});

test('emoteCdnUrl: emote png/gif, sticker hosts per format', () => {
  const e = (animated: boolean): EmoteOrStickerRef => ({ kind: 'emote', id: '99', name: 'x_y', animated });
  assert.match(emoteCdnUrl(e(false)), /^https:\/\/cdn\.discordapp\.com\/emojis\/99\.png\?/);
  assert.match(emoteCdnUrl(e(true)), /^https:\/\/cdn\.discordapp\.com\/emojis\/99\.gif\?/);
  assert.equal(emoteCdnUrl({ kind: 'sticker', id: '7', name: 's', format: 'gif' }), 'https://media.discordapp.net/stickers/7.gif');
  assert.equal(emoteCdnUrl({ kind: 'sticker', id: '7', name: 's', format: 'lottie' }), 'https://cdn.discordapp.com/stickers/7.json');
  assert.equal(emoteCdnUrl({ kind: 'sticker', id: '7', name: 's', format: 'apng' }), 'https://cdn.discordapp.com/stickers/7.png');
  assert.equal(emoteCdnUrl({ kind: 'sticker', id: '7', name: 's', format: 'png' }), 'https://cdn.discordapp.com/stickers/7.png');
});

test('isAnimated / refKey', () => {
  assert.equal(isAnimated({ kind: 'emote', id: '1', name: 'a_b', animated: true }), true);
  assert.equal(isAnimated({ kind: 'emote', id: '1', name: 'a_b', animated: false }), false);
  assert.equal(isAnimated({ kind: 'sticker', id: '1', name: 's', format: 'apng' }), true);
  assert.equal(isAnimated({ kind: 'sticker', id: '1', name: 's', format: 'gif' }), true);
  assert.equal(isAnimated({ kind: 'sticker', id: '1', name: 's', format: 'png' }), false);
  assert.equal(isAnimated({ kind: 'sticker', id: '1', name: 's', format: 'lottie' }), false);
  assert.equal(refKey({ kind: 'emote', id: '5', name: 'n_m', animated: false }), 'e:5');
  assert.equal(refKey({ kind: 'sticker', id: '5', name: 's', format: 'png' }), 's:5');
});

test('safeNameSlug sanitizes arbitrary sticker names', () => {
  assert.equal(safeNameSlug('Wave Hello!'), 'wave-hello');
  assert.equal(safeNameSlug('émote/../..'), 'mote');
  assert.equal(safeNameSlug('___'), '___');
  assert.equal(safeNameSlug('!!!'), 'unnamed');
});

test('attachmentName carries kind, name and id; frames only when of > 1', () => {
  const e: EmoteOrStickerRef = { kind: 'emote', id: '123456789', name: 'blobwave', animated: true };
  assert.equal(attachmentName(e), 'emote-blobwave-123456789.png');
  assert.equal(attachmentName(e, { frame: 2, of: 4 }), 'emote-blobwave-123456789-frame2of4.png');
  assert.equal(attachmentName(e, { frame: 1, of: 1 }), 'emote-blobwave-123456789.png');
  const s: EmoteOrStickerRef = { kind: 'sticker', id: '77', name: 'Wave Hello', format: 'lottie' };
  assert.equal(attachmentName(s, { ext: 'json' }), 'sticker-wave-hello-77.json');
});

test('pickKeyframeIndices: bounds, spacing, first+last inclusive', () => {
  assert.deepEqual(pickKeyframeIndices(0, 4), []);
  assert.deepEqual(pickKeyframeIndices(1, 4), [0]);
  assert.deepEqual(pickKeyframeIndices(3, 4), [0, 1, 2]);
  assert.deepEqual(pickKeyframeIndices(4, 4), [0, 1, 2, 3]);
  assert.deepEqual(pickKeyframeIndices(10, 4), [0, 3, 6, 9]);
  assert.deepEqual(pickKeyframeIndices(10, 1), [0]);
  const many = pickKeyframeIndices(300, 4);
  assert.equal(many[0], 0);
  assert.equal(many[many.length - 1], 299);
});

test('ffmpegExtractArgs forces -f apng only for apng input', () => {
  const plain = ffmpegExtractArgs('/in.gif', '/out/f-%03d.png', null);
  assert.ok(!plain.includes('apng'));
  assert.ok(plain.includes('/in.gif') && plain.includes('/out/f-%03d.png'));
  const apng = ffmpegExtractArgs('/in.png', '/out/f-%03d.png', 'apng');
  assert.equal(apng[apng.indexOf('-f') + 1], 'apng');
 // -f apng must precede -i (it describes the INPUT)
  assert.ok(apng.indexOf('-f') < apng.indexOf('-i'));
});

// ---- registry semantics (stubbed fetch, tmp cache dir) ----

function tmpCache(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'emotes-test-'));
}

/** 1x1 transparent PNG. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function stubFetch(body: Buffer, calls: string[], status = 200): typeof fetch {
  return (async (url: unknown) => {
    calls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  }) as unknown as typeof fetch;
}

test('registry: first use attaches, second use is silent, reset re-arms, cache skips re-download', async () => {
  const calls: string[] = [];
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: tmpCache(), fetchFn: stubFetch(TINY_PNG, calls) });

  const first = await reg.collect({ content: 'hi <:blobheart:111111>' });
  assert.equal(first.length, 1);
  assert.equal(first[0].name, 'emote-blobheart-111111.png');
  assert.equal(first[0].contentType, 'image/png');
  assert.ok(first[0].localPath && fs.existsSync(first[0].localPath));
  assert.equal(first[0].size, TINY_PNG.byteLength);
  assert.equal(calls.length, 1);

 // same emote again in the same window: nothing
  assert.deepEqual(await reg.collect({ content: '<:blobheart:111111> once more' }), []);
  assert.equal(reg.seenCountForTest(), 1);

 // context boundary: re-arms, but the disk cache serves it — no second fetch
  reg.resetSeen();
  assert.equal(reg.seenCountForTest(), 0);
  const again = await reg.collect({ content: '<:blobheart:111111>' });
  assert.equal(again.length, 1);
  assert.equal(calls.length, 1);
});

test('registry: failed download is not marked seen and retries on next use', async () => {
  const calls: string[] = [];
  const dir = tmpCache();
  const failing = stubFetch(TINY_PNG, calls, 404);
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: dir, fetchFn: failing });
  assert.deepEqual(await reg.collect({ content: '<:sad:222222>' }), []);
  assert.equal(reg.seenCountForTest(), 0);

 // same registry, now the network works (fresh registry over same cache dir
 // mirrors a retry after transient failure)
  const reg2 = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: dir, fetchFn: stubFetch(TINY_PNG, calls) });
  const ok = await reg2.collect({ content: '<:sad:222222>' });
  assert.equal(ok.length, 1);
});

test('registry: lottie sticker degrades to a name-only metadata entry', async () => {
  const calls: string[] = [];
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: tmpCache(), fetchFn: stubFetch(TINY_PNG, calls) });
  const out = await reg.collect({ content: '', stickers: [{ id: '333', name: 'Wave Hello', format: 3 }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'sticker-wave-hello-333.json');
  assert.equal(out[0].localPath, null);
  assert.equal(out[0].contentType, 'application/json');
  assert.equal(calls.length, 0); // no download for a lottie we can't render
  assert.equal(reg.seenCountForTest(), 1);
});

test('registry: unknown sticker format is skipped entirely', async () => {
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: tmpCache(), fetchFn: stubFetch(TINY_PNG, []) });
  assert.deepEqual(await reg.collect({ content: '', stickers: [{ id: '9', name: 'future', format: 42 }] }), []);
  assert.equal(reg.seenCountForTest(), 0);
});

test('registry: per-message cap defers the excess to the next use', async () => {
  const calls: string[] = [];
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: tmpCache(), fetchFn: stubFetch(TINY_PNG, calls) });
  const content = '<:a1:100001> <:a2:100002> <:a3:100003> <:a4:100004> <:a5:100005>';
  const first = await reg.collect({ content });
  assert.equal(first.length, 4);
  assert.equal(reg.seenCountForTest(), 4);
  const second = await reg.collect({ content });
  assert.equal(second.length, 1);
  assert.equal(second[0].name, 'emote-a5-100005.png');
});

test('registry: soft deadline — a slow first-use download does not block collect, attaches on next use', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  const slowFetch = (async (url: unknown) => {
    calls.push(String(url));
    await gate;
    return {
      ok: true, status: 200,
      arrayBuffer: async () => TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
    };
  }) as unknown as typeof fetch;
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: tmpCache(), fetchFn: slowFetch, collectDeadlineMs: 50 });

  const t0 = Date.now();
  const first = await reg.collect({ content: '<:slow:777777>' });
  assert.deepEqual(first, []);
  assert.ok(Date.now() - t0 < 2000, 'collect must return around the deadline, not wait for the download');
  assert.equal(reg.seenCountForTest(), 0, 'a timed-out ref must NOT be marked seen');

 // let the in-flight download finish priming the cache
  release();
  await new Promise((res) => setTimeout(res, 50));

  const second = await reg.collect({ content: '<:slow:777777>' });
  assert.equal(second.length, 1, 'next use attaches from the primed cache');
  assert.equal(calls.length, 1, 'the timed-out download was reused, not re-fetched');
});

test('registry: keyframes=1 attaches ONE extracted static PNG frame for an animated emote', { skip: !HAS_FFMPEG }, async () => {
  const dir = tmpCache();
  const gifPath = path.join(dir, 'src.gif');
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:rate=10:size=96x96', gifPath]);
  assert.equal(gen.status, 0);
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 1, cacheDir: dir, fetchFn: stubFetch(fs.readFileSync(gifPath), []) });
  const out = await reg.collect({ content: '<a:once:888888>' });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'emote-once-888888.png');
  assert.equal(out[0].contentType, 'image/png', 'a single downscaled PNG frame, not the raw gif');
});

test('registry: static PNG sticker attaches as a single image', async () => {
  const calls: string[] = [];
  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: tmpCache(), fetchFn: stubFetch(TINY_PNG, calls) });
  const out = await reg.collect({ content: '', stickers: [{ id: '444', name: 'OK!', format: 1 }] });
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'sticker-ok-444.png');
  assert.equal(out[0].contentType, 'image/png');
  assert.ok(out[0].localPath && fs.existsSync(out[0].localPath));
});

test('registry: animated emote extracts evenly spaced keyframes via ffmpeg', { skip: !HAS_FFMPEG }, async () => {
 // generate a 10-frame GIF to serve as the "CDN" body
  const dir = tmpCache();
  const gifPath = path.join(dir, 'src.gif');
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:rate=10:size=96x96', gifPath]);
  assert.equal(gen.status, 0);
  const gif = fs.readFileSync(gifPath);

  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 4, cacheDir: dir, fetchFn: stubFetch(gif, []) });
  const out = await reg.collect({ content: '<a:party:555555>' });
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((a) => a.name), [
    'emote-party-555555-frame1of4.png',
    'emote-party-555555-frame2of4.png',
    'emote-party-555555-frame3of4.png',
    'emote-party-555555-frame4of4.png',
  ]);
  for (const a of out) {
    assert.equal(a.contentType, 'image/png');
    assert.ok(a.localPath && fs.existsSync(a.localPath));
    assert.ok(a.size > 0);
  }
});

// ---- agent-side: transcript strip + the two context-window reset boundaries ----

test('agent: transcript persist strips base64 contentParts (persistable), in-memory keeps them', async () => {
  const dir = tmpCache();
  const png = path.join(dir, 'img.png');
  fs.writeFileSync(png, TINY_PNG);
  const stubLLM = {
    client: {} as unknown as LLM['client'], model: 'test', runTool: {} as unknown as LLM['runTool'],
    complete: () => Promise.resolve(EMPTY_END),
    summarize: () => Promise.resolve('SUMMARY '.padEnd(300, 'z')), // clears the quality-gate floor
  } as LLM;
  const { agent, tmpDir } = buildTestAgent({ llm: stubLLM, tmpPrefix: 'emotes-persist-' });
 // The loop fires onIdle on its INITIAL park too (synchronously inside
 // agent.loop) — arm the resolver only after that, so `idle` resolves at
 // the park that follows the enqueued turn, with the message drained.
  let idleResolve: (() => void) | null = null;
  agent['deps'].onIdle = () => idleResolve?.();
  void agent.loop();
  const idle = new Promise<void>((r) => { idleResolve = r; });
  agent.enqueue({
    id: 'm1', channelId: 'c', channelName: 'c', author: 'u', authorId: 'u',
    content: 'look at this', createdAt: '2026-01-01T00:00:00Z',
    replyTo: null, forwarded: null, mentions: [],
    attachments: [{ url: 'https://x/img.png', name: 'img.png', contentType: 'image/png', localPath: png, size: TINY_PNG.byteLength }],
  });
  await idle;
  agent.stop();

  const userMsg = agent.messagesForTest.find((m) => m.role === 'user' && m.content.includes('look at this'));
  assert.ok(userMsg?.contentParts && userMsg.contentParts.length === 2, 'in-memory history keeps the image parts');

  const sessionsDir = path.join(tmpDir, 'sessions');
  const files = fs.readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length > 0, 'a transcript file exists');
  const raw = files.map((f) => fs.readFileSync(path.join(sessionsDir, f), 'utf8')).join('\n');
  assert.ok(raw.includes('look at this'), 'the text envelope is persisted');
  assert.ok(!raw.includes('contentParts'), 'no contentParts field reaches the transcript');
  assert.ok(!raw.includes('base64,'), 'no base64 payload reaches the transcript');
});

test('agent: clearContext() re-arms the emote seen-set', () => {
  let resets = 0;
  const { agent } = buildTestAgent({
    agentDeps: { emotes: { resetSeen: () => { resets++; } } },
    tmpPrefix: 'emotes-clear-',
  });
  agent.clearContext();
  assert.equal(resets, 1);
});

test('agent: compaction-apply re-arms the emote seen-set', async () => {
  let resets = 0;
  const stubLLM = {
    client: {} as unknown as LLM['client'], model: 'test', runTool: {} as unknown as LLM['runTool'],
    complete: () => Promise.resolve(EMPTY_END),
    summarize: () => Promise.resolve('SUMMARY '.padEnd(300, 'z')), // clears the quality-gate floor
  } as LLM;
  const { agent } = buildTestAgent({
    llm: stubLLM,
    config: { compaction: { triggerTokens: 500, keepTokens: 20000 }, llm: { ...makeConfig().llm, completionReserveTokens: 100 }, heartbeat: { intervalMs: 0, maxIntervalMs: 4 * 60 * 60 * 1000, reflectionMinMessages: 3, socialNudgeMs: 12 * 60 * 60 * 1000 } },
    tracker: createContextTracker(100000, 100),
    compactorOpts: { keepTokens: 100 },
    agentDeps: { emotes: { resetSeen: () => { resets++; } } },
    tmpPrefix: 'emotes-compact-',
  });
  const bigUserMsg = (id: string): Parameters<Agent['enqueue']>[0] => ({
    id, channelId: 'c', channelName: 'c', author: 'u', authorId: 'u',
    content: 'x'.repeat(6000), createdAt: '2026-01-01T00:00:00Z',
    replyTo: null, forwarded: null, mentions: [], attachments: [],
  });
 // Arm idle AFTER loop start: onIdle also fires on the loop's initial park.
  let idleResolve: (() => void) | null = null;
  agent['deps'].onIdle = () => idleResolve?.();
  void agent.loop();
  const idle = new Promise<void>((r) => { idleResolve = r; });
  agent.enqueue(bigUserMsg('m1'));
  agent.enqueue(bigUserMsg('m2'));
  await idle;
  await agent['deps'].compactor.done();
  const idle2 = new Promise<void>((r) => { idleResolve = r; });
  agent.enqueue(bigUserMsg('m3'));
  await idle2;
  assert.equal(resets, 1, 'compaction apply should reset the seen-set exactly once');
  agent.stop();
});

test('registry: animated APNG sticker extracts keyframes via ffmpeg', { skip: !HAS_FFMPEG }, async () => {
  const dir = tmpCache();
  const apngPath = path.join(dir, 'src.png');
  const gen = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:rate=10:size=100x100', '-f', 'apng', apngPath]);
  assert.equal(gen.status, 0);
  const apng = fs.readFileSync(apngPath);

  const reg = createEmoteRegistry({ log: noopLogger, keyframes: 3, cacheDir: dir, fetchFn: stubFetch(apng, []) });
  const out = await reg.collect({ content: '', stickers: [{ id: '666', name: 'Bouncy', format: 2 }] });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((a) => a.name), [
    'sticker-bouncy-666-frame1of3.png',
    'sticker-bouncy-666-frame2of3.png',
    'sticker-bouncy-666-frame3of3.png',
  ]);
});
