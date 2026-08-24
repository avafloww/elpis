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
  ConsoleHub,
  serializeMessage,
  classifyMessage,
  extractCode,
  extractSandboxOperations,
  frameUrlFromLocalPath,
  extractDetail,
  parseEnvelope,
  type HubSources,
  type HubClient,
  type StreamEntry,
} from '../src/console/hub.js';
import { createArchivedReader } from '../src/console/history.js';
import { formatInboundEnvelope } from '../src/lib/envelope.js';
import { protectDisplayHeredocs } from '../src/lib/heredoc-display.js';
import { attachmentsOf, utterance } from '../src/console/client/envelope.js';
import { wakePresentation } from '../src/console/client/run.js';
import {
  createTranscriptStore,
  MAIN_TRANSCRIPT_ID,
} from '../src/store/sessions.js';
import type { ChatMessage } from '../src/llm/llm.js';

// A test client that records every frame it receives.
function recordingClient(): HubClient & {
  frames: any[];
  byType: (t: string) => any[];
} {
  const frames: any[] = [];
  return {
    frames,
    closed: false,
    send(data: string) {
      frames.push(JSON.parse(data));
    },
    byType(t: string) {
      return frames.filter((f) => f.t === t);
    },
  };
}

const stubSources = (overrides: Partial<HubSources> = {}): HubSources => ({
  usage: () => ({
    current: 1000,
    window: 262144,
    trigger: 100000,
    triggerRatio: 100000 / 262144,
    ratio: 1000 / 262144,
    prompt: 900,
    completion: 100,
    cache: {
      supported: false,
      lastCached: 0,
      lastNew: 0,
      lastRatio: 0,
      totalCached: 0,
      totalNew: 0,
      totalRatio: 0,
      bustCount: 0,
      bustTokens: 0,
      turns: 0,
    },
  }),
  rooms: () => [
    {
      id: 'c1',
      name: 'agora',
      color: 'gold',
      count: 3,
      presence: 2,
      group: 'discord' as const,
      guildSlug: null,
      tier: null,
      muteState: null,
    },
  ],
  participants: () => 4,
  meta: () => ({
    gitHash: 'abc1234',
    treeClean: true,
    uptimeMs: 1000,
    model: 'test',
    botTag: 'Echo#1',
  }),
  archived: () => [],
  subUsage: () => null,
  ...overrides,
});

const u = (
  chan: string,
  author: string,
  ts: string,
  text: string,
): ChatMessage => ({
  role: 'user',
  channel: chan,
  content: `<incoming-message channel="${chan}" author="${author}" time="${ts}" local-time="12:34">\n${text}\n</incoming-message>`,
});

test('handleClientMessage: console chat validates, delegates, and deduplicates by nonce', async () => {
  const accepted: { nonce: string; content: string }[] = [];
  const hub = new ConsoleHub();
  hub.attach(
    stubSources({
      chat: (input) => {
        accepted.push(input);
        return { ok: true, note: 'accepted' };
      },
    }),
  );
  const client = recordingClient();
  await hub.addClient(client);

  const frame = JSON.stringify({
    t: 'chat',
    nonce: '12345678-abcd',
    content: 'hello from console',
  });
  hub.handleClientMessage(client, frame);
  hub.handleClientMessage(client, frame);
  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'chat', nonce: 'short', content: 'x' }),
  );

  assert.deepEqual(accepted, [
    { nonce: '12345678-abcd', content: 'hello from console' },
  ]);
  const results = client.byType('chatResult');
  assert.equal(results.length, 3);
  assert.deepEqual(
    results.map((r) => [r.ok, r.note]),
    [
      [true, 'accepted'],
      [true, 'message already accepted'],
      [false, 'invalid message nonce'],
    ],
  );
});

test('client console composer uses IME-safe Enter and one acknowledged WebSocket ingress', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const main = fs.readFileSync(
    path.join(here, '../src/console/client/main.tsx'),
    'utf8',
  );
  const hook = fs.readFileSync(
    path.join(here, '../src/console/client/use-console.ts'),
    'utf8',
  );
  assert.match(
    main,
    /event\.key === 'Enter'[\s\S]*!event\.shiftKey[\s\S]*!event\.isComposing/,
  );
  assert.match(main, /<ThreadComposer state=\{state\} actions=\{actions\}/);
  assert.match(hook, /send\(\{ t: 'chat', nonce, content: value \}\)/);
  assert.match(hook, /case 'chatResult':[\s\S]*frame\.ok === false/);
  assert.match(
    hook,
    /live:\s*frame\.stream\s*\?\s*\(object\(frame\.stream\)/,
    'snapshot restores an active stream',
  );
});

