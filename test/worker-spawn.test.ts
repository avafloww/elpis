import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorkerControlCredential } from '../src/worker/auth.js';
import { WorkerMailboxBroker } from '../src/worker/mailbox.js';
import { resolveWorkerSession } from '../src/worker/session.js';
import {
  WorkerSpawnBroker,
  WorkerSpawnError,
  type WorkerPodRuntime,
  type WorkerProvisionRequest,
  type WorkerProvisionState,
  type WorkerSession,
} from '../src/worker/spawn.js';
import { WorkerWorkspaceError } from '../src/worker/workspace.js';
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
  let monotonicNow = 0;
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
  let sourceHook: ((sessionId: string) => void) | null = null;
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
        sourceHook?.(sessionId);
        if (sourceError) throw sourceError;
        return sourceReceipt;
      },
      discardSource(sessionId) {
        discardedSources.push(sessionId);
      },
    },
    now: () => ++now,
    monotonicNow: () => monotonicNow,
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
    runtime,
    provisioned,
    cleaned,
    states,
    credentials,
    preparedSources,
    discardedSources,
    setNow(value: number) {
      now = value;
    },
    advanceMonotonic(ms: number) {
      monotonicNow += ms;
    },
    setSourceReceipt(receipt: typeof sourceReceipt) {
      sourceReceipt = receipt;
    },
    setSourceError(error: Error | null) {
      sourceError = error;
    },
    setSourceHook(hook: typeof sourceHook) {
      sourceHook = hook;
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
      !error.message.includes('dirty') &&
      error.message.includes('elpis.worker.status("wrk-test0001")'),
  );
  assert.equal(f.provisioned.length, 0);
  assert.equal(f.preparedSources.length, 1);
  assert.deepEqual(f.discardedSources, f.preparedSources);
  const failed = f.broker.list()[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.lastError ?? '', /dirty source root detail/);
  const delivery = f.db
    .prepare('SELECT completion_notified_at FROM worker_sessions WHERE id = ?')
    .get(failed.id) as { completion_notified_at: number | null };
  assert.equal(delivery.completion_notified_at, null);
  assert.equal(failed.sourceRevision, null);
  assert.equal(resolveWorkerSession(f.db, f.credentials[0].token), null);
  f.close();
});

test('unclassified workspace failures expose a lookup instead of raw diagnostics', async () => {
  const f = fixture();
  try {
    f.setSourceError(
      new WorkerWorkspaceError('unavailable', 'private-git-diagnostic'),
    );
    await assert.rejects(
      () => f.broker.start(f.item.id),
      (error: unknown) => {
        assert.ok(error instanceof WorkerSpawnError);
        assert.equal(error.code, 'workspace_failed');
        assert.equal(
          error.message,
          'worker source preparation failed; inspect elpis.worker.status("wrk-test0001") for details',
        );
        return true;
      },
    );
    assert.equal(
      f.broker.status('wrk-test0001').lastError,
      'private-git-diagnostic',
    );
    assert.equal(f.provisioned.length, 0);
  } finally {
    f.close();
  }
});

test('dirty source failure gives fixed guidance and identifies its failed session', async () => {
  const f = fixture();
  try {
    const error = new WorkerWorkspaceError(
      'conflict',
      'private source detail',
      'dirty_source',
    );
    f.setSourceError(error);
    await assert.rejects(
      () => f.broker.start(f.item.id),
      (error: unknown) => {
        assert.ok(error instanceof WorkerSpawnError);
        assert.equal(error.code, 'workspace_failed');
        assert.match(error.message, /source repository must be clean/);
        assert.match(error.message, /checkpoint/);
        assert.ok(
          error.message.includes('elpis.worker.status("wrk-test0001")'),
        );
        assert.equal(error.message.includes('private source detail'), false);
        return true;
      },
    );
    assert.equal(f.provisioned.length, 0);
    assert.equal(f.broker.status('wrk-test0001').status, 'failed');
    assert.deepEqual(f.discardedSources, ['wrk-test0001']);
    assert.equal(resolveWorkerSession(f.db, f.credentials[0].token), null);
  } finally {
    f.close();
  }
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
  const delivery = f.db
    .prepare('SELECT completion_notified_at FROM worker_sessions WHERE id = ?')
    .get(failed.id) as { completion_notified_at: number | null };
  assert.equal(delivery.completion_notified_at, null);
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
  assert.equal(dismissed.lastError, null);
  const cleanup = f.db
    .prepare(
      'SELECT runtime_cleanup_completed_at, runtime_cleanup_error FROM worker_sessions WHERE id = ?',
    )
    .get(session.id) as {
    runtime_cleanup_completed_at: number | null;
    runtime_cleanup_error: string | null;
  };
  assert.equal(cleanup.runtime_cleanup_completed_at, null);
  assert.match(cleanup.runtime_cleanup_error ?? '', /delete denied/);
  f.close();
});

