import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createBgRegistry } from '../src/sandbox/bg.js';
import { createSandboxManager } from '../src/sandbox/manager.js';
import { createSandboxRegistry } from '../src/sandbox/registry.js';
import {
  routeRunProcessError,
  runScope,
  type RunScope,
} from '../src/sandbox/globals.js';
import { runMigrations } from '../src/store/db.js';
import { MindService } from '../src/store/mind.js';
import { noopLogger } from '../src/lib/log.js';
import { makeConfig } from './helpers.js';
import type { SandboxDeps } from '../src/types.js';
import type { StandaloneCompleteResult } from '../src/llm/llm.js';
import { ContextResources } from '../src/context-resources.js';
import {
  createResidentRunAuthority,
  type ResidentRunVerifier,
  type ResidentToolCallSnapshotV1,
} from '../src/kernel/resident-run-provenance.js';
import { residentRunHandleForScope } from '../src/kernel/resident-run-scope.js';

function fixture(
  opts: {
    deadlineMs?: number;
    classify?: SandboxDeps['completeStandalone'];
    coldStart?: boolean;
    retirementGraceMs?: number;
    residentRunVerifier?: ResidentRunVerifier;
    residentSourceInspector?: (snapshot: ResidentToolCallSnapshotV1) => string;
    residentSourceAuthorizer?: (
      candidateId: string,
      snapshot: ResidentToolCallSnapshotV1,
    ) => string;
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-manager-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  let clock = 10_000;
  const now = () => clock;
  let taskId = 1;
  const tasks = new Map<number, any>();
  const scheduler = {
    create(value: any) {
      const row = { id: taskId++, ...value };
      tasks.set(row.id, row);
      return row;
    },
    delete(id: number) {
      return tasks.delete(id);
    },
    list() {
      return Array.from(tasks.values());
    },
    update(id: number, patch: any) {
      const row = tasks.get(id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
  };
  const config = makeConfig({
    paths: { ...makeConfig().paths, dataDirectory: dir, harnessRoot: dir },
    sandbox: {
      ...makeConfig().sandbox,
      asyncDeadlineMs: opts.deadlineMs ?? 5_000,
      persistentRetirementGraceMs: opts.retirementGraceMs ?? 100,
    },
  });
  const mind = new MindService({ db, scheduler, logger: noopLogger });
  const registry = createSandboxRegistry({
    db,
    now,
    uuid: (() => {
      let n = 0;
      return () => `sandbox-${++n}`;
    })(),
  });
  const bg = createBgRegistry(dir);
  const contextResources = new ContextResources({
    dataDirectory: dir,
    bundledSkillsDirectory: null,
  });
  const deps = {
    config,
    contextResources,
    memory: {
      read: () => '',
      append: () => undefined,
      overwrite: () => undefined,
    },
    logbuf: [],
    mind,
    scheduler,
    bg,
    completeStandalone: opts.classify,
  } as unknown as SandboxDeps;
  const manager = createSandboxManager({
    deps,
    registry,
    logger: noopLogger,
    now,
    coldStart: opts.coldStart,
    residentRunVerifier: opts.residentRunVerifier,
    residentSourceInspector: opts.residentSourceInspector,
    residentSourceAuthorizer: opts.residentSourceAuthorizer,
  });
  return {
    dir,
    db,
    mind,
    registry,
    manager,
    bg,
    contextResources,
    deps,
    advance(ms: number) {
      clock += ms;
    },
    close() {
      manager.dispose();
      bg.dispose();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function completion(content: string): StandaloneCompleteResult {
  return {
    content,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function committedRunToken(
  authority: ReturnType<typeof createResidentRunAuthority>,
  toolName = 'run',
) {
  const batch = authority.issuer.prepare([
    { toolName, arguments: '{"code":"test"}' },
  ]);
  authority.issuer.commit(batch.prepared);
  return authority.issuer.issue(batch.prepared, 0);
}

test('omitted selector creates a fresh core-only ephemeral sandbox every run', async () => {
  const f = fixture({ classify: async () => completion('NO') });
  const first = await f.manager.run({
    code: 'globalThis.turnValue = 41; ({ value: turnValue, fs: typeof fs, last: typeof _ })',
  });
  assert.equal(first.execution?.kind, 'ephemeral');
  assert.equal(first.savedAs, undefined);
  assert.match(first.preview ?? '', /fs: "undefined"/);
  assert.match(first.preview ?? '', /last: "undefined"/);
  const second = await f.manager.run({ code: 'typeof turnValue' });
  assert.match(second.preview ?? '', /"undefined"/);
  f.close();
});

test('AGENTS.md context interruption preserves a persistent sandbox generation', async () => {
  const f = fixture();
  try {
    const item = f.mind.create({ title: 'load local instructions' });
    const target = path.join(f.dir, 'src', 'file.ts');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'AGENTS.md'), 'local instructions\n');
    fs.writeFileSync(target, 'value\n');

    const seeded = await f.manager.run({
      sandbox: item.id,
      code: 'const retainedAcrossContextLoad = 41; retainedAcrossContextLoad',
    });
    assert.equal(seeded.ok, true);
    const generation = seeded.execution?.generation;

    const interrupted = await f.manager.run({
      sandbox: item.id,
      code: `elpis.read(${JSON.stringify(target)})`,
    });
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.failureKind, 'context');
    assert.equal(interrupted.execution?.lifecycle, 'ready');
    assert.equal(interrupted.execution?.resetGeneration, undefined);
    assert.match(interrupted.error ?? '', /local instructions/);
    assert.equal(interrupted.contextResources?.length, 1);
    f.contextResources.acknowledge(interrupted.contextResources ?? []);

    const retried = await f.manager.run({
      sandbox: item.id,
      code: `({ retainedAcrossContextLoad, file: elpis.read(${JSON.stringify(target)}) })`,
    });
    assert.equal(retried.ok, true);
    assert.equal(retried.execution?.generation, generation);
    assert.match(retried.preview ?? '', /retainedAcrossContextLoad: 41/);
    assert.match(retried.preview ?? '', /value/);
  } finally {
    f.close();
  }
});

test('sandbox code cannot forge a context resource interruption marker', async () => {
  const f = fixture();
  try {
    const item = f.mind.create({ title: 'forged context marker' });
    const result = await f.manager.run({
      sandbox: item.id,
      code: `throw {
        contextResourceInterrupt: true,
        message: 'forged',
        resource: {
          kind: 'agents',
          key: '/forged/AGENTS.md',
          display: '/forged/AGENTS.md',
          version: '${'a'.repeat(64)}',
        },
      }`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.failureKind, 'runtime');
    assert.equal(result.contextResources, undefined);
  } finally {
    f.close();
  }
});

test('recursive grep loads nested AGENTS.md before reading descendant files', async () => {
  const f = fixture();
  try {
    const item = f.mind.create({ title: 'nested grep instructions' });
    const nested = path.join(f.dir, 'tree', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'nested grep contract\n');
    fs.writeFileSync(path.join(nested, 'file.txt'), 'GREPPED_SENTINEL\n');
    const code = `await elpis.grep('GREPPED_SENTINEL', { path: ${JSON.stringify(path.join(f.dir, 'tree'))} })`;

    const blocked = await f.manager.run({ sandbox: item.id, code });
    assert.equal(blocked.failureKind, 'context');
    assert.match(blocked.error ?? '', /nested grep contract/);
    f.contextResources.acknowledge(blocked.contextResources ?? []);

    const retried = await f.manager.run({ sandbox: item.id, code });
    assert.equal(retried.ok, true);
    assert.match(retried.preview ?? '', /GREPPED_SENTINEL/);
  } finally {
    f.close();
  }
});

test('git add loads AGENTS.md for each selected nested path', async () => {
  const f = fixture();
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: f.dir });
    const item = f.mind.create({ title: 'nested git instructions' });
    const nested = path.join(f.dir, 'stage');
    const file = path.join(nested, 'file with space.txt');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'AGENTS.md'), 'nested git contract\n');
    fs.writeFileSync(file, 'stage me\n');
    const code = `await elpis.git.add('stage/file with space.txt', { cwd: ${JSON.stringify(f.dir)} })`;

    const blocked = await f.manager.run({ sandbox: item.id, code });
    assert.equal(blocked.failureKind, 'context');
    assert.match(blocked.error ?? '', /nested git contract/);
    f.contextResources.acknowledge(blocked.contextResources ?? []);

    const retried = await f.manager.run({ sandbox: item.id, code });
    assert.equal(retried.ok, true);
    assert.equal(
      execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: f.dir,
        encoding: 'utf8',
      }).trim(),
      'stage/file with space.txt',
    );
  } finally {
    f.close();
  }
});