test('client console has a bounded CSS-driven mobile drawer and logs view', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const main = fs.readFileSync(
    path.join(here, '../src/console/client/main.tsx'),
    'utf8',
  );
  const css = fs.readFileSync(
    path.join(here, '../src/console/client/styles.css'),
    'utf8',
  );
  assert.match(main, /drawer-scrim/);
  assert.match(main, /MobileTabs/);
  assert.match(main, /view: 'logs' as ViewName/);
  assert.match(main, /actions\.setView\(item\.view\)/);
  const mobileCss = css.slice(css.indexOf('@media'));
  assert.match(mobileCss, /@media\s*\(max-width:\s*760px\)/);
  assert.match(mobileCss, /height:\s*100dvh/);
  assert.match(mobileCss, /safe-area-inset-bottom/);
  assert.match(mobileCss, /\.mobile-tabs\s*\{[\s\S]*?display:\s*flex/);
  assert.match(
    mobileCss,
    /\.drawer-layer\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0/,
  );
  assert.match(
    mobileCss,
    /\.drawer-scrim\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*0/,
  );
});

test('classifyMessage covers every render kind', () => {
  assert.equal(
    classifyMessage({
      role: 'user',
      content:
        '<incoming-message channel="c" author="a" time="t" local-time="12:34">\nhi\n</incoming-message>',
    }),
    'user',
  );
  assert.equal(
    classifyMessage({ role: 'assistant', content: 'thinking' }),
    'assistant',
  );
  assert.equal(classifyMessage({ role: 'tool', content: '[run ok]' }), 'tool');
  assert.equal(
    classifyMessage({
      role: 'system',
      content:
        '=== Summary of earlier conversation (3 earlier messages compacted) ===\nx',
    }),
    'summary',
  );
  assert.equal(
    classifyMessage({ role: 'system', content: 'You are Echo' }),
    'system',
  );
  assert.equal(
    classifyMessage({
      role: 'user',
      content: '[harness: context compacted — 4 earlier messages...',
    }),
    'notice',
  );
});

test('run-card extraction pulls code and detail while tolerating legacy or malformed JSON', () => {
  const args = JSON.stringify({
    code: 'await elpis.sh("ls")',
    detail: 'List the working directory',
  });
  assert.equal(extractCode(args), 'await elpis.sh("ls")');
  assert.equal(extractDetail(args), 'List the working directory');
  assert.equal(extractDetail(JSON.stringify({ code: '1' })), '');
  assert.equal(extractCode('{not json'), '{not json');
  assert.equal(extractDetail('{not json'), '');
});

test('parseEnvelope extracts author + timestamp from the inbound XML envelope', () => {
  const r = parseEnvelope(
    '<incoming-message channel="agora" author="ari" time="2026-07-04T05:09:15.235Z" local-time="22:04">\nhey\n</incoming-message>',
  );
  assert.equal(r.author, 'ari');
  assert.equal(typeof r.ts, 'number');
});

test('parseEnvelope still tolerates the legacy bracket header', () => {
  const r = parseEnvelope(
    '[22:04] #agora <ari> (2026-07-04T05:09:15.235Z)\ncontent: hey',
  );
  assert.equal(r.author, 'ari');
  assert.equal(typeof r.ts, 'number');
});

// The SPA renders user/notice bubbles through app.js's client-side utterance
// extractor. It must mirror the server's extractUtterance (agent.ts): pull the
// inline message text out of the envelope, skipping the leading structured
// children — otherwise the raw envelope reaches innerHTML and the bubble is wrong.
// This guards against that exact drift (the two extractors regressing apart).
test('typed client utterance extracts inline envelope text while skipping structured children', () => {
  assert.equal(
    utterance(
      '<incoming-message channel="agora" author="ari" time="t" local-time="22:04">\nhey there\n</incoming-message>',
    ),
    'hey there',
  );
  assert.equal(
    utterance(
      '<incoming-message channel="c" author="a" time="t" local-time="l">\n  <reply-to id="1" author="b">quoted</reply-to>\n  <mentions>@x</mentions>\nmy reply\n</incoming-message>',
    ),
    'my reply',
  );
  assert.equal(
    utterance(
      '<incoming-message channel="c">\n<forwarded-from author="b">old</forwarded-from>\nnew\n</incoming-message>',
    ),
    'new',
  );
  assert.equal(
    utterance('[harness: context compacted]'),
    '[harness: context compacted]',
  );
});