async function assertRecoverySkipsActiveStart(
  phase: 'source' | 'provision',
): Promise<void> {
  const f = fixture();
  f.setSourceReceipt({
    revision: '1'.repeat(40),
    sha256: '2'.repeat(64),
    sizeBytes: 1024,
  });
  let recovery: Promise<WorkerSession[]> | null = null;
  const triggerRecovery = () => {
    recovery = f.broker.recover();
  };
  if (phase === 'source') f.setSourceHook(triggerRecovery);
  else f.setProvisionHook(triggerRecovery);

  const session = await f.broker.start(f.item.id);
  assert.ok(recovery, `${phase} hook started recovery`);
  await recovery;
  assert.equal(session.status, 'running');
  assert.equal(f.broker.status(session.id).status, 'running');
  assert.deepEqual(f.cleaned, []);
  f.close();
}

test('repeated dismissal and recovery join one cleanup failure', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  const cleanupStarted = Promise.withResolvers<void>();
  const releaseCleanup = Promise.withResolvers<void>();
  let cleanupCalls = 0;
  f.runtime.cleanup = async () => {
    cleanupCalls++;
    cleanupStarted.resolve();
    await releaseCleanup.promise;
    throw new Error('synthetic shared cleanup failure');
  };

  const first = f.broker.dismiss(session.id);
  const firstOutcome = first.then(
    () => null,
    (error: unknown) => error,
  );
  await cleanupStarted.promise;
  let secondSettled = false;
  const second = f.broker.dismiss(session.id);
  const secondOutcome = second.then(
    () => {
      secondSettled = true;
      return null;
    },
    (error: unknown) => {
      secondSettled = true;
      return error;
    },
  );
  let recoverySettled = false;
  const recovery = f.broker.cleanupPending().finally(() => {
    recoverySettled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, false);
  assert.equal(recoverySettled, false);
  assert.equal(cleanupCalls, 1);

  releaseCleanup.resolve();
  const [firstError, secondError] = await Promise.all([
    firstOutcome,
    secondOutcome,
  ]);
  await recovery;
  assert.match(String(firstError), /cleanup failed/);
  assert.match(String(secondError), /cleanup failed/);
  assert.equal(cleanupCalls, 1);
  f.close();
});

test('dismiss and recovery serialize cleanup for one runtime', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let cleanups = 0;
  let recovery: Promise<WorkerSession[]> | null = null;
  f.runtime.cleanup = async () => {
    cleanups++;
    if (cleanups === 1) recovery = f.broker.recover();
    started.resolve();
    await release.promise;
  };

  const dismiss = f.broker.dismiss(session.id);
  await started.promise;
  release.resolve();
  await dismiss;
  assert.ok(recovery);
  await recovery;

  assert.equal(cleanups, 1);
  assert.equal(f.broker.status(session.id).status, 'dismissed');
  f.close();
});