test('caught context interruptions cannot replace their model-visible message', async () => {
  const f = fixture();
  try {
    const item = f.mind.create({ title: 'cannot rewrite instructions' });
    const target = path.join(f.dir, 'file.ts');
    fs.writeFileSync(path.join(f.dir, 'AGENTS.md'), 'immutable contract\n');
    fs.writeFileSync(target, 'value\n');
    const result = await f.manager.run({
      sandbox: item.id,
      code: `try {
        elpis.read(${JSON.stringify(target)})
      } catch (error) {
        error.message = 'instructions hidden'
        throw error
      }`,
    });
    if (result.failureKind === 'context') {
      assert.match(result.error ?? '', /immutable contract/);
      assert.doesNotMatch(result.error ?? '', /instructions hidden/);
    } else {
      assert.equal(result.failureKind, 'runtime');
      const retried = await f.manager.run({
        sandbox: item.id,
        code: `elpis.read(${JSON.stringify(target)})`,
      });
      assert.equal(retried.failureKind, 'context');
      assert.match(retried.error ?? '', /immutable contract/);
    }
  } finally {
    f.close();
  }
});

test('caught AGENTS.md interrupt remains pending until a visible failure', async () => {
  const f = fixture();
  try {
    const item = f.mind.create({ title: 'cannot catch instructions away' });
    const target = path.join(f.dir, 'file.ts');
    fs.writeFileSync(path.join(f.dir, 'AGENTS.md'), 'uncatchable contract\n');
    fs.writeFileSync(target, 'value\n');

    const caught = await f.manager.run({
      sandbox: item.id,
      code: `try { elpis.read(${JSON.stringify(target)}) } catch {}\n'caught'`,
    });
    assert.equal(caught.ok, true);
    assert.equal(caught.contextResources, undefined);

    const visible = await f.manager.run({
      sandbox: item.id,
      code: `elpis.read(${JSON.stringify(target)})`,
    });
    assert.equal(visible.ok, false);
    assert.equal(visible.failureKind, 'context');
    assert.match(visible.error ?? '', /uncatchable contract/);
    f.contextResources.acknowledge(visible.contextResources ?? []);

    const retry = await f.manager.run({
      sandbox: item.id,
      code: `elpis.read(${JSON.stringify(target)})`,
    });
    assert.equal(retry.ok, true);
    assert.match(retry.preview ?? '', /value/);
  } finally {
    f.close();
  }
});