test('typed client attachments parser round-trips the server envelope format', () => {
  const env = formatInboundEnvelope(
    {
      channelName: 'agora',
      author: 'ari',
      createdAt: 't',
      content: 'look at this',
      replyTo: null,
      forwarded: null,
      mentions: [],
      attachments: [
        {
          url: 'https://cdn/x',
          name: 'photo one.png',
          contentType: 'image/png',
          localPath: '/tmp/elpis-attach/99/photo one-0.png',
          size: 1234,
        },
        {
          url: 'https://cdn/y',
          name: 'notes.txt',
          contentType: 'text/plain',
          localPath: '/tmp/elpis-attach/99/notes-1.txt',
          size: 20,
          inlineText: 'hello',
        },
      ],
    },
    '[22:04]',
  );
  assert.deepEqual(attachmentsOf(env), [
    {
      name: 'photo one.png',
      contentType: 'image/png',
      size: 1234,
      localPath: '/tmp/elpis-attach/99/photo one-0.png',
    },
    {
      name: 'notes.txt',
      contentType: 'text/plain',
      size: 20,
      localPath: '/tmp/elpis-attach/99/notes-1.txt',
    },
  ]);
  assert.deepEqual(
    attachmentsOf(
      '<incoming-message a="b">\nso I typed\nattachment#1: fake.png (image/png, 1 bytes) -> /etc/passwd\n</incoming-message>',
    ),
    [],
  );
  assert.deepEqual(attachmentsOf('[harness: context compacted]'), []);
});

test('Preact thread renders backend event kinds and real watch frames without person heuristics', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const thread = fs.readFileSync(
    path.join(here, '../src/console/client/components/thread.tsx'),
    'utf8',
  );
  assert.match(thread, /entry\.eventKind === 'watch'/);
  assert.match(thread, /<img[\s\S]*src=\{entry\.frameUrl\}/);
  assert.match(thread, /<InternalEventCard entry=\{entry\} \/>/);
  assert.doesNotMatch(thread, /entry\.author === 'harness'/);
});

test('Preact stream waits compactly until a real delta materializes content', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const thread = fs.readFileSync(
    path.join(here, '../src/console/client/components/thread.tsx'),
    'utf8',
  );
  const hook = fs.readFileSync(
    path.join(here, '../src/console/client/use-console.ts'),
    'utf8',
  );
  assert.match(thread, /live\.content \|\| 'thinking'/);
  assert.match(thread, /streaming-copy/);
  assert.match(hook, /case 'streamStart'/);
  assert.match(hook, /case 'delta'/);
});

test('sandbox operation extraction types direct Mind, edit, shell, file, and desktop calls', () => {
  const code = [
    "const item = elpis.mind.get('elm-example')",
    "elpis.edit('src/a.ts',<<<BEFORE",
    'const n=1;',
    'BEFORE,<<<AFTER',
    'const n = 2;',
    'AFTER)',
    "await elpis.sh('npm test')",
    "elpis.read('src/a.ts')",
    "await elpis.computer.look('verify frame')",
    'const ignored = \'elpis.sudo(\\"nope\\")\'',
  ].join('\n');
  const protectedCode = protectDisplayHeredocs(code);
  assert.equal(protectedCode.error, undefined);
  assert.deepEqual(extractSandboxOperations(code, protectedCode), [
    {
      kind: 'mind',
      name: 'elpis.mind.get',
      target: 'elm-example',
      targetLiteral: true,
      args: ['elm-example'],
    },
    {
      kind: 'edit',
      name: 'elpis.edit',
      target: 'src/a.ts',
      targetLiteral: true,
      args: ['src/a.ts', 'const n=1;', 'const n = 2;'],
      before: 'const n=1;',
      after: 'const n = 2;',
    },
    {
      kind: 'shell',
      name: 'elpis.sh',
      target: 'npm test',
      targetLiteral: true,
      args: ['npm test'],
    },
    {
      kind: 'file',
      name: 'elpis.read',
      target: 'src/a.ts',
      targetLiteral: true,
      args: ['src/a.ts'],
    },
    {
      kind: 'computer',
      name: 'elpis.computer.look',
      target: 'verify frame',
      targetLiteral: true,
      args: ['verify frame'],
    },
  ]);
});

