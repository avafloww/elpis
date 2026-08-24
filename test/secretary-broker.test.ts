import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/store/db.js';
import { MindStore } from '../src/store/mind.js';
import { secretaryControlTokenDigest } from '../src/secretary/session.js';
import {
  SECRETARY_MIND_MAX_RESPONSE_CHARS,
  SecretaryMindBroker,
  SecretaryMindError,
} from '../src/secretary/mind.js';
import {
  SecretaryCompletionBroker,
  SecretaryCompletionError,
} from '../src/secretary/completion.js';
import { SECRETARY_MIND_TOOL } from '../src/secretary/tool.js';
import { makeConfig } from './helpers.js';
import { createLlmModelRegistry } from '../src/llm/model-registry.js';
import type { LLM, CompleteOptions } from '../src/llm/llm.js';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-broker-'));
  const db = openDatabase(dir);
  const now = Date.now();
  for (const [id, parent] of [
    ['elm-root0001', null],
    ['elm-child001', 'elm-root0001'],
    ['elm-sibling1', null],
  ] as const)
    db.prepare(
      `INSERT INTO mind_items (id,title,body,kind,status,priority,parent_id,created_by,created_at,updated_at) VALUES (?,?,?,'task','open',2,?,'agent',?,?)`,
    ).run(id, id, `body ${id}`, parent, now, now);
  db.prepare(
    "INSERT INTO mind_comments (item_id,author,body,created_at) VALUES ('elm-child001','agent','useful detail',?)",
  ).run(now);
  const token = 's'.repeat(43);
  db.prepare(
    `INSERT INTO secretary_sessions (id,hint_mind_id,status,model_ref,runtime,control_token_digest,created_at,updated_at) VALUES (?,?,?,?, 'kubernetes',?,?,?)`,
  ).run(
    'sec-' + 'a'.repeat(22),
    'elm-root0001',
    'ready',
    'p/secretary',
    secretaryControlTokenDigest(token),
    now,
    now,
  );
  return { dir, db, token };
}
function close(f: ReturnType<typeof fixture>) {
  f.db.close();
  fs.rmSync(f.dir, { recursive: true, force: true });
}

test('secretary Mind reads globally while an optional hint remains prompt context', () => {
  const f = fixture();
  const broker = new SecretaryMindBroker(f.db, new MindStore(f.db));
  assert.equal(broker.get(f.token).item.id, 'elm-root0001');
  assert.equal(
    broker.get(f.token, 'elm-child001').item.comments[0].body,
    'useful detail',
  );
  assert.equal(broker.get(f.token, 'elm-sibling1').item.id, 'elm-sibling1');
  assert.deepEqual(
    broker.tree(f.token).items.map((i) => i.id),
    ['elm-root0001', 'elm-child001'],
  );

  f.db.exec('DROP TRIGGER secretary_sessions_identity_no_update');
  f.db
    .prepare('UPDATE secretary_sessions SET hint_mind_id=NULL WHERE id=?')
    .run('sec-' + 'a'.repeat(22));
  assert.throws(
    () => broker.get(f.token),
    (e) => e instanceof SecretaryMindError && e.code === 'invalid_request',
  );
  assert.equal(broker.get(f.token, 'elm-sibling1').item.id, 'elm-sibling1');

  f.db
    .prepare("UPDATE secretary_sessions SET status='closed' WHERE id=?")
    .run('sec-' + 'a'.repeat(22));
  assert.throws(
    () => broker.get(f.token, 'elm-sibling1'),
    (e) => e instanceof SecretaryMindError && e.code === 'unauthorized',
  );
  close(f);
});

test('secretary lists globally and writes only attributed comments and replies', () => {
  const f = fixture();
  const broker = new SecretaryMindBroker(f.db, new MindStore(f.db));
  const listed = broker.list(f.token, {
    query: 'sibling1',
    limit: 10,
    offset: 0,
  });
  assert.deepEqual(
    listed.items.map((item) => item.id),
    ['elm-sibling1'],
  );
  assert.equal(Object.hasOwn(listed.items[0], 'body'), false);
  assert.equal(typeof listed.items[0].bodyPreview, 'string');
  assert.equal(typeof listed.items[0].bodyTruncated, 'boolean');
  const written = broker.comment(
    f.token,
    'elm-sibling1',
    'Secretary found a relevant follow-up.',
  );
  assert.equal(
    written.comment.author,
    `secretary:${written.binding.sessionId}`,
  );
  assert.equal(
    written.item.comments.at(-1)?.body,
    'Secretary found a relevant follow-up.',
  );
  const replied = broker.reply(
    f.token,
    'elm-sibling1',
    written.comment.id,
    'Bounded reply.',
  );
  assert.equal(replied.comment.replyToId, written.comment.id);
  assert.equal(
    replied.comment.author,
    `secretary:${replied.binding.sessionId}`,
  );
  const events = f.db
    .prepare(
      "SELECT actor, type FROM mind_events WHERE item_id='elm-sibling1' AND type='comment.added' ORDER BY id",
    )
    .all() as Array<{ actor: string; type: string }>;
  assert.equal(events.length, 2);
  assert.ok(
    events.every(
      (event) => event.actor === `secretary:${written.binding.sessionId}`,
    ),
  );
  const activity = new MindStore(f.db).secretaryActivity(0, 2);
  assert.deepEqual(
    activity.events.map((event) => ({
      itemId: event.itemId,
      body: event.body,
      replyToId: event.replyToId,
    })),
    [
      {
        itemId: 'elm-sibling1',
        body: 'Secretary found a relevant follow-up.',
        replyToId: null,
      },
      {
        itemId: 'elm-sibling1',
        body: 'Bounded reply.',
        replyToId: written.comment.id,
      },
    ],
  );
  assert.throws(
    () =>
      broker.reply(f.token, 'elm-root0001', written.comment.id, 'wrong item'),
    (error) =>
      error instanceof SecretaryMindError && error.code === 'invalid_request',
  );
  close(f);
});

