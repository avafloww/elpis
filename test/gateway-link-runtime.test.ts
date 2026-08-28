import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  GatewayToResidentFrame,
  ResidentConsoleOutputEffect,
  ResidentMediaResultEffect,
  ResidentOperationResultEffect,
} from '@elpis/gateway-protocol';
import type { HubClient } from '../src/console/hub.js';
import type {
  GatewayLinkControllerOptions,
  GatewayLinkEffectSink,
} from '../src/gateway-link.js';
import {
  startGatewayLinkRuntime,
  stopGatewayControlPlane,
  type GatewayLinkControllerLike,
} from '../src/gateway-link-runtime.js';

const remote = {
  url: 'https://gateway.example',
  enrollmentToken: null,
} as const;
const store = {
  read: () => {
    throw new Error('not exercised');
  },
  activeNodeToken: () => {
    throw new Error('not exercised');
  },
};
const identity = { name: 'Aster' } as const;
const build = {
  version: '1.2.3',
  revision: 'a'.repeat(40),
  state: 'dev',
} as const;

class FakeController implements GatewayLinkControllerLike {
  status = Object.freeze({ state: 'idle', failures: 0 } as const);
  starts = 0;
  stops = 0;
  start(): void {
    this.starts += 1;
    this.status = Object.freeze({
      state: 'waiting_for_enrollment',
      failures: 0,
    });
  }
  stop(): void {
    this.stops += 1;
    this.status = Object.freeze({ state: 'stopped', failures: 0 });
  }
}

function options(
  factory: (options: GatewayLinkControllerOptions) => GatewayLinkControllerLike,
  onStatus?: (status: unknown) => void,
) {
  return { remote, store, identity, build, factory, onStatus };
}

