// Unit tests for the operator console (src/console/*).
//
// Covers the pure, deterministic surface the live dashboard depends on:
// - serializeMessage / classifyMessage (every render kind)
// - extractCode + parseEnvelope helpers
// - ConsoleHub snapshot (tail window + hasMore) and backfill paging, including
// the mirror→archived (negative-id) handoff
// - streaming + compaction + log broadcast frames
// - createArchivedReader paging over rotated transcript files
// No network. Run with: npm run test:unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConsoleHub, serializeMessage, classifyMessage, extractCode, extractDetail, parseEnvelope,
  type HubSources, type HubClient, type StreamEntry,
} from '../src/console/hub.js';
import { createArchivedReader } from '../src/console/history.js';
import { formatInboundEnvelope } from '../src/lib/envelope.js';
import { createTranscriptStore, MAIN_TRANSCRIPT_ID } from '../src/store/sessions.js';
import type { ChatMessage } from '../src/llm/llm.js';

// A test client that records every frame it receives.
function recordingClient(): HubClient & { frames: any[]; byType: (t: string) => any[] } {
  const frames: any[] = [];
  return {
    frames,
    closed: false,
    send(data: string) { frames.push(JSON.parse(data)); },
    byType(t: string) { return frames.filter((f) => f.t === t); },
  };
}

const stubSources = (overrides: Partial<HubSources> = {}): HubSources => ({
  usage: () => ({
    current: 1000, window: 262144, trigger: 100000, triggerRatio: 100000 / 262144, ratio: 1000 / 262144, prompt: 900, completion: 100,
    cache: {
      supported: false,
      lastCached: 0, lastNew: 0, lastRatio: 0,
      totalCached: 0, totalNew: 0, totalRatio: 0,
      bustCount: 0, bustTokens: 0, turns: 0,
    },
  }),
  rooms: () => [{
    id: 'c1', name: 'agora', color: 'gold', count: 3, presence: 2, group: 'discord' as const,
    guildSlug: null, tier: null, muteState: null,
  }],
  participants: () => 4,
  meta: () => ({ gitHash: 'abc1234', treeClean: true, uptimeMs: 1000, model: 'test', botTag: 'Echo#1' }),
  archived: () => [],
  subUsage: () => null,
  ...overrides,
});

const u = (chan: string, author: string, ts: string, text: string): ChatMessage => ({
  role: 'user', channel: chan, content: `<incoming-message channel="${chan}" author="${author}" time="${ts}" local-time="12:34">\n${text}\n</incoming-message>`,
});

test('handleClientMessage: console chat validates, delegates, and deduplicates by nonce', async () => {
  const accepted: { nonce: string; content: string }[] = [];
  const hub = new ConsoleHub();
  hub.attach(stubSources({ chat: (input) => { accepted.push(input); return { ok: true, note: 'accepted' }; } }));
  const client = recordingClient();
  await hub.addClient(client);

  const frame = JSON.stringify({ t: 'chat', nonce: '12345678-abcd', content: 'hello from console' });
  hub.handleClientMessage(client, frame);
  hub.handleClientMessage(client, frame);
  hub.handleClientMessage(client, JSON.stringify({ t: 'chat', nonce: 'short', content: 'x' }));

  assert.deepEqual(accepted, [{ nonce: '12345678-abcd', content: 'hello from console' }]);
  const results = client.byType('chatResult');
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => [r.ok, r.note]), [
    [true, 'accepted'], [true, 'message already accepted'], [false, 'invalid message nonce'],
  ]);
});

