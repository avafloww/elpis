import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  build,
  buildPersonMemoryContent,
  loadPeopleFiles,
} from '../src/llm/prompt.js';
import { toApiMessage, type ChatMessage } from '../src/llm/llm.js';
import { toResponsesInput } from '../src/llm/responses.js';
import { type InboundMessage } from '../src/agent.js';
import { buildTestAgent, EMPTY_WAKE, makeStubLLM } from './helpers.js';

function tmpDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'people-inject-'));
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  return dir;
}

function writePerson(
  dir: string,
  slug: string,
  ids: string[],
  facts: string,
): void {
  const idsStr = ids.length ? `[${ids.join(', ')}]` : '[]';
  fs.mkdirSync(path.join(dir, 'people'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'people', `${slug}.md`),
    `---\nname: ${slug}\nids: ${idsStr}\n---\n\n${facts}\n`,
  );
}

function inbound(
  authorId: string,
  author: string,
  id: string,
  wakeClass?: 'direct' | 'ambient',
): InboundMessage {
  return {
    id,
    channelId: '100',
    channelName: 'general',
    author,
    authorId,
    content: `message ${id}`,
    createdAt: new Date().toISOString(),
    replyTo: null,
    forwarded: false,
    mentions: [],
    attachments: [],
    wakeClass,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('timed out waiting for agent');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('person-memory renderer requires exact Discord id and withholds colliding names', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'ID_MATCH_FACT');
  writePerson(dir, 'clover', ['discord:222'], 'PRIVATE_CLOVER_FACT');
  const files = loadPeopleFiles(dir);
  assert.match(
    buildPersonMemoryContent(files, { authorId: '111', author: 'Elsewhere' }),
    /ID_MATCH_FACT/,
  );
  const collision = buildPersonMemoryContent(files, {
    authorId: '999',
    author: 'Clover',
  });
  assert.doesNotMatch(collision, /PRIVATE_CLOVER_FACT/);
  assert.match(collision, /profile withheld/);
  assert.match(collision, /not linked to discord:999/);
  assert.match(
    buildPersonMemoryContent(files, { authorId: '222', author: 'Clover' }),
    /PRIVATE_CLOVER_FACT/,
  );
  const missing = buildPersonMemoryContent(files, {
    authorId: '333',
    author: 'New Person',
  });
  assert.match(missing, /no people\/ file yet for new-person/);
  assert.match(missing, /memory\.person\('new-person'/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('person-memory renderer bounds each profile message', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'large', ['discord:1'], 'x'.repeat(8000));
  const rendered = buildPersonMemoryContent(loadPeopleFiles(dir), {
    authorId: '1',
    author: 'Large',
  });
  assert.equal(rendered.length, 4000);
  assert.match(rendered, /truncated to bound context growth/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('system prompt never embeds participant profiles', () => {
  const prompt = build({
    soul: '',
    memory: '',
    now: '',
    harnessRoot: '/x',
    dataDirectory: '/y',
  });
  assert.doesNotMatch(prompt, /## People here/);
  assert.doesNotMatch(prompt, /person-memory — first appearance/);
  assert.match(prompt, /A `\[person-memory …\]` history message is/);
});

test('first real inbound appends one profile before the inbound and keeps the system prefix stable', async () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'DURABLE_BRAMBLE_FACT');
  writePerson(dir, 'rowan', ['discord:222'], 'UNRELATED_ROWAN_FACT');
  const requests: ChatMessage[][] = [];
  const llm = makeStubLLM({
    complete: async (messages) => {
      requests.push(messages.map((m) => ({ ...m })));
      return EMPTY_WAKE;
    },
  });
  const { agent, cleanup } = buildTestAgent({ dir, llm });
  void agent.loop();
  agent.enqueue(inbound('111', 'Bramble', 'm1'));
  await waitFor(() => requests.length >= 1);
  agent.enqueue(inbound('111', 'Bramble', 'm2'));
  await waitFor(() => requests.length >= 2);
  agent.enqueue(inbound('222', 'Rowan', 'm3'));
  await waitFor(() => requests.length >= 3);
  agent.stop();

  const history = requests[2].slice(1);
  const profiles = history.filter((m) => m.personContext?.kind === 'memory');
  const inbounds = history.filter((m) => m.personContext?.kind === 'inbound');
  assert.equal(profiles.length, 2);
  assert.equal(inbounds.length, 3);
  assert.ok(history.indexOf(profiles[0]) < history.indexOf(inbounds[0]));
  assert.ok(history.indexOf(profiles[1]) < history.indexOf(inbounds[2]));
  assert.match(profiles[0].content, /DURABLE_BRAMBLE_FACT/);
  assert.match(profiles[1].content, /UNRELATED_ROWAN_FACT/);
  assert.equal(requests[0][0].content, requests[1][0].content);
  assert.equal(
    requests[1][0].content,
    requests[2][0].content,
    'a new participant must not move messages[0]',
  );
  cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ambient multi-speaker batches inject each profile before first inbound and ignore the synthetic tick identity', async () => {
  const dir = tmpDataDir();
  writePerson(dir, 'abe', ['discord:1'], 'ABE_FACT');
  writePerson(dir, 'clover', ['discord:2'], 'CLOVER_FACT');
  let calls = 0;
  const llm = makeStubLLM({
    complete: async () => {
      calls++;
      return EMPTY_WAKE;
    },
  });
  const { agent, cleanup } = buildTestAgent({ dir, llm });
  void agent.loop();
  agent.enqueue(inbound('1', 'Abe', 'a1', 'ambient'));
  agent.enqueue(inbound('2', 'Clover', 'c1', 'ambient'));
  agent.enqueue({
    ...inbound('harness', 'harness', 'tick'),
    kind: 'heartbeat',
    channelId: 'internal',
    channelName: 'internal',
  });
  await waitFor(
    () =>
      agent.messagesForTest.filter((m) => m.personContext?.kind === 'inbound')
        .length === 2,
  );
  agent.stop();
  assert.equal(calls, 1);
  const marked = agent.messagesForTest.filter((m) => m.personContext);
  assert.deepEqual(
    marked.map((m) => `${m.personContext?.kind}:${m.personContext?.authorId}`),
    ['memory:1', 'inbound:1', 'memory:2', 'inbound:2'],
  );
  cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('restored profile metadata prevents duplicate injection after restart', async () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'RESTORED_FACT');
  const initialMessages: ChatMessage[] = [
    {
      role: 'user',
      content: '[person-memory]',
      channel: 'internal',
      personContext: { kind: 'memory', authorId: '111', author: 'Bramble' },
    },
    {
      role: 'user',
      content: '<incoming-message>old</incoming-message>',
      channel: '100',
      personContext: { kind: 'inbound', authorId: '111', author: 'Bramble' },
    },
  ];
  const { agent, cleanup } = buildTestAgent({
    dir,
    agentDeps: { initialMessages },
  });
  void agent.loop();
  agent.enqueue(inbound('111', 'Bramble', 'm2'));
  await waitFor(() =>
    agent.messagesForTest.some(
      (m) => m.personContext?.kind === 'inbound' && m.content.includes('m2'),
    ),
  );
  agent.stop();
  assert.equal(
    agent.messagesForTest.filter((m) => m.personContext?.kind === 'memory')
      .length,
    1,
  );
  cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('compaction refreshes retained identities and ages out absent profiles', () => {
  const dir = tmpDataDir();
  writePerson(dir, 'bramble', ['discord:111'], 'OLD_FACT');
  writePerson(dir, 'rowan', ['discord:222'], 'ROWAN_FACT');
  const { agent, cleanup } = buildTestAgent({ dir });
  writePerson(dir, 'bramble', ['discord:111'], 'REFRESHED_FACT');
  agent.messagesForTest.push(
    {
      role: 'user',
      content: 'retained inbound',
      personContext: { kind: 'inbound', authorId: '111', author: 'Bramble' },
    },
    {
      role: 'user',
      content: 'old bramble profile',
      personContext: { kind: 'memory', authorId: '111', author: 'Bramble' },
    },
    {
      role: 'user',
      content: 'orphan rowan profile',
      personContext: { kind: 'memory', authorId: '222', author: 'Rowan' },
    },
  );
  (agent as unknown as { onCompaction(): void }).onCompaction();
  const profiles = agent.messagesForTest.filter(
    (m) => m.personContext?.kind === 'memory',
  );
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].personContext?.authorId, '111');
  assert.match(profiles[0].content, /REFRESHED_FACT/);
  assert.doesNotMatch(profiles[0].content, /OLD_FACT|ROWAN_FACT/);
  const inboundIndex = agent.messagesForTest.findIndex(
    (m) => m.personContext?.kind === 'inbound',
  );
  assert.equal(
    agent.messagesForTest[inboundIndex - 1],
    profiles[0],
    'refreshed profile precedes the first retained inbound',
  );
  cleanup();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('person metadata is harness-only and absent from provider wire objects', () => {
  const wire = toApiMessage({
    role: 'user',
    content: 'profile content',
    personContext: { kind: 'memory', authorId: '111', author: 'Bramble' },
  });
  assert.deepEqual(wire, { role: 'user', content: 'profile content' });
  assert.deepEqual(
    toResponsesInput([
      {
        role: 'user',
        content: 'profile content',
        personContext: { kind: 'memory', authorId: '111', author: 'Bramble' },
      },
    ]),
    [{ role: 'user', content: 'profile content' }],
  );
});
