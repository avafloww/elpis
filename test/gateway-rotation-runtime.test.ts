import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRotationControllerOptions } from '../src/gateway-rotation.js';
import {
  startGatewayRotationRuntime,
  type GatewayRotationControllerLike,
  type GatewayRotationControllerFactory,
} from '../src/gateway-rotation-runtime.js';
import { SecretRegistry } from '../src/lib/secrets.js';
import type {
  GatewayResidentPhase,
  GatewayResidentStore,
} from '../src/store/gateway-resident.js';

const remote = {
  url: 'https://gateway.example',
  enrollmentToken: null,
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function storeView(initial: GatewayResidentPhase) {
  let phase = initial;
  let reads = 0;
  return {
    store: {
      read: () => {
        reads += 1;
        return { phase };
      },
    } as unknown as GatewayResidentStore,
    phase: (value: GatewayResidentPhase) => {
      phase = value;
    },
    reads: () => reads,
  };
}

class FakeController implements GatewayRotationControllerLike {
  readonly status = Object.freeze({ code: 'ready' } as const);
  triggers = 0;
  resumes = 0;
  stops = 0;
  triggerResult: Promise<{ code: 'rotated' | 'network_error' }> =
    Promise.resolve({ code: 'rotated' });
  resumeResult: Promise<{ code: 'rotated' | 'network_error' }> =
    Promise.resolve({ code: 'rotated' });

  trigger() {
    this.triggers += 1;
    return this.triggerResult;
  }
  resume() {
    this.resumes += 1;
    return this.resumeResult;
  }
  stop(): void {
    this.stops += 1;
  }
}

function options(
  phase: GatewayResidentPhase,
  factory: GatewayRotationControllerFactory,
) {
  const view = storeView(phase);
  return {
    view,
    value: {
      remote,
      store: view.store,
      secrets: new SecretRegistry(),
      fetch: async () => {
        throw new Error('fake controllers must not fetch');
      },
      factory,
    },
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('Gateway rotation runtime lifecycle', () => {
  it('has no store, factory, or fetch effects without remote configuration', () => {
    const view = storeView('rotating');
    let factories = 0;
    let fetches = 0;
    const runtime = startGatewayRotationRuntime({
      remote: null,
      store: view.store,
      secrets: new SecretRegistry(),
      fetch: async () => {
        fetches += 1;
        throw new Error('must not fetch');
      },
      factory: () => {
        factories += 1;
        return new FakeController();
      },
    });
    assert.equal(runtime, null);
    assert.equal(view.reads(), 0);
    assert.equal(factories, 0);
    assert.equal(fetches, 0);
  });

  it('does not construct or mutate a controller for active startup', async () => {
    let factories = 0;
    const f = options('active', () => {
      factories += 1;
      return new FakeController();
    });
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    assert.deepEqual(runtime.status, { code: 'ready' });
    assert.equal(f.view.reads(), 1);
    assert.equal(factories, 0);

    const result = await runtime.trigger();
    assert.deepEqual(result, { code: 'rotated' });
    assert.equal(factories, 1);
  });

  it('detaches startup replay only for durable rotating state', async () => {
    const pending = deferred<{ code: 'rotated' }>();
    const controller = new FakeController();
    controller.resumeResult = pending.promise;
    let captured: GatewayRotationControllerOptions | null = null;
    const f = options('rotating', (value) => {
      captured = value;
      return controller;
    });
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    assert.equal(controller.resumes, 1);
    assert.equal(controller.triggers, 0);
    assert.equal(captured?.mode, 'resume');
    assert.equal(captured?.store, f.view.store);
    assert.equal(captured?.secrets, f.value.secrets);
    assert.deepEqual(runtime.status, { code: 'rotating' });
    pending.resolve({ code: 'rotated' });
    await settle();
    assert.deepEqual(runtime.status, { code: 'rotated' });
  });

  it('retries a transient startup resume failure with a fresh controller', async () => {
    const first = new FakeController();
    first.resumeResult = Promise.reject(new Error('secret failure text'));
    const second = new FakeController();
    const made: FakeController[] = [];
    const f = options('rotating', () => {
      const controller = made.length === 0 ? first : second;
      made.push(controller);
      return controller;
    });
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    await settle();
    assert.deepEqual(runtime.status, { code: 'state_error' });

    const retry = await runtime.trigger();
    assert.deepEqual(retry, { code: 'rotated' });
    assert.equal(first.resumes, 1);
    assert.equal(first.stops, 1);
    assert.equal(second.resumes, 1);
    assert.equal(made.length, 2);
    assert.equal(JSON.stringify(runtime.status).includes('secret'), false);
  });

  it('uses a fresh controller for a later explicit rotation', async () => {
    const controllers: FakeController[] = [];
    const f = options('active', () => {
      const controller = new FakeController();
      controllers.push(controller);
      return controller;
    });
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    assert.deepEqual(await runtime.trigger(), { code: 'rotated' });
    // A real successful controller leaves the durable resident active again.
    f.view.phase('active');
    assert.deepEqual(await runtime.trigger(), { code: 'rotated' });
    assert.equal(controllers.length, 2);
    assert.equal(controllers[0]?.triggers, 1);
    assert.equal(controllers[1]?.triggers, 1);
  });

  it('joins concurrent triggers to the same live attempt', async () => {
    const pending = deferred<{ code: 'rotated' }>();
    const controller = new FakeController();
    controller.triggerResult = pending.promise;
    const f = options('active', () => controller);
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    const one = runtime.trigger();
    const two = runtime.trigger();
    assert.equal(two, one);
    assert.equal(controller.triggers, 1);
    assert.equal(f.view.reads(), 2); // one startup read and one operation read
    pending.resolve({ code: 'rotated' });
    assert.deepEqual(await one, { code: 'rotated' });
  });

  it('contains a factory failure and permits a later retry', async () => {
    const controller = new FakeController();
    let calls = 0;
    const f = options('active', () => {
      calls += 1;
      if (calls === 1) throw new Error('egc1.secret-must-not-escape');
      return controller;
    });
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    const failed = runtime.trigger();
    // The synchronous failure is already settled and must not poison an
    // immediate explicit retry with the old promise.
    const retried = runtime.trigger();
    assert.notEqual(retried, failed);
    assert.deepEqual(await failed, { code: 'state_error' });
    assert.deepEqual(await retried, { code: 'rotated' });
    assert.equal(calls, 2);
    assert.equal(controller.triggers, 1);
  });

  it('rereads durable phase and rejects non-active, non-rotating states', async () => {
    let factories = 0;
    const f = options('idle', () => {
      factories += 1;
      return new FakeController();
    });
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    assert.deepEqual(await runtime.trigger(), { code: 'invalid_state' });
    f.view.phase('enrolling');
    assert.deepEqual(await runtime.trigger(), { code: 'invalid_state' });
    assert.equal(factories, 0);
  });

  it('stops the current controller once and permanently rejects new work', async () => {
    const pending = deferred<{ code: 'rotated' }>();
    const controller = new FakeController();
    controller.triggerResult = pending.promise;
    let factories = 0;
    const f = options('active', () => {
      factories += 1;
      return controller;
    });
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    const attempt = runtime.trigger();
    runtime.stop();
    runtime.stop();
    assert.equal(controller.stops, 1);
    assert.deepEqual(runtime.status, { code: 'stopped' });
    // Stop settles the runtime even if an injected controller ignores abort.
    assert.deepEqual(await attempt, { code: 'stopped' });
    pending.resolve({ code: 'rotated' });
    assert.deepEqual(await runtime.trigger(), { code: 'stopped' });
    assert.equal(factories, 1);
  });

  it('sanitizes hostile controller results', async () => {
    const controller = new FakeController();
    controller.trigger = () =>
      Promise.resolve({ code: 'egc1.secret' } as never);
    const f = options('active', () => controller);
    const runtime = startGatewayRotationRuntime(f.value);
    assert.ok(runtime);
    assert.deepEqual(await runtime.trigger(), { code: 'state_error' });
    assert.deepEqual(runtime.status, { code: 'state_error' });
  });
});
