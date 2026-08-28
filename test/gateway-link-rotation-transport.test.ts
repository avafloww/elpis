import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import {
  CAPABILITIES,
  PROTOCOL_VERSION,
  RESIDENT_CONTROL_FORMATS,
  RESIDENT_CONTROL_PATHS,
  decodeCredentialVerifier,
  encodeCredentialVerifier,
  formatNodeBearerAuthorization,
  parseNodeCredential,
  serializeResidentRotationActivationRequest,
  serializeResidentRotationRequest,
  type GatewayToResidentFrame,
  type ResidentToGatewayFrame,
} from '@elpis/gateway-protocol';
import {
  GatewayResidentLinkRegistry,
  createGatewayHttpService,
  createGatewayResidentControlApi,
  createGatewayResidentLinkAuditWriter,
  openGatewayStore,
} from '../packages/gateway/src/index.js';
import {
  GatewayLinkController,
  WsGatewayLinkSocket,
  type GatewayLinkClock,
  type GatewayLinkSocket,
  type GatewayLinkSocketFactory,
  type GatewayLinkSocketHandlers,
  type GatewayLinkSocketOptions,
  type GatewayLinkStatus,
} from '../src/gateway-link.js';
import {
  startGatewayRotationRuntime,
  type GatewayRotationRuntime,
} from '../src/gateway-rotation-runtime.js';
import type { GatewayRotationFetch } from '../src/gateway-rotation.js';
import { SecretRegistry } from '../src/lib/secrets.js';
import { openDatabase } from '../src/store/db.js';
import {
  createGatewayResidentStore,
  type GatewayResidentStore,
} from '../src/store/gateway-resident.js';

const ORIGIN = 'https://gateway.example';
const DEADLINE_MS = 5_000;

type TimerHandle = ReturnType<typeof setTimeout>;
type TrackedClock = GatewayLinkClock & { readonly pending: Set<TimerHandle> };
type SocketReceipt = {
  readonly owner: 'resident' | 'revoked';
  readonly url: string;
  readonly connectionId: string;
  readonly proof: 'old' | 'new';
};
type HttpReceipt = {
  readonly target: string;
  readonly requestBytes: number;
  readonly proof: 'old' | 'pending';
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly responseBody: string;
};

function trackedClock(): TrackedClock {
  const pending = new Set<TimerHandle>();
  return {
    pending,
    now: Date.now,
    setTimeout(callback, delayMs) {
      const handle = setTimeout(() => {
        pending.delete(handle);
        callback();
      }, delayMs);
      handle.unref?.();
      pending.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      clearTimeout(handle as TimerHandle);
      pending.delete(handle as TimerHandle);
    },
  };
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = DEADLINE_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(label + ' timed out');
}

async function bounded<T>(label: string, operation: Promise<T>): Promise<T> {
  let timer: TimerHandle | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(label + ' exceeded its deadline')),
          DEADLINE_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fatalDisconnect(connectionId: string): GatewayToResidentFrame {
  return {
    version: PROTOCOL_VERSION,
    connectionId: connectionId as GatewayToResidentFrame['connectionId'],
    seq: 2,
    type: 'error',
    error: { code: 'invalid_frame', message: 'transport witness disconnect' },
    fatal: true,
  };
}

/** Delegate every transport operation to the production ws adapter while
 * retaining only secret-free ownership evidence for bounded teardown. */
function trackedSocket(
  socket: WsGatewayLinkSocket,
  ownership: Set<GatewayLinkSocket>,
): GatewayLinkSocket {
  let wrapper!: GatewayLinkSocket;
  const release = (): void => {
    ownership.delete(wrapper);
  };
  wrapper = {
    sendText: (text) => socket.sendText(text),
    close(code, reason) {
      release();
      socket.close(code, reason);
    },
    terminate() {
      release();
      socket.terminate();
    },
    attach(handlers: GatewayLinkSocketHandlers) {
      const detach = socket.attach({
        open: handlers.open,
        message: handlers.message,
        error: handlers.error,
        close: () => {
          release();
          handlers.close();
        },
      });
      return detach;
    },
  };
  ownership.add(wrapper);
  return wrapper;
}

function verifier(token: string): string {
  const parsed = parseNodeCredential(token);
  assert.ok(parsed);
  return encodeCredentialVerifier(parsed.verifier);
}