test('serializeMessage delivers backend-owned person, harness, and watch provenance', () => {
  const person = serializeMessage(
    {
      role: 'user',
      channel: 'friends/general',
      content:
        '<incoming-message guild="friends" channel="general" author="ari" time="2026-07-04T05:09:15.235Z">\nhello\n</incoming-message>',
    },
    1,
    null,
  );
  assert.equal(person.eventKind, 'person');
  assert.equal(person.displayName, 'ari');
  assert.equal(person.frameUrl, undefined);

  const internal = serializeMessage(
    {
      role: 'user',
      channel: 'internal',
      content: '[bg j123] finished with exit 0',
    },
    2,
    10,
  );
  assert.equal(internal.eventKind, 'background');
  assert.equal(internal.displayName, 'background job');

  const watch = serializeMessage(
    {
      role: 'user',
      channel: 'internal',
      content: [
        '<incoming-message channel="watch" author="harness" time="2026-07-04T05:09:15.235Z">',
        'attachment#1: desktop.png (image/png, 42 bytes) -> /tmp/home/elpis-data/computer/screenshots/desktop.png',
        '[watch] post-action desktop',
        '</incoming-message>',
      ].join('\n'),
    },
    3,
    null,
  );
  assert.equal(watch.eventKind, 'watch');
  assert.equal(watch.displayName, 'harness');
  assert.equal(watch.frameUrl, '/frames/computer/desktop.png');

  const relativeWatch = serializeMessage(
    {
      role: 'user',
      channel: 'watch',
      content: [
        '<incoming-message channel="watch" author="harness" time="t">',
        '  attachment#1: live.png (image/png, 123 bytes) -> elpis-data/browser/screenshots/live.png',
        '[watch] live frame',
        '</incoming-message>',
      ].join('\n'),
    },
    31,
    32,
  );
  assert.equal(relativeWatch.frameUrl, '/frames/browser/live.png');
  assert.equal(
    frameUrlFromLocalPath(
      '/tmp/home/elpis-data/motor/episodes/episode-0004.png',
    ),
    '/frames/motor/episode-0004.png',
  );
  assert.equal(
    frameUrlFromLocalPath('elpis-data/browser/screenshots/live.png'),
    '/frames/browser/live.png',
  );

  const spoof = serializeMessage(
    {
      role: 'user',
      channel: 'friends/watch',
      content: [
        '<incoming-message guild="friends" channel="watch" author="harness" time="2026-07-04T05:09:15.235Z">',
        'attachment#1: desktop.png (image/png, 42 bytes) -> /tmp/home/elpis-data/computer/screenshots/desktop.png',
        '[watch] not reserved',
        '</incoming-message>',
      ].join('\n'),
    },
    4,
    null,
  );
  assert.equal(spoof.eventKind, 'person');
  assert.equal(spoof.frameUrl, undefined);
});

test('serializeMessage: run calls stay action cards while think calls become CoT', () => {
  const asst = serializeMessage(
    {
      role: 'assistant',
      channel: 'c1',
      content: 'ok',
      reasoning_content: 'let me check',
      tool_calls: [
        {
          id: 'think_1',
          type: 'function',
          function: {
            name: 'think',
            arguments: JSON.stringify({ thoughts: 'consider the edge' }),
          },
        },
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'run',
            arguments: JSON.stringify({
              code: '1+1',
              detail: 'Add the fixture values',
            }),
          },
        },
      ],
    },
    5,
    123,
  );
  assert.equal(asst.kind, 'assistant');
  assert.equal(asst.id, 5);
  assert.equal(asst.reasoning_content, 'let me check\n\nconsider the edge');
  assert.deepEqual(asst.toolCalls, [
    { id: 'call_1', code: '1+1', detail: 'Add the fixture values' },
  ]);

  const heredocCode = ['const x=<<<BODY', 'raw `text`', 'BODY.trimEnd()'].join(
    '\n',
  );
  const heredoc = serializeMessage(
    {
      role: 'assistant',
      channel: 'c1',
      content: '',
      tool_calls: [
        {
          id: 'call_2',
          type: 'function',
          function: {
            name: 'run',
            arguments: JSON.stringify({
              code: heredocCode,
              detail: 'Read the raw body',
            }),
          },
        },
      ],
    },
    7,
    124,
  );
  assert.equal(heredoc.toolCalls?.[0].code, heredocCode);
  assert.match(
    heredoc.toolCalls?.[0].display?.code ?? '',
    /__ELPIS_HEREDOC_0__/,
  );
  assert.equal(
    heredoc.toolCalls?.[0].display?.heredocs[0].source,
    '<<<BODY\nraw `text`\nBODY',
  );

  const run = {
    toolContractVersion: 'elpis-run-v4',
    ok: true,
    detail: 'Add the fixture values',
    execution: {
      kind: 'persistent' as const,
      alias: 'quietly-crimson-ibis',
      mindId: 7,
      generation: 2,
      runId: 'exec-g2-r3',
    },
    wake: {
      kind: 'after' as const,
      state: 'armed' as const,
      requestedAt: 1,
      targetAt: 2,
      taskId: 3,
    },
  };
  const tool = serializeMessage(
    {
      role: 'tool',
      channel: 'c1',
      content: '[run ok]',
      tool_call_id: 'call_1',
      run,
      sends: [{ channel: 'agora', text: 'hi' }],
    },
    6,
    null,
  );
  assert.equal(tool.kind, 'tool');
  assert.deepEqual(tool.run, run);
  assert.deepEqual(tool.sends, [{ channel: 'agora', text: 'hi' }]);
});