test('dismiss during Pod creation waits and records one post-creation cleanup', async () => {
  const f = fixture();
  const provisionStarted = Promise.withResolvers<WorkerProvisionRequest>();
  const releaseProvision = Promise.withResolvers<void>();
  const originalProvision = f.runtime.provision.bind(f.runtime);
  f.runtime.provision = async (request) => {
    provisionStarted.resolve(request);
    await releaseProvision.promise;
    return originalProvision(request);
  };

  const starting = f.broker.start(f.item.id);
  const startOutcome = starting.then(
    (session) => ({ session, error: null }),
    (error: unknown) => ({ session: null, error }),
  );
  const request = await provisionStarted.promise;
  const dismissing = f.broker.dismiss(request.sessionId);
  let dismissSettled = false;
  void dismissing.finally(() => {
    dismissSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(f.broker.status(request.sessionId).status, 'dismissed');
  assert.equal(dismissSettled, false);
  assert.deepEqual(f.cleaned, []);

  releaseProvision.resolve();
  const dismissed = await dismissing;
  const outcome = await startOutcome;
  assert.equal(dismissed.status, 'dismissed');
  assert.equal(outcome.session, null);
  assert.ok(outcome.error instanceof WorkerSpawnError);
  assert.equal(outcome.error.code, 'conflict');
  assert.deepEqual(
    f.cleaned.map((session) => session.id),
    [request.sessionId],
  );
  const cleanup = f.db
    .prepare(
      'SELECT runtime_cleanup_completed_at FROM worker_sessions WHERE id = ?',
    )
    .get(request.sessionId) as { runtime_cleanup_completed_at: number | null };
  assert.equal(typeof cleanup.runtime_cleanup_completed_at, 'number');
  f.close();
});

test('durable finish during Pod creation survives final provisioning commit', async () => {
  const f = fixture();
  const provisionStarted = Promise.withResolvers<WorkerProvisionRequest>();
  const releaseProvision = Promise.withResolvers<void>();
  const originalProvision = f.runtime.provision.bind(f.runtime);
  f.runtime.provision = async (request) => {
    provisionStarted.resolve(request);
    await releaseProvision.promise;
    return originalProvision(request);
  };

  const starting = f.broker.start(f.item.id);
  const request = await provisionStarted.promise;
  new WorkerMailboxBroker(f.db, () => 2000).postFromWorker(
    request.token,
    'finish-during-provision',
    'finish',
    'durable result',
  );
  assert.equal(f.broker.status(request.sessionId).status, 'finished');

  releaseProvision.resolve();
  const session = await starting;

  assert.equal(session.status, 'finished');
  assert.deepEqual(f.cleaned, []);
  const cleanup = f.db
    .prepare(
      'SELECT runtime_cleanup_completed_at FROM worker_sessions WHERE id = ?',
    )
    .get(request.sessionId) as { runtime_cleanup_completed_at: number | null };
  assert.equal(cleanup.runtime_cleanup_completed_at, null);
  f.close();
});

test('source failure cleanup receipt clamps a rolled-back clock', async () => {
  const f = fixture();
  f.setSourceHook(() => f.setNow(-1000));
  f.setSourceError(new Error('synthetic source failure'));

  await assert.rejects(
    () => f.broker.start(f.item.id),
    /source preparation failed/,
  );
  const row = f.db
    .prepare(
      'SELECT status, created_at, updated_at, runtime_cleanup_completed_at FROM worker_sessions',
    )
    .get() as {
    status: string;
    created_at: number;
    updated_at: number;
    runtime_cleanup_completed_at: number | null;
  };
  assert.equal(row.status, 'failed');
  assert.ok(row.updated_at >= row.created_at);
  assert.ok((row.runtime_cleanup_completed_at ?? -1) >= row.created_at);
  f.close();
});

test('runtime cleanup receipt clamps a rolled-back clock', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  f.db
    .prepare("UPDATE worker_sessions SET status = 'failed' WHERE id = ?")
    .run(session.id);
  f.setNow(-1000);

  await f.broker.recover();

  const row = f.db
    .prepare(
      'SELECT created_at, runtime_cleanup_completed_at FROM worker_sessions WHERE id = ?',
    )
    .get(session.id) as {
    created_at: number;
    runtime_cleanup_completed_at: number | null;
  };
  assert.ok((row.runtime_cleanup_completed_at ?? -1) >= row.created_at);
  assert.equal(f.cleaned.length, 1);
  f.close();
});

test('recovery skips a session during source preparation', async () => {
  await assertRecoverySkipsActiveStart('source');
});

test('recovery skips a session during Pod provisioning', async () => {
  await assertRecoverySkipsActiveStart('provision');
});

test('durable mailbox finish outranks a later Pod failure during recovery', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  new WorkerMailboxBroker(f.db).postFromWorker(
    f.provisioned[0].token,
    'finish-accepted',
    'finish',
    'The bounded review is accepted.',
  );
  f.states.set(session.id, {
    state: 'failed',
    error: 'worker process exited after the durable finish receipt',
  });

  await f.broker.recover();

  const recovered = f.broker.status(session.id);
  assert.equal(recovered.status, 'finished');
  assert.equal(recovered.lastError, null);
  assert.deepEqual(
    f.cleaned.map((candidate) => candidate.id),
    [session.id],
  );
  f.close();
});