test('Mind selector lazily creates one persistent sandbox and retains bound state', async () => {
  const f = fixture();
  const item = f.mind.create({ title: 'hold state' });
  assert.equal(f.manager.getByMind(item.id), null);

  const first = await f.manager.run({
    sandbox: item.id,
    code: 'const kept = 41; elpis.mind.bound.get().id',
  });
  assert.equal(first.execution?.mindId, item.id);
  assert.equal(first.execution?.created, true);
  assert.equal(f.manager.getByMind(item.id)?.id, item.id);
  assert.equal(first.execution?.statusReminder, true);
  assert.equal(first.savedAs, '_');
  const second = await f.manager.run({ sandbox: item.title, code: 'kept + 1' });
  assert.equal(second.preview, '42');
  assert.equal(second.execution?.created, false);
  assert.equal(second.execution?.statusReminder, false);
  assert.equal(f.manager.list().length, 1);
  f.close();
});

test('preparse creates no persistent sandbox and preserves existing state', async () => {
  const f = fixture();
  const fresh = f.mind.create({ title: 'bad first use' });
  const rejected = await f.manager.run({
    sandbox: fresh.id,
    code: 'const nope =',
  });
  assert.equal(rejected.failureKind, 'preparse');
  assert.equal(f.manager.getByMind(fresh.id), null);

  const item = f.mind.create({ title: 'reset shape' });
  const registration = f.manager.ensurePersistent(item.id);
  await f.manager.run({
    sandbox: registration.id,
    code: 'const kept = 9; kept',
  });
  const preparse = await f.manager.run({
    sandbox: registration.id,
    code: 'const nope =',
  });
  assert.equal(preparse.failureKind, 'preparse');
  assert.equal(
    (await f.manager.run({ sandbox: registration.id, code: 'kept' })).preview,
    '9',
  );
  const failed = await f.manager.run({
    sandbox: registration.id,
    code: 'throw new Error("reset me")',
  });
  assert.equal(failed.failureKind, 'runtime');
  assert.equal(failed.execution?.generation, 1);
  assert.equal(failed.execution?.resetGeneration, 2);
  const after = await f.manager.run({
    sandbox: registration.id,
    code: 'typeof kept',
  });
  assert.match(after.preview ?? '', /"undefined"/);
  assert.equal(after.execution?.generation, 2);
  f.close();
});

test('preparse preserves persistent state while uncaught runtime failure resets one generation', async () => {
  const f = fixture();
  const item = f.mind.create({ title: 'reset shape' });
  const registration = f.manager.ensurePersistent(item.id);
  await f.manager.run({
    sandbox: registration.id,
    code: 'const kept = 9; kept',
  });
  const preparse = await f.manager.run({
    sandbox: registration.id,
    code: 'const nope =',
  });
  assert.equal(preparse.failureKind, 'preparse');
  assert.equal(
    (await f.manager.run({ sandbox: registration.id, code: 'kept' })).preview,
    '9',
  );
  const failed = await f.manager.run({
    sandbox: registration.id,
    code: 'throw new Error("reset me")',
  });
  assert.equal(failed.failureKind, 'runtime');
  assert.equal(failed.execution?.generation, 1);
  assert.equal(failed.execution?.resetGeneration, 2);
  const after = await f.manager.run({
    sandbox: registration.id,
    code: 'typeof kept',
  });
  assert.match(after.preview ?? '', /"undefined"/);
  assert.equal(after.execution?.generation, 2);
  f.close();
});

test('run-scoped callback exception resets only the owning persistent generation', async () => {
  const f = fixture();
  const item = f.mind.create({ title: 'callback reset' });
  const registration = f.manager.ensurePersistent(item.id);
  let routed = false;
  f.deps.send = async () => {
    routed = routeRunProcessError(
      'uncaughtException',
      new Error('request callback ENOENT'),
    );
  };
  const failed = await f.manager.run({
    sandbox: registration.id,
    code: `globalThis.beforeCallback = 1; await elpis.channel('console').send('trigger'); await new Promise(() => {})`,
  });
  assert.equal(routed, true);
  assert.equal(failed.failureKind, 'runtime');
  assert.match(
    failed.error ?? '',
    /asynchronous sandbox uncaughtException:.*request callback ENOENT/s,
  );
  assert.equal(failed.execution?.generation, 1);
  assert.equal(failed.execution?.resetGeneration, 2);
  const after = await f.manager.run({
    sandbox: registration.id,
    code: 'typeof beforeCallback',
  });
  assert.match(after.preview ?? '', /"undefined"/);
  assert.equal(after.execution?.generation, 2);
  f.close();
});

