import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, type Database } from '../src/store/db.js';
import type { MindId } from '../src/store/mind-id.js';
import {
  createSecretaryControlCredential,
  isSecretarySessionId,
  newSecretarySessionId,
  resolveSecretarySession,
  SecretarySessionError,
  SecretarySessionStore,
  secretaryControlTokenDigest,
  verifySecretaryControlToken,
} from '../src/secretary/session.js';

function database(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-secretary-'));
  return openDatabase(dir);
}

function insertMind(
  db: Database,
  id: MindId,
  status:
    | 'proposal'
    | 'inbox'
    | 'open'
    | 'in_progress'
    | 'waiting'
    | 'done'
    | 'cancelled' = 'open',
  archivedAt: number | null = null,
): void {
  db.prepare(
    `INSERT INTO mind_items
       (id, title, body, kind, status, priority, created_by,
        created_at, updated_at, closed_at, archived_at)
     VALUES (?, ?, '', 'task', ?, 2, 'test', 1, 1, NULL, ?)`,
  ).run(id, `Root ${id}`, status, archivedAt);
}

function token(byte: number): string {
  return Buffer.alloc(32, byte).toString('base64url');
}

function ids(...bytes: number[]): () => string {
  let position = 0;
  return () =>
    newSecretarySessionId(() => Buffer.alloc(16, bytes[position++] ?? 255));
}

function credentials(
  ...bytes: number[]
): () => { token: string; digest: string } {
  let position = 0;
  return () => {
    const raw = token(bytes[position++] ?? 255);
    return { token: raw, digest: secretaryControlTokenDigest(raw) };
  };
}

