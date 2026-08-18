import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBgRegistry } from '../src/sandbox/bg.js';
import { createSandboxManager } from '../src/sandbox/manager.js';
import { createSandboxRegistry } from '../src/sandbox/registry.js';
import { runMigrations } from '../src/store/db.js';
import { MindService } from '../src/store/mind.js';
import { noopLogger } from '../src/lib/log.js';
import { makeConfig } from './helpers.js';
import type { SandboxDeps } from '../src/types.js';
import type { StandaloneCompleteResult } from '../src/llm/llm.js';

function fixture(opts: { deadlineMs?: number; classify?: SandboxDeps['completeStandalone']; coldStart?: boolean; idleGcMs?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-manager-'));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db);
  let clock = 10_000;
  const now = () => clock;
  let taskId = 1;
  const tasks = new Map<number, any>();
  const scheduler = {
    create(value: any) { const row = { id: taskId++, ...value }; tasks.set(row.id, row); return row; },
    delete(id: number) { return tasks.delete(id); },
    update(id: number, patch: any) { const row = tasks.get(id); if (!row) return null; Object.assign(row, patch); return row; },
  };
  const config = makeConfig({
    paths: { ...makeConfig().paths, dataDirectory: dir, harnessRoot: dir },
    sandbox: {
      ...makeConfig().sandbox,
      asyncDeadlineMs: opts.deadlineMs ?? 5_000,
      persistentIdleGcMs: opts.idleGcMs ?? 100,
    },
  });
  const mind = new MindService({ db, scheduler, logger: noopLogger });
  const registry = createSandboxRegistry({
    db,
    now,
    uuid: (() => { let n = 0; return () => `sandbox-${++n}`; })(),
    aliases: { dataDirectory: dir, logger: noopLogger, chooseStart: () => 0 },
  });
  const bg = createBgRegistry(dir);
  const deps = {
    config,
    memory: { read: () => '', append: () => undefined, overwrite: () => undefined },
    logbuf: [],
    mind,
    scheduler,
    bg,
    completeStandalone: opts.classify,
  } as unknown as SandboxDeps;
  const manager = createSandboxManager({ deps, registry, logger: noopLogger, now, coldStart: opts.coldStart });
  return {
    dir, db, mind, registry, manager, bg, deps,
    advance(ms: number) { clock += ms; },
    close() { manager.dispose(); bg.dispose(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function completion(content: string): StandaloneCompleteResult {
  return { content, usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

test('omitted selector creates a fresh core-only ephemeral sandbox every run', async () => {
  const f = fixture({ classify: async () => completion('NO') });
  const first = await f.manager.run({ code: 'globalThis.turnValue = 41; ({ value: turnValue, fs: typeof fs, last: typeof _ })' });
  assert.equal(first.execution?.kind, 'ephemeral');
  assert.equal(first.savedAs, undefined);
  assert.match(first.preview ?? '', /fs: "undefined"/);
  assert.match(first.preview ?? '', /last: "undefined"/);
  const second = await f.manager.run({ code: 'typeof turnValue' });
  assert.match(second.preview ?? '', /"undefined"/);
  f.close();
});

test('ephemeral bootstrap registers one stable alias and persistent runs retain bound state', async () => {
  const f = fixture();
  const item = f.mind.create({ title: 'hold state' });
  const boot = await f.manager.run({ code: `elpis.sandbox.create({ mindId: ${item.id} })` });
  const registration = f.manager.getByMind(item.id)!;
  assert.match(boot.preview ?? '', new RegExp(registration.alias));
  assert.equal(f.manager.createPersistent(item.id).alias, registration.alias, 'registration is idempotent');

  const first = await f.manager.run({ sandbox: registration.alias, code: 'const kept = 41; elpis.mind.bound.get().id' });
  assert.equal(first.execution?.mindId, item.id);
  assert.equal(first.execution?.statusReminder, true);
  assert.equal(first.savedAs, '_');
  const second = await f.manager.run({ sandbox: registration.alias, code: 'kept + 1' });
  assert.equal(second.preview, '42');
  assert.equal(second.execution?.statusReminder, false);
  const byId = await f.manager.run({ sandbox: registration.id, code: '1' });
  assert.equal(byId.ok, false);
  assert.match(byId.error ?? '', /exact alias/);
  f.close();
});

test('preparse preserves persistent state while uncaught runtime failure resets one generation', async () => {
  const f = fixture();
  const item = f.mind.create({ title: 'reset shape' });
  const registration = f.manager.createPersistent(item.id);
  await f.manager.run({ sandbox: registration.alias, code: 'const kept = 9; kept' });
  const preparse = await f.manager.run({ sandbox: registration.alias, code: 'const nope =' });
  assert.equal(preparse.failureKind, 'preparse');
  assert.equal((await f.manager.run({ sandbox: registration.alias, code: 'kept' })).preview, '9');
  const failed = await f.manager.run({ sandbox: registration.alias, code: 'throw new Error("reset me")' });
  assert.equal(failed.failureKind, 'runtime');
  assert.equal(failed.execution?.generation, 1);
  assert.equal(failed.execution?.resetGeneration, 2);
  const after = await f.manager.run({ sandbox: registration.alias, code: 'typeof kept' });
  assert.match(after.preview ?? '', /"undefined"/);
  assert.equal(after.execution?.generation, 2);
  f.close();
});

test('persistent sandbox permits only one active run and detached future owns busy until settle', async () => {
  const f = fixture({ deadlineMs: 20 });
  const item = f.mind.create({ title: 'one at a time' });
  const registration = f.manager.createPersistent(item.id);
  const detached = await f.manager.run({ sandbox: registration.alias, code: 'await new Promise(resolve => setTimeout(() => resolve(7), 80))' });
  assert.equal(detached.detached, true);
  assert.equal(f.registry.get(registration.alias).lifecycle, 'detached');
  const refused = await f.manager.run({ sandbox: registration.alias, code: '2' });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? '', new RegExp(`detached.*${detached.bgId}`));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(f.registry.get(registration.alias).lifecycle, 'ready');
  assert.equal((await f.manager.run({ sandbox: registration.alias, code: '3' })).preview, '3');
  f.close();
});

test('cold start warns once through metadata and advances live generations', async () => {
  const f = fixture({ coldStart: false });
  const item = f.mind.create({ title: 'cold state' });
  const registration = f.manager.createPersistent(item.id);
  const manager = createSandboxManager({
    deps: f.deps,
    registry: f.registry,
    logger: noopLogger,
    now: () => 10_000,
  });
  const first = await manager.run({ sandbox: registration.alias, code: '1' });
  assert.equal(first.execution?.generation, 2);
  assert.equal(first.execution?.coldStart, true);
  const second = await manager.run({ sandbox: registration.alias, code: '2' });
  assert.equal(second.execution?.coldStart, false);
  f.close();
});

test('classifier sees bounded source only and is advisory on YES, malformed, or failure', async () => {
  const seen: Array<{ role: string; content: string }> = [];
  let answer = 'YES';
  const classify: SandboxDeps['completeStandalone'] = async (messages) => {
    seen.push(...messages.map((message) => ({ role: message.role, content: message.content ?? '' })));
    if (answer === 'THROW') throw new Error('provider unavailable');
    return completion(answer);
  };
  const f = fixture({ classify });
  const yes = await f.manager.run({ code: `'${'x'.repeat(9_000)}'.length` });
  assert.equal(yes.ok, true);
  assert.equal(yes.execution?.classifierReminder, true);
  assert.equal(seen.at(-1)!.content.length, 8_000);
  assert.equal(seen.length, 2, 'classifier receives system plus bounded source only');
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

test('closing requests retirement, reopen cancels, and closed idle GC finalizes', async () => {
  const f = fixture({ idleGcMs: 100 });
  const item = f.mind.create({ title: 'retire later' });
  const registration = f.manager.createPersistent(item.id);
  await f.manager.run({ sandbox: registration.alias, code: 'globalThis.warm = 1' });
  f.mind.setStatus(item.id, 'done', 'test');
  f.manager.handleMindStateChange(item.id, 'done', false);
  assert.equal(f.registry.get(registration.alias).retireRequested, true);
  const warned = await f.manager.run({ sandbox: registration.alias, code: 'warm' });
  assert.equal(warned.execution?.retiring, true);
  f.mind.setStatus(item.id, 'open', 'test');
  f.manager.handleMindStateChange(item.id, 'open', false);
  assert.equal(f.registry.get(registration.alias).retireRequested, false);
  f.mind.setStatus(item.id, 'done', 'test');
  f.manager.handleMindStateChange(item.id, 'done', false);
  f.advance(101);
  assert.deepEqual(f.manager.collectGarbage(), [registration.alias]);
  assert.equal(f.registry.get(registration.alias).lifecycle, 'retired');
  f.close();
});

test('cancelling a detached future releases ownership by resetting its generation', async () => {
  const f = fixture({ deadlineMs: 20 });
  const item = f.mind.create({ title: 'cancel future' });
  const registration = f.manager.createPersistent(item.id);
  const detached = await f.manager.run({ sandbox: registration.alias, code: 'await new Promise(resolve => setTimeout(() => resolve(7), 500))' });
  assert.equal(detached.detached, true);
  assert.ok(detached.bgId);
  assert.equal(f.bg.cancel(detached.bgId!).ok, true);
  const reset = f.registry.get(registration.alias);
  assert.equal(reset.lifecycle, 'ready');
  assert.equal(reset.generation, 2);
  const next = await f.manager.run({ sandbox: registration.alias, code: '8' });
  assert.equal(next.execution?.generation, 2);
  f.close();
});

test('classifier hard-timeout is advisory even when the provider ignores AbortSignal', async () => {
  const f = fixture({ classify: async () => new Promise<StandaloneCompleteResult>(() => {}) });
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
  assert.ok(Date.now() - started < 500, 'ignored abort cannot hang the ephemeral run');
  f.close();
});

test('persistent detach without bg registry fails visibly and resets generation', async () => {
  const f = fixture({ deadlineMs: 15, coldStart: false });
  const item = f.mind.create({ title: 'missing future registry' });
  const registration = f.manager.createPersistent(item.id);
  const deps = { ...f.deps, bg: undefined } as SandboxDeps;
  const manager = createSandboxManager({ deps, registry: f.registry, logger: noopLogger, coldStart: false });
  const result = await manager.run({ sandbox: registration.alias, code: 'await new Promise(resolve => setTimeout(resolve, 60))' });
  assert.equal(result.ok, false);
  assert.equal(result.detached, false);
  assert.equal(result.failureKind, 'runtime');
  assert.match(result.error ?? '', /without a background-future registry/);
  assert.equal(f.registry.get(registration.alias).generation, 2);
  manager.dispose();
  await new Promise((resolve) => setTimeout(resolve, 70));
  f.close();
});