test('client console composer sends Enter, preserves Shift+Enter, and handles chatResult', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(here, '../src/console/public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(here, '../src/console/public/styles.css'), 'utf8');
  const runCodeSrc = fs.readFileSync(path.join(here, '../src/console/public/run-code.js'), 'utf8');
  assert.match(html, /id="composer-text"[\s\S]*Message agent · console/);
  assert.match(html, /ep-composer-box[\s\S]*aria-label="Send message"/);
  assert.doesNotMatch(html, /ep-composer-foot/);
  assert.match(src, /event\.key === 'Enter' && !event\.shiftKey && !event\.isComposing/);
  assert.match(src, /ws\.send\(JSON\.stringify\(\{ t: 'chat', nonce, content \}\)\)/);
  assert.match(src, /case 'chatResult':[\s\S]*pendingChats\.delete/);
  assert.match(src, /restoreStream\(m\.stream \|\| null\)/);
  assert.match(src, /ensureStream[\s\S]*requestAnimationFrame[\s\S]*threadFollow\.afterGrowth/);
  assert.match(src, /composerText\.addEventListener\('focus',[\s\S]*state\.room !== 'console'[\s\S]*setRoom\('console'\)/);
  assert.match(src, /const harness = rooms\.filter[\s\S]*for \(const r of harness\)[\s\S]*const guilds =/);
  assert.match(src, /function spotlightMatches[\s\S]*data-related-rooms[\s\S]*includes\(active\)/);
  assert.match(src, /const relatedRooms = [\s\S]*entry\.sends[\s\S]*data-related-rooms': relatedRooms/);
  assert.match(src, /ep-divider cachebust'[\s\S]*'data-global': 'true'/);
  assert.match(src, /cotOpen: localStorage\.getItem\('ep-cot'\) !== 'hidden'/);
  assert.match(src, /localStorage\.setItem\('ep-cot',[\s\S]*localStorage\.setItem\('ep-tools'/);
  assert.doesNotMatch(src, /ep-previews|previewsOpen|ep-preview-fold|previews-toggle/);
  assert.doesNotMatch(html, /previews-toggle|previews-label/);
  assert.match(src, /class: 'ep-run ep-tool-fold'[\s\S]*details\.open = state\.toolsOpen/);
  assert.match(src, /void runCode\?\.render\(code, tc\)/);
  assert.match(html, /prettier-standalone\.js[\s\S]*prism-typescript\.js[\s\S]*run-code\.js/);
  assert.match(runCodeSrc, /import\('.\/heredoc-display\.js'\)/);
  assert.match(src, /class: 'ep-result ep-tool-fold'[\s\S]*details\.open = state\.toolsOpen/);
  assert.match(src, /class: 'ep-run-detail'[\s\S]*tc\.detail \|\| 'execute javascript · vm sandbox'/);
  assert.match(src, /class: 'ep-result-detail'[\s\S]*entry\.run\?\.detail \|\| 'RunResult'/);
  assert.doesNotMatch(src, /class: 'ep-result-sub', text: `· \${attribution}`/);
  assert.match(css, /\.ep-view-tab[^}]*IBM Plex Sans/);
  assert.match(css, /\.ep-run-detail[^}]*IBM Plex Sans/);
  assert.match(css, /\.ep-result-detail[^}]*IBM Plex Sans/);
  assert.match(src, /class: 'ep-result-pre ep-result-scroll value'/);
  assert.match(css, /\.ep-result-scroll \{[^}]*max-height: min\(32rem, 55vh\);[^}]*overflow: auto;[^}]*scrollbar-gutter: stable/);
});