test('typed wake presentation omits sandbox lifecycle from the primary surface', () => {
  const value = wakePresentation(
    {
      execution: {
        kind: 'persistent',
        lifecycle: 'ready',
        alias: 'quietly-crimson-ibis',
        mindId: 7,
        mindTitle: 'Wake contract',
        mindStatus: 'open',
        runId: 'exec-g2-r3',
      },
      detached: true,
      bgId: 'bg-4',
      wake: {
        kind: 'after',
        state: 'armed',
        targetAt: 60_000,
        taskId: 3,
        advice: { reason: 'quiet-exploration' },
      },
    },
    0,
  );
  assert.ok(value);
  assert.equal(value.reason, 'quiet exploration');
  assert.equal(value.raw, 'task #3 · after · armed');
  assert.doesNotMatch(
    JSON.stringify(value),
    /quietly-crimson-ibis|ready|Mind #7|exec-g2-r3|detached bg-4/,
  );
});

test('ConsoleHub marks only paired think separators as hidden Thread results', async () => {
  const hub = new ConsoleHub();
  hub.messageAppended({
    role: 'assistant',
    channel: 'c1',
    content: '',
    tool_calls: [
      {
        id: 'think_1',
        type: 'function',
        function: {
          name: 'think',
          arguments: JSON.stringify({ thoughts: 'private work' }),
        },
      },
    ],
  });
  hub.messageAppended({
    role: 'tool',
    channel: 'c1',
    content: '------',
    tool_call_id: 'think_1',
  });
  hub.messageAppended({
    role: 'tool',
    channel: 'c1',
    content: '------',
    tool_call_id: 'unrelated',
  });
  const client = recordingClient();
  hub.attach(stubSources());
  await hub.addClient(client);
  const messages = client.byType('snapshot')[0].messages;
  assert.equal(
    messages.find((entry: StreamEntry) => entry.tool_call_id === 'think_1')
      .kind,
    'think-result',
  );
  assert.equal(
    messages.find((entry: StreamEntry) => entry.tool_call_id === 'unrelated')
      .kind,
    'tool',
  );
  assert.equal(
    messages.find(
      (entry: StreamEntry) => entry.reasoning_content === 'private work',
    ).toolCalls,
    undefined,
  );
});

test('serializeMessage: user entry parses author + ts from the envelope when ts is null', () => {
  const e = serializeMessage(
    u('agora', 'ari', '2026-07-04T05:09:15.235Z', 'hey'),
    0,
    null,
  );
  assert.equal(e.author, 'ari');
  assert.equal(typeof e.ts, 'number');
});