test('completed persistent run attributes one stale-listener error to alias and generation', async () => {
  const f = fixture();
  const item = f.mind.create({ title: 'late callback owner' });
  const registration = f.manager.ensurePersistent(item.id);
  let captured: RunScope | undefined;
  const late: Array<{
    alias?: string;
    generation?: number;
    runId?: string;
    kind: string;
    error: unknown;
  }> = [];
  f.deps.send = async () => {
    captured = runScope.getStore();
  };
  f.deps.onLateProcessError = (event) => late.push(event);
  const completed = await f.manager.run({
    sandbox: registration.id,
    code: `await elpis.channel('console').send('capture'); 7`,
  });
  assert.equal(completed.ok, true);
  assert.ok(captured?.processError);
  const error = new Error('stale server ENOENT');
  assert.equal(captured!.processError!('uncaughtException', error), true);
  assert.equal(
    captured!.processError!('uncaughtException', new Error('repeat')),
    true,
  );
  assert.deepEqual(late, [
    {
      alias: registration.id,
      generation: 1,
      runId: completed.execution?.runId,
      kind: 'uncaughtException',
      error,
    },
  ]);
  assert.equal(f.registry.get(registration.id).generation, 1);
  assert.equal(f.registry.get(registration.id).lifecycle, 'ready');
  f.close();
});

test('detached callback exception rejects its future and resets ownership', async () => {
  const f = fixture({ deadlineMs: 20 });
  const item = f.mind.create({ title: 'detached callback reset' });
  const registration = f.manager.ensurePersistent(item.id);
  let routed = false;
  f.deps.send = async () => {
    setTimeout(() => {
      routed = routeRunProcessError(
        'uncaughtException',
        new Error('late request callback ENOENT'),
      );
    }, 50);
  };
  const detached = await f.manager.run({
    sandbox: registration.id,
    code: `await elpis.channel('console').send('arm'); await new Promise(() => {})`,
  });
  assert.equal(detached.detached, true);
  assert.equal(f.registry.get(registration.id).lifecycle, 'detached');
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(routed, true);
  const reset = f.registry.get(registration.id);
  assert.equal(reset.lifecycle, 'ready');
  assert.equal(reset.generation, 2);
  f.close();
});

test('persistent sandbox permits only one active run and detached future owns busy until settle', async () => {
  const f = fixture({ deadlineMs: 20 });
  const item = f.mind.create({ title: 'one at a time' });
  const registration = f.manager.ensurePersistent(item.id);
  const detached = await f.manager.run({
    sandbox: registration.id,
    code: 'await new Promise(resolve => setTimeout(() => resolve(7), 80))',
  });
  assert.equal(detached.detached, true);
  assert.equal(f.registry.get(registration.id).lifecycle, 'detached');
  const refused = await f.manager.run({ sandbox: registration.id, code: '2' });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', new RegExp(`detached.*${detached.bgId}`));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.registry.get(registration.id).lifecycle, 'ready');
  assert.equal(
    (await f.manager.run({ sandbox: registration.id, code: '3' })).preview,
    '3',
  );
  f.close();
});

test('cold start warns once through metadata and advances live generations', async () => {
  const f = fixture({ coldStart: false });
  const item = f.mind.create({ title: 'cold state' });
  const registration = f.manager.ensurePersistent(item.id);
  const manager = createSandboxManager({
    deps: f.deps,
    registry: f.registry,
    logger: noopLogger,
    now: () => 10_000,
  });
  const first = await manager.run({ sandbox: registration.id, code: '1' });
  assert.equal(first.execution?.generation, 2);
  assert.equal(first.execution?.coldStart, true);
  const second = await manager.run({ sandbox: registration.id, code: '2' });
  assert.equal(second.execution?.coldStart, false);
  f.close();
});

test('classifier sees bounded source only and is advisory on YES, malformed, or failure', async () => {
  const seen: Array<{ role: string; content: string }> = [];
  let answer = 'YES';
  const classify: SandboxDeps['completeStandalone'] = async (messages) => {
    seen.push(
      ...messages.map((message) => ({
        role: message.role,
        content: message.content ?? '',
      })),
    );
    if (answer === 'THROW') throw new Error('provider unavailable');
    return completion(answer);
  };
  const f = fixture({ classify });
  const yes = await f.manager.run({ code: `'${'x'.repeat(9_000)}'.length` });
  assert.equal(yes.ok, true);
  assert.equal(yes.execution?.classifierReminder, true);
  assert.equal(seen.at(-1)!.content.length, 8_000);
  assert.equal(
    seen.length,
    2,
    'classifier receives system plus bounded source only',
  );
  answer = 'maybe';
  const malformed = await f.manager.run({ code: '2' });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.execution?.classifierReminder, false);
  answer = 'THROW';
  const failed = await f.manager.run({ code: '3' });
  assert.equal(failed.ok, true);
  assert.equal(failed.execution?.classifierReminder, false);
  f.close();
});