test('client console has a bounded mobile layout with room and log drawers', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  const html = fs.readFileSync(path.join(here, '../src/console/public/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(here, '../src/console/public/styles.css'), 'utf8');

  assert.match(html, /id="rooms-toggle"[^>]+aria-controls="rail"[^>]+aria-expanded="false"/);
  assert.match(html, /id="rail-scrim"[^>]+aria-label="Close rooms"[^>]+hidden/);
  assert.match(html, /id="log-toggle"[^>]+aria-controls="log-body"[^>]+aria-expanded="false"/);
  assert.match(src, /matchMedia\('\(max-width: 700px\)'\)/);
  assert.match(src, /function setMobileRail[\s\S]*\.inert = mobileViewport\.matches/);
  assert.match(src, /contains\(document\.activeElement\)[\s\S]*rooms-toggle'\)\.focus/);
  assert.match(src, /Escape'[\s\S]*setMobileRail\(false\)/);
  assert.match(src, /MOBILE_LOG_KEY = 'ep-mobile-log'[\s\S]*data-mobile-open/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*height: 100dvh/);
  assert.match(css, /data-mobile-rail="open"[\s\S]*translateX\(0\)/);
  assert.match(css, /\.ep-stream-head[^{]*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.ep-composer textarea[^{]*\{[^}]*font-size: 16px/);
  assert.match(css, /\.ep-resizer \{ display: none; \}/);
  assert.match(css, /data-mobile-open="false"[\s\S]*\.ep-log-body \{ display: none; \}/);
});

test('classifyMessage covers every render kind', () => {
  assert.equal(classifyMessage({ role: 'user', content: '<incoming-message channel="c" author="a" time="t" local-time="12:34">\nhi\n</incoming-message>' }), 'user');
  assert.equal(classifyMessage({ role: 'assistant', content: 'thinking' }), 'assistant');
  assert.equal(classifyMessage({ role: 'tool', content: '[run ok]' }), 'tool');
  assert.equal(classifyMessage({ role: 'system', content: '=== Summary of earlier conversation (3 earlier messages compacted) ===\nx' }), 'summary');
  assert.equal(classifyMessage({ role: 'system', content: 'You are Echo' }), 'system');
  assert.equal(classifyMessage({ role: 'user', content: '[harness: context compacted — 4 earlier messages...' }), 'notice');
});

test('run-card extraction pulls code and detail while tolerating legacy or malformed JSON', () => {
  const args = JSON.stringify({ code: 'await elpis.sh("ls")', detail: 'List the working directory' });
  assert.equal(extractCode(args), 'await elpis.sh("ls")');
  assert.equal(extractDetail(args), 'List the working directory');
  assert.equal(extractDetail(JSON.stringify({ code: '1' })), '');
  assert.equal(extractCode('{not json'), '{not json');
  assert.equal(extractDetail('{not json'), '');
});

test('parseEnvelope extracts author + timestamp from the inbound XML envelope', () => {
  const r = parseEnvelope('<incoming-message channel="agora" author="ari" time="2026-07-04T05:09:15.235Z" local-time="22:04">\nhey\n</incoming-message>');
  assert.equal(r.author, 'ari');
  assert.equal(typeof r.ts, 'number');
});

test('parseEnvelope still tolerates the legacy bracket header', () => {
  const r = parseEnvelope('[22:04] #agora <ari> (2026-07-04T05:09:15.235Z)\ncontent: hey');
  assert.equal(r.author, 'ari');
  assert.equal(typeof r.ts, 'number');
});

// The SPA renders user/notice bubbles through app.js's client-side utterance
// extractor. It must mirror the server's extractUtterance (agent.ts): pull the
// inline message text out of the envelope, skipping the leading structured
// children — otherwise the raw envelope reaches innerHTML and the bubble is wrong.
// This guards against that exact drift (the two extractors regressing apart).
test('client utterance() (app.js) extracts inline envelope text, skipping children', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  const body = src.slice(src.indexOf('const ENVELOPE_CHILD_TAGS'), src.indexOf('function tokEst'));
  const utterance = new Function(body + '\n return utterance;')() as (s: string) => string;

  assert.equal(
    utterance('<incoming-message channel="agora" author="ari" time="t" local-time="22:04">\nhey there\n</incoming-message>'),
    'hey there',
  );
 // A leading reply-to child must not leak into the extracted utterance.
  assert.equal(
    utterance('<incoming-message channel="c" author="a" time="t" local-time="l">\n  <reply-to id="1" author="b">quoted</reply-to>\n  <mentions>@x</mentions>\nmy reply\n</incoming-message>'),
    'my reply',
  );
 // Envelope-less notices fall through whole.
  assert.equal(utterance('[harness: context compacted]'), '[harness: context compacted]');
});

// The SPA's attachmentsOf (app.js) re-parses the leading `attachment#N:`
// metadata lines that formatAttachmentParts (envelope.ts) writes, to render
// inbound images inline. Same eval-the-source technique as the utterance
// drift guard above — the two ends of the format must not regress apart.
test('client attachmentsOf() (app.js) parses attachment metadata lines from the envelope', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  const body = src.slice(src.indexOf('const ENVELOPE_CHILD_TAGS'), src.indexOf('function tokEst'));
  const attachmentsOf = new Function(body + '\n return attachmentsOf;')() as (s: string) => {
    name: string; contentType: string; size: number; localPath: string | null;
  }[];

 // Built by the REAL server-side formatter, so this is a round-trip guard:
 // if formatAttachmentParts changes its rendering, this parse must change too.
  const env = formatInboundEnvelope({
    channelName: 'agora', author: 'ari', createdAt: 't', content: 'look at this',
    replyTo: null, forwarded: null, mentions: [],
    attachments: [
      { url: 'https://cdn/x', name: 'photo one.png', contentType: 'image/png', localPath: '/tmp/elpis-attach/99/photo one-0.png', size: 1234 },
      { url: 'https://cdn/y', name: 'notes.txt', contentType: 'text/plain', localPath: '/tmp/elpis-attach/99/notes-1.txt', size: 20, inlineText: 'hello' },
    ],
  }, '[22:04]');
  assert.deepEqual(attachmentsOf(env), [
    { name: 'photo one.png', contentType: 'image/png', size: 1234, localPath: '/tmp/elpis-attach/99/photo one-0.png' },
    { name: 'notes.txt', contentType: 'text/plain', size: 20, localPath: '/tmp/elpis-attach/99/notes-1.txt' },
  ]);

  const animated = formatInboundEnvelope({
    channelName: 'agora', author: 'ari', createdAt: 't', content: 'wag',
    replyTo: null, forwarded: null, mentions: [],
    attachments: [1, 2].map((frame) => ({
      url: `https://cdn/${frame}`,
      name: `emote-tail-123456789-frame${frame}of2.png`,
      contentType: 'image/png', localPath: `/tmp/tail-${frame}.png`, size: frame,
    })),
  }, '[22:04]');
  assert.deepEqual(attachmentsOf(animated), [
    { name: 'emote-tail-123456789-frame1of2.png', contentType: 'image/png', size: 1, localPath: '/tmp/tail-1.png' },
    { name: 'emote-tail-123456789-frame2of2.png', contentType: 'image/png', size: 2, localPath: '/tmp/tail-2.png' },
  ]);

 // A failed download renders no ` -> path` — localPath comes back null.
  assert.deepEqual(
    attachmentsOf('<incoming-message a="b">\nattachment#1: x.png (image/png, 9 bytes)\nhi\n</incoming-message>'),
    [{ name: 'x.png', contentType: 'image/png', size: 9, localPath: null }],
  );

 // An attachment-looking line in the message BODY is content, not metadata.
  assert.deepEqual(
    attachmentsOf('<incoming-message a="b">\nso I typed\nattachment#1: fake.png (image/png, 1 bytes) -> /etc/passwd\n</incoming-message>'),
    [],
  );

 // Envelope-less notices carry no attachments.
  assert.deepEqual(attachmentsOf('[harness: context compacted]'), []);
});

test('client stream waits compactly until a real delta materializes a message bubble', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  const ensure = src.slice(src.indexOf('function ensureStream'), src.indexOf('function clearStream'));
  assert.match(ensure, /ep-stream-wait/);
  assert.match(ensure, /is thinking/);
  assert.match(ensure, /function materializeStream/);
  assert.doesNotMatch(ensure.slice(0, ensure.indexOf('function materializeStream')), /ep-bubble/);
  assert.match(src, /materializeStream\(s\);\n    if \(msg\.kind === 'content'\)/);
});

test('serializeMessage: run calls stay action cards while think calls become CoT', () => {
  const asst = serializeMessage({
    role: 'assistant', channel: 'c1', content: 'ok',
    reasoning_content: 'let me check',
    tool_calls: [
      { id: 'think_1', type: 'function', function: { name: 'think', arguments: JSON.stringify({ thoughts: 'consider the edge' }) } },
      { id: 'call_1', type: 'function', function: { name: 'run', arguments: JSON.stringify({ code: '1+1', detail: 'Add the fixture values' }) } },
    ],
  }, 5, 123);
  assert.equal(asst.kind, 'assistant');
  assert.equal(asst.id, 5);
  assert.equal(asst.reasoning_content, 'let me check\n\nconsider the edge');
  assert.deepEqual(asst.toolCalls, [{ id: 'call_1', code: '1+1', detail: 'Add the fixture values' }]);

  const heredocCode = ["const x=<<<BODY", 'raw `text`', 'BODY.trimEnd()'].join('\n');
  const heredoc = serializeMessage({
    role: 'assistant', channel: 'c1', content: '',
    tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'run', arguments: JSON.stringify({ code: heredocCode, detail: 'Read the raw body' }) } }],
  }, 7, 124);
  assert.equal(heredoc.toolCalls?.[0].code, heredocCode);
  assert.match(heredoc.toolCalls?.[0].display?.code ?? '', /__ELPIS_HEREDOC_0__/);
  assert.equal(heredoc.toolCalls?.[0].display?.heredocs[0].source, '<<<BODY\nraw `text`\nBODY');

  const run = {
    toolContractVersion: 'elpis-run-v4', ok: true, detail: 'Add the fixture values',
    execution: { kind: 'persistent' as const, alias: 'quietly-crimson-ibis', mindId: 7, generation: 2, runId: 'exec-g2-r3' },
    wake: { kind: 'after' as const, state: 'armed' as const, requestedAt: 1, targetAt: 2, taskId: 3 },
  };
  const tool = serializeMessage({
    role: 'tool', channel: 'c1', content: '[run ok]', tool_call_id: 'call_1', run,
    sends: [{ channel: 'agora', text: 'hi' }],
  }, 6, null);
  assert.equal(tool.kind, 'tool');
  assert.deepEqual(tool.run, run);
  assert.deepEqual(tool.sends, [{ channel: 'agora', text: 'hi' }]);
});