test('archived reader reconstructs think-result pairing across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-think-archive-'));
  const store = createTranscriptStore(path.join(dir, 'sessions'));
  store.append(MAIN_TRANSCRIPT_ID, {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'think_archived',
        type: 'function',
        function: {
          name: 'think',
          arguments: JSON.stringify({ thoughts: 'old thought' }),
        },
      },
    ],
  });
  store.append(MAIN_TRANSCRIPT_ID, {
    role: 'tool',
    content: '------',
    tool_call_id: 'think_archived',
  });
  store.rotate(MAIN_TRANSCRIPT_ID);
  store.append(MAIN_TRANSCRIPT_ID, {
    role: 'user',
    content: 'newest file sentinel',
  });
  const reader = createArchivedReader(path.join(dir, 'sessions'));
  const page = reader.read(0, 10);
  assert.equal(
    page.find((entry) => entry.reasoning_content === 'old thought')?.kind,
    'assistant',
  );
  assert.equal(
    page.find((entry) => entry.tool_call_id === 'think_archived')?.kind,
    'think-result',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hub snapshot sends the tail window and flags hasMore when history exceeds it', async () => {
  // 70 messages > SNAPSHOT_MESSAGES (60): snapshot carries the last 60, hasMore true.
  const initial: ChatMessage[] = [];
  for (let i = 0; i < 70; i++)
    initial.push(u('c1', 'ari', '2026-07-04T05:00:00.000Z', `m${i}`));
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
  for (let i = 0; i < 70; i++)
    initial.push(u('c1', 'ari', '2026-07-04T05:00:00.000Z', `m${i}`));
  // an archived reader with two older messages (ids -2, -1)
  const archivedMsgs: StreamEntry[] = [
    serializeMessage(
      u('c1', 'ari', '2026-07-03T00:00:00.000Z', 'old0'),
      -2,
      null,
    ),
    serializeMessage(
      u('c1', 'ari', '2026-07-03T00:00:01.000Z', 'old1'),
      -1,
      null,
    ),
  ];
  const hub = new ConsoleHub(initial);
  hub.attach(
    stubSources({
      archived: (beforeId, limit) => {
        // newest archived page (beforeId 0) → both; page before -2 → none
        if (beforeId >= 0) return archivedMsgs.slice(-limit);
        return archivedMsgs.filter((m) => m.id < beforeId).slice(-limit);
      },
    }),
  );
  const client = recordingClient();
  await hub.addClient(client);

  // page 1: before id 10 (snapshot oldest) → ids 0..9
  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'backfill', reqId: 1, beforeId: 10 }),
  );
  const h1 = client.byType('history').at(-1);
  assert.equal(h1.messages[0].id, 0);
  assert.equal(h1.messages.at(-1).id, 9);
  assert.equal(h1.oldestId, 0);
  assert.equal(h1.hasMore, true, 'archived history still available below id 0');

  // page 2: before id 0 → archived negative ids
  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'backfill', reqId: 2, beforeId: 0 }),
  );
  const h2 = client.byType('history').at(-1);
  assert.deepEqual(
    h2.messages.map((m: StreamEntry) => m.id),
    [-2, -1],
  );
});

test('snapshot hasMore is true when the mirror is small but archived history exists (must-fix #1)', async () => {
  // only 5 live messages (< SNAPSHOT_MESSAGES) but there IS on-disk history: the
  // client must still be told to scroll back, or pre-restart context is unreachable.
  const initial: ChatMessage[] = [];
  for (let i = 0; i < 5; i++)
    initial.push(u('c1', 'ari', '2026-07-04T05:00:00.000Z', `m${i}`));
  const arch: StreamEntry[] = [
    serializeMessage(
      u('c1', 'ari', '2026-07-03T00:00:00.000Z', 'old'),
      -1,
      null,
    ),
  ];
  const hub = new ConsoleHub(initial);
  hub.attach(
    stubSources({ archived: (b, l) => (b >= 0 ? arch.slice(-l) : []) }),
  );
  const client = recordingClient();
  await hub.addClient(client);
  const snap = client.byType('snapshot')[0];
  assert.equal(snap.messages.length, 5);
  assert.equal(
    snap.hasMore,
    true,
    'archived history keeps scroll-back available',
  );

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
    streamId: 1,
    channel: 'console',
    content: 'hello',
    reasoning: 'holding several thoughts',
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
  assert.equal(
    client.byType('streamEnd').at(-1).streamId,
    client.byType('streamStart').at(-1).streamId,
  );
});