describe('Gateway link runtime lifecycle', () => {
  it('is absent when remote Gateway configuration is absent', () => {
    let calls = 0;
    const runtime = startGatewayLinkRuntime({
      ...options(() => {
        calls += 1;
        return new FakeController();
      }),
      remote: null,
    });
    assert.equal(runtime, null);
    assert.equal(calls, 0);
  });

  it('starts once with exact resident inputs and stops idempotently', () => {
    const controller = new FakeController();
    let captured: GatewayLinkControllerOptions | null = null;
    const runtime = startGatewayLinkRuntime(
      options((value) => {
        captured = value;
        return controller;
      }),
    );
    assert.ok(runtime);
    assert.equal(controller.starts, 1);
    assert.equal(captured?.remote, remote);
    assert.equal(captured?.store, store);
    assert.equal(captured?.identity, identity);
    assert.equal(captured?.build, build);
    assert.equal(captured?.offeredCapabilities, undefined);
    assert.equal(typeof captured?.events?.status, 'function');
    assert.deepEqual(runtime.status, {
      state: 'waiting_for_enrollment',
      failures: 0,
    });
    runtime.stop();
    runtime.stop();
    assert.equal(controller.stops, 1);
  });

  it('wires console effects and detaches viewers on status loss and stop', async () => {
    const controller = new FakeController();
    let captured: GatewayLinkControllerOptions | null = null;
    const clients = new Set<HubClient>();
    const removed: HubClient[] = [];
    const operations: ResidentOperationResultEffect[] = [];
    const outputs: ResidentConsoleOutputEffect[] = [];
    const media: ResidentMediaResultEffect[] = [];
    const sink: GatewayLinkEffectSink = {
      operationResult: (effect) => (operations.push(effect), true),
      consoleOutput: (effect) => (outputs.push(effect), true),
      mediaResult: (effect) => (media.push(effect), true),
    };
    const runtime = startGatewayLinkRuntime({
      ...options((value) => {
        captured = value;
        return controller;
      }),
      console: {
        hub: {
          async addClient(client) {
            clients.add(client);
            client.send('{"t":"snapshot"}');
          },
          removeClient(client) {
            clients.delete(client);
            removed.push(client);
          },
          async sendSnapshot(client) {
            client.send('{"t":"snapshot"}');
            return true;
          },
          handleClientMessage() {},
        },
        media: { read: async () => ({ ok: false, reason: 'not_found' }) },
      },
    });
    assert.ok(runtime);
    assert.deepEqual(captured?.offeredCapabilities, [
      'console.v1',
      'identity.v1',
      'media.v1',
    ]);
    assert.equal(typeof captured?.onFrame, 'function');

    const open = (requestId: string): GatewayToResidentFrame =>
      ({
        version: 1,
        connectionId: 'egx1.AAAAAAAAAAAAAAAAAAAAAA',
        seq: 2,
        type: 'viewer.open',
        requestId,
        viewerId: 'egv1.AAAAAAAAAAAAAAAAAAAAAA',
      }) as GatewayToResidentFrame;
    captured?.events?.status({ state: 'ready', failures: 0 });
    captured?.onFrame?.(open('egr1.AAAAAAAAAAAAAAAAAAAAAA'), sink);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(clients.size, 1);
    assert.equal(operations.length, 1);
    assert.equal(outputs.length, 1);

    captured?.events?.status({ state: 'backoff', failures: 1 });
    assert.equal(clients.size, 0);
    assert.equal(removed.length, 1);
    captured?.events?.status({ state: 'ready', failures: 0 });
    captured?.onFrame?.(open('egr1.BBBBBBBBBBBBBBBBBBBBBB'), sink);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(clients.size, 1);

    runtime.stop();
    runtime.stop();
    assert.equal(clients.size, 0);
    assert.equal(controller.stops, 1);
    assert.deepEqual(media, []);
  });

  it('contains factory and start failures without exposing thrown text', () => {
    const secret = 'egc1.secret-material-that-must-not-escape';
    const statuses: unknown[] = [];
    const factoryFault = startGatewayLinkRuntime(
      options(
        () => {
          throw new Error(secret);
        },
        (status) => statuses.push(status),
      ),
    );
    assert.deepEqual(factoryFault?.status, { state: 'faulted', failures: 0 });

    const controller = new FakeController();
    controller.start = () => {
      throw new Error(secret);
    };
    const startFault = startGatewayLinkRuntime(
      options(
        () => controller,
        (status) => statuses.push(status),
      ),
    );
    assert.deepEqual(startFault?.status, { state: 'faulted', failures: 0 });
    assert.equal(controller.stops, 1);
    assert.equal(JSON.stringify(statuses).includes(secret), false);
  });

  it('stops rotation before enrollment and link and contains shutdown failures', () => {
    const order: string[] = [];
    stopGatewayControlPlane(
      {
        stop: () => {
          order.push('rotation');
          throw new Error('contained');
        },
      },
      {
        stop: () => {
          order.push('enrollment');
          throw new Error('contained');
        },
      },
      {
        status: { state: 'ready', failures: 0 },
        stop: () => {
          order.push('link');
          throw new Error('contained');
        },
      },
    );
    assert.deepEqual(order, ['rotation', 'enrollment', 'link']);
  });

  it('sanitizes hostile controller status and status callbacks', () => {
    const emitted: unknown[] = [];
    let captured: GatewayLinkControllerOptions | null = null;
    const hostile = new FakeController();
    Object.defineProperty(hostile, 'status', {
      get() {
        return { state: 'ready', failures: 'secret' };
      },
    });
    const runtime = startGatewayLinkRuntime(
      options(
        (value) => {
          captured = value;
          return hostile;
        },
        (status) => emitted.push(status),
      ),
    );
    assert.deepEqual(runtime?.status, { state: 'faulted', failures: 0 });
    captured?.events?.status({
      state: 'ready',
      failures: 'egc1.secret',
    } as never);
    assert.deepEqual(emitted, [{ state: 'faulted', failures: 0 }]);
  });
});