test('legacy durable finish starts cleanup grace at the finish timestamp', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  f.setNow(50_000);
  f.db
    .prepare(
      `INSERT INTO worker_mailbox_messages
       (session_id,direction,kind,message_key,sender,body,created_at)
       VALUES (?,'worker_to_dispatcher','finish','finish-before-crash',?,'done',50000)`,
    )
    .run(session.id, session.worker);
  f.db
    .prepare(
      `UPDATE worker_sessions
       SET status = 'failed', updated_at = ?, last_error = 'late broker error'
       WHERE id = ?`,
    )
    .run(session.updatedAt, session.id);

  await f.broker.recover();

  const recovered = f.broker.status(session.id);
  assert.equal(recovered.status, 'finished');
  assert.equal(recovered.updatedAt, 50_000);
  assert.deepEqual(f.cleaned, []);
  f.close();
});

test('forward wall-clock jump cannot shorten finish cleanup grace', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  new WorkerMailboxBroker(f.db, () => 2000).postFromWorker(
    f.provisioned[0].token,
    'finish-before-forward-clock-jump',
    'finish',
    'done',
  );

  await f.broker.cleanupPending();
  f.setNow(1_000_000);
  await f.broker.cleanupPending();
  assert.deepEqual(f.cleaned, []);
  f.advanceMonotonic(30_001);
  await f.broker.cleanupPending();

  assert.deepEqual(
    f.cleaned.map((candidate) => candidate.id),
    [session.id],
  );
  f.close();
});

test('finish cleanup grace remains bounded when wall clock rolls backward', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  new WorkerMailboxBroker(f.db, () => 2000).postFromWorker(
    f.provisioned[0].token,
    'finish-before-clock-rollback',
    'finish',
    'done',
  );
  f.setNow(-1000);

  await f.broker.cleanupPending();
  assert.deepEqual(f.cleaned, []);
  f.advanceMonotonic(30_001);
  await f.broker.cleanupPending();

  assert.deepEqual(
    f.cleaned.map((candidate) => candidate.id),
    [session.id],
  );
  f.close();
});

test('finished cleanup proceeds after grace when Pod inspection keeps failing', async () => {
  const f = fixture();
  const session = await f.broker.start(f.item.id);
  new WorkerMailboxBroker(f.db, () => 2000).postFromWorker(
    f.provisioned[0].token,
    'finish-before-broken-inspect',
    'finish',
    'done',
  );
  f.setNow(50_000);
  f.runtime.inspect = async () => {
    throw new Error('inspection unavailable');
  };

  await f.broker.cleanupPending();
  assert.deepEqual(f.cleaned, []);
  f.advanceMonotonic(30_001);
  await f.broker.cleanupPending();

  assert.deepEqual(
    f.cleaned.map((candidate) => candidate.id),
    [session.id],
  );
  f.close();
});

test('recovery adopts ready Pods and fails terminal claims without finish', async () => {
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
  assert.equal(f.broker.status(a.id).status, 'failed');
  assert.match(
    f.broker.status(a.id).lastError ?? '',
    /exited successfully without a durable finish/,
  );
  assert.equal(f.broker.status(b.id).status, 'running');
  assert.equal(f.broker.status(b.id).podName, 'adopted');
  assert.equal(f.broker.status('wrk-missing1').status, 'failed');
  assert.ok(f.cleaned.some((session) => session.id === a.id));
  assert.ok(f.cleaned.some((session) => session.id === 'wrk-missing1'));
  f.close();
});
