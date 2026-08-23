import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorkerControlCredential } from '../src/worker/auth.js';
import { resolveWorkerSession } from '../src/worker/session.js';
import {
  WorkerSpawnBroker,
  WorkerSpawnError,
  type WorkerPodRuntime,
  type WorkerProvisionRequest,
  type WorkerProvisionState,
  type WorkerSession,
} from '../src/worker/spawn.js';
import { noopLogger } from '../src/lib/log.js';
import { openDatabase } from '../src/store/db.js';
import { MindService } from '../src/store/mind.js';
import { makeConfig } from './helpers.js';

function fixture(opts: { max?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-spawn-'));
  const db = openDatabase(dir);
  const mind = new MindService({
    db,
    scheduler: {
      create() {
        throw new Error('unused');
      },
      delete() {
        return true;
      },
      update() {
        return null;
      },
    } as never,
    logger: noopLogger,
  });
  const item = mind.create({ title: 'bounded worker task', kind: 'task' });
  const config = makeConfig();
  config.workers.enabled = true;
  config.workers.maxConcurrent = opts.max ?? 4;
  let now = 1000;
  const provisioned: WorkerProvisionRequest[] = [];
  const cleaned: WorkerSession[] = [];
  const states = new Map<string, WorkerProvisionState>();
  let provisionError: Error | null = null;
  let provisionHook: ((request: WorkerProvisionRequest) => void) | null = null;
  let sourceReceipt: {
    revision: string;
    sha256: string;
    sizeBytes: number;
  } | null = null;
  let sourceError: Error | null = null;
  const preparedSources: string[] = [];
  const discardedSources: string[] = [];
  let cleanupHook: ((session: WorkerSession) => void) | null = null;
  const runtime: WorkerPodRuntime = {
    async provision(request) {
      provisioned.push(request);
      provisionHook?.(request);
      if (provisionError) throw provisionError;
      const receipt = {
        podName: `pod-${request.sessionId}`,
        podUid: `uid-${request.sessionId}`,
        workspaceRef: `workspace/${request.sessionId}`,
      };
      states.set(request.sessionId, { state: 'ready', receipt });
      return receipt;
    },
    async inspect(session) {
      return states.get(session.id) ?? { state: 'missing' };
    },
    async cleanup(session) {
      cleanupHook?.(session);
      cleaned.push(session);
    },
  };
  const credentials = [
    createWorkerControlCredential(),
    createWorkerControlCredential(),
  ];
  let cred = 0;
  let id = 0;
  const broker = new WorkerSpawnBroker({
    db,
    config,
    mind,
    runtime,
    workspace: {
      async prepareSource(sessionId) {
        preparedSources.push(sessionId);
        if (sourceError) throw sourceError;
        return sourceReceipt;
      },
      discardSource(sessionId) {
        discardedSources.push(sessionId);
      },
    },
    now: () => ++now,
    credential: () => credentials[cred++],
    id: () => `wrk-test000${++id}`,
    slug: (taken) => (taken.has('quiet-otter') ? 'still-fox' : 'quiet-otter'),
  });
  return {
    dir,
    db,
    mind,
    item,
    config,
    broker,
    provisioned,
    cleaned,
    states,
    credentials,
    preparedSources,
    discardedSources,
    setSourceReceipt(receipt: typeof sourceReceipt) {
      sourceReceipt = receipt;
    },
    setSourceError(error: Error | null) {
      sourceError = error;
    },
    setProvisionHook(hook: typeof provisionHook) {
      provisionHook = hook;
    },
    setProvisionError(error: Error | null) {
      provisionError = error;
    },
    setCleanupHook(hook: ((session: WorkerSession) => void) | null) {
      cleanupHook = hook;
    },
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('spawn validates authority, claims Mind, and never returns the control token', async () => {
  const f = fixture();
  await assert.rejects(
    () => f.broker.start(f.item.id, { prompt: 'escape' }),
    (error: unknown) =>
      error instanceof WorkerSpawnError && error.code === 'invalid_request',
  );
  assert.equal(
    f.broker.list().length,
    0,
    'invalid input has no durable or Pod effect',
  );
  const session = await f.broker.start(f.item.id);
  assert.equal(session.status, 'running');
  assert.equal(session.mindId, f.item.id);
  assert.equal(session.modelRef, f.config.llm.registry.roles.main);
  assert.equal(session.worker, 'worker:quiet-otter');
  assert.equal(Object.hasOwn(session, 'token'), false);
  assert.deepEqual(Object.keys(f.provisioned[0]).sort(), [
    'sessionId',
    'slug',
    'token',
  ]);
  assert.equal(
    resolveWorkerSession(f.db, f.provisioned[0].token)?.sessionId,
    session.id,
  );
  const stored = f.db
    .prepare('SELECT control_token_digest FROM worker_sessions WHERE id = ?')
    .get(session.id) as { control_token_digest: string };
  assert.equal(stored.control_token_digest, f.credentials[0].digest);
  assert.equal(JSON.stringify(session).includes(f.provisioned[0].token), false);
  await assert.rejects(
    () => f.broker.start(f.item.id),
    (error: unknown) =>
      error instanceof WorkerSpawnError && error.code === 'conflict',
  );
  f.close();
});

test('closed, blocked, unknown-model, disabled, and capacity failures are pre-effect', async () => {
  const f = fixture({ max: 1 });
  const blocked = f.mind.create({ title: 'blocked', dependsOn: [f.item.id] });
  await assert.rejects(
    () => f.broker.start(blocked.id),
    (e: unknown) => e instanceof WorkerSpawnError && e.code === 'blocked',
  );
  const proposal = f.mind.create({
    title: 'proposed work',
    status: 'proposal',
  });
  await assert.rejects(
    () => f.broker.start(proposal.id),
    (e: unknown) =>
      e instanceof WorkerSpawnError &&
      e.code === 'blocked' &&
      /not committed work/.test(e.message),
  );
  await assert.rejects(
    () => f.broker.start(f.item.id, { modelRef: 'missing/model' }),
    (e: unknown) =>
      e instanceof WorkerSpawnError && e.code === 'invalid_request',
  );
  assert.equal(f.provisioned.length, 0);
  await f.broker.start(f.item.id);
  const other = f.mind.create({ title: 'other' });
  await assert.rejects(
    () => f.broker.start(other.id),
    (e: unknown) => e instanceof WorkerSpawnError && e.code === 'capacity',
  );
  f.config.workers.enabled = false;
  await assert.rejects(
    () => f.broker.start(other.id),
    (e: unknown) => e instanceof WorkerSpawnError && e.code === 'disabled',
  );
  f.close();
});

test('source receipt is durably bound before Pod provisioning', async () => {
  const f = fixture();
  const source = {
    revision: 'a'.repeat(40),
    sha256: 'b'.repeat(64),
    sizeBytes: 12345,
  };
  f.setSourceReceipt(source);
  f.setProvisionHook((request) => {
    const row = f.db
      .prepare(
        'SELECT status, source_revision, source_sha256, source_bytes FROM worker_sessions WHERE id = ?',
      )
      .get(request.sessionId) as Record<string, unknown>;
    assert.equal(row.status, 'spawning');
    assert.equal(row.source_revision, source.revision);
    assert.equal(row.source_sha256, source.sha256);
    assert.equal(row.source_bytes, source.sizeBytes);
  });
  const session = await f.broker.start(f.item.id);
  assert.deepEqual(f.preparedSources, [session.id]);
  assert.deepEqual(f.discardedSources, []);
  assert.equal(session.sourceRevision, source.revision);
  assert.equal(session.sourceSha256, source.sha256);
  assert.equal(session.sourceBytes, source.sizeBytes);
  f.close();
});

test('source preparation failure creates no Pod and revokes the failed session', async () => {
  const f = fixture();
  f.setSourceError(new Error('dirty source root detail'));
  await assert.rejects(
    () => f.broker.start(f.item.id),
    (error: unknown) =>
      error instanceof WorkerSpawnError &&
      error.code === 'workspace_failed' &&
      !error.message.includes('dirty'),
  );
  assert.equal(f.provisioned.length, 0);
  assert.equal(f.preparedSources.length, 1);
  assert.deepEqual(f.discardedSources, f.preparedSources);
  const failed = f.broker.list()[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.lastError ?? '', /dirty source root detail/);
  assert.equal(failed.sourceRevision, null);
  assert.equal(resolveWorkerSession(f.db, f.credentials[0].token), null);
  f.close();
});

test('provision failure is durable, revoked, and cleaned without leaking detail', async () => {
  const f = fixture();
  f.setProvisionError(new Error('secret infrastructure detail'));
  await assert.rejects(
    () => f.broker.start(f.item.id),
    (error: unknown) =>
      error instanceof WorkerSpawnError &&
      error.code === 'provision_failed' &&
      !error.message.includes('secret'),
  );
  const failed = f.broker.list()[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.lastError ?? '', /secret infrastructure detail/);
  assert.equal(resolveWorkerSession(f.db, f.provisioned[0].token), null);
  assert.equal(f.cleaned.length, 1);
  f.close();
});

test('dismiss revokes token before cleanup and cleanup failure stays revoked', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  const token = f.provisioned[0].token;
  f.setCleanupHook(() => {
    assert.equal(
      resolveWorkerSession(f.db, token),
      null,
      'credential is revoked before cleanup',
    );
    throw new Error('delete denied');
  });
  await assert.rejects(
    () => f.broker.dismiss(session.id),
    (e: unknown) =>
      e instanceof WorkerSpawnError && e.code === 'cleanup_failed',
  );
  const dismissed = f.broker.status(session.id);
  assert.equal(dismissed.status, 'dismissed');
  assert.match(dismissed.lastError ?? '', /delete denied/);
  f.close();
});

test('recovery adopts ready Pods, finalizes terminal Pods, and fails missing claims', async () => {
  const f = fixture();
  const a = await f.broker.start(f.item.id);
  const bItem = f.mind.create({ title: 'b' });
  const b = await f.broker.start(bItem.id);
  const cItem = f.mind.create({ title: 'c' });
  f.db
    .prepare("UPDATE worker_sessions SET status = 'spawning' WHERE id = ?")
    .run(b.id);
  f.db
    .prepare(
      `INSERT INTO worker_sessions (id,slug,status,model_ref,mind_id,runtime,control_token_digest,created_at,updated_at) VALUES ('wrk-missing1','plain-ibis','spawning',?,?, 'kubernetes',?,1,1)`,
    )
    .run(
      f.config.llm.registry.roles.main,
      cItem.id,
      createWorkerControlCredential().digest,
    );
  f.states.set(a.id, { state: 'succeeded' });
  f.states.set(b.id, {
    state: 'ready',
    receipt: {
      podName: 'adopted',
      podUid: 'uid-adopted',
      workspaceRef: 'workspace/adopted',
    },
  });
  await f.broker.recover();
  assert.equal(f.broker.status(a.id).status, 'finished');
  assert.equal(f.broker.status(b.id).status, 'running');
  assert.equal(f.broker.status(b.id).podName, 'adopted');
  assert.equal(f.broker.status('wrk-missing1').status, 'failed');
  assert.ok(f.cleaned.some((session) => session.id === a.id));
  assert.ok(f.cleaned.some((session) => session.id === 'wrk-missing1'));
  f.close();
});