test('client runAttribution renders bounded sandbox and wake lifecycle', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  const body = src.slice(src.indexOf('function runAttribution'), src.indexOf('function resultBlock'));
  const runAttribution = new Function(body + '\n return runAttribution;')() as (run: unknown) => string;
  const text = runAttribution({
    execution: { kind: 'persistent', lifecycle: 'ready', alias: 'quietly-crimson-ibis', mindId: 7, mindTitle: 'Wake contract', mindStatus: 'open', runId: 'exec-g2-r3', generation: 2, coldStart: true, retiring: true },
    detached: true, bgId: 'bg-4',
    wake: { kind: 'after', state: 'armed', targetAt: 2, taskId: 3 },
  });
  assert.equal(text, 'quietly-crimson-ibis · ready · Mind #7 · Wake contract · open · exec-g2-r3 · cold · retiring · detached bg-4 · wake armed · after → 1970-01-01T00:00:00.002Z · task #3');
});

test('ConsoleHub marks only paired think separators as hidden Thread results', async () => {
  const hub = new ConsoleHub();
  hub.messageAppended({
    role: 'assistant', channel: 'c1', content: '',
    tool_calls: [{ id: 'think_1', type: 'function', function: { name: 'think', arguments: JSON.stringify({ thoughts: 'private work' }) } }],
  });
  hub.messageAppended({ role: 'tool', channel: 'c1', content: '------', tool_call_id: 'think_1' });
  hub.messageAppended({ role: 'tool', channel: 'c1', content: '------', tool_call_id: 'unrelated' });
  const client = recordingClient();
  hub.attach(stubSources());
  await hub.addClient(client);
  const messages = client.byType('snapshot')[0].messages;
  assert.equal(messages.find((entry: StreamEntry) => entry.tool_call_id === 'think_1').kind, 'think-result');
  assert.equal(messages.find((entry: StreamEntry) => entry.tool_call_id === 'unrelated').kind, 'tool');
  assert.equal(messages.find((entry: StreamEntry) => entry.reasoning_content === 'private work').toolCalls, undefined);
});

