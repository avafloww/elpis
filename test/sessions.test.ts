// Unit tests for transcript persistence (sessions.ts).
// Verifies: append writes JSONL, rotation starts a new file,
// loadMostRecentForChannel finds a channel's newest transcript and round-trips
// messages including tool_calls/tool_call_id/reasoning_content. Run with:
// npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createTranscriptStore,
  loadMostRecentForChannel,
  parseTranscriptFile,
} from '../src/store/sessions.js';
import type { ChatMessage } from '../src/llm/llm.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sess-'));
}

function mkMsg(role: ChatMessage['role'], content: string): ChatMessage {
  return { role, content };
}

test('sessions: append writes a JSON line per message to discord/CHANNEL_ID/', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('ch1', mkMsg('user', 'hello'));
  store.append('ch1', mkMsg('assistant', 'hi there'));
  // find the file
  const dir = path.join(root, 'discord', 'ch1');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(
    files.length,
    1,
    'one transcript file per channel until rotation',
  );
  const raw = fs
    .readFileSync(path.join(dir, files[0]), 'utf8')
    .trim()
    .split('\n');
  assert.equal(raw.length, 2, 'two lines for two appends');
  const first = JSON.parse(raw[0]) as ChatMessage;
  assert.equal(first.role, 'user');
  assert.equal(first.content, 'hello');
});

test('sessions: append to a fresh channel creates its own dir', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('chA', mkMsg('user', 'a'));
  store.append('chB', mkMsg('user', 'b'));
  assert.ok(fs.existsSync(path.join(root, 'discord', 'chA')));
  assert.ok(fs.existsSync(path.join(root, 'discord', 'chB')));
});

test('sessions: rotate starts a new file; subsequent appends go to the new one', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('ch1', mkMsg('user', 'before-rotate'));
  store.rotate('ch1');
  store.append('ch1', mkMsg('user', 'after-rotate'));
  const dir = path.join(root, 'discord', 'ch1');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 2, 'rotation creates a second file');
  // the newest file should contain only the post-rotate message
  const loaded = loadMostRecentForChannel(root, 'ch1');
  assert.ok(loaded);
  assert.equal(loaded!.messages.length, 1);
  assert.equal(loaded!.messages[0].content, 'after-rotate');
});

test('sessions: loadMostRecentForChannel returns null when no transcripts exist', () => {
  const root = tmpRoot();
  assert.equal(loadMostRecentForChannel(root, 'ch1'), null);
});

test('sessions: round-trips tool_calls and tool_call_id', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'tc1',
        type: 'function',
        function: { name: 'run', arguments: '{"code":"1+1"}' },
      },
    ],
  };
  const toolMsg: ChatMessage = {
    role: 'tool',
    tool_call_id: 'tc1',
    content: '{"ok":true,"preview":"2"}',
  };
  store.append('ch1', assistantMsg);
  store.append('ch1', toolMsg);
  const loaded = loadMostRecentForChannel(root, 'ch1');
  assert.ok(loaded);
  assert.equal(loaded!.messages.length, 2);
  const a = loaded!.messages[0];
  assert.equal(a.role, 'assistant');
  assert.ok(a.tool_calls);
  assert.equal(a.tool_calls!.length, 1);
  assert.equal(a.tool_calls![0].id, 'tc1');
  assert.equal(a.tool_calls![0].function.name, 'run');
  const t = loaded!.messages[1];
  assert.equal(t.role, 'tool');
  assert.equal(t.tool_call_id, 'tc1');
});