test('persisted resident rotates over real Gateway HTTP and reconnects over authenticated ws', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'elpis-gateway-rotation-transport-'),
  );
  const residentDirectory = path.join(directory, 'resident');
  const gatewayDirectory = path.join(directory, 'gateway');
  const publicRoot = path.join(directory, 'public');
  fs.mkdirSync(residentDirectory, { recursive: true });
  fs.mkdirSync(publicRoot, { recursive: true });
  fs.writeFileSync(path.join(publicRoot, 'index.html'), 'gateway witness');

  const gateway = openGatewayStore(gatewayDirectory);
  let residentDatabase = openDatabase(residentDirectory);
  let resident: GatewayResidentStore =
    createGatewayResidentStore(residentDatabase);
  let service: ReturnType<typeof createGatewayHttpService> | null = null;
  let link: GatewayLinkController | null = null;
  let revokedLink: GatewayLinkController | null = null;
  let rotation: GatewayRotationRuntime | null = null;
  const clock = trackedClock();
  const socketOwnership = new Set<GatewayLinkSocket>();

  try {
    // Enrollment transport is proved by the separate fresh-process witness. This
    // seam deliberately begins by reopening a genuinely persisted active row.
    const grant = gateway.credentials.createEnrollmentGrant();
    resident.beginEnrollment({
      endpoint: ORIGIN,
      displayName: 'Aster',
      grantToken: grant.token,
    });
    const enrollmentRequest = resident.enrollmentRequest();
    const enrollment = gateway.credentials.enroll({
      grantToken: enrollmentRequest.grantToken,
      instanceId: enrollmentRequest.instanceId,
      displayName: enrollmentRequest.displayName,
      credentialId: enrollmentRequest.credentialId,
      credentialVerifier: decodeCredentialVerifier(
        enrollmentRequest.credentialVerifier,
      ),
      requestId: enrollmentRequest.requestId,
    });
    resident.activateEnrollment({
      format: RESIDENT_CONTROL_FORMATS.enrollmentResult,
      instanceId: enrollmentRequest.instanceId,
      credentialId: enrollmentRequest.credentialId,
      replayed: enrollment.replayed,
    });
    const persisted = resident.read();
    const oldToken = resident.activeNodeToken();
    const grantComponent = grant.token.split('.')[2]!;
    const oldComponent = oldToken.split('.')[2]!;
    const oldVerifier = verifier(oldToken);
    residentDatabase.close();
    residentDatabase = openDatabase(residentDirectory);
    resident = createGatewayResidentStore(residentDatabase);
    assert.deepEqual(resident.read(), persisted);
    assert.equal(resident.activeNodeToken(), oldToken);

    const received: ResidentToGatewayFrame[] = [];
    const registry = new GatewayResidentLinkRegistry({
      clock,
      supportedCapabilities: CAPABILITIES,
      audit: createGatewayResidentLinkAuditWriter(gateway),
      handshakeTimeoutMs: 1_000,
      onFrame: (_summary, frame) => received.push(frame),
    });
    service = createGatewayHttpService({
      publicRoot,
      listen: { host: '127.0.0.1', port: 0 },
      store: gateway,
      residentControl: createGatewayResidentControlApi(gateway.credentials),
      residentCredentialStore: gateway.credentials,
      residentLinkRegistry: registry,
      residentRateLimiter: { allow: () => true },
      shutdownGraceMs: 200,
    });
    const address = await service.start();
    const localOrigin = 'http://127.0.0.1:' + address.port;
    const localSocket =
      'ws://127.0.0.1:' + address.port + RESIDENT_CONTROL_PATHS.link;
    const canonicalSocket =
      'wss://gateway.example' + RESIDENT_CONTROL_PATHS.link;
    const oldAuthorization = formatNodeBearerAuthorization(oldToken);
    let pendingToken = '';
    let pendingComponent = '';
    let pendingVerifier = '';
    let pendingAuthorization = '';
    const requestBodies: string[] = [];
    const httpReceipts: HttpReceipt[] = [];
    const socketReceipts: SocketReceipt[] = [];
    const statuses: GatewayLinkStatus[] = [];
    const revokedStatuses: GatewayLinkStatus[] = [];
    const rotationStatuses: Array<{ code: string }> = [];

    const socketFactory =
      (owner: SocketReceipt['owner']): GatewayLinkSocketFactory =>
      (url, options) => {
        assert.equal(url, canonicalSocket);
        assert.deepEqual(Object.keys(options).sort(), [
          'authorization',
          'connectionId',
          'maxPayload',
          'perMessageDeflate',
        ]);
        const proof =
          options.authorization === oldAuthorization
            ? 'old'
            : options.authorization === pendingAuthorization
              ? 'new'
              : null;
        assert.ok(proof, 'socket used an unexpected bearer');
        socketReceipts.push({
          owner,
          url,
          connectionId: options.connectionId,
          proof,
        });
        // This is the sole test-only mapping. The resident still requested the
        // exact canonical wss target; no TLS setting or certificate is changed.
        return trackedSocket(
          new WsGatewayLinkSocket(localSocket, options),
          socketOwnership,
        );
      };

    link = new GatewayLinkController({
      remote: { url: ORIGIN, enrollmentToken: null },
      store: resident,
      identity: { name: 'Aster' },
      build: { version: '1.2.3', revision: 'a'.repeat(40), state: 'dev' },
      clock,
      retryBaseMs: 20,
      retryMaxMs: 40,
      random: () => 0,
      socketFactory: socketFactory('resident'),
      events: { status: (status) => statuses.push(status) },
    });
    link.start();
    await waitFor(
      'initial hello acknowledgement',
      () =>
        link?.status.state === 'ready' &&
        registry.summary(persisted.instanceId)?.state === 'ready',
    );
    const first = registry.summary(persisted.instanceId)!;
    assert.equal(first.credentialId, persisted.activeCredentialId);
    assert.equal(received[0]?.type, 'hello');
    assert.equal(socketReceipts[0]?.url, canonicalSocket);
    assert.equal(socketReceipts[0]?.proof, 'old');

    const reconnectStatusStart = statuses.length;
    assert.equal(
      registry.send(
        persisted.instanceId,
        first.connectionId,
        fatalDisconnect(first.connectionId),
      ),
      true,
    );
    await waitFor('forced old-credential reconnect', () => {
      const current = registry.summary(persisted.instanceId);
      return (
        link?.status.state === 'ready' &&
        current?.state === 'ready' &&
        current.connectionId !== first.connectionId
      );
    });
    const second = registry.summary(persisted.instanceId)!;
    assert.ok(
      statuses
        .slice(reconnectStatusStart)
        .some((status) => status.state === 'backoff' && status.failures === 1),
    );
    assert.equal(socketReceipts[1]?.proof, 'old');

    const rotationFetch: GatewayRotationFetch = async (input, init) => {
      const target = new URL(input);
      assert.equal(target.origin, ORIGIN);
      assert.equal(target.search, '');
      assert.equal(target.hash, '');
      const headers = new Headers(init.headers);
      const body = String(init.body ?? '');
      requestBodies.push(body);
      let proof: HttpReceipt['proof'];
      if (target.pathname === RESIDENT_CONTROL_PATHS.rotation) {
        assert.equal(httpReceipts.length, 0);
        pendingToken = resident.pendingNodeToken();
        pendingComponent = pendingToken.split('.')[2]!;
        pendingVerifier = verifier(pendingToken);
        pendingAuthorization = formatNodeBearerAuthorization(pendingToken);
        assert.equal(headers.get('authorization'), oldAuthorization);
        assert.equal(
          body,
          serializeResidentRotationRequest(resident.rotationRequest()),
        );
        proof = 'old';
      } else {
        assert.equal(
          target.pathname,
          RESIDENT_CONTROL_PATHS.rotationActivation,
        );
        assert.equal(httpReceipts.length, 1);
        assert.equal(headers.get('authorization'), pendingAuthorization);
        assert.equal(
          body,
          serializeResidentRotationActivationRequest({
            format: RESIDENT_CONTROL_FORMATS.rotationActivationRequest,
            requestId: resident.rotationRequest().requestId,
          }),
        );
        proof = 'pending';
      }
      // Map only the canonical origin to the ephemeral plain HTTP listener. The
      // production controller's URL, method, headers, body, and redirect policy
      // are asserted before this test adapter performs that mapping.
      const localHeaders = new Headers(headers);
      localHeaders.set('connection', 'close');
      const response = await fetch(localOrigin + target.pathname, {
        ...init,
        headers: localHeaders,
      });
      const responseBody = await response.text();
      const responseHeaders = Object.freeze(
        Object.fromEntries(response.headers.entries()),
      );
      httpReceipts.push({
        target: input,
        requestBytes: Buffer.byteLength(body),
        proof,
        status: response.status,
        responseHeaders,
        responseBody,
      });
      // A synthetic Response only restores the originally requested canonical
      // URL (empty Response.url), avoiding any false claim of end-to-end TLS.
      return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };

    rotation = startGatewayRotationRuntime({
      remote: { url: ORIGIN, enrollmentToken: null },
      store: resident,
      secrets: new SecretRegistry(),
      fetch: rotationFetch,
    });
    assert.ok(rotation);
    const rotationResult = await bounded(
      'credential rotation',
      rotation.trigger(),
    );
    rotationStatuses.push(rotationResult, rotation.status);
    assert.deepEqual(rotationResult, { code: 'rotated' });
    assert.deepEqual(
      httpReceipts.map(({ target, proof, status }) => ({
        target,
        proof,
        status,
      })),
      [
        {
          target: ORIGIN + RESIDENT_CONTROL_PATHS.rotation,
          proof: 'old',
          status: 201,
        },
        {
          target: ORIGIN + RESIDENT_CONTROL_PATHS.rotationActivation,
          proof: 'pending',
          status: 200,
        },
      ],
    );
    assert.ok(pendingToken);
    assert.notEqual(pendingToken, oldToken);
    assert.equal(resident.activeNodeToken(), pendingToken);
    assert.equal(gateway.credentials.authenticateNode(oldToken), null);
    assert.deepEqual(gateway.credentials.authenticateNode(pendingToken), {
      instanceId: persisted.instanceId,
      credentialId: resident.read().activeCredentialId,
    });

    const admittedBeforeRevoked = gateway
      .audit()
      .filter(
        (event) => event.action === 'gateway.resident.link.admitted',
      ).length;
    revokedLink = new GatewayLinkController({
      remote: { url: ORIGIN, enrollmentToken: null },
      store: {
        read: () => resident.read(),
        activeNodeToken: () => oldToken,
      },
      identity: { name: 'Revoked credential witness' },
      build: { version: '1.2.3' },
      clock,
      retryBaseMs: 10_000,
      retryMaxMs: 10_000,
      random: () => 0,
      socketFactory: socketFactory('revoked'),
      events: { status: (status) => revokedStatuses.push(status) },
    });
    revokedLink.start();
    await waitFor('revoked credential fresh reconnect denial', () =>
      revokedStatuses.some((status) => status.state === 'backoff'),
    );
    assert.equal(
      revokedStatuses.some((status) => status.state === 'ready'),
      false,
    );
    assert.equal(socketReceipts.at(-1)?.owner, 'revoked');
    assert.equal(socketReceipts.at(-1)?.proof, 'old');
    assert.equal(
      gateway
        .audit()
        .filter((event) => event.action === 'gateway.resident.link.admitted')
        .length,
      admittedBeforeRevoked,
    );
    assert.equal(
      registry.summary(persisted.instanceId)?.connectionId,
      second.connectionId,
    );
    revokedLink.stop();
    revokedLink = null;

    const newReconnectStatusStart = statuses.length;
    assert.equal(
      registry.send(
        persisted.instanceId,
        second.connectionId,
        fatalDisconnect(second.connectionId),
      ),
      true,
    );
    await waitFor('rotated credential authenticated reconnect', () => {
      const current = registry.summary(persisted.instanceId);
      return (
        link?.status.state === 'ready' &&
        current?.state === 'ready' &&
        current.connectionId !== second.connectionId &&
        current.credentialId === resident.read().activeCredentialId
      );
    });
    const third = registry.summary(persisted.instanceId)!;
    assert.equal(socketReceipts.at(-1)?.owner, 'resident');
    assert.equal(socketReceipts.at(-1)?.proof, 'new');
    assert.ok(
      statuses
        .slice(newReconnectStatusStart)
        .some((status) => status.state === 'backoff'),
    );
    assert.equal(received.filter((frame) => frame.type === 'hello').length, 3);
    assert.notEqual(third.credentialId, second.credentialId);

    const publicEvidence = JSON.stringify({
      logs: [],
      statuses: {
        link: statuses,
        revoked: revokedStatuses,
        rotation: rotationStatuses,
      },
      httpReceipts,
      socketReceipts,
      wsObservations: received,
      registry: registry.summaries(),
      publicDatabase: {
        resident: resident.read(),
        gateway: {
          config: gateway.config(),
          instances: gateway.instances(),
          audit: gateway.audit(),
        },
      },
    });
    const secretValues = [
      grant.token,
      grantComponent,
      oldToken,
      oldComponent,
      oldVerifier,
      oldAuthorization,
      pendingToken,
      pendingComponent,
      pendingVerifier,
      pendingAuthorization,
      ...requestBodies,
    ];
    for (const secret of secretValues) {
      assert.ok(secret.length > 0);
      assert.equal(publicEvidence.includes(secret), false);
    }
    assert.equal(publicEvidence.toLowerCase().includes('authorization'), false);
    assert.equal(publicEvidence.includes('"credentialVerifier"'), false);

    rotation.stop();
    assert.deepEqual(rotation.status, { code: 'stopped' });
    rotation = null;
    link.stop();
    link = null;
    await waitFor('resident registry empty', () => registry.size === 0);
    await bounded('Gateway service stop', service.stop());
    assert.equal(service.listening, false);
    assert.equal(registry.stopped, true);
    assert.equal(registry.size, 0);
    assert.equal(socketOwnership.size, 0);
    assert.equal(clock.pending.size, 0);
    await assert.rejects(
      fetch(localOrigin + '/healthz', {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(250),
      }),
    );
    service = null;
  } finally {
    rotation?.stop();
    revokedLink?.stop();
    link?.stop();
    await service?.stop();
    gateway.close();
    residentDatabase.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