test('serializeMessage: user entry parses author + ts from the envelope when ts is null', () => {
  const e = serializeMessage(u('agora', 'ari', '2026-07-04T05:09:15.235Z', 'hey'), 0, null);
  assert.equal(e.author, 'ari');
  assert.equal(typeof e.ts, 'number');
});

test('archived reader reconstructs think-result pairing across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-think-archive-'));
  const store = createTranscriptStore(path.join(dir, 'sessions'));
  store.append(MAIN_TRANSCRIPT_ID, {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'think_archived', type: 'function', function: { name: 'think', arguments: JSON.stringify({ thoughts: 'old thought' }) } }],
  });
  store.append(MAIN_TRANSCRIPT_ID, { role: 'tool', content: '------', tool_call_id: 'think_archived' });
  store.rotate(MAIN_TRANSCRIPT_ID);
  store.append(MAIN_TRANSCRIPT_ID, { role: 'user', content: 'newest file sentinel' });
  const reader = createArchivedReader(path.join(dir, 'sessions'));
  const page = reader.read(0, 10);
  assert.equal(page.find((entry) => entry.reasoning_content === 'old thought')?.kind, 'assistant');
  assert.equal(page.find((entry) => entry.tool_call_id === 'think_archived')?.kind, 'think-result');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hub snapshot sends the tail window and flags hasMore when history exceeds it', async () => {
 // 70 messages > SNAPSHOT_MESSAGES (60): snapshot carries the last 60, hasMore true.
  const initial: ChatMessage[] = [];
  for (let i = 0; i < 70; i++) initial.push(u('c1', 'ari', '2026-07-04T05:00:00.000Z', `m${i}`));
  const hub = new ConsoleHub(initial);
  hub.attach(stubSources());
  const client = recordingClient();
  await hub.addClient(client);
  const snap = client.byType('snapshot')[0];
  assert.ok(snap, 'snapshot sent on connect');
  assert.equal(snap.messages.length, 60);
  assert.equal(snap.messages[0].id, 10); // ids are array indices; tail starts at 10
  assert.equal(snap.oldestId, 10);
  assert.equal(snap.hasMore, true);
  assert.equal(snap.usage.window, 262144);
  assert.equal(snap.rooms[0].name, 'agora');
  assert.equal(snap.participants, 4);
});

test('hub backfill pages backward through the mirror, then hands off to archived (negative ids)', async () => {
  const initial: ChatMessage[] = [];
  for (let i = 0; i < 70; i++) initial.push(u('c1', 'ari', '2026-07-04T05:00:00.000Z', `m${i}`));
 // an archived reader with two older messages (ids -2, -1)
  const archivedMsgs: StreamEntry[] = [
    serializeMessage(u('c1', 'ari', '2026-07-03T00:00:00.000Z', 'old0'), -2, null),
    serializeMessage(u('c1', 'ari', '2026-07-03T00:00:01.000Z', 'old1'), -1, null),
  ];
  const hub = new ConsoleHub(initial);
  hub.attach(stubSources({
    archived: (beforeId, limit) => {
 // newest archived page (beforeId 0) → both; page before -2 → none
      if (beforeId >= 0) return archivedMsgs.slice(-limit);
      return archivedMsgs.filter((m) => m.id < beforeId).slice(-limit);
    },
  }));
  const client = recordingClient();
  await hub.addClient(client);

 // page 1: before id 10 (snapshot oldest) → ids 0..9
  hub.handleClientMessage(client, JSON.stringify({ t: 'backfill', reqId: 1, beforeId: 10 }));
  const h1 = client.byType('history').at(-1);
  assert.equal(h1.messages[0].id, 0);
  assert.equal(h1.messages.at(-1).id, 9);
  assert.equal(h1.oldestId, 0);
  assert.equal(h1.hasMore, true, 'archived history still available below id 0');

 // page 2: before id 0 → archived negative ids
  hub.handleClientMessage(client, JSON.stringify({ t: 'backfill', reqId: 2, beforeId: 0 }));
  const h2 = client.byType('history').at(-1);
  assert.deepEqual(h2.messages.map((m: StreamEntry) => m.id), [-2, -1]);
});

test('snapshot hasMore is true when the mirror is small but archived history exists (must-fix #1)', async () => {
 // only 5 live messages (< SNAPSHOT_MESSAGES) but there IS on-disk history: the
 // client must still be told to scroll back, or pre-restart context is unreachable.
  const initial: ChatMessage[] = [];
  for (let i = 0; i < 5; i++) initial.push(u('c1', 'ari', '2026-07-04T05:00:00.000Z', `m${i}`));
  const arch: StreamEntry[] = [serializeMessage(u('c1', 'ari', '2026-07-03T00:00:00.000Z', 'old'), -1, null)];
  const hub = new ConsoleHub(initial);
  hub.attach(stubSources({ archived: (b, l) => (b >= 0 ? arch.slice(-l) : []) }));
  const client = recordingClient();
  await hub.addClient(client);
  const snap = client.byType('snapshot')[0];
  assert.equal(snap.messages.length, 5);
  assert.equal(snap.hasMore, true, 'archived history keeps scroll-back available');

 // and with NO archived history, a small mirror reports hasMore false
  const hub2 = new ConsoleHub(initial);
  hub2.attach(stubSources({ archived: () => [] }));
  const c2 = recordingClient();
  await hub2.addClient(c2);
  assert.equal(c2.byType('snapshot')[0].hasMore, false);
});