test('mirror entry ids are monotonic and stable across appends (not array indices)', async () => {
  const hub = new ConsoleHub([
    u('c1', 'ari', '2026-07-04T05:00:00.000Z', 'seed'),
  ]);
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
  store.append(
    MAIN_TRANSCRIPT_ID,
    u('c1', 'ari', '2026-07-03T00:00:00.000Z', 'a0'),
  );
  store.append(
    MAIN_TRANSCRIPT_ID,
    u('c1', 'ari', '2026-07-03T00:00:01.000Z', 'a1'),
  );
  store.rotate(MAIN_TRANSCRIPT_ID); // start file B
  // file B (newest — seeds the mirror, must be excluded from archived): 1 message
  store.append(
    MAIN_TRANSCRIPT_ID,
    u('c1', 'ari', '2026-07-03T01:00:00.000Z', 'b0'),
  );

  const reader = createArchivedReader(path.join(root, 'sessions'));
  const page = reader.read(0, 40);
  // only file A's two messages are archived; ids are -2, -1
  assert.equal(page.length, 2);
  assert.deepEqual(
    page.map((m) => m.id),
    [-2, -1],
  );
  assert.equal(page[0].content.includes('a0'), true);
  assert.equal(page[1].content.includes('a1'), true);
  // paging before the oldest archived id yields nothing
  assert.equal(reader.read(-2, 40).length, 0);
});

const SNAP_FIXTURE = {
  provider: 'kimi',
  label: 'Kimi',
  fetchedAt: '2026-07-21T00:00:00.000Z',
  windows: [
    {
      id: '5h',
      label: '5h',
      usedPct: 4,
      resetAt: '2026-07-22T05:36:03.631117Z',
    },
    {
      id: '7d',
      label: '7d',
      usedPct: 21,
      resetAt: '2026-07-28T19:36:03.631117Z',
    },
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
  const calls: {
    channelId: string;
    action: string;
    reason: string | undefined;
  }[] = [];
  const hub = new ConsoleHub([]);
  hub.attach(
    stubSources({
      moderate: (channelId, action, reason) => {
        calls.push({ channelId, action, reason });
        return { ok: true, note: 'channel muted' };
      },
    }),
  );
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'moderate',
      channelId: '2001',
      action: 'mute',
      reason: 'r',
    }),
  );

  assert.deepEqual(calls, [{ channelId: '2001', action: 'mute', reason: 'r' }]);
  const result = client.byType('moderateResult').at(-1);
  assert.deepEqual(result, {
    t: 'moderateResult',
    ok: true,
    note: 'channel muted',
  });
});

test('handleClientMessage: moderate never rebroadcasts a rooms frame (Agent.moderateChannel owns that)', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(
    stubSources({ moderate: () => ({ ok: true, note: 'channel muted' }) }),
  );
  const client = recordingClient();
  await hub.addClient(client);
  const roomsBefore = client.byType('rooms').length;

  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'moderate', channelId: '2001', action: 'mute' }),
  );

  assert.equal(
    client.byType('rooms').length,
    roomsBefore,
    'the hub must not broadcast rooms itself from the moderate path',
  );
});

test('handleClientMessage: moderate normalizes an empty-string or non-string reason to undefined', async () => {
  const calls: (string | undefined)[] = [];
  const hub = new ConsoleHub([]);
  hub.attach(
    stubSources({
      moderate: (_channelId, _action, reason) => {
        calls.push(reason);
        return { ok: true, note: '' };
      },
    }),
  );
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'moderate',
      channelId: '2001',
      action: 'mute',
      reason: '',
    }),
  );
  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'moderate',
      channelId: '2001',
      action: 'mute',
      reason: 123,
    }),
  );

  assert.deepEqual(calls, [undefined, undefined]);
});

test('handleClientMessage: moderate replies ok:false with a note when moderation is not wired (not silent)', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources()); // no `moderate` override — matches an un-wired mute store
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'moderate', channelId: '2001', action: 'mute' }),
  );

  assert.deepEqual(client.byType('moderateResult').at(-1), {
    t: 'moderateResult',
    ok: false,
    note: 'moderation unavailable',
  });
});

test('handleClientMessage: unknown action or missing/non-string channelId does NOT call sources.moderate', async () => {
  let called = false;
  const hub = new ConsoleHub([]);
  hub.attach(
    stubSources({
      moderate: () => {
        called = true;
        return { ok: true, note: '' };
      },
    }),
  );
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'moderate', channelId: '2001', action: 'nuke' }),
  );
  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'moderate', action: 'mute' }),
  ); // missing channelId
  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'moderate', channelId: 123, action: 'mute' }),
  ); // non-string channelId

  assert.equal(called, false);
  assert.equal(client.byType('moderateResult').length, 0);
});