test('closure starts a hard grace, warns every call, reopen cancels, and use cannot extend expiry', async () => {
  const f = fixture({ retirementGraceMs: 100 });
  const item = f.mind.create({ title: 'retire on deadline' });
  const registration = f.manager.ensurePersistent(item.id);
  await f.manager.run({
    sandbox: registration.id,
    code: 'globalThis.warm = 1',
  });
  f.mind.setStatus(item.id, 'done', 'test');
  f.manager.handleMindStateChange(item.id, 'done', false);
  const firstRequest = f.registry.get(registration.id).retireRequestedAt;
  assert.ok(firstRequest);
  const firstWarning = await f.manager.run({
    sandbox: registration.id,
    code: 'warm',
  });
  assert.equal(firstWarning.execution?.retiring, true);
  assert.equal(
    firstWarning.execution?.retirementDeadlineAt,
    firstRequest! + 100,
  );
  assert.match(
    firstWarning.execution?.retirementWarning ?? '',
    /Mind #elm-[0-9a-z]+ is closed.*retires at.*Select or create/,
  );

  f.mind.setStatus(item.id, 'open', 'test');
  f.manager.handleMindStateChange(item.id, 'open', false);
  const reopened = f.registry.get(registration.id);
  assert.equal(reopened.retireRequested, false);
  assert.equal(reopened.retireRequestedAt, null);

  f.advance(10);
  f.mind.setStatus(item.id, 'done', 'test');
  f.manager.handleMindStateChange(item.id, 'done', false);
  const hardRequest = f.registry.get(registration.id).retireRequestedAt;
  assert.ok(hardRequest && hardRequest > firstRequest!);
  f.advance(90);
  const repeated = await f.manager.run({
    sandbox: registration.id,
    code: 'warm',
  });
  assert.equal(repeated.ok, true);
  assert.equal(repeated.execution?.retirementDeadlineAt, hardRequest! + 100);
  assert.equal(
    f.registry.get(registration.id).retireRequestedAt,
    hardRequest,
    'begin/finish must not refresh closure time',
  );
  f.advance(11);
  f.mind.setStatus(item.id, 'open', 'late reopen');
  f.manager.handleMindStateChange(item.id, 'open', false);
  assert.equal(
    f.registry.get(registration.id).lifecycle,
    'retired',
    'reopening after expiry cannot resurrect the context',
  );
  const expired = await f.manager.run({
    sandbox: registration.id,
    code: 'warm',
  });
  assert.equal(expired.ok, false);
  assert.match(expired.error ?? '', /retired/);
  f.close();
});

test('zero grace retires a ready sandbox in the closure callback', async () => {
  const f = fixture({ retirementGraceMs: 0 });
  const item = f.mind.create({ title: 'retire immediately' });
  const registration = f.manager.ensurePersistent(item.id);
  await f.manager.run({ sandbox: registration.id, code: '1' });
  f.mind.setStatus(item.id, 'done', 'test');
  f.manager.handleMindStateChange(item.id, 'done', false);
  assert.equal(f.registry.get(registration.id).lifecycle, 'retired');
  f.close();
});