test('snapshot carries active thinking/stream state across refresh and clears after streamEnd', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources());
  hub.setStreamChannel('console');
  hub.streamStart();
  hub.streamDelta('reasoning', 'holding ');
  hub.streamDelta('reasoning', 'several thoughts');
  hub.streamDelta('content', 'hello');

  const liveClient = recordingClient();
  await hub.addClient(liveClient);
  const live = liveClient.byType('snapshot')[0].stream;
  assert.deepEqual(live, {
    streamId: 1, channel: 'console', content: 'hello', reasoning: 'holding several thoughts',
  });

  hub.streamEnd();
  const endedClient = recordingClient();
  await hub.addClient(endedClient);
  assert.equal(endedClient.byType('snapshot')[0].stream, null);
});

test('contextCleared and streamEnd broadcast their frames', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources());
  const client = recordingClient();
  await hub.addClient(client);
  hub.contextCleared();
  const cleared = client.byType('message').at(-1);
  assert.equal(cleared.msg.kind, 'cleared');
  hub.streamStart();
  hub.streamEnd();
  assert.equal(client.byType('streamEnd').length, 1);
  assert.equal(client.byType('streamEnd').at(-1).streamId, client.byType('streamStart').at(-1).streamId);
});

test('mirror entry ids are monotonic and stable across appends (not array indices)', async () => {
  const hub = new ConsoleHub([u('c1', 'ari', '2026-07-04T05:00:00.000Z', 'seed')]);
  hub.attach(stubSources());
  const client = recordingClient();
  await hub.addClient(client);
  hub.messageAppended(u('c1', 'ari', '2026-07-04T05:00:01.000Z', 'a'));
  hub.messageAppended(u('c1', 'ari', '2026-07-04T05:00:02.000Z', 'b'));
  const ids = client.byType('message').map((f) => f.msg.id);
  assert.deepEqual(ids, [1, 2], 'ids continue from the seeded entry (id 0)');
});

test('hub broadcasts message / compaction / streaming / usage / log frames', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources());
  const client = recordingClient();
  await hub.addClient(client);

  hub.messageAppended(u('c1', 'ari', '2026-07-04T05:00:00.000Z', 'hello'));
  const msg = client.byType('message').at(-1);
  assert.equal(msg.msg.kind, 'user');
  assert.equal(msg.msg.id, 0);
 // usage refreshed alongside the append
  assert.ok(client.byType('usage').length >= 1);

  hub.setStreamChannel('c1');
  hub.streamStart();
  hub.streamDelta('reasoning', 'thinking…');
  hub.streamDelta('content', 'hi');
  const starts = client.byType('streamStart');
  const deltas = client.byType('delta');
  assert.equal(starts.at(-1).channel, 'c1');
  assert.equal(deltas[0].kind, 'reasoning');
  assert.equal(deltas[1].kind, 'content');
  assert.equal(deltas[1].streamId, starts.at(-1).streamId);

  hub.compactionApplied(12);
  const comp = client.byType('message').at(-1);
  assert.equal(comp.msg.kind, 'compaction');
  assert.equal(comp.msg.replaced, 12);

  hub.logLine('warn', 'compaction started');
  const log = client.byType('log').at(-1);
  assert.equal(log.line.level, 'warn');
  assert.equal(log.line.msg, 'compaction started');
});

test('archived reader pages rotated main transcripts with negative ids, excluding the newest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-console-arch-'));
  const store = createTranscriptStore(path.join(root, 'sessions'));
 // file A (older): 2 messages
  store.append(MAIN_TRANSCRIPT_ID, u('c1', 'ari', '2026-07-03T00:00:00.000Z', 'a0'));
  store.append(MAIN_TRANSCRIPT_ID, u('c1', 'ari', '2026-07-03T00:00:01.000Z', 'a1'));
  store.rotate(MAIN_TRANSCRIPT_ID); // start file B
 // file B (newest — seeds the mirror, must be excluded from archived): 1 message
  store.append(MAIN_TRANSCRIPT_ID, u('c1', 'ari', '2026-07-03T01:00:00.000Z', 'b0'));

  const reader = createArchivedReader(path.join(root, 'sessions'));
  const page = reader.read(0, 40);
 // only file A's two messages are archived; ids are -2, -1
  assert.equal(page.length, 2);
  assert.deepEqual(page.map((m) => m.id), [-2, -1]);
  assert.equal(page[0].content.includes('a0'), true);
  assert.equal(page[1].content.includes('a1'), true);
 // paging before the oldest archived id yields nothing
  assert.equal(reader.read(-2, 40).length, 0);
});

