import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  ConsoleHub,
  type HubClient,
  type HubSources,
} from '../src/console/hub.js';
import { runMigrations } from '../src/store/db.js';
import { MindService } from '../src/store/mind.js';
import { makeConfig } from './helpers.js';

class Client implements HubClient {
  closed = false;
  frames: any[] = [];
  send(data: string) {
    this.frames.push(JSON.parse(data));
  }
}

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  let next = 1;
  const tasks = new Map<number, any>();
  const scheduler = {
    create(opts: any) {
      const row = { id: next++, ...opts };
      tasks.set(row.id, row);
      return row;
    },
    delete(id: number) {
      return tasks.delete(id);
    },
    update(id: number, patch: any) {
      const row = tasks.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };
  const hub = new ConsoleHub();
  const mind = new MindService({
    db,
    scheduler,
    logger: makeConfig().logger,
    onChanged: () => hub.mindChanged(),
  });
  const sources: HubSources = {
    usage: () =>
      ({
        tokens: 0,
        maxTokens: 1,
        triggerTokens: 1,
        byRoom: [],
        cache: null,
      }) as any,
    rooms: () => [],
    participants: () => 0,
    meta: () => ({
      gitHash: 'x',
      treeClean: true,
      uptimeMs: 1,
      model: 'test',
      botTag: 'aster',
    }),
    archived: () => [],
    subUsage: () => null,
    mind,
  };
  hub.attach(sources);
  return { db, hub, mind, tasks };
}

test('console snapshot includes the authoritative mind snapshot', async () => {
  const { db, hub, mind } = setup();
  mind.create({ title: 'one true thing' });
  const client = new Client();
  await hub.addClient(client);
  const snapshot = client.frames.find((x) => x.t === 'snapshot');
  assert.equal(snapshot.mind.available, true);
  assert.equal(snapshot.mind.items[0].title, 'one true thing');
  assert.equal(snapshot.mind.stats.ready, 1);
  db.close();
});

test('console mind mutations broadcast snapshots and return affected records', async () => {
  const { db, hub } = setup();
  const client = new Client();
  await hub.addClient(client);
  client.frames.length = 0;
  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'mind',
      op: 'create',
      reqId: 1,
      item: { title: 'build the pane', tags: ['console'] },
    }),
  );
  const result = client.frames.find((x) => x.t === 'mindResult');
  assert.equal(result.ok, true);
  assert.equal(result.result.title, 'build the pane');
  assert.ok(
    client.frames.some((x) => x.t === 'mindSnapshot' && x.items.length === 1),
  );

  client.frames.length = 0;
  hub.handleClientMessage(
    client,
    JSON.stringify({ t: 'mind', op: 'get', reqId: 2, id: result.result.id }),
  );
  assert.equal(client.frames[0].t, 'mindDetail');
  assert.equal(client.frames[0].item.tags[0], 'console');
  db.close();
});

test('console supports comments, links, reminders and teachable failures', async () => {
  const { db, hub, mind, tasks } = setup();
  const first = mind.create({ title: 'first' });
  const second = mind.create({ title: 'second' });
  const client = new Client();
  await hub.addClient(client);
  client.frames.length = 0;

  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'mind',
      op: 'link',
      reqId: 1,
      id: second.id,
      dependsOn: first.id,
    }),
  );
  assert.equal(client.frames.at(-1).ok, true);
  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'mind',
      op: 'comment',
      reqId: 2,
      id: second.id,
      body: 'waiting on the foundation',
    }),
  );
  assert.equal(client.frames.at(-1).ok, true);
  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'mind',
      op: 'remind',
      reqId: 3,
      id: second.id,
      at: Date.now() + 60_000,
    }),
  );
  assert.equal(client.frames.at(-1).ok, true);
  assert.equal(tasks.size, 1);

  hub.handleClientMessage(
    client,
    JSON.stringify({
      t: 'mind',
      op: 'link',
      reqId: 4,
      id: first.id,
      dependsOn: second.id,
    }),
  );
  const failure = client.frames.at(-1);
  assert.equal(failure.ok, false);
  assert.match(failure.error, /cycle/);
  assert.equal(
    mind.get(second.id)!.comments[0].body,
    'waiting on the foundation',
  );
  db.close();
});

test('console mind unavailable and malformed operations do not throw', async () => {
  const hub = new ConsoleHub();
  hub.attach({
    usage: () => ({}) as any,
    rooms: () => [],
    participants: () => 0,
    meta: () => ({}) as any,
    archived: () => [],
    subUsage: () => null,
  });
  const client = new Client();
  await hub.addClient(client);
  assert.doesNotThrow(() =>
    hub.handleClientMessage(
      client,
      JSON.stringify({ t: 'mind', op: 'snapshot', reqId: 9 }),
    ),
  );
  const result = client.frames.at(-1);
  assert.equal(result.ok, false);
  assert.match(result.error, /unavailable/);
});