test('secretary proposal creation derives attribution and preserves proposal invariants', () => {
  const f = fixture();
  const broker = new SecretaryMindBroker(f.db, new MindStore(f.db));
  const created = broker.propose(f.token, {
    title: 'Review this candidate',
    body: 'As submitted through the bounded secretary lane.',
    kind: 'idea',
    priority: 1,
    parentId: 'elm-sibling1',
    tags: ['secretary-intake'],
  });
  assert.equal(created.item.status, 'proposal');
  assert.equal(
    created.item.createdBy,
    `secretary:${created.binding.sessionId}`,
  );
  assert.equal(created.item.parentId, 'elm-sibling1');
  assert.equal(created.item.dueAt, null);
  assert.deepEqual(created.item.blockedBy, []);
  assert.deepEqual(created.item.tags, ['secretary-intake']);
  const event = f.db
    .prepare(
      "SELECT actor, data_json FROM mind_events WHERE item_id=? AND type='item.created'",
    )
    .get(created.item.id) as { actor: string; data_json: string };
  assert.equal(event.actor, `secretary:${created.binding.sessionId}`);
  assert.deepEqual(
    {
      status: JSON.parse(event.data_json).status,
      body: JSON.parse(event.data_json).body,
      proposalIntake: JSON.parse(event.data_json).proposalIntake,
    },
    {
      status: 'proposal',
      body: 'As submitted through the bounded secretary lane.',
      proposalIntake: {
        requester: 'conversation-user',
        source: 'secretary',
        sessionId: created.binding.sessionId,
      },
    },
  );
  close(f);
});

test('secretary Mind fails closed when a detail exceeds the response bound', () => {
  const f = fixture();
  const broker = new SecretaryMindBroker(f.db, new MindStore(f.db));
  f.db
    .prepare("UPDATE mind_items SET body=? WHERE id='elm-root0001'")
    .run('x'.repeat(SECRETARY_MIND_MAX_RESPONSE_CHARS + 1));
  assert.throws(
    () => broker.get(f.token),
    (e) => e instanceof SecretaryMindError && e.code === 'too_large',
  );
  close(f);
});

test('secretary completion binds model, fixed Mind tool, capacity and one-in-flight', async () => {
  const f = fixture();
  const config = makeConfig();
  config.llm.registry = createLlmModelRegistry({
    providers: {
      p: {
        providerType: 'openai-compatible',
        apiKey: 'x',
        baseUrl: 'https://example.test/v1',
        api: 'responses',
        externalThinking: false,
        streamIdleTimeoutMs: 1000,
        callTimeoutMs: 1000,
        models: {
          secretary: {
            name: 'wire-secretary',
            contextSize: 10000,
            reasoningEffort: null,
            reasoningSummary: null,
            reasoningContext: null,
          },
        },
      },
    },
    roles: {
      main: 'p/secretary',
      classifier: 'p/secretary',
      motor: null,
      secretary: 'p/secretary',
    },
  });
  config.llm.registrySource = 'canonical';
  const pending = Promise.withResolvers<any>();
  let options: CompleteOptions | undefined;
  const fake: LLM = {
    model: 'wire-secretary',
    runTool: {} as never,
    complete: async (_m, o) => {
      options = o;
      return pending.promise;
    },
    summarize: async () => {
      throw new Error('no');
    },
  };
  const broker = new SecretaryCompletionBroker({
    db: f.db,
    config,
    maxConcurrent: 1,
    create(projected) {
      assert.equal(projected.llm.model, 'wire-secretary');
      return fake;
    },
  });
  const first = broker.complete(f.token, [
    { role: 'user', content: 'synthesize' },
  ]);
  await assert.rejects(
    () => broker.complete(f.token, [{ role: 'user', content: 'again' }]),
    (e) => e instanceof SecretaryCompletionError && e.code === 'busy',
  );
  const secondToken = 't'.repeat(43);
  f.db
    .prepare(
      `INSERT INTO secretary_sessions (id,hint_mind_id,status,model_ref,runtime,control_token_digest,created_at,updated_at) VALUES (?,?,?,?, 'kubernetes',?,?,?)`,
    )
    .run(
      'sec-' + 'b'.repeat(22),
      'elm-sibling1',
      'ready',
      'p/secretary',
      secretaryControlTokenDigest(secondToken),
      Date.now(),
      Date.now(),
    );
  await assert.rejects(
    () => broker.complete(secondToken, [{ role: 'user', content: 'other' }]),
    (e) => e instanceof SecretaryCompletionError && e.code === 'capacity',
  );
  assert.equal(options?.runTool, SECRETARY_MIND_TOOL);
  assert.equal((options?.runTool as any).function.name, 'mind');
  pending.resolve({
    message: { role: 'assistant', content: 'ok' },
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    stripped: false,
  });
  assert.equal((await first).binding.modelRef, 'p/secretary');
  close(f);
});