const SNAP_FIXTURE = {
  provider: 'kimi', label: 'Kimi', fetchedAt: '2026-07-21T00:00:00.000Z',
  windows: [
    { id: '5h', label: '5h', usedPct: 4, resetAt: '2026-07-22T05:36:03.631117Z' },
    { id: '7d', label: '7d', usedPct: 21, resetAt: '2026-07-28T19:36:03.631117Z' },
  ],
  error: null,
};

test('hub: snapshot carries subUsage; subUsageChanged broadcasts a subUsage frame', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({ subUsage: () => SNAP_FIXTURE }));
  const client = recordingClient();
  await hub.addClient(client);
  assert.deepEqual(client.byType('snapshot')[0].subUsage, SNAP_FIXTURE);
  hub.subUsageChanged();
  const frames = client.byType('subUsage');
  assert.equal(frames.length, 1);
  assert.deepEqual(frames[0].usage, SNAP_FIXTURE);
});

test('hub: snapshot subUsage is null when the tracker is inactive', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources());
  const client = recordingClient();
  await hub.addClient(client);
  assert.equal(client.byType('snapshot')[0].subUsage, null);
});

test('handleClientMessage: a valid moderate frame reaches sources.moderate with exact args; client gets moderateResult', async () => {
  const calls: { channelId: string; action: string; reason: string | undefined }[] = [];
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({
    moderate: (channelId, action, reason) => {
      calls.push({ channelId, action, reason });
      return { ok: true, note: 'channel muted' };
    },
  }));
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', channelId: '2001', action: 'mute', reason: 'r' }));

  assert.deepEqual(calls, [{ channelId: '2001', action: 'mute', reason: 'r' }]);
  const result = client.byType('moderateResult').at(-1);
  assert.deepEqual(result, { t: 'moderateResult', ok: true, note: 'channel muted' });
});

test('handleClientMessage: moderate never rebroadcasts a rooms frame (Agent.moderateChannel owns that)', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({ moderate: () => ({ ok: true, note: 'channel muted' }) }));
  const client = recordingClient();
  await hub.addClient(client);
  const roomsBefore = client.byType('rooms').length;

  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', channelId: '2001', action: 'mute' }));

  assert.equal(client.byType('rooms').length, roomsBefore, 'the hub must not broadcast rooms itself from the moderate path');
});

test('handleClientMessage: moderate normalizes an empty-string or non-string reason to undefined', async () => {
  const calls: (string | undefined)[] = [];
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({
    moderate: (_channelId, _action, reason) => { calls.push(reason); return { ok: true, note: '' }; },
  }));
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', channelId: '2001', action: 'mute', reason: '' }));
  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', channelId: '2001', action: 'mute', reason: 123 }));

  assert.deepEqual(calls, [undefined, undefined]);
});

test('handleClientMessage: moderate replies ok:false with a note when moderation is not wired (not silent)', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources()); // no `moderate` override — matches an un-wired mute store
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', channelId: '2001', action: 'mute' }));

  assert.deepEqual(client.byType('moderateResult').at(-1), { t: 'moderateResult', ok: false, note: 'moderation unavailable' });
});

test('handleClientMessage: unknown action or missing/non-string channelId does NOT call sources.moderate', async () => {
  let called = false;
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({ moderate: () => { called = true; return { ok: true, note: '' }; } }));
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', channelId: '2001', action: 'nuke' }));
  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', action: 'mute' })); // missing channelId
  hub.handleClientMessage(client, JSON.stringify({ t: 'moderate', channelId: 123, action: 'mute' })); // non-string channelId

  assert.equal(called, false);
  assert.equal(client.byType('moderateResult').length, 0);
});

test('handleClientMessage: a context frame answers with the snapshot from sources.context', async () => {
  const snapshot = {
    model: 'test-model',
    tools: [{ type: 'function', function: { name: 'run' } }],
    messages: [{ role: 'system', content: 'You are Echo' }, { role: 'user', content: 'hi' }],
  };
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({ context: () => snapshot }));
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 7 }));

  const frame = client.byType('context').at(-1);
  assert.equal(frame.reqId, 7);
  assert.deepEqual(frame.context, snapshot);
});

test('handleClientMessage: context requests inside the throttle window reuse the last build', async () => {
  let builds = 0;
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({
    context: () => { builds++; return { model: 'm', tools: [], messages: [{ role: 'system', content: `build ${builds}` }] }; },
  }));
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 1 }));
  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 2 }));

  assert.equal(builds, 1, 'a back-to-back request must not trigger a second build');
  const frames = client.byType('context');
  assert.equal(frames.length, 2, 'both requests are still answered');
  assert.deepEqual(frames[0].context, frames[1].context);
  assert.equal(frames[1].reqId, 2, 'the cached answer carries the new reqId');
});