test('active and detached runs finalize immediately when they settle after the hard deadline', async () => {
  const active = fixture({ retirementGraceMs: 10 });
  const activeItem = active.mind.create({ title: 'active retirement' });
  const activeRegistration = active.manager.ensurePersistent(activeItem.id);
  const activeRun = active.manager.run({
    sandbox: activeRegistration.id,
    code: 'await new Promise(resolve => setTimeout(() => resolve(7), 30))',
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  active.mind.setStatus(activeItem.id, 'done', 'test');
  active.manager.handleMindStateChange(activeItem.id, 'done', false);
  active.advance(11);
  const activeResult = await activeRun;
  assert.equal(activeResult.ok, true);
  assert.equal(activeResult.execution?.lifecycle, 'retired');
  assert.equal(active.registry.get(activeRegistration.id).lifecycle, 'retired');
  active.close();

  const detached = fixture({ deadlineMs: 10, retirementGraceMs: 10 });
  const detachedItem = detached.mind.create({ title: 'detached retirement' });
  const detachedRegistration = detached.manager.ensurePersistent(
    detachedItem.id,
  );
  const detachedRun = await detached.manager.run({
    sandbox: detachedRegistration.id,
    code: 'await new Promise(resolve => setTimeout(() => resolve(8), 50))',
  });
  assert.equal(detachedRun.detached, true);
  detached.mind.setStatus(detachedItem.id, 'done', 'test');
  detached.manager.handleMindStateChange(detachedItem.id, 'done', false);
  detached.advance(11);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(
    detached.registry.get(detachedRegistration.id).lifecycle,
    'retired',
  );
  detached.close();
});

test('cancelling a detached future closes provenance and resets its generation', async () => {
  const authority = createResidentRunAuthority();
  let accepted: ReturnType<ResidentRunVerifier['accept']> | undefined;
  const verifier: ResidentRunVerifier = {
    accept(token) {
      accepted = authority.verifier.accept(token);
      return accepted;
    },
    resolveActive: (handle) => authority.verifier.resolveActive(handle),
    lifecycle: (handle) => authority.verifier.lifecycle(handle),
    detach: (handle) => authority.verifier.detach(handle),
    close: (handle) => authority.verifier.close(handle),
  };
  const f = fixture({ deadlineMs: 20, residentRunVerifier: verifier });
  const item = f.mind.create({ title: 'cancel future' });
  const registration = f.manager.ensurePersistent(item.id);
  const detached = await f.manager.run({
    sandbox: registration.id,
    code: 'await new Promise(resolve => setTimeout(() => resolve(7), 500))',
    residentRunToken: committedRunToken(authority),
  });
  assert.equal(detached.detached, true);
  assert.ok(detached.bgId);
  assert.ok(accepted);
  assert.equal(authority.verifier.lifecycle(accepted!), 'detached');
  assert.equal(f.bg.cancel(detached.bgId!).ok, true);
  assert.equal(authority.verifier.lifecycle(accepted!), 'closed');
  const reset = f.registry.get(registration.id);
  assert.equal(reset.lifecycle, 'ready');
  assert.equal(reset.generation, 2);
  const next = await f.manager.run({ sandbox: registration.id, code: '8' });
  assert.equal(next.execution?.generation, 2);
  f.close();
});

test('classifier hard-timeout is advisory even when the provider ignores AbortSignal', async () => {
  const f = fixture({
    classify: async () => new Promise<StandaloneCompleteResult>(() => {}),
  });
  const manager = createSandboxManager({
    deps: f.deps,
    registry: f.registry,
    logger: noopLogger,
    now: () => 10_000,
    coldStart: false,
    classifierTimeoutMs: 15,
  });
  const started = Date.now();
  const result = await manager.run({ code: '1 + 1' });
  assert.equal(result.ok, true);
  assert.equal(result.execution?.classifierReminder, false);
  assert.ok(
    Date.now() - started < 500,
    'ignored abort cannot hang the ephemeral run',
  );
  f.close();
});

test('persistent detach without bg registry fails visibly and closes provenance', async () => {
  const authority = createResidentRunAuthority();
  let accepted: ReturnType<ResidentRunVerifier['accept']> | undefined;
  const verifier: ResidentRunVerifier = {
    accept(token) {
      accepted = authority.verifier.accept(token);
      return accepted;
    },
    resolveActive: (handle) => authority.verifier.resolveActive(handle),
    lifecycle: (handle) => authority.verifier.lifecycle(handle),
    detach: (handle) => authority.verifier.detach(handle),
    close: (handle) => authority.verifier.close(handle),
  };
  const f = fixture({ deadlineMs: 15, coldStart: false });
  const item = f.mind.create({ title: 'missing future registry' });
  const registration = f.manager.ensurePersistent(item.id);
  const deps = { ...f.deps, bg: undefined } as SandboxDeps;
  const manager = createSandboxManager({
    deps,
    registry: f.registry,
    logger: noopLogger,
    coldStart: false,
    residentRunVerifier: verifier,
  });
  const result = await manager.run({
    sandbox: registration.id,
    code: 'await new Promise(resolve => setTimeout(resolve, 60))',
    residentRunToken: committedRunToken(authority),
  });
  assert.equal(result.ok, false);
  assert.equal(result.detached, false);
  assert.equal(result.failureKind, 'runtime');
  assert.match(result.error ?? '', /without a background-future registry/);
  assert.equal(f.registry.get(registration.id).generation, 2);
  assert.ok(accepted);
  assert.equal(authority.verifier.lifecycle(accepted!), 'closed');
  manager.dispose();
  await new Promise((resolve) => setTimeout(resolve, 70));
  f.close();
});

test('wake advice runs through the manager classifier seam with bounded turn state', async () => {
  let userPayload = '';
  const f = fixture({
    classify: async (messages) => {
      userPayload = String(messages[1]?.content ?? '');
      return completion('{"minutes":45,"reason":"quiet-exploration"}');
    },
  });
  const advice = await f.manager.adviseWake({
    turnKind: 'autonomous',
    sendsThisTurn: 0,
    ranCode: false,
    continuedMindId: null,
  });
  assert.deepEqual(advice, {
    delayMs: 45 * 60_000,
    reason: 'quiet-exploration',
    source: 'classifier',
  });
  assert.match(userPayload, /"turnKind":"autonomous"/);
  assert.match(userPayload, /"inProgress":\[\]/);
  f.close();
});

test('resident run tokens reject invalid presence, wrong authority, wrong tool, and replay before execution', async () => {
  const authority = createResidentRunAuthority();
  const accepted: ReturnType<ResidentRunVerifier['accept']>[] = [];
  const verifier: ResidentRunVerifier = {
    accept(token) {
      const handle = authority.verifier.accept(token);
      accepted.push(handle);
      return handle;
    },
    resolveActive: (handle) => authority.verifier.resolveActive(handle),
    lifecycle: (handle) => authority.verifier.lifecycle(handle),
    detach: (handle) => authority.verifier.detach(handle),
    close: (handle) => authority.verifier.close(handle),
  };
  const f = fixture({ residentRunVerifier: verifier });
  let appends = 0;
  f.deps.memory!.append = () => {
    appends++;
  };
  try {
    const undefinedResult = await f.manager.run({
      code: `elpis.memory.append('undefined')`,
      residentRunToken: undefined,
    } as any);
    assert.equal(undefinedResult.ok, false);

    const other = createResidentRunAuthority();
    const crossResult = await f.manager.run({
      code: `elpis.memory.append('cross')`,
      residentRunToken: committedRunToken(other),
    });
    assert.equal(crossResult.ok, false);

    const forgedResult = await f.manager.run({
      code: `elpis.memory.append('forged')`,
      residentRunToken: Object.freeze({}) as any,
    });
    assert.equal(forgedResult.ok, false);

    const wrongResult = await f.manager.run({
      code: `elpis.memory.append('wrong')`,
      residentRunToken: committedRunToken(authority, 'think'),
    });
    assert.equal(wrongResult.ok, false);
    assert.match(wrongResult.error ?? '', /not run/);
    assert.equal(authority.verifier.lifecycle(accepted.at(-1)!), 'closed');

    const token = committedRunToken(authority);
    const valid = await f.manager.run({
      code: `elpis.memory.append('valid')`,
      residentRunToken: token,
    });
    assert.equal(valid.ok, true);
    assert.equal(appends, 1);
    assert.equal(authority.verifier.lifecycle(accepted.at(-1)!), 'closed');

    const replay = await f.manager.run({
      code: `elpis.memory.append('replay')`,
      residentRunToken: token,
    });
    assert.equal(replay.ok, false);
    assert.match(replay.error ?? '', /already accepted/);
    assert.equal(appends, 1);
  } finally {
    f.close();
  }
});

test('resident identity inspection is active-run-only on core and persistent surfaces', async () => {
  const authority = createResidentRunAuthority();
  const seen: ResidentToolCallSnapshotV1[] = [];
  const f = fixture({
    residentRunVerifier: authority.verifier,
    residentSourceInspector: (snapshot) => {
      seen.push(snapshot);
      return 'CANDIDATE ONLY — NOT AUTHORIZED\nsynthetic inspection';
    },
  });
  try {
    const direct = await f.manager.run({
      code: 'elpis.context.inspectIdentityCandidate()',
    });
    assert.equal(direct.ok, false);
    assert.match(direct.error ?? '', /active resident run/);
    assert.equal(seen.length, 0);

    const core = await f.manager.run({
      code: 'elpis.context.inspectIdentityCandidate()',
      residentRunToken: committedRunToken(authority),
    });
    assert.equal(core.ok, true);
    assert.match(core.preview ?? '', /CANDIDATE ONLY — NOT AUTHORIZED/);

    const item = f.mind.create({ title: 'resident identity inspection' });
    const persistent = await f.manager.run({
      sandbox: item.id,
      code: 'elpis.context.inspectIdentityCandidate()',
      residentRunToken: committedRunToken(authority),
    });
    assert.equal(persistent.ok, true);
    assert.match(persistent.preview ?? '', /synthetic inspection/);
    assert.equal(seen.length, 2);
    assert.ok(seen.every((snapshot) => snapshot.toolName === 'run'));
    assert.ok(seen.every((snapshot) => snapshot.callIndex === 0));
    assert.notEqual(seen[0]?.batchId, seen[1]?.batchId);

    const inherited = await f.manager.run({
      sandbox: item.id,
      code: 'elpis.context.inspectIdentityCandidate()',
    });
    assert.equal(inherited.ok, false);
    assert.match(inherited.error ?? '', /active resident run/);
    assert.equal(seen.length, 2);
  } finally {
    f.close();
  }
});

const SYNTHETIC_CANDIDATE_ID = `resident-source-candidate:${'a'.repeat(64)}`;

test('resident identity authorization is active-run-only and receives exact live provenance', async () => {
  const authority = createResidentRunAuthority();
  const inspections: ResidentToolCallSnapshotV1[] = [];
  const authorizations: Array<{
    candidateId: string;
    snapshot: ResidentToolCallSnapshotV1;
  }> = [];
  const f = fixture({
    residentRunVerifier: authority.verifier,
    residentSourceInspector: (snapshot) => {
      inspections.push(snapshot);
      return SYNTHETIC_CANDIDATE_ID;
    },
    residentSourceAuthorizer: (candidateId, snapshot) => {
      authorizations.push({ candidateId, snapshot });
      return 'SOURCE CANDIDATE AUTHORIZED — NOT PROFILED OR ACTIVE';
    },
  });
  try {
    const direct = await f.manager.run({
      code: `elpis.context.authorizeIdentityCandidate('${SYNTHETIC_CANDIDATE_ID}')`,
    });
    assert.equal(direct.ok, false);
    assert.match(direct.error ?? '', /active resident run/);
    assert.equal(authorizations.length, 0);

    const sameBatch = await f.manager.run({
      code: `elpis.context.inspectIdentityCandidate(); elpis.context.authorizeIdentityCandidate('${SYNTHETIC_CANDIDATE_ID}')`,
      residentRunToken: committedRunToken(authority),
    });
    assert.equal(sameBatch.ok, true);
    assert.match(sameBatch.preview ?? '', /SOURCE CANDIDATE AUTHORIZED/);
    assert.equal(inspections.length, 1);
    assert.equal(authorizations.length, 1);
    assert.equal(authorizations[0]?.candidateId, SYNTHETIC_CANDIDATE_ID);
    assert.equal(
      authorizations[0]?.snapshot.batchId,
      inspections[0]?.batchId,
    );

    const item = f.mind.create({ title: 'resident identity authorization' });
    const persistent = await f.manager.run({
      sandbox: item.id,
      code: `elpis.context.authorizeIdentityCandidate('${SYNTHETIC_CANDIDATE_ID}')`,
      residentRunToken: committedRunToken(authority),
    });
    assert.equal(persistent.ok, true);
    assert.equal(authorizations.length, 2);
    assert.notEqual(
      authorizations[0]?.snapshot.batchId,
      authorizations[1]?.snapshot.batchId,
    );

    const inherited = await f.manager.run({
      sandbox: item.id,
      code: `elpis.context.authorizeIdentityCandidate('${SYNTHETIC_CANDIDATE_ID}')`,
    });
    assert.equal(inherited.ok, false);
    assert.match(inherited.error ?? '', /active resident run/);
    assert.equal(authorizations.length, 2);
  } finally {
    f.close();
  }
});

test('persistent invocations bind fresh resident handles without inheritance', async () => {

  const authority = createResidentRunAuthority();
  const f = fixture({ residentRunVerifier: authority.verifier });
  const seen: Array<ReturnType<typeof residentRunHandleForScope>> = [];
  const snapshots: Array<{ batchId: string; callIndex: number }> = [];
  f.deps.memory!.read = () => {
    const scope = runScope.getStore();
    const handle = scope ? residentRunHandleForScope(scope) : undefined;
    seen.push(handle);
    if (handle) {
      const snapshot = authority.verifier.resolveActive(handle);
      snapshots.push({
        batchId: snapshot.batchId,
        callIndex: snapshot.callIndex,
      });
    }
    return '';
  };
  try {
    const item = f.mind.create({ title: 'resident provenance scopes' });
    const first = await f.manager.run({
      sandbox: item.id,
      code: 'elpis.memory.read()',
      residentRunToken: committedRunToken(authority),
    });
    const second = await f.manager.run({
      sandbox: item.id,
      code: 'elpis.memory.read()',
      residentRunToken: committedRunToken(authority),
    });
    const direct = await f.manager.run({
      sandbox: item.id,
      code: 'elpis.memory.read()',
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(direct.ok, true);
    assert.equal(seen.length, 3);
    assert.ok(seen[0]);
    assert.ok(seen[1]);
    assert.notEqual(seen[0], seen[1]);
    assert.equal(seen[2], undefined);
    assert.notEqual(snapshots[0]?.batchId, snapshots[1]?.batchId);
    assert.equal(authority.verifier.lifecycle(seen[0]!), 'closed');
    assert.equal(authority.verifier.lifecycle(seen[1]!), 'closed');
  } finally {
    f.close();
  }
});

test('resident provenance closes on preparse and manager disposal', async () => {
  const authority = createResidentRunAuthority();
  const accepted: ReturnType<ResidentRunVerifier['accept']>[] = [];
  const verifier: ResidentRunVerifier = {
    accept(token) {
      const handle = authority.verifier.accept(token);
      accepted.push(handle);
      return handle;
    },
    resolveActive: (handle) => authority.verifier.resolveActive(handle),
    lifecycle: (handle) => authority.verifier.lifecycle(handle),
    detach: (handle) => authority.verifier.detach(handle),
    close: (handle) => authority.verifier.close(handle),
  };
  const f = fixture({
    deadlineMs: 5_000,
    residentRunVerifier: verifier,
  });
  const started = Promise.withResolvers<void>();
  f.deps.memory!.read = () => {
    started.resolve();
    return '';
  };
  try {
    const preparse = await f.manager.run({
      sandbox: 'unused',
      code: 'const =',
      residentRunToken: committedRunToken(authority),
    });
    assert.equal(preparse.failureKind, 'preparse');
    assert.equal(authority.verifier.lifecycle(accepted[0]!), 'closed');

    const pending = f.manager.run({
      code: `elpis.memory.read(); await elpis.sleep(50); 1`,
      residentRunToken: committedRunToken(authority),
    });
    await started.promise;
    assert.equal(authority.verifier.lifecycle(accepted[1]!), 'active');
    f.manager.dispose();
    assert.equal(authority.verifier.lifecycle(accepted[1]!), 'closed');
    await pending;
  } finally {
    f.close();
  }
});

test('resident provenance detaches at the real deadline and closes on settlement', async () => {
  const authority = createResidentRunAuthority();
  let accepted: ReturnType<ResidentRunVerifier['accept']> | undefined;
  const verifier: ResidentRunVerifier = {
    accept(token) {
      accepted = authority.verifier.accept(token);
      return accepted;
    },
    resolveActive: (handle) => authority.verifier.resolveActive(handle),
    lifecycle: (handle) => authority.verifier.lifecycle(handle),
    detach: (handle) => authority.verifier.detach(handle),
    close: (handle) => authority.verifier.close(handle),
  };
  let inspections = 0;
  const f = fixture({
    deadlineMs: 15,
    residentRunVerifier: verifier,
    residentSourceInspector: () => {
      inspections++;
      return 'should not run after detach';
    },
  });
  const continued = Promise.withResolvers<void>();
  let continuationLifecycle = '';
  f.deps.memory!.read = () => {
    const scope = runScope.getStore();
    const handle = scope ? residentRunHandleForScope(scope) : undefined;
    continuationLifecycle = handle
      ? authority.verifier.lifecycle(handle)
      : 'missing';
    continued.resolve();
    return '';
  };
  try {
    const result = await f.manager.run({
      code: `await elpis.sleep(60); try { elpis.context.inspectIdentityCandidate(); } catch {} elpis.memory.read(); 7`,
      residentRunToken: committedRunToken(authority),
    });
    assert.equal(result.detached, true);
    assert.ok(accepted);
    assert.equal(authority.verifier.lifecycle(accepted!), 'detached');
    await continued.promise;
    assert.equal(continuationLifecycle, 'detached');
    assert.equal(inspections, 0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(authority.verifier.lifecycle(accepted!), 'closed');
  } finally {
    f.close();
  }
});