test('handleClientMessage: a context frame answers with the snapshot from sources.context', async () => {
  const snapshot = {
    model: 'test-model',
    tools: [{ type: 'function', function: { name: 'run' } }],
    messages: [
      { role: 'system', content: 'You are Echo' },
      { role: 'user', content: 'hi' },
    ],
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
  hub.attach(
    stubSources({
      context: () => {
        builds++;
        return {
          model: 'm',
          tools: [],
          messages: [{ role: 'system', content: `build ${builds}` }],
        };
      },
    }),
  );
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 1 }));
  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 2 }));

  assert.equal(
    builds,
    1,
    'a back-to-back request must not trigger a second build',
  );
  const frames = client.byType('context');
  assert.equal(frames.length, 2, 'both requests are still answered');
  assert.deepEqual(frames[0].context, frames[1].context);
  assert.equal(frames[1].reqId, 2, 'the cached answer carries the new reqId');
});

test('handleClientMessage: committed history invalidates the context cache', async () => {
  let builds = 0;
  const hub = new ConsoleHub([]);
  hub.attach(
    stubSources({
      context: () => {
        builds++;
        return {
          model: 'm',
          tools: [],
          messages: [{ role: 'system', content: `build ${builds}` }],
        };
      },
    }),
  );
  const client = recordingClient();
  await hub.addClient(client);

  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 1 }));
  hub.messageAppended({ role: 'user', content: 'new committed message' });
  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 2 }));

  assert.equal(builds, 2, 'history mutation bypasses the throttle cache');
  assert.notDeepEqual(
    client.byType('context')[0].context,
    client.byType('context')[1].context,
  );
});

test('Preact Mind detail follows the rendered-first reference without v1 edit chrome', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(
    path.join(here, '../src/console/client/components/mind.tsx'),
    'utf8',
  );
  assert.match(source, /<Markdown value=\{item\.body\}/);
  assert.match(source, /class='secretary-glyph'/);
  assert.match(source, /class='mind-comments'/);
  assert.match(
    source,
    /\.sort\([\s\S]*?\(a,\s*b\)\s*=>[\s\S]*?Number\(a\.createdAt/,
  );
  assert.match(source, /item\.dependencies \?\? item\.blockedBy/);
  assert.doesNotMatch(source, /MindForm|editing|copy raw|copy\(item\.body/);
});

test('Preact context pane quietly debounces committed-message refreshes', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const hook = fs.readFileSync(
    path.join(here, '../src/console/client/use-console.ts'),
    'utf8',
  );
  const view = fs.readFileSync(
    path.join(here, '../src/console/client/components/context.tsx'),
    'utf8',
  );
  assert.match(
    hook,
    /frame\.t === 'message' && stateRef\.current\.view === 'context'/,
  );
  assert.match(hook, /contextRefreshTimer[\s\S]*window\.setTimeout[\s\S]*150/);
  assert.match(
    hook,
    /dispatch\(\{ type: 'context-request', reqId \}\)[\s\S]*send\(\{ t: 'context', reqId \}\)/,
  );
  assert.doesNotMatch(
    view,
    /scrollTop\s*=/,
    'Preact preserves the existing scroll container across context diffs',
  );
});

test('handleClientMessage: context answers null when unwired or when the source throws', async () => {
  const hub = new ConsoleHub([]);
  hub.attach(stubSources()); // no context source
  const client = recordingClient();
  await hub.addClient(client);
  hub.handleClientMessage(client, JSON.stringify({ t: 'context', reqId: 1 }));
  assert.deepEqual(client.byType('context').at(-1), {
    t: 'context',
    reqId: 1,
    context: null,
  });

  const hub2 = new ConsoleHub([]);
  hub2.attach(
    stubSources({
      context: () => {
        throw new Error('boom');
      },
    }),
  );
  const c2 = recordingClient();
  await hub2.addClient(c2);
  hub2.handleClientMessage(c2, JSON.stringify({ t: 'context', reqId: 2 }));
  assert.deepEqual(
    c2.byType('context').at(-1),
    { t: 'context', reqId: 2, context: null },
    'a throwing source degrades to null, never to a dropped frame',
  );
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

test('v2 room rail is an observational lens with no duplicate moderation authority', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const main = fs.readFileSync(
    path.join(here, '../src/console/client/main.tsx'),
    'utf8',
  );
  assert.match(
    main,
    /actions\.setRoom\(id\);[\s\S]*actions\.setView\('thread'\)/,
  );
  assert.doesNotMatch(main, /['"](?:moderate|mute|deafen|undeafen)['"]/);
});