test('secretary credentials are random 256-bit base64url capabilities', () => {
  const first = createSecretaryControlCredential();
  const second = createSecretaryControlCredential();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(first.digest, /^[0-9a-f]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(first.digest, secretaryControlTokenDigest(first.token));
  assert.equal(verifySecretaryControlToken(first.token, first.digest), true);
  assert.equal(verifySecretaryControlToken(second.token, first.digest), false);
  assert.equal(
    verifySecretaryControlToken('legacy-shared-token', first.digest),
    false,
  );
  assert.throws(
    () => secretaryControlTokenDigest('legacy-shared-token'),
    /malformed/,
  );
  assert.equal(isSecretarySessionId(newSecretarySessionId()), true);
});

test('secretary store preserves an optional hint and persists only a token digest', () => {
  const db = database();
  const root = 'elm-000000a1' as MindId;
  insertMind(db, root);
  const raw = token(1);
  const store = new SecretarySessionStore({
    db,
    now: () => 100,
    id: ids(1, 2),
    credential: credentials(1, 2),
  });

  const created = store.create(root, 'resident/secretary-v1');
  assert.equal(created.token, raw);
  assert.deepEqual(created.session, {
    id: newSecretarySessionId(() => Buffer.alloc(16, 1)),
    hintMindId: root,
    status: 'starting',
    modelRef: 'resident/secretary-v1',
    runtime: 'kubernetes',
    podName: null,
    podUid: null,
    createdAt: 100,
    updatedAt: 100,
    lastError: null,
  });
  const persisted = db
    .prepare(
      'SELECT hint_mind_id, runtime, control_token_digest FROM secretary_sessions',
    )
    .get() as {
    hint_mind_id: string;
    runtime: string;
    control_token_digest: string;
  };
  assert.equal(persisted.hint_mind_id, root);
  assert.equal(persisted.runtime, 'kubernetes');
  assert.equal(
    persisted.control_token_digest,
    secretaryControlTokenDigest(raw),
  );
  assert.equal(JSON.stringify(persisted).includes(raw), false);
  assert.deepEqual(resolveSecretarySession(db, raw), {
    sessionId: created.session.id,
    hintMindId: root,
    modelRef: 'resident/secretary-v1',
    runtime: 'kubernetes',
  });
  assert.equal(resolveSecretarySession(db, token(9)), null);
  assert.equal(resolveSecretarySession(db, 'legacy-shared-token'), null);
  assert.deepEqual(store.get(created.session.id), created.session);
  assert.deepEqual(store.list(), [created.session]);

  const ready = store.markReady(created.session.id, {
    podName: 'secretary-a1',
    podUid: 'pod-uid-a1',
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.podName, 'secretary-a1');
  assert.ok(resolveSecretarySession(db, raw));
  const closed = store.close(created.session.id);
  assert.equal(closed.status, 'closed');
  assert.equal(resolveSecretarySession(db, raw), null);
  assert.deepEqual(
    store.close(created.session.id),
    closed,
    'close is idempotent',
  );

  const replacement = store.create(null, 'resident/secretary-v1');
  assert.notEqual(replacement.session.id, created.session.id);
  assert.equal(replacement.session.hintMindId, null);
  assert.ok(resolveSecretarySession(db, replacement.token));
  db.close();
});

test('secretary creation accepts no hint and any existing Mind item state', () => {
  const db = database();
  const valid = 'elm-000000b1' as MindId;
  insertMind(db, valid);
  insertMind(db, 'elm-000000b2' as MindId, 'proposal');
  insertMind(db, 'elm-000000b3' as MindId, 'done');
  insertMind(db, 'elm-000000b4' as MindId, 'cancelled');
  insertMind(db, 'elm-000000b5' as MindId, 'open', 50);
  const store = new SecretarySessionStore({
    db,
    id: ids(10, 11, 12, 13, 14),
    credential: credentials(10, 11, 12, 13, 14),
  });

  assert.throws(
    () => store.create('elm-00000' as MindId, 'resident/secretary-v1'),
    (error) =>
      error instanceof SecretarySessionError &&
      error.code === 'invalid_request',
  );
  assert.throws(
    () => store.create('elm-000000ff' as MindId, 'resident/secretary-v1'),
    (error) =>
      error instanceof SecretarySessionError && error.code === 'not_found',
  );
  const hints = [
    null,
    'elm-000000b2',
    'elm-000000b3',
    'elm-000000b4',
    'elm-000000b5',
  ] as (MindId | null)[];
  assert.deepEqual(
    hints.map(
      (hint) => store.create(hint, 'resident/secretary-v1').session.hintMindId,
    ),
    hints,
  );
  assert.throws(
    () => store.create(valid, 'Resident/secretary-v1'),
    (error) =>
      error instanceof SecretarySessionError &&
      error.code === 'invalid_request',
  );
  assert.equal(store.list().length, hints.length);
  db.close();
});

test('duplicate hints do not define authority and terminal transitions revoke only their token', () => {
  const db = database();
  const hint = 'elm-000000c1' as MindId;
  insertMind(db, hint);
  const store = new SecretarySessionStore({
    db,
    now: () => 200,
    id: ids(20, 21, 22),
    credential: credentials(20, 21, 22),
  });
  const first = store.create(hint, 'resident/secretary-v1');
  const second = store.create(hint, 'resident/secretary-v1');
  const unhinted = store.create(null, 'resident/secretary-v1');
  assert.equal(second.session.hintMindId, hint);
  assert.equal(unhinted.session.hintMindId, null);

  const failed = store.fail(first.session.id, new Error('synthetic failure'));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.lastError, 'synthetic failure');
  assert.equal(resolveSecretarySession(db, first.token), null);
  assert.ok(resolveSecretarySession(db, second.token));
  assert.ok(resolveSecretarySession(db, unhinted.token));
  assert.throws(
    () => store.close(first.session.id),
    (error) =>
      error instanceof SecretarySessionError && error.code === 'conflict',
  );
  db.close();
});

test('v24 schema enforces canonical identity, immutable hint, runtime, digest, and lifecycle', () => {
  const db = database();
  const root = 'elm-000000d1' as MindId;
  insertMind(db, root);
  const id = newSecretarySessionId(() => Buffer.alloc(16, 30));
  const digest = secretaryControlTokenDigest(token(30));
  const insert = db.prepare(
    `INSERT INTO secretary_sessions
       (id, hint_mind_id, status, model_ref, runtime,
        control_token_digest, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
  );
  insert.run(
    id,
    root,
    'starting',
    'resident/secretary-v1',
    'kubernetes',
    digest,
  );
  insert.run(
    newSecretarySessionId(() => Buffer.alloc(16, 31)),
    root,
    'ready',
    'resident/secretary-v1',
    'kubernetes',
    secretaryControlTokenDigest(token(31)),
  );
  insert.run(
    newSecretarySessionId(() => Buffer.alloc(16, 32)),
    null,
    'closed',
    'resident/secretary-v1',
    'kubernetes',
    secretaryControlTokenDigest(token(32)),
  );
  assert.throws(
    () =>
      insert.run(
        'secretary-readable',
        root,
        'starting',
        'resident/secretary-v1',
        'kubernetes',
        secretaryControlTokenDigest(token(32)),
      ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      insert.run(
        newSecretarySessionId(() => Buffer.alloc(16, 33)),
        root,
        'running',
        'resident/secretary-v1',
        'kubernetes',
        secretaryControlTokenDigest(token(33)),
      ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      insert.run(
        newSecretarySessionId(() => Buffer.alloc(16, 34)),
        root,
        'starting',
        'not-canonical',
        'kubernetes',
        secretaryControlTokenDigest(token(34)),
      ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      insert.run(
        newSecretarySessionId(() => Buffer.alloc(16, 35)),
        root,
        'starting',
        'resident/secretary-v1',
        'trusted',
        secretaryControlTokenDigest(token(35)),
      ),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      db
        .prepare('UPDATE secretary_sessions SET hint_mind_id = ? WHERE id = ?')
        .run('elm-000000d2', id),
    /identity and hint are immutable/,
  );
  db.prepare(
    "UPDATE secretary_sessions SET status = 'closed' WHERE id = ?",
  ).run(id);
  assert.throws(
    () =>
      db
        .prepare("UPDATE secretary_sessions SET status = 'ready' WHERE id = ?")
        .run(id),
    /invalid secretary session status transition/,
  );
  const foreignKeys = db
    .prepare(
      "SELECT [from] AS source, [table] AS target FROM pragma_foreign_key_list('secretary_sessions')",
    )
    .all() as { source: string; target: string }[];
  assert.deepEqual(
    foreignKeys.map((row) => ({ ...row })),
    [{ source: 'hint_mind_id', target: 'mind_items' }],
  );
  db.close();
});