test('handleClientMessage: committed history invalidates the context cache', async () => {
  let builds = 0;
  const hub = new ConsoleHub([]);
  hub.attach(stubSources({
    context: () => { builds++; return { model: 'm', tools: [], messages: [{ role: 'system', content: `build ${builds}` }] }; },
  }));
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 1 }));
  hub.messageAppended({ role: 'user', content: 'new committed message' });
  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 2 }));

  assert.equal(builds, 2, 'history mutation bypasses the throttle cache');
  assert.notDeepEqual(client.byType('context')[0].context, client.byType('context')[1].context);
});

test('client Mind detail is rendered-first with explicit edit and raw markdown copy', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  assert.match(src, /mindState\.tag = mindState\.tag === tag \? null : tag/, 'clicking the active tag clears it');
  assert.match(src, /mindState\.mode !== 'edit'\) \{ renderMindReadDetail\(item\); return; \}/, 'view mode never falls through into inputs');
  assert.match(src, /function mindMarkdown[\s\S]*html: md\(text\)/, 'item and comment prose use the existing GFM renderer');
  assert.match(src, /copyMini\(item\.body, 'Copy raw item body markdown'\)/, 'item copy keeps raw markdown');
  assert.match(src, /copyMini\(comment\.body, `Copy raw markdown for comment c#\$\{comment\.id\}`\)/, 'comment copy keeps raw markdown');
  assert.match(src, /const commentRows = \[\.\.\.\(item\.comments \|\| \[\]\)\]\.sort[\s\S]*return bTime - aTime \|\| b\.id - a\.id/, 'comments render newest first with id tie-break');
  assert.match(src, /renderMindRelations\(item, root, false\)/, 'read mode keeps mutations hidden');
  assert.match(src, /renderMindRelations\(source, form, true\)/, 'edit mode exposes relation mutations');
});

test('client context pane quietly debounces refreshes on live message events', () => {

  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  assert.match(src, /function scheduleContextRefresh\(\)/);
  assert.match(src, /requestContext\(true\)/, 'automatic refresh is quiet');
  assert.match(src, /case 'message':[\s\S]*?appendEntry\(m\.msg\);\s*scheduleContextRefresh\(\);/);
  assert.match(src, /function renderContext\(\)[\s\S]*contextFollow\.capture\(\)[\s\S]*contextFollow\.restore\(position\)/, 'Context refresh preserves a paused reader position');
  assert.doesNotMatch(src, /ctxBody\.scrollTop = ctxBody\.scrollHeight/, 'Context no longer forces every refresh to latest');
});

test('handleClientMessage: context answers null when unwired or when the source throws', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources()); // no context source
  const client = recordingClient();
  await hub.addClient(client);
  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 1 }));
  assert.deepEqual(client.byType('context').at(-1), { t: 'context', reqId: 1, context: null });

  const hub2 = new ConsoleHub([]);
  hub2.attach(stubSources({ context: () => { throw new Error('boom'); } }));
  const c2 = recordingClient();
  await hub2.addClient(c2);
  hub2.handleClientMessage(c2, JSON.stringify({ t: 'context', reqId: 2 }));
  assert.deepEqual(c2.byType('context').at(-1), { t: 'context', reqId: 2, context: null }, 'a throwing source degrades to null, never to a dropped frame');
});

test('hub: cacheBusted appends a cachebust entry and broadcasts one message frame', async () => {
  const hub = new ConsoleHub([]);
  const client = recordingClient();
  await hub.addClient(client);
  const before = client.byType('message').length;

  hub.cacheBusted(47312);

  const frames = client.byType('message');
  assert.equal(frames.length, before + 1, 'exactly one message frame');
  const entry = frames[frames.length - 1].msg as StreamEntry;
  assert.equal(entry.kind, 'cachebust');
  assert.equal(entry.rewritten, 47312);
  assert.equal(entry.role, 'system');
  assert.equal(entry.channel, 'internal');
  assert.ok(typeof entry.id === 'number');
  assert.ok(entry.ts && entry.ts > 0, 'stamped with a wall-clock time');
});

test('hub: yieldNudge appends an yieldnudge entry and broadcasts one message frame', async () => {
  const hub = new ConsoleHub([]);
  const client = recordingClient();
  await hub.addClient(client);
  const before = client.byType('message').length;

  hub.yieldNudge(3);

  const frames = client.byType('message');
  assert.equal(frames.length, before + 1, 'exactly one message frame');
  const entry = frames[frames.length - 1].msg as StreamEntry;
  assert.equal(entry.kind, 'yieldnudge');
  assert.equal(entry.count, 3);
  assert.equal(entry.role, 'system');
  assert.equal(entry.channel, 'internal');
  assert.ok(typeof entry.id === 'number');
  assert.ok(entry.ts && entry.ts > 0, 'stamped with a wall-clock time');
});

test('client room controls show config send locks without offering a redundant mute', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '../src/console/public/app.js'), 'utf8');
  assert.match(src, /r\.allowSend === false[\s\S]*send disabled by config/);
  assert.match(src, /if \(r\.allowSend !== false\)[\s\S]*modKids\.push\(muteBtn\)/);
});
