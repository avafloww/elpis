import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { noopLogger, type Logger } from '../src/lib/log.js';
import { SecretaryConversationStore } from '../src/secretary/conversation.js';
import { startSecretarySupervisor } from '../src/secretary/supervisor.js';
import { SecretarySessionStore } from '../src/secretary/session.js';
import type { SecretaryPodRuntime } from '../src/secretary/spawn.js';
import { openDatabase } from '../src/store/db.js';
import { MindService } from '../src/store/mind.js';
import { Scheduler } from '../src/store/scheduler.js';
import type { MindId } from '../src/store/mind-id.js';
import { makeConfig } from './helpers.js';

const ROOT = 'elm-000000a1' as MindId;

function fixture(enabled: boolean) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-supervisor-'));
  const db = openDatabase(data);
  const config = makeConfig();
  config.secretary.enabled = enabled;
  config.secretary.kubernetes.brokerUrl = 'https://broker.example.com';
  config.llm.registry.roles.secretary = config.llm.registry.roles.main;
  db.prepare(
    `INSERT INTO mind_items
       (id,title,body,kind,status,priority,created_by,created_at,updated_at,closed_at,archived_at)
     VALUES (?,?,'','task','open',2,'test',1,1,NULL,NULL)`,
  ).run(ROOT, 'Secretary root');
  const logs: string[] = [];
  const logger: Logger = {
    ...noopLogger,
    info: (message) => logs.push(message),
  };
  const scheduler = new Scheduler({ db, logger });
  const mind = new MindService({ db, scheduler, logger });
  let inspections = 0;
  const runtime: SecretaryPodRuntime = {
    async provision() {
      throw new Error('provision must not run during boot recovery');
    },
    async inspect(session) {
      inspections += 1;
      return {
        state: 'ready',
        receipt: { podName: `pod-${session.id}`, podUid: `uid-${session.id}` },
      };
    },
    async cleanup() {
      throw new Error('cleanup must not run for matching ready identity');
    },
  };
  return {
    db,
    config,
    logger,
    mind,
    logs,
    runtime,
    inspections: () => inspections,
    close() {
      db.close();
      fs.rmSync(data, { recursive: true, force: true });
    },
  };
}

test('disabled secretary supervisor has no runtime or session effects', async () => {
  const f = fixture(false);
  const result = await startSecretarySupervisor(f);
  assert.equal(result, null);
  assert.equal(f.inspections(), 0);
  assert.deepEqual(f.logs, []);
  f.close();
});

test('enabled secretary supervisor recovers exact starting session identity once', async () => {
  const f = fixture(true);
  const store = new SecretarySessionStore({ db: f.db });
  const created = store.create(ROOT, f.config.llm.registry.roles.secretary!);
  const result = await startSecretarySupervisor(f);
  assert.ok(result);
  assert.equal(f.inspections(), 1);
  assert.ok(result.completion);
  assert.ok(result.conversation);
  assert.ok(result.conversationTransport);
  assert.equal(result.conversationTransport.store, result.conversation);
  assert.ok(result.mind);
  assert.deepEqual(result.broker.list(), [
    {
      ...created.session,
      status: 'ready',
      podName: `pod-${created.session.id}`,
      podUid: `uid-${created.session.id}`,
      updatedAt: result.broker.list()[0].updatedAt,
    },
  ]);
  assert.deepEqual(f.logs, [
    'secretary supervisor recovered 1 active session(s); marked 0 claimed turn(s) ambiguous',
  ]);
  f.close();
});

test('enabled supervisor marks claimed turns ambiguous before exposure', async () => {
  const f = fixture(true);
  const sessions = new SecretarySessionStore({ db: f.db });
  const created = sessions.create(ROOT, f.config.llm.registry.roles.secretary!);
  const ready = sessions.ready(created.session.id, {
    podName: `pod-${created.session.id}`,
    podUid: `uid-${created.session.id}`,
  });
  const conversation = new SecretaryConversationStore({ db: f.db });
  const turn = conversation.enqueue(ready.id, {
    role: 'user',
    content: 'claimed before restart',
  });
  conversation.claim(ready.id);

  const result = await startSecretarySupervisor(f);
  assert.ok(result);
  assert.equal(f.inspections(), 1);
  assert.equal(result.conversation.status(turn.id).status, 'ambiguous');
  assert.equal(result.conversation.claim(ready.id), null);
  assert.deepEqual(f.logs, [
    'secretary supervisor recovered 1 active session(s); marked 1 claimed turn(s) ambiguous',
  ]);
  f.close();
});
