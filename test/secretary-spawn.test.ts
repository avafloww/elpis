import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/store/db.js';
import type { MindId } from '../src/store/mind-id.js';
import {
  newSecretarySessionId,
  resolveSecretarySession,
  SecretarySessionStore,
  secretaryControlTokenDigest,
  type SecretarySession,
} from '../src/secretary/session.js';
import {
  SecretarySpawnBroker,
  SecretarySpawnError,
  type SecretaryPodRuntime,
  type SecretaryProvisionRequest,
  type SecretaryProvisionState,
} from '../src/secretary/spawn.js';
import { makeConfig } from './helpers.js';

function insertMind(db: ReturnType<typeof openDatabase>, id: MindId): void {
  db.prepare(
    `INSERT INTO mind_items
       (id,title,body,kind,status,priority,created_by,created_at,updated_at,closed_at,archived_at)
     VALUES (?,?,'','task','open',2,'test',1,1,NULL,NULL)`,
  ).run(id, `Root ${id}`);
}

function fixture(maxConcurrent = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'secretary-spawn-'));
  const db = openDatabase(root);
  const config = makeConfig();
  config.secretary.enabled = true;
  config.secretary.maxConcurrent = maxConcurrent;
  config.llm.registry.roles.secretary = config.llm.registry.roles.main;
  const requests: SecretaryProvisionRequest[] = [];
  const cleaned: string[] = [];
  const states = new Map<string, SecretaryProvisionState>();
  let idByte = 1;
  let tokenByte = 1;
  let now = 100;
  const store = new SecretarySessionStore({
    db,
    now: () => now++,
    id: () => newSecretarySessionId(() => Buffer.alloc(16, idByte++)),
    credential: () => {
      const token = Buffer.alloc(32, tokenByte++).toString('base64url');
      return { token, digest: secretaryControlTokenDigest(token) };
    },
  });
  const runtime: SecretaryPodRuntime = {
    async provision(request) {
      requests.push(request);
      const receipt = {
        podName: `secretary-${request.sessionId}`,
        podUid: `uid-${request.sessionId}`,
      };
      states.set(request.sessionId, { state: 'ready', receipt });
      return receipt;
    },
    async inspect(session) {
      return states.get(session.id) ?? { state: 'missing' };
    },
    async cleanup(session) {
      cleaned.push(session.id);
      states.delete(session.id);
    },
  };
  return {
    db,
    config,
    store,
    runtime,
    requests,
    cleaned,
    states,
    broker: new SecretarySpawnBroker({ db, config, runtime, store }),
    close() {
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const ROOT_A = 'elm-000000a1' as MindId;
const ROOT_B = 'elm-000000b2' as MindId;

function active(session: SecretarySession): boolean {
  return session.status === 'starting' || session.status === 'ready';
}

test('secretary spawn binds exact root and configured model while persisting only token digest', async () => {
  const f = fixture();
  insertMind(f.db, ROOT_A);
  const session = await f.broker.start(ROOT_A);
  assert.equal(session.status, 'ready');
  assert.equal(session.hintMindId, ROOT_A);
  assert.equal(session.modelRef, f.config.llm.registry.roles.secretary);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].hintMindId, ROOT_A);
  assert.equal(f.requests[0].modelRef, f.config.llm.registry.roles.secretary);
  assert.match(f.requests[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    resolveSecretarySession(f.db, f.requests[0].token)?.sessionId,
    session.id,
  );
  assert.equal(
    f.db
      .prepare(
        'SELECT instr(control_token_digest, ?) AS found FROM secretary_sessions WHERE id=?',
      )
      .get(f.requests[0].token, session.id)?.found,
    0,
  );
  f.close();
});

test('secretary spawn serializes global capacity and revokes before cleanup', async () => {
  const f = fixture(1);
  insertMind(f.db, ROOT_A);
  insertMind(f.db, ROOT_B);
  const first = await f.broker.start(ROOT_A);
  await assert.rejects(
    () => f.broker.start(ROOT_B),
    (error: unknown) => {
      assert.equal((error as SecretarySpawnError).code, 'conflict');
      return true;
    },
  );
  const token = f.requests[0].token;
  const closed = await f.broker.close(first.id);
  assert.equal(closed.status, 'closed');
  assert.equal(resolveSecretarySession(f.db, token), null);
  assert.deepEqual(f.cleaned, [first.id]);
  const second = await f.broker.start(ROOT_B);
  assert.equal(second.status, 'ready');
  assert.equal(f.broker.list().filter(active).length, 1);
  f.close();
});

test('secretary provision failure is terminal, revoked, and cleaned', async () => {
  const f = fixture();
  insertMind(f.db, ROOT_A);
  f.runtime.provision = async (request) => {
    f.requests.push(request);
    throw new Error('PodTemplate rejected');
  };
  await assert.rejects(
    () => f.broker.start(ROOT_A),
    (error: unknown) => {
      assert.equal((error as SecretarySpawnError).code, 'provision_failed');
      return true;
    },
  );
  const failed = f.broker.list()[0];
  assert.equal(failed.status, 'failed');
  assert.equal(resolveSecretarySession(f.db, f.requests[0].token), null);
  assert.deepEqual(f.cleaned, [failed.id]);
  f.close();
});

test('secretary recovery resumes exact ready identity and fails missing or changed Pods', async () => {
  const f = fixture(4);
  insertMind(f.db, ROOT_A);
  insertMind(f.db, ROOT_B);
  const first = f.store.create(ROOT_A, f.config.llm.registry.roles.secretary!);
  const firstReceipt = {
    podName: `secretary-${first.session.id}`,
    podUid: `uid-${first.session.id}`,
  };
  f.states.set(first.session.id, { state: 'ready', receipt: firstReceipt });
  const second = await f.broker.start(ROOT_B);
  f.states.set(second.id, {
    state: 'ready',
    receipt: { podName: second.podName!, podUid: `${second.podUid}-changed` },
  });
  const sessions = await f.broker.recover();
  assert.equal(
    sessions.find((session) => session.id === first.session.id)?.status,
    'ready',
  );
  assert.equal(
    sessions.find((session) => session.id === second.id)?.status,
    'failed',
  );
  assert.deepEqual(f.cleaned, [second.id]);

  const thirdRoot = 'elm-000000c3' as MindId;
  insertMind(f.db, thirdRoot);
  const third = f.store.create(
    thirdRoot,
    f.config.llm.registry.roles.secretary!,
  );
  await f.broker.recover();
  assert.equal(f.broker.status(third.session.id).status, 'failed');
  assert.equal(f.cleaned.includes(third.session.id), true);
  f.close();
});

test('secretary spawn stays absent when disabled and status accepts only exact session ids', async () => {
  const f = fixture();
  insertMind(f.db, ROOT_A);
  f.config.secretary.enabled = false;
  await assert.rejects(
    () => f.broker.start(ROOT_A),
    (error: unknown) => {
      assert.equal((error as SecretarySpawnError).code, 'unavailable');
      return true;
    },
  );
  assert.throws(
    () => f.broker.status('secretary-latest'),
    (error: unknown) => {
      assert.equal((error as SecretarySpawnError).code, 'not_found');
      return true;
    },
  );
  assert.equal(f.requests.length, 0);
  f.close();
});