test('sessions: round-trips bounded context resource descriptors', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  const version = 'a'.repeat(64);
  store.append('ch1', {
    role: 'tool',
    tool_call_id: 'skill-1',
    content: 'loaded instructions',
    contextResources: [
      { kind: 'skill', key: 'alpha', display: 'alpha', version },
      {
        kind: 'agents',
        key: '/real/AGENTS.md',
        display: '/AGENTS.md',
        version,
      },
    ],
  });
  const loaded = loadMostRecentForChannel(root, 'ch1');
  assert.deepEqual(loaded?.messages[0].contextResources, [
    { kind: 'skill', key: 'alpha', display: 'alpha', version },
    { kind: 'agents', key: '/real/AGENTS.md', display: '/AGENTS.md', version },
  ]);

  const file = loaded!.path;
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      role: 'tool',
      content: 'bad metadata',
      contextResources: [
        { kind: 'agents', key: '/x', display: '/x', version: 'not-a-hash' },
        { kind: 'other', key: 'x', display: 'x', version },
      ],
    })}\n`,
  );
  const reparsed = parseTranscriptFile(file);
  assert.equal(reparsed.at(-1)?.contextResources, undefined);
});

test('sessions: round-trips Anthropic thinking_blocks (signed + redacted)', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  const msg: ChatMessage = {
    role: 'assistant',
    content: 'answer',
    thinking_blocks: [
      { type: 'thinking', thinking: 'reasoning text', signature: 'sig-abc' },
      { type: 'redacted_thinking', data: 'ENC' },
    ],
  };
  store.append('ch1', msg);
  const loaded = loadMostRecentForChannel(root, 'ch1');
  assert.ok(loaded);
  const a = loaded!.messages[0];
  assert.deepEqual(a.thinking_blocks, [
    { type: 'thinking', thinking: 'reasoning text', signature: 'sig-abc' },
    { type: 'redacted_thinking', data: 'ENC' },
  ]);
});

test('sessions: parseTranscriptFile skips malformed lines', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'discord', 'ch1');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'broken.jsonl');
  fs.writeFileSync(
    f,
    [
      JSON.stringify(mkMsg('user', 'good')),
      'this is not json',
      JSON.stringify(mkMsg('assistant', 'also good')),
      '{"role":"user","content":42}', // bad content type
      '{"role":"potato","content":"bad role"}', // bad role
      '',
    ].join('\n') + '\n',
  );
  const msgs = parseTranscriptFile(f);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].content, 'good');
  assert.equal(msgs[1].content, 'also good');
});

test('sessions: falsy channelId is a no-op (no channel bound yet)', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('', mkMsg('user', 'no channel'));
  assert.ok(!fs.existsSync(path.join(root, 'discord')));
  store.rotate(''); // must not throw
});

test('sessions: loadMostRecentForChannel returns null for an empty (zero-message) file', () => {
  const root = tmpRoot();
  const dir = path.join(root, 'discord', 'ch1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  assert.equal(loadMostRecentForChannel(root, 'ch1'), null);
});

test('sessions: round-trips reasoning_content on assistant messages', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  const reasoning =
    'I should use elpis.channel().send() to deliver this message to the user, since assistant content is not visible.';
  const assistantMsg: ChatMessage = {
    role: 'assistant',
    content: '',
    reasoning_content: reasoning,
    tool_calls: [
      {
        id: 'tc1',
        type: 'function',
        function: {
          name: 'run',
          arguments: JSON.stringify({ code: 'elpis.channel().send("hi")' }),
        },
      },
    ],
  };
  store.append('ch1', assistantMsg);
  const loaded = loadMostRecentForChannel(root, 'ch1');
  assert.ok(loaded);
  assert.equal(loaded!.messages.length, 1);
  const a = loaded!.messages[0];
  assert.equal(a.role, 'assistant');
  assert.equal(
    a.reasoning_content,
    reasoning,
    'reasoning_content must survive the transcript round-trip',
  );
  assert.ok(a.tool_calls, 'tool_calls also preserved');
});

test('sessions: assistant messages without reasoning_content load without the field', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('ch1', mkMsg('assistant', 'just a reply'));
  const loaded = loadMostRecentForChannel(root, 'ch1');
  assert.ok(loaded);
  assert.equal(loaded!.messages[0].reasoning_content, undefined);
});

test('sessions: channel stamp + sends round-trip (V1 whitelist, review N6)', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  const user: ChatMessage = { role: 'user', content: 'hi', channel: '12345' };
  const tool: ChatMessage = {
    role: 'tool',
    tool_call_id: 't1',
    content: '[run ok]',
    channel: 'internal',
    sends: [{ channel: '12345', text: 'delivered' }],
  };
  store.append('main', user);
  store.append('main', tool);
  const loaded = loadMostRecentForChannel(root, 'main');
  assert.ok(loaded);
  assert.equal(loaded!.messages[0].channel, '12345', 'channel stamp restored');
  assert.equal(loaded!.messages[1].channel, 'internal');
  assert.deepEqual(
    loaded!.messages[1].sends,
    [{ channel: '12345', text: 'delivered' }],
    'sends restored',
  );
});

test('sessions: run execution and wake metadata round-trip', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  const tool: ChatMessage = {
    role: 'tool',
    tool_call_id: 'run-1',
    content: '[run ok]',
    run: {
      toolContractVersion: 'elpis-run-v3',
      ok: true,
      execution: {
        kind: 'persistent',
        lifecycle: 'ready',
        alias: 'quietly-crimson-ibis',
        mindId: 'elm-a2b3k7q9',
        executorId: 'executor-1',
        generation: 2,
        runId: 'executor-1:g2:r4',
        statusReminder: true,
      },
      operationReceipts: [
        {
          sequence: 0,
          kind: 'shell',
          name: 'sh',
          command: 'printf persisted',
          state: 'completed',
          startedAt: 900,
          durationMs: 10,
          ok: true,
          code: 0,
          signal: null,
          stdout: 'persisted',
          stdoutBytes: 9,
          stderrBytes: 0,
        },
      ],
      wake: {
        kind: 'after',
        state: 'armed',
        requestedAt: 1000,
        targetAt: 2000,
        taskId: 9,
      },
    },
  };
  store.append('main', tool);
  const loaded = loadMostRecentForChannel(root, 'main');
  assert.ok(loaded);
  assert.deepEqual(loaded!.messages[0].run, tool.run);
});

test('sessions: failed sentinel rotation retains the old active transcript', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sessions-'));
  let failSentinel = true;
  const store = createTranscriptStore(root, {
    writeFileSync(file, data, options) {
      if (failSentinel) throw new Error('injected sentinel failure');
      fs.writeFileSync(file, data, options);
    },
  });
  store.append('main', { role: 'user', content: 'before failed clear' });
  assert.throws(() => store.rotate('main', true), /injected sentinel failure/);
  failSentinel = false;
  store.append('main', { role: 'assistant', content: 'after failed clear' });

  assert.deepEqual(
    loadMostRecentForChannel(root, 'main')?.messages.map(
      (message) => message.content,
    ),
    ['before failed clear', 'after failed clear'],
  );
});

test('sessions: rotate with sentinel writes an empty newest file (clear honored)', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('main', mkMsg('user', 'pre-clear content'));
  store.rotate('main', true); // /clear
  // The newest file is now empty → boot loads nothing (does not resurrect).
  assert.equal(
    loadMostRecentForChannel(root, 'main'),
    null,
    'clear sentinel prevents resurrection',
  );
});

test('sessions: adopt continues an existing file so restart-resume keeps prior context', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('main', mkMsg('user', 'first-boot message 1'));
  store.append('main', mkMsg('assistant', 'first-boot reply 1'));

  // Simulate a restart: a fresh store loads the newest file and ADOPTS it, then
  // appends. Without adopt, the append mints a new file and the two prior
  // messages are stranded (lost from context on the NEXT boot).
  const loaded = loadMostRecentForChannel(root, 'main');
  assert.ok(loaded);
  const store2 = createTranscriptStore(root);
  store2.adopt('main', loaded!.path);
  store2.append('main', mkMsg('user', 'second-boot message'));

  // The next boot must see ALL THREE messages in one file.
  const reloaded = loadMostRecentForChannel(root, 'main');
  assert.ok(reloaded);
  assert.equal(
    reloaded!.messages.length,
    3,
    'adopted file carries prior + new messages',
  );
  assert.equal(reloaded!.messages[2].content, 'second-boot message');
  // exactly one transcript file exists (no stranded fresh file)
  const files = fs
    .readdirSync(path.join(root, 'discord', 'main'))
    .filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, 'no second file minted');
});

test('sessions: transcript tree and files are private, including pre-existing paths', () => {
  const root = tmpRoot();
  const channel = path.join(root, 'discord', 'main');
  fs.mkdirSync(channel, { recursive: true, mode: 0o755 });
  fs.chmodSync(root, 0o755);
  fs.chmodSync(path.join(root, 'discord'), 0o755);
  fs.chmodSync(channel, 0o755);
  const old = path.join(channel, 'old.jsonl');
  fs.writeFileSync(old, JSON.stringify(mkMsg('user', 'old')) + '\n', {
    mode: 0o644,
  });
  fs.chmodSync(old, 0o644);

  const store = createTranscriptStore(root);
  store.append('main', mkMsg('assistant', 'new'));

  assert.equal(fs.statSync(root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'discord')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(channel).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(channel)) {
    assert.equal(fs.statSync(path.join(channel, name)).mode & 0o777, 0o600);
  }
});

test('sessions: person-context metadata round-trips with validation', () => {
  const root = tmpRoot();
  const store = createTranscriptStore(root);
  store.append('people', {
    role: 'user',
    content: 'profile',
    personContext: { kind: 'memory', authorId: '111', author: 'Bramble' },
  });
  const loaded = loadMostRecentForChannel(root, 'people');
  assert.deepEqual(loaded?.messages[0].personContext, {
    kind: 'memory',
    authorId: '111',
    author: 'Bramble',
  });

  const malformed = path.join(root, 'malformed-person.jsonl');
  fs.writeFileSync(
    malformed,
    [
      JSON.stringify({
        role: 'user',
        content: 'bad kind',
        personContext: { kind: 'other', authorId: '1', author: 'A' },
      }),
      JSON.stringify({
        role: 'assistant',
        content: 'wrong role',
        personContext: { kind: 'memory', authorId: '1', author: 'A' },
      }),
    ].join('\n'),
  );
  const parsed = parseTranscriptFile(malformed);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].personContext, undefined);
  assert.equal(parsed[1].personContext, undefined);
});
